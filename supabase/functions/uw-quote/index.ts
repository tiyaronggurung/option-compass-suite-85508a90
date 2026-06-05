// Live stock quote via Unusual Whales.
// POST { tickers: string[] } -> { quotes: { [ticker]: { price, ts } }, errors: {...} }
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const UW_KEY = Deno.env.get("UNUSUAL_WHALES_API_KEY") ?? "";
const UW_BASE = "https://api.unusualwhales.com/api";

async function fetchOne(ticker: string): Promise<{ price: number | null; ts: string | null; error?: string }> {
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
    // Prefer last trade close, fall back to close.
    const priceStr = d.close ?? d.last ?? d.price ?? null;
    const price = priceStr != null ? Number(priceStr) : null;
    const ts = d.tape_time ?? d.market_time ?? null;
    return { price: Number.isFinite(price) ? price : null, ts };
  } catch (e) {
    return { price: null, ts: null, error: (e as Error).message?.slice(0, 80) };
  }
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
    const quotes: Record<string, { price: number | null; ts: string | null; error?: string }> = {};
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
