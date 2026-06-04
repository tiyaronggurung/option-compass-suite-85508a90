// Institutional 5-component scoring engine.
// Each component returns 0..100. Missing API key → neutral 50 + "not configured".
// The final blended score is weighted, clamped 0..100, then optionally adjusted
// by the market regime (capped at ±5 points). No live orders, paper-only.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

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

export type ScoringResult = {
  final: number;            // 0..100 after regime adjust
  base: number;             // pre-regime
  regime_adjust: number;    // signed, ±5 max
  regime: string | null;
  components: Record<ComponentKey, ComponentScore>;
  sources_used: string[];
  reasons: string[];
};

export const WEIGHTS: Record<ComponentKey, number> = {
  options_flow: 0.30,
  technical:    0.25,
  news:         0.20,
  sentiment:    0.15,
  volatility:   0.10,
};

const FINVIZ_KEY  = Deno.env.get("FINVIZ_API_KEY") ?? "";
const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const APIFY_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? "";

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

// ---------- Finviz (technical confirmation) ----------
async function finvizSnapshot(ticker: string): Promise<any | null> {
  if (!FINVIZ_KEY) return null;
  try {
    // Finviz Elite "quote" endpoint
    const url = `https://elite.finviz.com/quote_export.ashx?t=${ticker}&auth=${FINVIZ_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length < 20) return null;
    // CSV: header, data
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const headers = lines[0].split(",").map((s) => s.replace(/^"|"$/g, ""));
    const values = lines[1].split(",").map((s) => s.replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  } catch { return null; }
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
async function scoreNews(ticker: string, direction: "CALL" | "PUT"): Promise<ComponentScore> {
  if (!FINNHUB_KEY) return neutral("finnhub", "Finnhub key not configured");
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/news-sentiment?symbol=${ticker}&token=${FINNHUB_KEY}`;
    const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const [sentRes, newsRes] = await Promise.all([fetch(url), fetch(newsUrl)]);
    if (!sentRes.ok) return { score: 50, configured: true, source: "finnhub", reason: `HTTP ${sentRes.status}` };
    const sent = await sentRes.json();
    const news = newsRes.ok ? await newsRes.json() : [];
    const bullish = Number(sent?.sentiment?.bullishPercent ?? 0);
    const bearish = Number(sent?.sentiment?.bearishPercent ?? 0);
    const articles = Array.isArray(news) ? news.length : 0;
    const directional = direction === "CALL" ? bullish - bearish : bearish - bullish; // -1..1
    const sentimentScore = clamp100(50 + directional * 50);
    const volumeBoost = Math.min(20, articles); // up to +20 for active coverage
    const score = clamp100(sentimentScore * 0.8 + (50 + volumeBoost) * 0.2);
    return {
      score,
      configured: true,
      source: "finnhub",
      reason: `${articles} articles · sentiment ${(bullish * 100).toFixed(0)}% bull / ${(bearish * 100).toFixed(0)}% bear`,
      details: { bullish, bearish, article_count: articles },
    };
  } catch (e) {
    return { score: 50, configured: true, source: "finnhub", reason: `error: ${(e as Error).message.slice(0, 80)}` };
  }
}

// ---------- Apify (X/Twitter sentiment) ----------
async function scoreSentiment(ticker: string, direction: "CALL" | "PUT"): Promise<ComponentScore> {
  if (!APIFY_TOKEN) return neutral("apify", "Apify token not configured");
  try {
    // Lightweight key-value check — assumes user has a saved dataset with $TICKER aggregates.
    // Reads the most recent dataset item; if none exists, returns neutral.
    const url = `https://api.apify.com/v2/key-value-stores/x_sentiment/records/${ticker}?token=${APIFY_TOKEN}`;
    const res = await fetch(url);
    if (res.status === 404) {
      return { score: 50, configured: true, source: "apify", reason: "no sentiment data for ticker yet" };
    }
    if (!res.ok) {
      return { score: 50, configured: true, source: "apify", reason: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const bullish = Number(data?.bullish_pct ?? 0);
    const bearish = Number(data?.bearish_pct ?? 0);
    const mentions = Number(data?.mentions ?? 0);
    const directional = direction === "CALL" ? bullish - bearish : bearish - bullish;
    const sentimentScore = clamp100(50 + directional * 50);
    const velocityBoost = Math.min(20, Math.log10(mentions + 1) * 10);
    const score = clamp100(sentimentScore * 0.7 + (50 + velocityBoost) * 0.3);
    return {
      score,
      configured: true,
      source: "apify",
      reason: `${mentions} mentions · ${(bullish * 100).toFixed(0)}% bull`,
      details: { bullish, bearish, mentions },
    };
  } catch (e) {
    return { score: 50, configured: true, source: "apify", reason: `error: ${(e as Error).message.slice(0, 80)}` };
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
  const [optionsFlow, technical, news, sentiment, volatility, regime] = await Promise.all([
    scoreOptionsFlow(ticker, direction),
    scoreTechnical(ticker, baseTrendScore),
    scoreNews(ticker, direction),
    scoreSentiment(ticker, direction),
    scoreVolatility(ticker),
    getRegime(admin),
  ]);

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

  return { final: Math.round(final), base: Math.round(base), regime_adjust: adj, regime: regimeName, components, sources_used, reasons };
}

export function tierFor(confidence: number): "elite" | "strong" | "watchlist" | "rejected" {
  if (confidence >= 90) return "elite";
  if (confidence >= 80) return "strong";
  if (confidence >= 70) return "watchlist";
  return "rejected";
}
