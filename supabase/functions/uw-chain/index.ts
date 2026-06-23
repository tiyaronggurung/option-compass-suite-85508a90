// Live option chain via Unusual Whales (reverted from Tradier so the chain panel
// matches the source used by update-paper-marks — UW everywhere).
//
// POST { ticker: string, expiry?: string } ->
//   { ticker, spot, expiries: string[], expiry, rows: ChainRow[], ... }
//
// Same I/O shape as the previous Tradier implementation — frontend unchanged.
// Tradeoff (per user): UW chain often limits to ≤60 DTE and can 429 on bursts.
// We mitigate with per-isolate caching + stale-on-error fallback.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from "npm:@supabase/supabase-js@2";

const UW_KEY = Deno.env.get("UNUSUAL_WHALES_API_KEY") ?? "";
const UW_BASE = "https://api.unusualwhales.com/api";
const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const TRADIER_BASE = "https://api.tradier.com/v1";

// Live underlying fallback. UW's option-contracts response doesn't always include
// `underlying_price`, which left the dialog showing the signal's snapshot price
// (often yesterday's). Tradier always returns a fresh last trade.
async function fetchLiveSpot(ticker: string): Promise<number | null> {
  if (!TRADIER_KEY) return null;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(
      `${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(ticker)}&greeks=false`,
      { headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" }, signal: ctrl.signal },
    );
    clearTimeout(tid);
    if (!res.ok) { await res.text().catch(() => ""); return null; }
    const json = await res.json();
    const q = json?.quotes?.quote;
    const row = Array.isArray(q) ? q[0] : q;
    const v = row?.last ?? row?.close ?? row?.prevclose;
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

type ChainRow = {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
};

async function uw(path: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${UW_BASE}${path}`, {
      headers: { Authorization: `Bearer ${UW_KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`uw ${path} ${res.status}: ${t.slice(0, 120)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// OCC: AAPL260710C00320000 -> { strike: 320, type: "call" }
function parseOcc(occ: string): { strike: number; type: "call" | "put" } | null {
  const m = /^[A-Z]{1,6}\d{6}([CP])(\d{8})$/.exec(String(occ).trim().toUpperCase());
  if (!m) return null;
  return { type: m[1] === "C" ? "call" : "put", strike: parseInt(m[2], 10) / 1000 };
}

// Per-isolate caches (same strategy as before — collapses 5s client polls and
// survives short UW 429 windows by serving last-known data).
const CACHE_TTL_MS = 8_000;
const META_TTL_MS = 120_000;
const LAST_GOOD_TTL_MS = 600_000;
type CacheEntry = { at: number; payload: any };
type MetaEntry = { at: number; expiries: string[] };
const responseCache = new Map<string, CacheEntry>();
const metaCache = new Map<string, MetaEntry>();
const lastGoodCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any>>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth gate.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  {
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: cd, error: cErr } = await authClient.auth.getClaims(token);
    if (cErr || !cd?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
  if (!UW_KEY) {
    return new Response(JSON.stringify({ error: "UNUSUAL_WHALES_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const ticker = String(body?.ticker ?? "").toUpperCase().trim();
    const requestedExpiry = body?.expiry ? String(body.expiry) : null;
    if (!ticker) {
      return new Response(JSON.stringify({ error: "ticker required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cacheKey = `${ticker}|${requestedExpiry ?? ""}`;
    const now = Date.now();

    const cached = responseCache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ...cached.payload, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let work = inflight.get(cacheKey);
    if (!work) {
      work = (async () => {
        const metaKey = ticker;
        const meta = metaCache.get(metaKey);
        const metaFresh = meta && now - meta.at < META_TTL_MS;

        let expiries: string[] = metaFresh ? meta!.expiries : [];
        let expiryErr: string | null = null;

        if (!metaFresh) {
          try {
            const expJson = await uw(`/stock/${encodeURIComponent(ticker)}/expiry-breakdown`);
            const arr: any[] = Array.isArray(expJson?.data) ? expJson.data : Array.isArray(expJson) ? expJson : [];
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            const set = new Set<string>();
            for (const row of arr) {
              const e = row?.expires ?? row?.expiry ?? row?.expiration ?? row?.expires_at;
              if (typeof e !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e)) continue;
              const d = new Date(e + "T00:00:00Z");
              const dte = Math.round((d.getTime() - today.getTime()) / 86_400_000);
              // UW often caps; honor whatever UW returns up to ~120 DTE for safety.
              if (dte >= 0 && dte <= 120) set.add(e);
            }
            expiries = Array.from(set).sort();
            if (expiries.length > 0) metaCache.set(metaKey, { at: Date.now(), expiries });
          } catch (e) {
            expiryErr = (e as Error)?.message ?? String(e);
            if (meta) expiries = meta.expiries;
          }
        }

        let expiry = requestedExpiry && expiries.includes(requestedExpiry)
          ? requestedExpiry
          : expiries[0] ?? "";
        if (!expiry && requestedExpiry) expiry = requestedExpiry;

        let rows: ChainRow[] = [];
        let spot: number | null = null;
        let contractsError: string | null = null;
        if (expiry) {
          try {
            const chainJson = await uw(
              `/stock/${encodeURIComponent(ticker)}/option-contracts?expiry=${expiry}&limit=500`,
            );
            const arr: any[] = Array.isArray(chainJson?.data) ? chainJson.data : Array.isArray(chainJson) ? chainJson : [];
            for (const c of arr) {
              const occ = String(c.option_symbol ?? c.symbol ?? "").trim().toUpperCase();
              if (!occ) continue;
              const parsed = parseOcc(occ);
              if (!parsed) continue;
              const bid = numOrNull(c.nbbo_bid ?? c.bid);
              const ask = numOrNull(c.nbbo_ask ?? c.ask);
              const last = numOrNull(c.last_price ?? c.last ?? c.mark);
              const row: ChainRow = {
                symbol: occ,
                underlying: String(c.underlying ?? ticker),
                expiry: String(c.expiry ?? c.expiration ?? expiry),
                strike: parsed.strike,
                type: parsed.type,
                bid, ask, last,
                volume: numOrNull(c.volume) != null ? Math.round(numOrNull(c.volume)!) : null,
                open_interest: numOrNull(c.open_interest ?? c.oi) != null
                  ? Math.round(numOrNull(c.open_interest ?? c.oi)!) : null,
                delta: numOrNull(c.delta),
                gamma: numOrNull(c.gamma),
                theta: numOrNull(c.theta),
                vega: numOrNull(c.vega),
                iv: numOrNull(c.implied_volatility ?? c.iv),
              };
              rows.push(row);
              // UW frequently surfaces underlying price on each row — sample first non-null.
              if (spot == null) {
                const s = numOrNull(c.underlying_price ?? c.spot ?? c.price);
                if (s && s > 0) spot = s;
              }
            }
            rows.sort((a, b) => a.strike - b.strike);
          } catch (e) {
            contractsError = (e as Error).message;
          }
        }

        // Always ensure we return a fresh underlying spot. If UW didn't surface
        // it on the contract rows, fall back to a live Tradier quote so the
        // Buy Option dialog never shows yesterday's signal-snapshot price.
        if (spot == null || !(spot > 0)) {
          const live = await fetchLiveSpot(ticker);
          if (live != null) spot = live;
        }

        const payload: any = {
          ticker, spot, expiries, expiry, rows,
          fetched_at: new Date().toISOString(),
          contracts_error: contractsError,
          state_error: null,
          expiry_error: expiryErr,
          stale: false,
          source: "unusual_whales",
        };

        if (rows.length === 0) {
          const lg = lastGoodCache.get(cacheKey);
          if (lg && now - lg.at < LAST_GOOD_TTL_MS) {
            payload.rows = lg.payload.rows;
            payload.expiry = lg.payload.expiry || payload.expiry;
            if (payload.spot == null) payload.spot = lg.payload.spot ?? null;
            if (!payload.expiries.length) payload.expiries = lg.payload.expiries ?? [];
            payload.stale = true;
            payload.stale_age_ms = now - lg.at;
          }
        } else {
          lastGoodCache.set(cacheKey, { at: Date.now(), payload });
          responseCache.set(cacheKey, { at: Date.now(), payload });
        }
        return payload;
      })();
      inflight.set(cacheKey, work);
      work.finally(() => inflight.delete(cacheKey));
    }

    const payload = await work;
    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
