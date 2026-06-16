// Live option chain via Tradier (migrated from Unusual Whales).
// POST { ticker: string, expiry?: string } ->
//   { ticker, spot, expiries: string[], expiry, rows: ChainRow[] }
// Same I/O shape as before — frontend (OptionsChainPanel, etc.) unchanged.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const TRADIER_BASE = "https://api.tradier.com/v1";

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

async function tradier(path: string, params: Record<string, string>, timeoutMs = 8000): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TRADIER_BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`tradier ${path} ${res.status}: ${t.slice(0, 120)}`);
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

// Per-isolate caches (same strategy as before).
const CACHE_TTL_MS = 8_000;
const META_TTL_MS = 120_000;
const LAST_GOOD_TTL_MS = 600_000;
type CacheEntry = { at: number; payload: any };
type MetaEntry = { at: number; spot: number | null; expiries: string[] };
const responseCache = new Map<string, CacheEntry>();
const metaCache = new Map<string, MetaEntry>();
const lastGoodCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any>>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Auth gate — prevent anonymous quota abuse.
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
  if (!TRADIER_KEY) {
    return new Response(JSON.stringify({ error: "TRADIER_API_KEY not configured" }), {
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

        let spot: number | null = metaFresh ? meta!.spot : null;
        let expiries: string[] = metaFresh ? meta!.expiries : [];
        let stateErr: string | null = null;
        let expiryErr: string | null = null;

        if (!metaFresh) {
          const [quoteRes, expRes] = await Promise.allSettled([
            tradier("/markets/quotes", { symbols: ticker, greeks: "false" }),
            tradier("/markets/options/expirations", { symbol: ticker, includeAllRoots: "true", strikes: "false" }),
          ]);

          if (quoteRes.status === "fulfilled") {
            const qq = quoteRes.value?.quotes?.quote;
            const row = Array.isArray(qq) ? qq[0] : qq;
            spot = numOrNull(row?.last) ?? numOrNull(row?.close) ?? numOrNull(row?.prevclose);
          } else {
            stateErr = (quoteRes.reason as Error)?.message ?? String(quoteRes.reason);
            if (meta) spot = meta.spot;
          }

          const today = new Date();
          today.setUTCHours(0, 0, 0, 0);
          if (expRes.status === "fulfilled") {
            const raw = expRes.value?.expirations?.date;
            const arr: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
            const set = new Set<string>();
            for (const e of arr) {
              if (typeof e !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e)) continue;
              const d = new Date(e + "T00:00:00Z");
              const dte = Math.round((d.getTime() - today.getTime()) / 86_400_000);
              if (dte >= 0 && dte <= 60) set.add(e);
            }
            expiries = Array.from(set).sort();
          } else {
            expiryErr = (expRes.reason as Error)?.message ?? String(expRes.reason);
            if (meta) expiries = meta.expiries;
          }

          if (expiries.length > 0) {
            metaCache.set(metaKey, { at: Date.now(), spot, expiries });
          }
        }

        let expiry = requestedExpiry && expiries.includes(requestedExpiry) ? requestedExpiry : expiries[0] ?? "";
        if (!expiry && requestedExpiry) expiry = requestedExpiry;

        let rows: ChainRow[] = [];
        let contractsError: string | null = null;
        if (expiry) {
          try {
            const chainJson = await tradier("/markets/options/chains", {
              symbol: ticker, expiration: expiry, greeks: "true",
            });
            const raw = chainJson?.options?.option;
            const arr: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
            rows = arr.map((c) => {
              const g = c.greeks ?? {};
              const row: ChainRow = {
                symbol: String(c.symbol ?? ""),
                underlying: String(c.underlying ?? ticker),
                expiry: String(c.expiration_date ?? expiry),
                strike: numOrNull(c.strike) ?? 0,
                type: String(c.option_type ?? "").toLowerCase() === "put" ? "put" : "call",
                bid: numOrNull(c.bid),
                ask: numOrNull(c.ask),
                last: numOrNull(c.last),
                volume: numOrNull(c.volume),
                open_interest: numOrNull(c.open_interest),
                delta: numOrNull(g.delta),
                gamma: numOrNull(g.gamma),
                theta: numOrNull(g.theta),
                vega: numOrNull(g.vega),
                iv: numOrNull(g.mid_iv ?? g.smv_vol ?? g.ask_iv ?? g.bid_iv),
              };
              return row;
            }).filter((r) => r.symbol);
            rows.sort((a, b) => a.strike - b.strike);
          } catch (e) {
            contractsError = (e as Error).message;
          }
        }

        const payload: any = {
          ticker, spot, expiries, expiry, rows,
          fetched_at: new Date().toISOString(),
          contracts_error: contractsError,
          state_error: stateErr,
          expiry_error: expiryErr,
          stale: false,
          source: "tradier",
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
