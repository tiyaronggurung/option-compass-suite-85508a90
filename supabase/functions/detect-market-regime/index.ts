// Market regime detector. Pulls SPY/QQQ/VIX bars from Alpaca and classifies
// the current market into bull / bear / sideways / high_vol. Writes a single
// row in public.market_regime (id='global'). Cron every 15 min in market hours.
// No live orders. Safe to call manually for testing.
import { createClient } from "npm:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

type Bar = { t: string; c: number };

async function dailyBars(symbol: string, days = 25): Promise<Bar[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?` + new URLSearchParams({
    timeframe: "1Day",
    start: start.toISOString(),
    end: end.toISOString(),
    limit: "100",
    adjustment: "raw",
    feed: "iex",
  });
  const res = await fetch(url, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.bars ?? []) as Bar[];
}

function trendPct(bars: Bar[], lookback = 20): number {
  if (bars.length < 2) return 0;
  const slice = bars.slice(-Math.min(lookback, bars.length));
  const first = slice[0].c, last = slice[slice.length - 1].c;
  if (!first) return 0;
  return ((last - first) / first) * 100;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!ALPACA_KEY) throw new Error("ALPACA_API_KEY_ID not configured");
    const [spy, qqq, vix] = await Promise.all([
      dailyBars("SPY"), dailyBars("QQQ"), dailyBars("VIXY"), // VIXY proxy (VIX direct often blocked on Alpaca)
    ]);
    const spyTrend = trendPct(spy);
    const qqqTrend = trendPct(qqq);
    const vixLast = vix.length ? vix[vix.length - 1].c : null;
    const avgTrend = (spyTrend + qqqTrend) / 2;

    let regime: "bull" | "bear" | "sideways" | "high_vol";
    if (vixLast !== null && vixLast > 22) regime = "high_vol";
    else if (avgTrend > 2) regime = "bull";
    else if (avgTrend < -2) regime = "bear";
    else regime = "sideways";

    await admin.from("market_regime").upsert({
      id: "global",
      regime,
      spy_trend: +spyTrend.toFixed(2),
      qqq_trend: +qqqTrend.toFixed(2),
      vix_level: vixLast,
      details: { source: "alpaca", lookback_days: 20, vix_proxy: "VIXY" },
      updated_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true, regime, spy_trend: spyTrend, qqq_trend: qqqTrend, vix_level: vixLast,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
