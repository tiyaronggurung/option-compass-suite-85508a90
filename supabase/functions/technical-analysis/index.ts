// POST /functions/v1/technical-analysis
// Body: { ticker: string, force?: boolean }
// Returns: { ok, cached, snapshot: { ticker, computed_at, indicators, verdict, tech_score, reasons } }
//
// Pulls ~250 daily bars from Alpaca, computes RSI/MACD/EMA/Bollinger/ATR/support/resistance/volume,
// derives a verdict (bullish/neutral/bearish) + numeric score in [-100, +100], caches for 15min.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { detectCandlePatterns, summarizeCandles, type CandleMatch } from "../_shared/candlePatterns.ts";
import { detectChartPatterns, computeExpectedMove, patternsToScore } from "../_shared/chartPatterns.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";
const CACHE_TTL_MS = 15 * 60 * 1000;

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };

async function fetchDailyBars(symbol: string, days = 400): Promise<Bar[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?` + new URLSearchParams({
    timeframe: "1Day",
    start: start.toISOString(),
    end: end.toISOString(),
    limit: "500",
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

// ---------- Indicator math ----------
function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(NaN); continue; }
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += values[j];
      prev = s / period;
      out.push(prev);
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  }
  return out;
}

function macd(closes: number[]) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) => (isNaN(e12[i]) || isNaN(e26[i])) ? NaN : e12[i] - e26[i]);
  // signal line = EMA9 of macd line (filter NaN start)
  const valid = line.filter(v => !isNaN(v));
  const sigValid = ema(valid, 9);
  const signal: number[] = new Array(closes.length).fill(NaN);
  let k = 0;
  for (let i = 0; i < line.length; i++) {
    if (!isNaN(line[i])) {
      signal[i] = sigValid[k];
      k++;
    }
  }
  const hist = line.map((v, i) => (isNaN(v) || isNaN(signal[i])) ? NaN : v - signal[i]);
  return { line, signal, hist };
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: number[] = [], lower: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(NaN); lower.push(NaN); continue; }
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
  }
  return { mid, upper, lower };
}

function atr(bars: Bar[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { tr.push(bars[i].h - bars[i].l); continue; }
    const prev = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prev), Math.abs(bars[i].l - prev)));
  }
  // Wilder smoothing
  const out: number[] = new Array(bars.length).fill(NaN);
  if (tr.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

function supportResistance(bars: Bar[], lookback = 50) {
  const slice = bars.slice(-lookback);
  let hi = -Infinity, lo = Infinity;
  for (const b of slice) {
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
  }
  return { resistance: hi, support: lo };
}

function pickLast(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) if (!isNaN(arr[i])) return arr[i];
  return NaN;
}

// ---------- Verdict ----------
function buildVerdict(bars: Bar[]) {
  const closes = bars.map(b => b.c);
  const vols = bars.map(b => b.v);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const ema20 = pickLast(e20), ema50 = pickLast(e50), ema200 = pickLast(e200);
  const ema50Prev = e50[e50.length - 6] ?? ema50; // 5-bar slope
  const ema50Slope = ema50 && ema50Prev ? (ema50 - ema50Prev) / ema50Prev : 0;

  const rsiArr = rsi(closes, 14);
  const rsiVal = pickLast(rsiArr);

  const macdRes = macd(closes);
  const macdLine = pickLast(macdRes.line);
  const macdSig = pickLast(macdRes.signal);
  const macdHist = pickLast(macdRes.hist);
  const macdHistPrev = macdRes.hist[macdRes.hist.length - 2] ?? macdHist;
  const macdRising = !isNaN(macdHist) && !isNaN(macdHistPrev) && macdHist > macdHistPrev;

  const boll = bollinger(closes, 20, 2);
  const bbUpper = pickLast(boll.upper), bbLower = pickLast(boll.lower), bbMid = pickLast(boll.mid);
  const bbPctB = (bbUpper && bbLower && bbUpper !== bbLower) ? (last - bbLower) / (bbUpper - bbLower) : 0.5;

  const atrArr = atr(bars, 14);
  const atrVal = pickLast(atrArr);
  const atrPct = last ? (atrVal / last) * 100 : 0;

  const sr = supportResistance(bars, 50);
  const distToSupport = last ? ((last - sr.support) / last) * 100 : 0;
  const distToResistance = last ? ((sr.resistance - last) / last) * 100 : 0;

  const avgVol20 = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const lastVol = vols[vols.length - 1] ?? 0;
  const volRatio = avgVol20 ? lastVol / avgVol20 : 1;
  const up = last >= prev;

  // ---- Scoring ----
  let score = 0;
  const reasons: { label: string; pts: number; bullish: boolean }[] = [];

  // Trend stack
  if (last > ema20 && ema20 > ema50 && ema50 > ema200) {
    score += 25; reasons.push({ label: "Price above all EMAs (20>50>200)", pts: 25, bullish: true });
  } else if (last < ema20 && ema20 < ema50 && ema50 < ema200) {
    score -= 25; reasons.push({ label: "Price below all EMAs (20<50<200)", pts: -25, bullish: false });
  } else if (last > ema50) {
    score += 8; reasons.push({ label: "Price above EMA50", pts: 8, bullish: true });
  } else if (last < ema50) {
    score -= 8; reasons.push({ label: "Price below EMA50", pts: -8, bullish: false });
  }

  // EMA50 slope
  if (ema50Slope > 0.002) { score += 10; reasons.push({ label: "EMA50 sloping up", pts: 10, bullish: true }); }
  else if (ema50Slope < -0.002) { score -= 10; reasons.push({ label: "EMA50 sloping down", pts: -10, bullish: false }); }

  // Golden / death cross (recent)
  const e50Now = e50[e50.length - 1], e200Now = e200[e200.length - 1];
  const e50Then = e50[e50.length - 21], e200Then = e200[e200.length - 21];
  if (!isNaN(e50Then) && !isNaN(e200Then)) {
    if (e50Then <= e200Then && e50Now > e200Now) { score += 12; reasons.push({ label: "Recent golden cross", pts: 12, bullish: true }); }
    if (e50Then >= e200Then && e50Now < e200Now) { score -= 12; reasons.push({ label: "Recent death cross", pts: -12, bullish: false }); }
  }

  // RSI
  if (!isNaN(rsiVal)) {
    if (rsiVal >= 50 && rsiVal <= 70) { score += 12; reasons.push({ label: `RSI ${rsiVal.toFixed(1)} (bullish zone)`, pts: 12, bullish: true }); }
    else if (rsiVal < 50 && rsiVal >= 30) { score -= 12; reasons.push({ label: `RSI ${rsiVal.toFixed(1)} (bearish zone)`, pts: -12, bullish: false }); }
    else if (rsiVal > 70) { score -= 5; reasons.push({ label: `RSI ${rsiVal.toFixed(1)} (overbought)`, pts: -5, bullish: false }); }
    else if (rsiVal < 30) { score += 5; reasons.push({ label: `RSI ${rsiVal.toFixed(1)} (oversold)`, pts: 5, bullish: true }); }
  }

  // MACD
  if (!isNaN(macdHist)) {
    if (macdHist > 0 && macdRising) { score += 15; reasons.push({ label: "MACD histogram positive & rising", pts: 15, bullish: true }); }
    else if (macdHist > 0) { score += 7; reasons.push({ label: "MACD histogram positive", pts: 7, bullish: true }); }
    else if (macdHist < 0 && !macdRising) { score -= 15; reasons.push({ label: "MACD histogram negative & falling", pts: -15, bullish: false }); }
    else if (macdHist < 0) { score -= 7; reasons.push({ label: "MACD histogram negative", pts: -7, bullish: false }); }
  }

  // Bollinger %B
  if (bbPctB > 1) { score -= 5; reasons.push({ label: "Above upper Bollinger (stretched)", pts: -5, bullish: false }); }
  else if (bbPctB < 0) { score += 5; reasons.push({ label: "Below lower Bollinger (oversold)", pts: 5, bullish: true }); }
  else if (bbPctB > 0.6) { score += 5; reasons.push({ label: "Upper Bollinger half", pts: 5, bullish: true }); }
  else if (bbPctB < 0.4) { score -= 5; reasons.push({ label: "Lower Bollinger half", pts: -5, bullish: false }); }

  // Volume
  if (volRatio >= 1.5 && up) { score += 10; reasons.push({ label: `Volume ${volRatio.toFixed(1)}× avg on up day`, pts: 10, bullish: true }); }
  else if (volRatio >= 1.5 && !up) { score -= 10; reasons.push({ label: `Volume ${volRatio.toFixed(1)}× avg on down day`, pts: -10, bullish: false }); }

  // Proximity to S/R
  const nearSupport = distToSupport < 2 && distToSupport >= 0;
  const nearResistance = distToResistance < 2 && distToResistance >= 0;
  if (nearSupport) { score += 5; reasons.push({ label: "Near 50-day support", pts: 5, bullish: true }); }
  if (nearResistance) { score -= 5; reasons.push({ label: "Near 50-day resistance", pts: -5, bullish: false }); }

  // Candlestick patterns (last 5 bars)
  const candleMatches: CandleMatch[] = detectCandlePatterns(bars, 5);
  const candleSummary = summarizeCandles(candleMatches);
  for (const m of candleMatches) {
    // Only the last 2 bars influence scoring; older ones are informational.
    const recency = bars.length - 1 - m.bar_index;
    if (recency > 1 || m.bias === "neutral") continue;
    const atKey = (m.bias === "bullish" && nearSupport) || (m.bias === "bearish" && nearResistance);
    const base = m.kind === "reversal" ? (atKey ? 15 : 8) : m.kind === "continuation" ? 5 : 0;
    const pts = (m.bias === "bullish" ? 1 : -1) * base * (m.strength / 3);
    if (pts === 0) continue;
    const rounded = Math.round(pts);
    score += rounded;
    reasons.push({
      label: `Candle: ${m.name}${atKey ? (m.bias === "bullish" ? " at support" : " at resistance") : ""}`,
      pts: rounded,
      bullish: rounded > 0,
    });
  }

  // Clamp
  if (score > 100) score = 100;
  if (score < -100) score = -100;

  const verdict = score >= 30 ? "bullish" : score <= -30 ? "bearish" : "neutral";

  return {
    verdict,
    tech_score: Math.round(score),
    reasons,
    indicators: {
      price: last,
      ema20, ema50, ema200,
      ema50_slope_pct: +(ema50Slope * 100).toFixed(3),
      rsi14: isNaN(rsiVal) ? null : +rsiVal.toFixed(2),
      macd: {
        line: isNaN(macdLine) ? null : +macdLine.toFixed(4),
        signal: isNaN(macdSig) ? null : +macdSig.toFixed(4),
        hist: isNaN(macdHist) ? null : +macdHist.toFixed(4),
        rising: macdRising,
      },
      bollinger: { upper: bbUpper, mid: bbMid, lower: bbLower, percent_b: +bbPctB.toFixed(3) },
      atr14: isNaN(atrVal) ? null : +atrVal.toFixed(3),
      atr_pct: +atrPct.toFixed(2),
      support: sr.support,
      resistance: sr.resistance,
      dist_to_support_pct: +distToSupport.toFixed(2),
      dist_to_resistance_pct: +distToResistance.toFixed(2),
      avg_volume_20: Math.round(avgVol20),
      last_volume: lastVol,
      volume_ratio: +volRatio.toFixed(2),
    },
    candles: {
      matches: candleMatches,
      summary: candleSummary,
    },
    bars_used: bars.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const tickerRaw = String(body?.ticker ?? "").trim().toUpperCase();
    const force = !!body?.force;
    if (!tickerRaw || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(tickerRaw)) {
      return new Response(JSON.stringify({ error: "valid ticker required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!ALPACA_KEY || !ALPACA_SECRET) {
      return new Response(JSON.stringify({ error: "Alpaca credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Cache lookup
    if (!force) {
      const { data: cached } = await supabase
        .from("technical_snapshots")
        .select("*")
        .eq("ticker", tickerRaw)
        .maybeSingle();
      if (cached && Date.now() - new Date(cached.computed_at).getTime() < CACHE_TTL_MS) {
        return new Response(JSON.stringify({ ok: true, cached: true, snapshot: cached }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const bars = await fetchDailyBars(tickerRaw, 400);
    if (bars.length < 60) {
      return new Response(JSON.stringify({ error: "Not enough price history", bars: bars.length }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = buildVerdict(bars);

    const recentBars = bars.slice(-200).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    const fullPayload = { ...payload, recent_bars: recentBars };

    const { data: saved } = await supabase
      .from("technical_snapshots")
      .upsert(
        { ticker: tickerRaw, payload: fullPayload, computed_at: new Date().toISOString() },
        { onConflict: "ticker" },
      )
      .select()
      .maybeSingle();

    return new Response(JSON.stringify({ ok: true, cached: false, snapshot: saved ?? { ticker: tickerRaw, payload: fullPayload, computed_at: new Date().toISOString() } }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("technical-analysis error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
