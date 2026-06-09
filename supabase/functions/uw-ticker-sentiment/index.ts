// GET /functions/v1/uw-ticker-sentiment?ticker=AAPL
// Returns total call vs put volume + premium and put/call ratio from Unusual Whales.

import { uwFetch, UW_CONFIGURED } from "../_shared/unusual-whales.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function n(v: any): number {
  const x = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(x) ? Number(x) : 0;
}

function label(pcr: number): { sentiment: "bullish" | "bearish" | "neutral"; reason: string } {
  if (!Number.isFinite(pcr) || pcr <= 0) return { sentiment: "neutral", reason: "no flow" };
  if (pcr < 0.7) return { sentiment: "bullish", reason: "calls dominate puts" };
  if (pcr > 1.3) return { sentiment: "bearish", reason: "puts dominate calls" };
  return { sentiment: "neutral", reason: "balanced flow" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") ?? "").toUpperCase().trim();
  if (!ticker) {
    return new Response(JSON.stringify({ error: "ticker required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!UW_CONFIGURED) {
    return new Response(JSON.stringify({ error: "Unusual Whales not configured" }), {
      status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // UW endpoint: per-ticker daily options-volume aggregates
  const r = await uwFetch(`/stock/${encodeURIComponent(ticker)}/options-volume`);
  if (r.state !== "ok") {
    return new Response(JSON.stringify({ error: "uw fetch failed", detail: r.error ?? r.state }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // UW returns either { data: {...} } or { data: [ {...latest}, ... ] }
  const raw = r.data?.data ?? r.data;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") {
    return new Response(JSON.stringify({ error: "no data" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const callVolume = n(row.call_volume ?? row.calls_volume);
  const putVolume = n(row.put_volume ?? row.puts_volume);
  const callPremium = n(row.call_premium ?? row.calls_premium);
  const putPremium = n(row.put_premium ?? row.puts_premium);
  const avgCall = n(row.avg_30_day_call_volume ?? row.avg30_call_volume);
  const avgPut = n(row.avg_30_day_put_volume ?? row.avg30_put_volume);

  const totalVol = callVolume + putVolume;
  const pcr = callVolume > 0 ? putVolume / callVolume : 0;
  const callShare = totalVol > 0 ? callVolume / totalVol : 0;
  const putShare = totalVol > 0 ? putVolume / totalVol : 0;
  const { sentiment, reason } = label(pcr);

  return new Response(JSON.stringify({
    ticker,
    call_volume: callVolume,
    put_volume: putVolume,
    call_premium: callPremium,
    put_premium: putPremium,
    put_call_ratio: +pcr.toFixed(3),
    call_share: +callShare.toFixed(3),
    put_share: +putShare.toFixed(3),
    avg_30d_call_volume: avgCall,
    avg_30d_put_volume: avgPut,
    sentiment,
    reason,
    as_of: row.date ?? row.trade_date ?? null,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
