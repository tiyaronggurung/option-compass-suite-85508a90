// Live stock quote via Unusual Whales.
// POST { tickers: string[] } -> { quotes: { [ticker]: { price, ts } }, errors: {...} }
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const UW_KEY = Deno.env.get("UNUSUAL_WHALES_API_KEY") ?? "";
const UW_BASE = "https://api.unusualwhales.com/api";

// Per-isolate cache. Stock quotes change second-to-second, but a 4s TTL is plenty
// for UI freshness while collapsing 12 polls/min into ~3 actual UW calls per ticker.
// On 429, we keep serving last-good for up to STALE_TTL_MS so the UI never blanks.
type QuoteVal = { price: number | null; ts: string | null; error?: string };
type CacheEntry = { at: number; val: QuoteVal };
const TTL_MS = 4_000;
const STALE_TTL_MS = 120_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<QuoteVal>>();

async function fetchOneLive(ticker: string): Promise<QuoteVal> {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${UW_BASE}/stock/${encodeURIComponent(ticker)}/stock-state`, {
      headers: { Authorization: `Bearer ${UW_KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return { price: null, ts: null, error: `status_${res.status}` };
    const json = await res.json();
    const d = json?.data ?? json ?? {};
    const priceStr = d.close ?? d.last ?? d.price ?? null;
    const price = priceStr != null ? Number(priceStr) : null;
    const ts = d.tape_time ?? d.market_time ?? null;
    return { price: Number.isFinite(price) ? price : null, ts };
  } catch (e) {
    return { price: null, ts: null, error: (e as Error).message?.slice(0, 80) };
  }
}

async function fetchOne(ticker: string): Promise<QuoteVal> {
  const now = Date.now();
  const cached = cache.get(ticker);
  if (cached && now - cached.at < TTL_MS) return cached.val;

  let work = inflight.get(ticker);
  if (!work) {
    work = (async () => {
      const fresh = await fetchOneLive(ticker);
      // Successful fetch (has a price): cache it.
      if (fresh.price != null) {
        cache.set(ticker, { at: Date.now(), val: fresh });
        return fresh;
      }
      // Failed/empty: serve last-good if recent.
      if (cached && now - cached.at < STALE_TTL_MS) {
        return { ...cached.val, error: fresh.error ?? "stale" };
      }
      return fresh;
    })();
    inflight.set(ticker, work);
    work.finally(() => inflight.delete(ticker));
  }
  return work;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!UW_KEY) {
    return new Response(JSON.stringify({ error: "UNUSUAL_WHALES_API_KEY not configured" }), {
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
    const results = await Promise.all(tickers.map(async (t) => [t, await fetchOne(t)] as const));
    const quotes: Record<string, QuoteVal> = {};
    for (const [t, r] of results) quotes[t] = r;
    return new Response(JSON.stringify({ quotes, fetched_at: new Date().toISOString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
