// Institutional 5-component scoring engine.
// Each component returns 0..100. Missing API key → neutral 50 + "not configured".
// The final blended score is weighted, clamped 0..100, then optionally adjusted
// by the market regime (capped at ±5 points). No live orders, paper-only.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  fetchFinvizExtrasForTicker,
  type FinvizExtras,
  type InsiderSummary,
  type FinvizNewsSummary,
  type SectorPerf,
} from "./finviz-extras.ts";
import { scoreOptionsFlowUnusualWhales, UW_CONFIGURED } from "./unusual-whales.ts";
import { scoreSocialIntelligence } from "./social-intel.ts";
import { TAPI_CONFIGURED } from "./twitterapi.ts";

export type ComponentKey =
  | "options_flow"
  | "technical"
  | "news"
  | "sentiment"
  | "volatility";

export type ComponentScore = {
  score: number;            // 0..100
  configured: boolean;
  source: string;           // primary source label
  reason: string;
  details?: Record<string, unknown>;
};

export type ProviderStatus = {
  provider: string;
  role: string;            // what this provider currently powers
  state:
    | "active"
    | "reserved"
    | "missing_key"
    | "auth_failed"
    | "not_entitled"
    | "degraded";
  detail?: string;
  note?: string;
};

export type ScoringResult = {
  final: number;            // 0..100 after regime adjust
  base: number;             // pre-regime
  regime_adjust: number;    // signed, ±5 max
  regime: string | null;
  components: Record<ComponentKey, ComponentScore>;
  sources_used: string[];
  reasons: string[];
  provider_status: ProviderStatus[];
};

export const WEIGHTS: Record<ComponentKey, number> = {
  options_flow: 0.25,
  technical:    0.35,
  news:         0.25,
  sentiment:    0.05,
  volatility:   0.10,
};

const FINVIZ_KEY  = Deno.env.get("FINVIZ_API_KEY") ?? "";
const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const APIFY_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? "";
const ALPACA_KEY_ID = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";

// ---------- Trendline analysis (sub-signal inside Technical) ----------
type DailyBar = { t: string; o: number; h: number; l: number; c: number; v: number };

async function fetchDailyBars(ticker: string, days = 60): Promise<DailyBar[] | null> {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) return null;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - (days + 20) * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeframe: "1Day",
      start: start.toISOString(),
      end: end.toISOString(),
      limit: "200",
      adjustment: "raw",
      feed: "iex",
    });
    const res = await fetch(`https://data.alpaca.markets/v2/stocks/${ticker}/bars?${params}`, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY_ID, "APCA-API-SECRET-KEY": ALPACA_SECRET },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const bars = (data?.bars ?? []) as DailyBar[];
    return bars.length ? bars : null;
  } catch { return null; }
}

function linreg(ys: number[]): { slope: number; intercept: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += ys[i]; sumXY += i * ys[i]; sumXX += i * i; }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  return { slope, intercept: (sumY - slope * sumX) / n };
}

type TrendlineWindow = {
  window: number;
  support_line_now: number;
  resistance_line_now: number;
  support_dir: "rising" | "falling" | "flat";
  resistance_dir: "rising" | "falling" | "flat";
};

function analyzeWindow(bars: DailyBar[], window: number): TrendlineWindow | null {
  if (bars.length < window) return null;
  const slice = bars.slice(-window);
  const sup = linreg(slice.map(b => b.l));
  const res = linreg(slice.map(b => b.h));
  const n = window - 1;
  const avgPrice = slice.reduce((s, b) => s + b.c, 0) / slice.length || 1;
  const flat = avgPrice * 0.0005;
  const dirOf = (slope: number): "rising" | "falling" | "flat" =>
    slope > flat ? "rising" : slope < -flat ? "falling" : "flat";
  return {
    window,
    support_line_now: sup.intercept + sup.slope * n,
    resistance_line_now: res.intercept + res.slope * n,
    support_dir: dirOf(sup.slope),
    resistance_dir: dirOf(res.slope),
  };
}

export type TrendlineResult = {
  trendline_signal:
    | "bullish_breakout" | "bullish_bounce"
    | "bearish_breakdown" | "bearish_rejection"
    | "none" | "insufficient_data";
  trendline_direction: "bullish" | "bearish" | "neutral";
  support_line: number | null;
  resistance_line: number | null;
  breakout_confirmed: boolean;
  volume_confirmed: boolean;
  reason_code: string;
  human_reason: string;
  adjustment: number;
  window_used: number | null;
};

