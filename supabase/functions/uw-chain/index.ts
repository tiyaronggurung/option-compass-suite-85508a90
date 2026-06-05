// Live option chain via Unusual Whales.
// POST { ticker: string, expiry?: string } ->
//   { ticker, spot, expiries: string[], expiry, rows: ChainRow[] }
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const UW_KEY = Deno.env.get("UNUSUAL_WHALES_API_KEY") ?? "";
const UW_BASE = "https://api.unusualwhales.com/api";

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

const OCC_RE = /^(?<root>[A-Z]+?)(?<yy>\d{2})(?<mm>\d{2})(?<dd>\d{2})(?<type>[PC])(?<strike>\d{8})$/;

function parseOcc(sym: string): { underlying: string; expiry: string; type: "call" | "put"; strike: number } | null {
  const m = OCC_RE.exec(sym);
  if (!m?.groups) return null;
  const { root, yy, mm, dd, type, strike } = m.groups;
  return {
    underlying: root,
    expiry: `20${yy}-${mm}-${dd}`,
    type: type === "C" ? "call" : "put",
    strike: parseInt(strike, 10) / 1000,
  };
}

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

// Per-isolate in-memory cache. Multiple concurrent polls within CACHE_TTL_MS
// share the same response, drastically cutting UW API calls and avoiding 429s.
const CACHE_TTL_MS = 8_000;
type CacheEntry = { at: number; payload: any };
const responseCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any>>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
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

    // Serve from cache if fresh.
    const cached = responseCache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ...cached.payload, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Coalesce concurrent identical requests so only one hits UW.
    let work = inflight.get(cacheKey);
    if (!work) {
      work = (async () => {
        const [stateRes, chainsRes] = await Promise.allSettled([
          uw(`/stock/${encodeURIComponent(ticker)}/stock-state`),
          uw(`/stock/${encodeURIComponent(ticker)}/option-chains`),
        ]);

        let spot: number | null = null;
        if (stateRes.status === "fulfilled") {
          const d = stateRes.value?.data ?? stateRes.value ?? {};
          spot = numOrNull(d.close ?? d.last ?? d.price);
        }

        let allSymbols: string[] = [];
        if (chainsRes.status === "fulfilled") {
          const c = chainsRes.value;
          allSymbols = Array.isArray(c?.data) ? c.data : Array.isArray(c) ? c : [];
        }

        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const expirySet = new Set<string>();
        for (const sym of allSymbols) {
          const p = parseOcc(sym);
          if (!p) continue;
          const d = new Date(p.expiry + "T00:00:00Z");
          const dte = Math.round((d.getTime() - today.getTime()) / 86_400_000);
          if (dte >= 0 && dte <= 45) expirySet.add(p.expiry);
        }
        const expiries = Array.from(expirySet).sort();

        let expiry = requestedExpiry && expiries.includes(requestedExpiry) ? requestedExpiry : expiries[0] ?? "";
        if (!expiry && requestedExpiry) expiry = requestedExpiry;

        let rows: ChainRow[] = [];
        let contractsError: string | null = null;
        if (expiry) {
          try {
            const contractsJson = await uw(
              `/stock/${encodeURIComponent(ticker)}/option-contracts?expiry=${encodeURIComponent(expiry)}&limit=500`,
            );
            const data: any[] = Array.isArray(contractsJson?.data) ? contractsJson.data : [];
            rows = data.flatMap((c) => {
              const sym = c.option_symbol ?? c.symbol;
              if (!sym) return [];
              const parsed = parseOcc(sym);
              if (!parsed) return [];
              const row: ChainRow = {
                symbol: sym,
                underlying: parsed.underlying,
                expiry: parsed.expiry,
                strike: parsed.strike,
                type: parsed.type,
                bid: numOrNull(c.nbbo_bid),
                ask: numOrNull(c.nbbo_ask),
                last: numOrNull(c.last_price),
                volume: numOrNull(c.volume),
                open_interest: numOrNull(c.open_interest),
                delta: null,
                gamma: null,
                theta: null,
                vega: null,
                iv: numOrNull(c.implied_volatility),
              };
              return [row];
            });
            rows.sort((a, b) => a.strike - b.strike);
          } catch (e) {
            contractsError = (e as Error).message;
            console.error("uw-chain contracts error", contractsError);
          }
        }

        const payload = {
          ticker, spot, expiries, expiry, rows,
          fetched_at: new Date().toISOString(),
          contracts_error: contractsError,
        };

        // Only cache if we got contracts; otherwise let the next poll retry sooner.
        if (rows.length > 0) {
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
