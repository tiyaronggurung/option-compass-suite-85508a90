// Market breadth across 10 mega-caps. Calls Tradier directly (key already in secrets)
// and returns up/down counts + a bullish/bearish/neutral bias.
// Cached in-memory ~30s so the Technical page marquee can poll cheaply.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const TICKERS = ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "AAPL", "META", "MSFT", "AMZN", "GOOGL"];
const THRESHOLD = 6;
const TTL_MS = 30_000;

type Row = { sym: string; price: number | null; prev: number | null; chgPct: number | null; dir: "up" | "down" | "flat" };
let cache: { at: number; payload: any } | null = null;

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function fetchBreadth() {
  const url = `https://api.tradier.com/v1/markets/quotes?symbols=${TICKERS.join(",")}&greeks=false`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`tradier_${res.status}`);
  const json = await res.json();
  const q = json?.quotes?.quote;
  const arr: any[] = Array.isArray(q) ? q : q ? [q] : [];
  const map = new Map<string, any>();
  for (const r of arr) if (r?.symbol) map.set(String(r.symbol).toUpperCase(), r);

  const rows: Row[] = TICKERS.map((sym) => {
    const r = map.get(sym);
    const price = r ? num(r.last) ?? num(r.close) : null;
    const prev = r ? num(r.prevclose) : null;
    const chgPct = price != null && prev && prev !== 0 ? ((price - prev) / prev) * 100 : null;
    const dir: Row["dir"] = chgPct == null ? "flat" : chgPct > 0 ? "up" : chgPct < 0 ? "down" : "flat";
    return { sym, price, prev, chgPct, dir };
  });

  const up = rows.filter((r) => r.dir === "up").length;
  const down = rows.filter((r) => r.dir === "down").length;
  let bias: "bullish" | "bearish" | "neutral" = "neutral";
  if (up >= THRESHOLD) bias = "bullish";
  else if (down >= THRESHOLD) bias = "bearish";

  return {
    bias,
    up,
    down,
    total: TICKERS.length,
    threshold: THRESHOLD,
    tickers: rows,
    fetched_at: new Date().toISOString(),
    source: "tradier",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!TRADIER_KEY) {
    return new Response(JSON.stringify({ error: "TRADIER_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const now = Date.now();
    if (!cache || now - cache.at > TTL_MS) {
      const payload = await fetchBreadth();
      cache = { at: now, payload };
    }
    return new Response(JSON.stringify(cache.payload), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