function detectTrendlines(bars: DailyBar[] | null, direction: "CALL" | "PUT"): TrendlineResult {
  if (!bars || bars.length < 20) {
    return {
      trendline_signal: "insufficient_data",
      trendline_direction: "neutral",
      support_line: null, resistance_line: null,
      breakout_confirmed: false, volume_confirmed: false,
      reason_code: "trendline_insufficient_candles",
      human_reason: "", adjustment: 0, window_used: null,
    };
  }
  const w20 = analyzeWindow(bars, 20);
  const w50 = analyzeWindow(bars, 50);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const close = last.c;
  const prevClose = prev?.c ?? close;
  const vols = bars.slice(-20).map(b => b.v);
  const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length || 1;
  const relVol = last.v / avgVol;
  const volumeConfirmed = relVol >= 1.5;
  const tol = close * 0.005;

  const evaluate = (w: TrendlineWindow): TrendlineResult | null => {
    const sup = w.support_line_now;
    const resv = w.resistance_line_now;
    const volBonus = volumeConfirmed ? 2 : 0;
    if (prevClose <= resv + tol && close > resv && w.resistance_dir !== "rising") {
      return {
        trendline_signal: "bullish_breakout", trendline_direction: "bullish",
        support_line: +sup.toFixed(2), resistance_line: +resv.toFixed(2),
        breakout_confirmed: true, volume_confirmed: volumeConfirmed,
        reason_code: "bullish_breakout_above_resistance",
        human_reason: `Bullish breakout above ${w.resistance_dir} resistance (${w.window}d)${volumeConfirmed ? " with volume confirmation" : ""}.`,
        adjustment: 5 + volBonus, window_used: w.window,
      };
    }
    if (prevClose >= sup - tol && close < sup && w.support_dir !== "falling") {
      return {
        trendline_signal: "bearish_breakdown", trendline_direction: "bearish",
        support_line: +sup.toFixed(2), resistance_line: +resv.toFixed(2),
        breakout_confirmed: true, volume_confirmed: volumeConfirmed,
        reason_code: "bearish_breakdown_below_support",
        human_reason: `Bearish breakdown below ${w.support_dir} support (${w.window}d)${volumeConfirmed ? " with volume confirmation" : ""}.`,
        adjustment: -5 - volBonus, window_used: w.window,
      };
    }
    if (w.support_dir === "rising" && Math.abs(close - sup) <= tol * 2 && close >= prevClose) {
      return {
        trendline_signal: "bullish_bounce", trendline_direction: "bullish",
        support_line: +sup.toFixed(2), resistance_line: +resv.toFixed(2),
        breakout_confirmed: false, volume_confirmed: volumeConfirmed,
        reason_code: "bullish_bounce_from_rising_support",
        human_reason: `Bullish bounce from rising support (${w.window}d)${volumeConfirmed ? " with volume confirmation" : ""}.`,
        adjustment: 3 + volBonus, window_used: w.window,
      };
    }
    if (w.resistance_dir === "falling" && Math.abs(close - resv) <= tol * 2 && close <= prevClose) {
      return {
        trendline_signal: "bearish_rejection", trendline_direction: "bearish",
        support_line: +sup.toFixed(2), resistance_line: +resv.toFixed(2),
        breakout_confirmed: false, volume_confirmed: volumeConfirmed,
        reason_code: "bearish_rejection_at_falling_resistance",
        human_reason: `Bearish rejection at falling resistance (${w.window}d)${volumeConfirmed ? " with volume confirmation" : ""}.`,
        adjustment: -3 - volBonus, window_used: w.window,
      };
    }
    return null;
  };

  const hit = (w20 && evaluate(w20)) || (w50 && evaluate(w50));
  if (hit) {
    // Direction flip: bullish helps CALL / hurts PUT; bearish helps PUT / hurts CALL.
    const aligned =
      (hit.trendline_direction === "bullish" && direction === "CALL") ||
      (hit.trendline_direction === "bearish" && direction === "PUT");
    const mag = Math.abs(hit.adjustment);
    return { ...hit, adjustment: aligned ? mag : -mag };
  }
  const w = w20 ?? w50!;
  return {
    trendline_signal: "none", trendline_direction: "neutral",
    support_line: +w.support_line_now.toFixed(2),
    resistance_line: +w.resistance_line_now.toFixed(2),
    breakout_confirmed: false, volume_confirmed: volumeConfirmed,
    reason_code: "no_trendline_event",
    human_reason: "", adjustment: 0, window_used: w.window,
  };
}



function clamp100(v: number) { return Math.max(0, Math.min(100, v)); }
function neutral(source: string, reason = "not configured"): ComponentScore {
  return { score: 50, configured: false, source, reason };
}

