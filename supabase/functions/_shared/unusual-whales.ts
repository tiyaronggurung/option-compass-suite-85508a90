// Unusual Whales client + Options Flow adapter.
// Safe-by-design: never throws into scoring. All failures classify and degrade.
// Used ONLY to power Options Flow (30% weight). Does not touch Tradier paths,
// scoring weights, tier thresholds, scanner gate, or hidden flag logic.

const UW_KEY = Deno.env.get("UNUSUAL_WHALES_API_KEY") ?? "";
const UW_BASE = "https://api.unusualwhales.com/api";

export type UWState =
  | "active"
  | "missing_key"
  | "auth_failed"
  | "rate_limited"
  | "degraded";

export type UWFetchResult = {
  state: UWState;
  status?: number;
  data?: any;
  error?: string;
  ms?: number;
};

export async function uwFetch(path: string, timeoutMs = 8000): Promise<UWFetchResult> {
  if (!UW_KEY) return { state: "missing_key", error: "UNUSUAL_WHALES_API_KEY not configured" };
  const url = path.startsWith("http") ? path : `${UW_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${UW_KEY}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    const ms = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => "");
      return { state: "auth_failed", status: res.status, error: t.slice(0, 200), ms };
    }
    if (res.status === 429) {
      return { state: "rate_limited", status: 429, error: "rate limited", ms };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { state: "degraded", status: res.status, error: t.slice(0, 200), ms };
    }
    const json = await res.json().catch(() => null);
    if (!json) return { state: "degraded", status: res.status, error: "invalid json", ms };
    return { state: "active", status: res.status, data: json, ms };
  } catch (e) {
    return { state: "degraded", error: (e as Error).message.slice(0, 200), ms: Date.now() - t0 };
  }
}

// ---------- Options Flow scoring via UW ----------

export type UWFlowScore = {
  score: number;            // 0..100 (50 = neutral)
  state: UWState;
  source: "unusual_whales";
  reason_code: string;
  human_reason: string;
  bullish_premium: number;
  bearish_premium: number;
  net_premium_bias: number;    // -1..+1
  call_put_bias: number;       // call_premium / put_premium ratio (capped)
  ask_side_premium: number;
  bid_side_premium: number;
  sweep_count: number;
  block_count: number;
  unusual_volume_count: number;
  largest_flows: Array<{
    ticker?: string;
    type?: string;
    side?: string;
    premium?: number;
    strike?: number | string;
    expiry?: string;
    is_sweep?: boolean;
    is_block?: boolean;
  }>;
  raw_summary?: Record<string, unknown>;
};

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Score Options Flow for a ticker using Unusual Whales flow-alerts.
 * Direction-aware: CALL rewards bullish ask-side call premium / sweeps;
 * PUT rewards bearish ask-side put premium / sweeps.
 */
export async function scoreOptionsFlowUnusualWhales(
  ticker: string,
  direction: "CALL" | "PUT",
): Promise<UWFlowScore> {
  const neutral = (state: UWState, reason_code: string, human_reason: string): UWFlowScore => ({
    score: 50,
    state,
    source: "unusual_whales",
    reason_code,
    human_reason,
    bullish_premium: 0,
    bearish_premium: 0,
    net_premium_bias: 0,
    call_put_bias: 1,
    ask_side_premium: 0,
    bid_side_premium: 0,
    sweep_count: 0,
    block_count: 0,
    unusual_volume_count: 0,
    largest_flows: [],
  });

  if (!UW_KEY) return neutral("missing_key", "uw_missing_key", "Unusual Whales API key not configured");

  // Primary: flow-alerts endpoint (ticker-scoped, returns recent unusual flow events).
  const r = await uwFetch(`/stock/${encodeURIComponent(ticker)}/flow-alerts?limit=200`);
  if (r.state !== "active") {
    return neutral(r.state, `uw_${r.state}`, `Unusual Whales ${r.state}${r.error ? `: ${r.error}` : ""}`);
  }

  // UW commonly returns { data: [...] }
  const rows: any[] = Array.isArray(r.data?.data) ? r.data.data
    : Array.isArray(r.data) ? r.data
    : Array.isArray(r.data?.flow_alerts) ? r.data.flow_alerts
    : [];

  if (rows.length === 0) {
    return neutral("active", "uw_no_flow", `No unusual flow detected for ${ticker} on Unusual Whales`);
  }

  let callPremium = 0, putPremium = 0;
  let askPremium = 0, bidPremium = 0;
  let bullishPremium = 0, bearishPremium = 0;
  let sweeps = 0, blocks = 0, unusual = 0;

  // Normalize per real UW flow-alerts schema:
  //   type: "call"|"put", total_premium, total_ask_side_prem, total_bid_side_prem,
  //   has_sweep, has_floor (block-ish), volume_oi_ratio, alert_rule, strike, expiry
  const normalized = rows.map((row) => {
    const type = String(row.type ?? row.option_type ?? "").toLowerCase();
    const isCall = type === "call" || type === "c";
    const isPut = type === "put" || type === "p";
    const totalPrem = num(row.total_premium ?? row.premium);
    const askPrem = num(row.total_ask_side_prem ?? row.ask_side_premium);
    const bidPrem = num(row.total_bid_side_prem ?? row.bid_side_premium);
    const isSweep = !!(row.has_sweep ?? row.is_sweep ?? row.sweep);
    const isBlock = !!(row.has_floor ?? row.is_block ?? row.block);
    const volOiRatio = num(row.volume_oi_ratio);
    const isUnusual = volOiRatio > 0.5
      || String(row.alert_rule ?? "").toLowerCase().includes("unusual")
      || String(row.alert_rule ?? "").toLowerCase().includes("repeatedhits");

    if (isCall) callPremium += totalPrem;
    if (isPut) putPremium += totalPrem;
    askPremium += askPrem;
    bidPremium += bidPrem;

    // Bullish / bearish premium using actual ask/bid split per row:
    //   bullish = call premium on ask  +  put premium on bid
    //   bearish = put  premium on ask  +  call premium on bid
    if (isCall) { bullishPremium += askPrem; bearishPremium += bidPrem; }
    if (isPut)  { bearishPremium += askPrem; bullishPremium += bidPrem; }

    if (isSweep) sweeps++;
    if (isBlock) blocks++;
    if (isUnusual) unusual++;

    // Determine dominant side for display
    const side = askPrem > bidPrem ? "ask" : bidPrem > askPrem ? "bid" : "mixed";

    return {
      ticker: row.ticker ?? row.underlying ?? ticker,
      type: isCall ? "call" : isPut ? "put" : type,
      side,
      premium: totalPrem,
      strike: row.strike ?? row.strike_price,
      expiry: row.expiry ?? row.expiration,
      is_sweep: isSweep,
      is_block: isBlock,
    };
  });

  const totalPremium = bullishPremium + bearishPremium;
  const netBias = totalPremium > 0 ? (bullishPremium - bearishPremium) / totalPremium : 0; // -1..+1
  const callPutBias = putPremium > 0 ? callPremium / putPremium : (callPremium > 0 ? 5 : 1);

  // Direction-aware alignment: for CALL, positive netBias is good; for PUT, negative netBias is good.
  const aligned = direction === "CALL" ? netBias : -netBias; // -1..+1

  // Base from premium alignment (50 ± 35)
  let score = 50 + aligned * 35;

  // Sweep/block bonus — aligned sweeps boost, opposing sweeps drag.
  // Approximate alignment using direction vs the bullish/bearish premium dominance.
  const directionDominant = direction === "CALL" ? bullishPremium > bearishPremium : bearishPremium > bullishPremium;
  const sweepBoost = directionDominant ? Math.min(10, sweeps * 0.8) : -Math.min(6, sweeps * 0.5);
  const blockBoost = directionDominant ? Math.min(6, blocks * 1.0) : -Math.min(4, blocks * 0.6);
  const unusualBoost = directionDominant ? Math.min(6, unusual * 0.5) : 0;

  score += sweepBoost + blockBoost + unusualBoost;

  // Magnitude floor: very small premium → pull toward neutral.
  if (totalPremium < 50_000) score = 50 + (score - 50) * 0.3;
  else if (totalPremium < 250_000) score = 50 + (score - 50) * 0.6;

  score = clamp(Math.round(score), 0, 100);

  const largest = [...normalized].sort((a, b) => b.premium - a.premium).slice(0, 5);

  const fmtUsd = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K`
    : `$${n.toFixed(0)}`;

  const humanReason =
    `UW ${rows.length} flow events · ${fmtUsd(bullishPremium)} bullish vs ${fmtUsd(bearishPremium)} bearish · ` +
    `C/P bias ${callPutBias.toFixed(2)}x · ${sweeps} sweeps · ${blocks} blocks`;

  const reasonCode =
    aligned >= 0.4 ? `uw_strong_${direction.toLowerCase()}_flow`
    : aligned >= 0.15 ? `uw_aligned_${direction.toLowerCase()}_flow`
    : aligned <= -0.4 ? `uw_opposing_${direction.toLowerCase()}_flow`
    : "uw_mixed_flow";

  return {
    score,
    state: "active",
    source: "unusual_whales",
    reason_code: reasonCode,
    human_reason: humanReason,
    bullish_premium: Math.round(bullishPremium),
    bearish_premium: Math.round(bearishPremium),
    net_premium_bias: +netBias.toFixed(3),
    call_put_bias: +clamp(callPutBias, 0, 99).toFixed(2),
    ask_side_premium: Math.round(askPremium),
    bid_side_premium: Math.round(bidPremium),
    sweep_count: sweeps,
    block_count: blocks,
    unusual_volume_count: unusual,
    largest_flows: largest,
    raw_summary: { rows: rows.length, totalPremium: Math.round(totalPremium) },
  };
}

export const UW_CONFIGURED = !!UW_KEY;
