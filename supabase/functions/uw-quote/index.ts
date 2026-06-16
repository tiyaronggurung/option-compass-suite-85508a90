// Live stock quote via Tradier (migrated from Unusual Whales to cut UW quota).
// POST { tickers: string[] } -> { quotes: { [ticker]: { price, ts } } }
// Same input/output shape as before — frontend (liveQuotesStore, useLiveQuote) unchanged.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const TRADIER_BASE = "https://api.tradier.com/v1";

type QuoteVal = { price: number | null; ts: string | null; error?: string };
type CacheEntry = { at: number; val: QuoteVal };

// 4s TTL collapses UI polling (every 5s × many tickers) into ~1 Tradier call per ticker per cycle.
// Tradier supports batch quotes, so we batch all requested tickers into ONE HTTP call.
const TTL_MS = 4_000;
const STALE_TTL_MS = 120_000;
const cache = new Map<string, CacheEntry>();
let inflight: Promise<Record<string, QuoteVal>> | null = null;
let inflightKey = "";

async function fetchBatchLive(tickers: string[]): Promise<Record<string, QuoteVal>> {
  const out: Record<string, QuoteVal> = {};
  if (!tickers.length) return out;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 6000);
    const url = `${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(tickers.join(","))}&greeks=false`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) {
      const err = `status_${res.status}`;
      for (const t of tickers) out[t] = { price: null, ts: null, error: err };
      return out;
    }
    const json = await res.json();
    // Tradier returns { quotes: { quote: {...} | [...] } } or { quotes: "null" } for no matches.
    const q = json?.quotes;
    let arr: any[] = [];
    if (q && typeof q === "object") {
      const qq = q.quote;
      arr = Array.isArray(qq) ? qq : qq ? [qq] : [];
    }
    const map = new Map<string, any>();
    for (const row of arr) {
      if (row?.symbol) map.set(String(row.symbol).toUpperCase(), row);
    }
    for (const t of tickers) {
      const row = map.get(t);
      if (!row) { out[t] = { price: null, ts: null, error: "no_quote" }; continue; }
      const price = num(row.last) ?? num(row.close) ?? num(row.prevclose);
      // trade_date is a unix ms timestamp; fall back to now if absent.
      const tsMs = num(row.trade_date) ?? num(row.bid_date) ?? num(row.ask_date);
      const ts = tsMs ? new Date(tsMs).toISOString() : new Date().toISOString();
      out[t] = { price: price ?? null, ts };
    }
    return out;
  } catch (e) {
    const err = (e as Error).message?.slice(0, 80);
    for (const t of tickers) out[t] = { price: null, ts: null, error: err };
    return out;
  }
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function getQuotes(tickers: string[]): Promise<Record<string, QuoteVal>> {
  const now = Date.now();
  const result: Record<string, QuoteVal> = {};
  const needFetch: string[] = [];
  for (const t of tickers) {
    const c = cache.get(t);
    if (c && now - c.at < TTL_MS) result[t] = c.val;
    else needFetch.push(t);
  }
  if (!needFetch.length) return result;

  // Coalesce concurrent identical batches.
  const key = needFetch.slice().sort().join(",");
  if (!inflight || inflightKey !== key) {
    inflightKey = key;
    inflight = (async () => {
      const fresh = await fetchBatchLive(needFetch);
      for (const t of needFetch) {
        const f = fresh[t];
        if (f?.price != null) {
          cache.set(t, { at: Date.now(), val: f });
        } else {
          // Stale-on-error: serve last-good if recent.
          const prev = cache.get(t);
          if (prev && Date.now() - prev.at < STALE_TTL_MS) {
            fresh[t] = { ...prev.val, error: f?.error ?? "stale" };
          }
        }
      }
      return fresh;
    })();
    inflight.finally(() => { inflight = null; inflightKey = ""; });
  }
  const fresh = await inflight;
  for (const t of needFetch) result[t] = fresh[t] ?? { price: null, ts: null, error: "miss" };
  return result;
}

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
    const raw = Array.isArray(body?.tickers) ? body.tickers : [];
    const tickers = Array.from(new Set(raw.map((t: unknown) => String(t).toUpperCase()).filter(Boolean))).slice(0, 50);
    if (!tickers.length) {
      return new Response(JSON.stringify({ quotes: {} }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const quotes = await getQuotes(tickers);
    return new Response(JSON.stringify({ quotes, fetched_at: new Date().toISOString(), source: "tradier" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