// ---------- Tradier (options flow + volatility) ----------
async function tradierChain(ticker: string): Promise<any | null> {
  if (!TRADIER_KEY) return null;
  try {
    // Nearest expiry within 14-45 DTE
    const expRes = await fetch(
      `https://api.tradier.com/v1/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`,
      { headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" } },
    );
    if (!expRes.ok) return null;
    const expData = await expRes.json();
    const dates: string[] = expData?.expirations?.date ?? [];
    const now = Date.now();
    const target = dates.find((d) => {
      const dte = Math.floor((+new Date(d) - now) / 86400000);
      return dte >= 14 && dte <= 45;
    }) ?? dates[0];
    if (!target) return null;
    const chainRes = await fetch(
      `https://api.tradier.com/v1/markets/options/chains?symbol=${ticker}&expiration=${target}&greeks=true`,
      { headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" } },
    );
    if (!chainRes.ok) return null;
    const data = await chainRes.json();
    return data?.options?.option ?? null;
  } catch { return null; }
}

async function scoreOptionsFlow(ticker: string, direction: "CALL" | "PUT"): Promise<ComponentScore> {
  if (!TRADIER_KEY) return neutral("tradier", "Tradier key not configured");
  const chain = await tradierChain(ticker);
  if (!chain || !Array.isArray(chain) || chain.length === 0) {
    return { score: 50, configured: true, source: "tradier", reason: "no chain data" };
  }
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const o of chain) {
    const v = Number(o.volume ?? 0);
    const oi = Number(o.open_interest ?? 0);
    if (o.option_type === "call") { callVol += v; callOI += oi; }
    else if (o.option_type === "put") { putVol += v; putOI += oi; }
  }
  const totalVol = callVol + putVol;
  if (totalVol === 0) return { score: 50, configured: true, source: "tradier", reason: "no volume yet today" };
  const callShare = callVol / totalVol;        // 0..1
  const volOIRatio = (callVol + putVol) / Math.max(1, callOI + putOI);
  // Bullish flow = high call share; bearish = high put share.
  const directional = direction === "CALL" ? callShare : (1 - callShare);
  // Boost when volume/OI suggests fresh positioning.
  const freshness = Math.min(1, volOIRatio / 0.5); // 50% v/oi → max
  const raw = directional * 70 + freshness * 30;
  const score = clamp100(raw);
  return {
    score,
    configured: true,
    source: "tradier",
    reason: `Calls ${callVol.toLocaleString()} vs Puts ${putVol.toLocaleString()} · V/OI ${volOIRatio.toFixed(2)}`,
    details: { call_volume: callVol, put_volume: putVol, call_oi: callOI, put_oi: putOI },
  };
}

async function scoreVolatility(ticker: string): Promise<ComponentScore> {
  if (!TRADIER_KEY) return neutral("tradier", "Tradier key not configured");
  const chain = await tradierChain(ticker);
  if (!chain || !Array.isArray(chain) || chain.length === 0) {
    return { score: 50, configured: true, source: "tradier", reason: "no chain data" };
  }
  // Average mid IV from greeks; tight spreads = liquid = higher score.
  let ivSum = 0, ivCount = 0, spreadSum = 0, spreadCount = 0;
  for (const o of chain) {
    const iv = Number(o?.greeks?.mid_iv ?? o?.greeks?.bid_iv ?? 0);
    if (iv > 0 && iv < 5) { ivSum += iv; ivCount++; }
    const bid = Number(o.bid ?? 0), ask = Number(o.ask ?? 0);
    if (bid > 0 && ask > 0) {
      spreadSum += (ask - bid) / ((ask + bid) / 2);
      spreadCount++;
    }
  }
  const avgIv = ivCount > 0 ? ivSum / ivCount : 0;
  const avgSpread = spreadCount > 0 ? spreadSum / spreadCount : 1;
  // Lower spread = better. 5% spread → 100, 50% → 0.
  const liquidity = clamp100(100 - (avgSpread * 200));
  // IV bucket — 30-60% is the sweet spot for options trades.
  const ivScore = avgIv > 0
    ? clamp100(100 - Math.abs(avgIv - 0.45) * 200)
    : 50;
  const score = clamp100(liquidity * 0.5 + ivScore * 0.5);
  return {
    score,
    configured: true,
    source: "tradier",
    reason: `IV ${(avgIv * 100).toFixed(0)}% · spread ${(avgSpread * 100).toFixed(1)}%`,
    details: { avg_iv: +avgIv.toFixed(4), avg_spread: +avgSpread.toFixed(4) },
  };
}

// ---------- Finviz options flow + volatility (ACTIVE) ----------
// Aggregate-level only — not per-contract sweep detail.
// Uses the same finvizSnapshot() CSV row already fetched for technical scoring.
async function scoreOptionsFlowFinviz(
  ticker: string,
  direction: "CALL" | "PUT",
  fv: { row: Record<string, string> | null; state: string; reason: string; detail?: string },
  insider?: InsiderSummary | null,
): Promise<ComponentScore> {
  if (fv.state !== "ok" || !fv.row) {
    return {
      score: 50,
      configured: fv.state !== "missing_key",
      source: "finviz",
      reason: `${fv.reason}${fv.detail ? ` (${fv.detail})` : ""}`,
      details: { finviz_state: fv.state, fallback: "neutral_50" },
    };
  }
  const snap = fv.row;
  const optionable = (snap["Optionable"] ?? "").trim().toLowerCase() === "yes";
  if (!optionable) {
    return { score: 40, configured: true, source: "finviz", reason: "Underlying not optionable per Finviz" };
  }
  const relVol = parseFloat(snap["Rel Volume"] ?? "1") || 1;
  const shortFloat = parsePct(snap["Short Float"]) ?? 0;
  const recom = parseFloat(snap["Recom"] ?? "3") || 3;
  const perfWeek = parsePct(snap["Perf Week"]) ?? 0;

  const analystDir = clamp100(((3 - recom) / 2 + 1) * 50);
  const shortBoost = direction === "CALL"
    ? Math.min(20, shortFloat * 0.8)
    : Math.min(15, shortFloat * 0.5);
  const volSurge = clamp100(50 + (relVol - 1) * 30);
  const moveAligned = direction === "CALL" ? perfWeek : -perfWeek;
  const moveScore = clamp100(50 + moveAligned * 2);
  const analystAligned = direction === "CALL" ? analystDir : (100 - analystDir);

  const raw = volSurge * 0.40 + analystAligned * 0.30 + moveScore * 0.20 + shortBoost;
  let score = clamp100(raw);

  // Sub-signal: insider trading nudge (capped ±6, sub-signal inside options_flow)
  let insiderNudge = 0;
  let insiderNote = "";
  if (insider && insider.rows > 0) {
    // ratio 0.5 = neutral; >0.5 = more buys, <0.5 = more sells
    const skew = insider.buy_sell_ratio - 0.5;     // -0.5..+0.5
    const aligned = direction === "CALL" ? skew : -skew;
    insiderNudge = Math.max(-6, Math.min(6, aligned * 12));
    score = clamp100(score + insiderNudge);
    insiderNote = ` · Insider ${insider.buys}B/${insider.sells}S`;
  }

  return {
    score,
    configured: true,
    source: insider && insider.rows > 0 ? "finviz+insider" : "finviz",
    reason: `RelVol ${relVol.toFixed(1)}x · Recom ${recom.toFixed(1)} · ShortFloat ${shortFloat.toFixed(1)}% · Week ${perfWeek.toFixed(1)}%${insiderNote}`,
    details: {
      rel_volume: relVol,
      analyst_recom: recom,
      short_float_pct: shortFloat,
      perf_week_pct: perfWeek,
      insider_buys: insider?.buys ?? null,
      insider_sells: insider?.sells ?? null,
      insider_net_value_usd: insider?.net_value_usd ?? null,
      insider_nudge: insiderNudge,
      note: "Aggregate-level proxy (Finviz) + insider sub-signal. Per-contract flow requires Tradier/UW.",
    },
  };
}

async function scoreVolatilityFinviz(
  ticker: string,
  fv: { row: Record<string, string> | null; state: string; reason: string; detail?: string },
): Promise<ComponentScore> {
  if (fv.state !== "ok" || !fv.row) {
    return {
      score: 50,
      configured: fv.state !== "missing_key",
      source: "finviz",
      reason: `${fv.reason}${fv.detail ? ` (${fv.detail})` : ""}`,
      details: { finviz_state: fv.state, fallback: "neutral_50" },
    };
  }
  const snap = fv.row;
  const volStr = snap["Volatility"] ?? "";
  const matches = volStr.match(/-?\d+(\.\d+)?/g) ?? [];
  const volWeek = matches[0] ? parseFloat(matches[0]) : 0;
  const volMonth = matches[1] ? parseFloat(matches[1]) : volWeek;
  const atr = parseFloat(snap["ATR"] ?? "0") || 0;
  const price = parseFloat(snap["Price"] ?? "0") || 0;
  const atrPct = price > 0 ? (atr / price) * 100 : 0;

  const hv = (volWeek + volMonth) / 2 || atrPct;
  const ivScore = hv > 0 ? clamp100(100 - Math.abs(hv - 3) * 25) : 50;
  const atrScore = clamp100(50 + Math.min(30, atrPct * 8));
  const score = clamp100(ivScore * 0.7 + atrScore * 0.3);
  return {
    score,
    configured: true,
    source: "finviz",
    reason: `HV ~${hv.toFixed(1)}% · ATR ${atrPct.toFixed(1)}% of price`,
    details: {
      vol_week_pct: volWeek,
      vol_month_pct: volMonth,
      atr,
      atr_pct_of_price: +atrPct.toFixed(2),
      note: "Realized-vol proxy (Finviz). True IV requires Tradier chain.",
    },
  };
}

// ---------- Finviz (technical confirmation) ----------
async function finvizSnapshot(ticker: string): Promise<any | null> {
  // LEGACY — preserved for the dormant scoreTechnical() Tradier-era code path.
  // Active code path uses finvizSnapshotChecked() below.
  if (!FINVIZ_KEY) return null;
  try {
    const url = `https://elite.finviz.com/quote_export.ashx?t=${ticker}&auth=${FINVIZ_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length < 20) return null;
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const headers = lines[0].split(",").map((s) => s.replace(/^"|"$/g, ""));
    const values = lines[1].split(",").map((s) => s.replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  } catch { return null; }
}

// ---------- Finviz defensive fetch (ACTIVE) ----------
// Detects HTML/upsell/login/empty responses so scoring never parses garbage.
export type FinvizState =
  | "ok"
  | "missing_key"
  | "auth_failed"
  | "not_entitled"
  | "html_response"
  | "empty"
  | "missing_fields"
  | "http_error"
  | "fetch_error";

const FINVIZ_REASONS: Record<FinvizState, string> = {
  ok:              "finviz_ok",
  missing_key:     "finviz_key_not_configured",
  auth_failed:     "finviz_auth_failed_or_not_entitled",
  not_entitled:    "finviz_export_endpoint_unavailable",
  html_response:   "finviz_returned_html_instead_of_csv",
  empty:           "finviz_empty_response",
  missing_fields:  "finviz_csv_missing_expected_fields",
  http_error:      "finviz_http_error",
  fetch_error:     "finviz_fetch_error",
};

const EXPECTED_FIELDS = ["Ticker", "Price", "SMA50", "SMA200", "Rel Volume"];

export type FinvizSnap = {
  row: Record<string, string> | null;
  state: FinvizState;
  reason: string;
  detail?: string;
};

export async function finvizSnapshotChecked(ticker: string): Promise<FinvizSnap> {
  if (!FINVIZ_KEY) return { row: null, state: "missing_key", reason: FINVIZ_REASONS.missing_key };
  let res: Response;
  // Screener export endpoint returns snapshot fields. v=152 + explicit c= column list
  // gives us all the fields scoring expects (Ticker, Price, SMA50, SMA200, Rel Volume, ATR,
  // Volatility, Recom, Short Float, Perf Week, Sector, Optionable, etc.).
  // Previous URL (quote_export.ashx) was returning historical OHLCV bars on this plan.
  const FINVIZ_COLS = "0,1,2,3,4,5,6,7,30,42,43,44,45,46,47,48,49,50,51,52,53,54,59,62,63,64,65,66,67,68,69,87";
  const url = `https://elite.finviz.com/export.ashx?v=152&t=${ticker}&c=${FINVIZ_COLS}&auth=${FINVIZ_KEY}`;
  try {
    res = await fetch(url); // default redirect: follow
  } catch (e) {
    return { row: null, state: "fetch_error", reason: FINVIZ_REASONS.fetch_error, detail: (e as Error).message.slice(0, 120) };
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = (res.url ?? "").toLowerCase();
  if (!res.ok) {
    return { row: null, state: "http_error", reason: FINVIZ_REASONS.http_error, detail: `HTTP ${res.status}` };
  }
  const text = await res.text();
  if (!text || text.trim().length < 20) {
    return { row: null, state: "empty", reason: FINVIZ_REASONS.empty };
  }
  const head = text.slice(0, 500).toLowerCase();

  // Upsell / non-entitled redirect (confirmed by finviz-debug probe).
  if (finalUrl.includes("utm_campaign=quote-export") || finalUrl.includes("finviz.com/elite")) {
    return { row: null, state: "not_entitled", reason: FINVIZ_REASONS.not_entitled, detail: "redirected to Elite upsell page" };
  }
  if (head.includes("login") && contentType.includes("text/html")) {
    return { row: null, state: "auth_failed", reason: FINVIZ_REASONS.auth_failed, detail: "login page returned" };
  }
  if (contentType.includes("text/html") || head.includes("<!doctype html") || head.includes("<html")) {
    return { row: null, state: "html_response", reason: FINVIZ_REASONS.html_response, detail: `content-type: ${contentType || "unknown"}` };
  }

  const lines = text.trim().split("\n");
  if (lines.length < 2) {
    return { row: null, state: "empty", reason: FINVIZ_REASONS.empty, detail: "CSV header only" };
  }
  // CSV parser that handles quoted fields containing commas (e.g. company names).
  const splitCsv = (line: string): string[] => {
    const out: string[] = [];
    let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = splitCsv(lines[0]);
  const values = splitCsv(lines[1]);
  const rawRow: Record<string, string> = {};
  headers.forEach((h, i) => { rawRow[h] = values[i] ?? ""; });

  // Header alias map: Finviz export.ashx returns long-form column names. Map them to
  // the short keys the scoring code already reads. Pure data normalization — no math change.
  const HEADER_ALIASES: Record<string, string> = {
    "Performance (Week)":             "Perf Week",
    "Performance (Month)":            "Perf Month",
    "50-Day Simple Moving Average":   "SMA50",
    "200-Day Simple Moving Average":  "SMA200",
    "20-Day Simple Moving Average":   "SMA20",
    "Relative Volume":                "Rel Volume",
    "Average True Range":             "ATR",
    "Volatility (Week)":              "Volatility W",
    "Volatility (Month)":             "Volatility M",
    "Analyst Recom":                  "Recom",
    "Recommendation":                 "Recom",
  };
  const row: Record<string, string> = { ...rawRow };
  for (const [long, short] of Object.entries(HEADER_ALIASES)) {
    if (long in rawRow && !(short in row)) row[short] = rawRow[long];
  }
  // Synthesize combined "Volatility" string ("W M") to match legacy snapshot field.
  if (!row["Volatility"] && (row["Volatility W"] || row["Volatility M"])) {
    row["Volatility"] = `${row["Volatility W"] ?? ""} ${row["Volatility M"] ?? ""}`.trim();
  }
  // Optionable is not in export.ashx; default to "yes" for all listed equities (Finviz
  // only returns rows for tradable tickers anyway). Preserves prior scoring behavior.
  if (!("Optionable" in row)) row["Optionable"] = "yes";

  const missing = EXPECTED_FIELDS.filter((f) => !(f in row));
  if (missing.length > 0) {
    return { row: null, state: "missing_fields", reason: FINVIZ_REASONS.missing_fields, detail: `missing: ${missing.join(", ")}` };
  }
  return { row, state: "ok", reason: FINVIZ_REASONS.ok };
}

function parsePct(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function scoreTechnical(
  ticker: string,
  baseTrendScore: number, // -1..1 from local Alpaca trend
): Promise<ComponentScore> {
  // Local Alpaca trend always contributes (-1..1 → 0..100)
  const localScore = clamp100((baseTrendScore + 1) * 50);
  if (!FINVIZ_KEY) {
    return {
      score: localScore,
      configured: false,
      source: "alpaca",
      reason: `Alpaca trend ${baseTrendScore >= 0 ? "+" : ""}${baseTrendScore.toFixed(2)} · Finviz not configured`,
    };
  }
  const snap = await finvizSnapshot(ticker);
  if (!snap) {
    return { score: localScore, configured: true, source: "alpaca+finviz", reason: "Finviz unreachable" };
  }
  const perfWeek = parsePct(snap["Perf Week"]) ?? 0;
  const sma50 = parsePct(snap["SMA50"]) ?? 0;
  const sma200 = parsePct(snap["SMA200"]) ?? 0;
  const relVol = parseFloat(snap["Rel Volume"] ?? "1") || 1;
  // Finviz contribution: above SMA50 & SMA200 = bullish, RelVol > 1.5 = strong move
  const finvizTrend = clamp100(50 + sma50 * 2 + sma200 + perfWeek * 1.5);
  const finvizVol = clamp100(50 + (relVol - 1) * 25);
  const finvizScore = clamp100(finvizTrend * 0.7 + finvizVol * 0.3);
  const blended = clamp100(localScore * 0.5 + finvizScore * 0.5);
  return {
    score: blended,
    configured: true,
    source: "alpaca+finviz",
    reason: `SMA50 ${sma50.toFixed(1)}% · SMA200 ${sma200.toFixed(1)}% · RelVol ${relVol.toFixed(1)}x`,
    details: { perf_week: perfWeek, sma50, sma200, rel_volume: relVol },
  };
}

// ---------- Finnhub (news + analyst) ----------
async function scoreNews(
  ticker: string,
  direction: "CALL" | "PUT",
  finvizNews?: FinvizNewsSummary | null,
): Promise<ComponentScore> {
  if (!FINNHUB_KEY) {
    // Even without Finnhub, fall back to finviz news volume if available.
    if (finvizNews && finvizNews.count_7d > 0) {
      const volumeBoost = Math.min(20, finvizNews.count_7d);
      const score = clamp100(50 + volumeBoost);
      const headlines = (finvizNews.headlines ?? []).slice(0, 5).map((h) => ({
        headline: h.slice(0, 200), source: "finviz" as const,
      }));
      return {
        score,
        configured: true,
        source: "finviz_news",
        reason: `Finnhub missing · Finviz ${finvizNews.count_24h}/24h · ${finvizNews.count_7d}/7d`,
        details: {
          finviz_news_24h: finvizNews.count_24h,
          finviz_news_7d: finvizNews.count_7d,
          article_count: finvizNews.count_7d,
          reason_code: finvizNews.count_7d >= 20 ? "volume_cap_hit_20_articles" : "volume_only_below_cap",
          top_headlines: headlines,
          finnhub_sentiment_403: false,
          finviz_fallback_active: true,
        },
      };
    }
    return neutral("finnhub", "Finnhub key not configured");
  }
  // Finnhub free tier: `company-news` works, `news-sentiment` is paid-only (403 on free).
  // Strategy: probe both; if news-sentiment 403s we still use company-news for volume,
  // and merge Finviz headlines as a sub-signal. If company-news also fails, fall back
  // entirely to Finviz news. Math (sentimentScore * 0.8 + volume * 0.2) is unchanged.
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/news-sentiment?symbol=${ticker}&token=${FINNHUB_KEY}`;
    const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const [sentRes, newsRes] = await Promise.all([fetch(url), fetch(newsUrl)]);

    const sentimentOk = sentRes.ok;
    const sent = sentimentOk ? await sentRes.json().catch(() => null) : null;
    if (!sentimentOk) { try { await sentRes.text(); } catch { /* drain */ } }

    const newsOk = newsRes.ok;
    const news = newsOk ? await newsRes.json().catch(() => []) : [];
    if (!newsOk) { try { await newsRes.text(); } catch { /* drain */ } }

    const finnhubArticles = Array.isArray(news) ? news.length : 0;

    // Sub-signal: merge Finviz headlines (dedupe by lowercased first 40 chars vs Finnhub).
    let extraCount = 0;
    if (finvizNews && finvizNews.headlines.length > 0) {
      const seen = new Set<string>(
        (Array.isArray(news) ? news : [])
          .map((n: any) => String(n?.headline ?? "").toLowerCase().slice(0, 40))
          .filter(Boolean),
      );
      for (const h of finvizNews.headlines) {
        const k = h.toLowerCase().slice(0, 40);
        if (k && !seen.has(k)) { seen.add(k); extraCount++; }
      }
    }
    const articles = finnhubArticles + extraCount;

    // Build merged top-5 headlines (Finnhub first, then Finviz extras), with source tag.
    // Transparency only — does NOT feed scoring math.
    const topHeadlines: Array<{ headline: string; source: "finnhub" | "finviz"; url?: string; datetime?: number }> = [];
    if (Array.isArray(news)) {
      for (const n of news) {
        if (topHeadlines.length >= 5) break;
        const h = String((n as any)?.headline ?? "").trim();
        if (!h) continue;
        topHeadlines.push({
          headline: h.slice(0, 200),
          source: "finnhub",
          url: typeof (n as any)?.url === "string" ? (n as any).url : undefined,
          datetime: typeof (n as any)?.datetime === "number" ? (n as any).datetime : undefined,
        });
      }
    }
    if (topHeadlines.length < 5 && finvizNews?.headlines?.length) {
      const seen = new Set(topHeadlines.map((t) => t.headline.toLowerCase().slice(0, 40)));
      for (const h of finvizNews.headlines) {
        if (topHeadlines.length >= 5) break;
        const k = h.toLowerCase().slice(0, 40);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        topHeadlines.push({ headline: h.slice(0, 200), source: "finviz" });
      }
    }

    // Case A: full path — sentiment endpoint worked, use blended formula.
    if (sentimentOk && sent) {
      const bullish = Number(sent?.sentiment?.bullishPercent ?? 0);
      const bearish = Number(sent?.sentiment?.bearishPercent ?? 0);
      const directional = direction === "CALL" ? bullish - bearish : bearish - bullish;
      const sentimentScore = clamp100(50 + directional * 50);
      const volumeBoost = Math.min(20, articles);
      const score = clamp100(sentimentScore * 0.8 + (50 + volumeBoost) * 0.2);
      return {
        score,
        configured: true,
        source: extraCount > 0 ? "finnhub+finviz_news" : "finnhub",
        reason: `${articles} articles${extraCount > 0 ? ` (+${extraCount} Finviz)` : ""} · sentiment ${(bullish * 100).toFixed(0)}% bull / ${(bearish * 100).toFixed(0)}% bear`,
        details: {
          bullish, bearish,
          article_count: articles,
          finnhub_articles: finnhubArticles,
          finviz_extra_articles: extraCount,
          finviz_news_24h: finvizNews?.count_24h ?? null,
          news_sentiment_endpoint: "ok",
          reason_code: articles >= 20 ? "blended_sentiment_volume_cap_hit" : "blended_sentiment_volume",
          top_headlines: topHeadlines,
          finnhub_sentiment_403: false,
          finviz_fallback_active: false,
        },
      };
    }

    // Case B: sentiment 403/failed but we have article coverage from company-news and/or Finviz.
    if (articles > 0) {
      const volumeBoost = Math.min(20, articles);
      const score = clamp100(50 + volumeBoost);
      const usingFinvizFallback = finnhubArticles === 0 && extraCount > 0;
      const sentEndpoint403 = sentRes.status === 403;
      return {
        score,
        configured: true,
        source: usingFinvizFallback
          ? "finviz_news"
          : (extraCount > 0 ? "finnhub_news+finviz_news" : "finnhub_news"),
        reason: `Sentiment ${sentRes.status} · ${articles} articles${extraCount > 0 ? ` (+${extraCount} Finviz)` : ""} · volume-only`,
        details: {
          article_count: articles,
          finnhub_articles: finnhubArticles,
          finviz_extra_articles: extraCount,
          finviz_news_24h: finvizNews?.count_24h ?? null,
          finviz_news_7d: finvizNews?.count_7d ?? null,
          news_sentiment_endpoint: `http_${sentRes.status}`,
          fallback_active: usingFinvizFallback ? "finnhub_403_finviz_news_fallback_active" : undefined,
          reason_code: articles >= 20 ? "volume_cap_hit_20_articles" : "volume_only_below_cap",
          top_headlines: topHeadlines,
          finnhub_sentiment_403: sentEndpoint403,
          finviz_fallback_active: extraCount > 0,
        },
      };
    }

    // Case C: everything failed/empty — neutral.
    return {
      score: 50,
      configured: true,
      source: "finnhub",
      reason: `Sentiment HTTP ${sentRes.status} · company-news HTTP ${newsRes.status} · no Finviz headlines`,
      details: {
        news_sentiment_endpoint: `http_${sentRes.status}`,
        company_news_endpoint: `http_${newsRes.status}`,
        reason_code: "no_news_neutral",
        top_headlines: [],
        finnhub_sentiment_403: sentRes.status === 403,
        finviz_fallback_active: false,
      },
    };
  } catch (e) {
    return { score: 50, configured: true, source: "finnhub", reason: `error: ${(e as Error).message.slice(0, 80)}` };
  }
}


// ---------- Sentiment (TwitterAPI.io Social Intelligence — primary) ----------
// Replaces prior Apify path. TwitterAPI.io powers a 4-subscore engine:
// polarity (40), mention velocity (25), KOL activity (20), engagement momentum (15).
// If TwitterAPI.io is unavailable → neutral 50 (preserves prior behavior).
async function scoreSentiment(ticker: string, direction: "CALL" | "PUT"): Promise<ComponentScore> {
  try {
    const si = await scoreSocialIntelligence(ticker, direction);
    return {
      score: si.score,
      configured: si.configured,
      source: si.source,
      reason: si.reason,
      details: si.details as unknown as Record<string, unknown>,
    };
  } catch (e) {
    return {
      score: 50,
      configured: TAPI_CONFIGURED,
      source: TAPI_CONFIGURED ? "twitterapi_io" : "neutral",
      reason: `sentiment error: ${(e as Error).message.slice(0, 80)}`,
      details: { source: "twitterapi_io", provider_status: "degraded", reason_code: "exception" },
    };
  }
}

// ---------- Regime adjustment (±5 cap) ----------
async function getRegime(admin: SupabaseClient): Promise<{ regime: string; vix: number | null } | null> {
  try {
    const { data } = await admin
      .from("market_regime").select("regime, vix_level").eq("id", "global").maybeSingle();
    if (!data) return null;
    return { regime: data.regime as string, vix: data.vix_level as number | null };
  } catch { return null; }
}

function regimeAdjust(regime: string | null, direction: "CALL" | "PUT"): number {
  if (!regime) return 0;
  if (regime === "bull")  return direction === "CALL" ? +5 : -5;
  if (regime === "bear")  return direction === "PUT"  ? +5 : -5;
  if (regime === "high_vol") return -3; // be more conservative
  return 0;
}

// ---------- Main entry ----------
export async function scoreInstitutional(
  admin: SupabaseClient,
  args: {
    ticker: string;
    direction: "CALL" | "PUT";
    baseTrendScore: number; // -1..1 from local scanner trend component
  },
): Promise<ScoringResult> {
  const { ticker, direction, baseTrendScore } = args;

  // Shared Finviz snapshot — single fetch powers technical + options flow + volatility.
  // finvizSnapshotChecked returns a typed state so we never parse HTML/upsell pages as CSV.
  // Finviz "extras" (insider/news/sector) are fetched in parallel; each degrades independently.
  const [fv, extras] = await Promise.all([
    finvizSnapshotChecked(ticker),
    fetchFinvizExtrasForTicker(ticker),
  ]);

  // Resolve sector context (best-effort: matches Finviz Sector field from the snapshot row)
  const sectorName = (fv.row?.["Sector"] ?? "").trim().toLowerCase();
  const sectorPerf: SectorPerf | null =
    extras.sectors.state === "ok" && extras.sectors.data && sectorName
      ? (extras.sectors.data[sectorName] ?? null)
      : null;

  // Options Flow priority: Unusual Whales (institutional) → Finviz (aggregate proxy) → neutral.
  // UW runs in parallel with the Finviz adapter so we always have the fallback ready and
  // can store side-by-side metadata for transparency. UW.state !== "active" → fallback used.
  const [uwFlow, finvizFlow, technical, news, sentiment, volatility, regime] = await Promise.all([
    UW_CONFIGURED ? scoreOptionsFlowUnusualWhales(ticker, direction) : Promise.resolve(null),
    scoreOptionsFlowFinviz(ticker, direction, fv, extras.insider.data),
    scoreTechnicalWithSnap(ticker, baseTrendScore, fv, sectorPerf, direction),
    scoreNews(ticker, direction, extras.news.data),
    scoreSentiment(ticker, direction),
    scoreVolatilityFinviz(ticker, fv),
    getRegime(admin),
  ]);

  // Build the unified options_flow ComponentScore.
  // Active UW → use UW score. UW failed/missing → use Finviz proxy. Both missing → neutral 50.
  let optionsFlow: ComponentScore;
  if (uwFlow && uwFlow.state === "active") {
    optionsFlow = {
      score: uwFlow.score,
      configured: true,
      source: "unusual_whales",
      reason: uwFlow.human_reason,
      details: {
        provider: "unusual_whales",
        provider_status: uwFlow.state,
        uw_score: uwFlow.score,
        finviz_fallback_score: finvizFlow.score,
        bullish_premium: uwFlow.bullish_premium,
        bearish_premium: uwFlow.bearish_premium,
        net_premium_bias: uwFlow.net_premium_bias,
        call_put_bias: uwFlow.call_put_bias,
        ask_side_premium: uwFlow.ask_side_premium,
        bid_side_premium: uwFlow.bid_side_premium,
        sweep_count: uwFlow.sweep_count,
        block_count: uwFlow.block_count,
        unusual_volume_count: uwFlow.unusual_volume_count,
        largest_flows: uwFlow.largest_flows,
        reason_code: uwFlow.reason_code,
        human_reason: uwFlow.human_reason,
        finviz_fallback_details: finvizFlow.details ?? null,
      },
    };
  } else {
    optionsFlow = {
      ...finvizFlow,
      details: {
        ...(finvizFlow.details ?? {}),
        provider: "finviz",
        provider_status: uwFlow ? `uw_${uwFlow.state}` : "uw_missing_key",
        uw_score: null,
        finviz_fallback_score: finvizFlow.score,
        uw_reason: uwFlow?.reason_code ?? "uw_missing_key",
      },
    };
  }


  const components: Record<ComponentKey, ComponentScore> = {
    options_flow: optionsFlow,
    technical,
    news,
    sentiment,
    volatility,
  };

  let base = 0;
  for (const k of Object.keys(WEIGHTS) as ComponentKey[]) {
    base += components[k].score * WEIGHTS[k];
  }
  base = clamp100(base);

  const regimeName = regime?.regime ?? null;
  const adj = Math.max(-5, Math.min(5, regimeAdjust(regimeName, direction)));
  const final = clamp100(base + adj);

  const sources_used = Array.from(new Set(
    Object.values(components).filter((c) => c.configured).map((c) => c.source),
  ));

  const reasons: string[] = [];
  for (const k of Object.keys(components) as ComponentKey[]) {
    const c = components[k];
    if (c.configured && c.score >= 65) reasons.push(`${k.replace("_", " ")}: ${c.reason}`);
  }
  if (regimeName && regimeName !== "sideways") {
    reasons.push(`Regime: ${regimeName} (${adj >= 0 ? "+" : ""}${adj} pts)`);
  }

  // Provider lifecycle metadata — surfaced in score_components.provider_status
  // Finviz state reflects the actual fetch result (active / auth_failed / not_entitled / etc.)
  const finvizProviderState: ProviderStatus["state"] =
    fv.state === "ok"            ? "active" :
    fv.state === "missing_key"   ? "missing_key" :
    fv.state === "auth_failed"   ? "auth_failed" :
    fv.state === "not_entitled"  ? "not_entitled" :
                                   "degraded";
  const provider_status: ProviderStatus[] = [
    {
      provider: "finviz",
      role: "options_flow + volatility + technical",
      state: finvizProviderState,
      detail: fv.state !== "ok" ? `${fv.reason}${fv.detail ? ` — ${fv.detail}` : ""}` : undefined,
      note: finvizProviderState === "active"
        ? "Aggregate-level options data only (no per-contract sweeps)."
        : "Finviz request did not return valid CSV — all 3 components fell back to neutral 50.",
    },
    {
      provider: "finviz_extras",
      role: "insider (options_flow sub) + news (news sub) + sectors (technical sub)",
      state: (extras.insider.state === "ok" || extras.news.state === "ok" || extras.sectors.state === "ok")
        ? "active"
        : (extras.insider.state === "missing_key" ? "missing_key" :
           extras.insider.state === "auth_failed" ? "auth_failed" :
           extras.insider.state === "not_entitled" ? "not_entitled" : "degraded"),
      detail: `insider:${extras.insider.state} · news:${extras.news.state} · sectors:${extras.sectors.state}`,
      note: "Sub-signals only — weights now 35/25/25/5/10. Each endpoint degrades independently.",
    },
    (() => {
      const nd = (news.details ?? {}) as Record<string, unknown>;
      const sentEp = String(nd.news_sentiment_endpoint ?? "");
      const fallback = String(nd.fallback_active ?? "");
      let state: ProviderStatus["state"] = FINNHUB_KEY ? "active" : "missing_key";
      let detail: string | undefined;
      if (FINNHUB_KEY && sentEp.startsWith("http_4")) {
        state = "degraded";
        detail = fallback || `news-sentiment ${sentEp} (paid endpoint) · using company-news + Finviz fallback`;
      }
      return { provider: "finnhub", role: "news + sentiment", state, detail };
    })(),
    (() => {
      const sd = (sentiment.details ?? {}) as Record<string, unknown>;
      const ps = String(sd.provider_status ?? "missing_key");
      let state: ProviderStatus["state"];
      let detail: string | undefined;
      if (!TAPI_CONFIGURED) {
        state = "missing_key";
        detail = "TWITTERAPI_IO_API_KEY not configured — Sentiment neutral 50";
      } else if (ps === "active") {
        state = "active";
        const samples = (sd.samples ?? {}) as Record<string, unknown>;
        detail = `Powering Sentiment (tweets=${samples.total_tweets ?? 0}, score=${Math.round(Number(sd.score ?? 50))})`;
      } else {
        state = ps === "auth_failed" ? "auth_failed" : "degraded";
        detail = `TwitterAPI.io ${ps} — Sentiment fell back to neutral 50`;
      }
      return {
        provider: "twitterapi_io",
        role: "sentiment (social intelligence — primary)",
        state,
        detail,
        note: "TwitterAPI.io + AI classifier power Sentiment; neutral 50 on failure.",
      };
    })(),
    {
      provider: "tradier",
      role: "options_flow + volatility (per-contract)",
      state: "reserved",
      note: "Reserved for future upgrade — code paths preserved, currently inactive.",
    },
    (() => {
      const ofDetails = (optionsFlow.details ?? {}) as Record<string, unknown>;
      const usingUW = optionsFlow.source === "unusual_whales";
      let state: ProviderStatus["state"];
      let detail: string | undefined;
      if (!UW_CONFIGURED) {
        state = "missing_key";
        detail = "UNUSUAL_WHALES_API_KEY not configured — Options Flow using Finviz proxy";
      } else if (usingUW) {
        state = "active";
        detail = `Powering Options Flow (uw_score=${ofDetails.uw_score})`;
      } else {
        const ps = String(ofDetails.provider_status ?? "uw_degraded");
        state = ps.includes("auth") ? "auth_failed" : ps.includes("rate") ? "degraded" : "degraded";
        detail = `UW unavailable (${ps}) — Options Flow fell back to Finviz proxy`;
      }
      return {
        provider: "unusual_whales",
        role: "options_flow (institutional flow — primary)",
        state,
        detail,
        note: "UW powers Options Flow when active; Finviz proxy is used as fallback.",
      };
    })(),

  ];

  return {
    final: Math.round(final),
    base: Math.round(base),
    regime_adjust: adj,
    regime: regimeName,
    components,
    sources_used,
    reasons,
    provider_status,
  };
}

// Variant of scoreTechnical that accepts the checked Finviz snapshot
// to avoid double-fetching when called from scoreInstitutional.
async function scoreTechnicalWithSnap(
  ticker: string,
  baseTrendScore: number,
  fv: { row: Record<string, string> | null; state: string; reason: string; detail?: string },
  sectorPerf?: SectorPerf | null,
  direction?: "CALL" | "PUT",
): Promise<ComponentScore> {
  const dir: "CALL" | "PUT" = direction ?? "CALL";
  const [bars] = await Promise.all([fetchDailyBars(ticker, 60)]);
  const tl = detectTrendlines(bars, dir);
  const tlNote = tl.human_reason ? ` · ${tl.human_reason}` : "";

  const localScore = clamp100((baseTrendScore + 1) * 50);
  if (fv.state === "missing_key") {
    return {
      score: clamp100(localScore + tl.adjustment),
      configured: false,
      source: "alpaca",
      reason: `Alpaca trend ${baseTrendScore >= 0 ? "+" : ""}${baseTrendScore.toFixed(2)} · Finviz not configured${tlNote}`,
      details: { trendline: tl },
    };
  }
  if (fv.state !== "ok" || !fv.row) {
    return {
      score: clamp100(localScore + tl.adjustment),
      configured: true,
      source: "alpaca",
      reason: `Alpaca-only (${fv.reason}${fv.detail ? `: ${fv.detail}` : ""})${tlNote}`,
      details: { finviz_state: fv.state, fallback: "alpaca_only", trendline: tl },
    };
  }
  const snap = fv.row;
  const perfWeek = parsePct(snap["Perf Week"]) ?? 0;
  const sma50 = parsePct(snap["SMA50"]) ?? 0;
  const sma200 = parsePct(snap["SMA200"]) ?? 0;
  const relVol = parseFloat(snap["Rel Volume"] ?? "1") || 1;
  const finvizTrend = clamp100(50 + sma50 * 2 + sma200 + perfWeek * 1.5);
  const finvizVol = clamp100(50 + (relVol - 1) * 25);
  const finvizScore = clamp100(finvizTrend * 0.7 + finvizVol * 0.3);
  let blended = clamp100(localScore * 0.5 + finvizScore * 0.5);

  let sectorNudge = 0;
  let sectorNote = "";
  if (sectorPerf && direction) {
    const aligned = direction === "CALL" ? sectorPerf.perf_week_pct : -sectorPerf.perf_week_pct;
    sectorNudge = Math.max(-3, Math.min(3, aligned * 0.6));
    blended = clamp100(blended + sectorNudge);
    sectorNote = ` · ${sectorPerf.sector} ${sectorPerf.perf_week_pct >= 0 ? "+" : ""}${sectorPerf.perf_week_pct.toFixed(1)}%/wk`;
  }

  // Trendline sub-signal (capped via clamp100). No weight change, no new component.
  blended = clamp100(blended + tl.adjustment);

  return {
    score: blended,
    configured: true,
    source: sectorPerf ? "alpaca+finviz+sector" : "alpaca+finviz",
    reason: `SMA50 ${sma50.toFixed(1)}% · SMA200 ${sma200.toFixed(1)}% · RelVol ${relVol.toFixed(1)}x${sectorNote}${tlNote}`,
    details: {
      perf_week: perfWeek, sma50, sma200, rel_volume: relVol,
      sector: sectorPerf?.sector ?? null,
      sector_perf_week_pct: sectorPerf?.perf_week_pct ?? null,
      sector_nudge: sectorNudge,
      trendline: tl,
    },
  };
}


export function tierFor(confidence: number): "elite" | "strong" | "watchlist" | "rejected" {
  if (confidence >= 90) return "elite";
  if (confidence >= 80) return "strong";
  if (confidence >= 70) return "watchlist";
  return "rejected";
}
