// POST /functions/v1/intraday-analysis
// Body: { ticker: string, force?: boolean }
//
// Pulls today's 5-min bars from Tradier, computes intraday structure for
// 0DTE / same-day decision-making:
//   - VWAP
//   - Opening Range (first 30 min after 9:30 ET)
//   - Session high / low
//   - 5m EMA(9) / EMA(21) / EMA cross
//   - RSI(14) on 5m
//   - Time-of-day risk (theta-decay warning post-14:00 ET)
//   - Intraday verdict (bullish/bearish/neutral) + score in [-100, +100]
//
// Cached in-memory ~60s per ticker. NEVER touches the daily technical-analysis
// function, scanner, scoring, or paper-trading code paths.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const CACHE_TTL_MS = 60_000;

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };

const cache = new Map<string, { at: number; payload: any }>();

// ---------- Tradier timesales ----------
async function fetchIntradayBars(symbol: string): Promise<Bar[]> {
  // Tradier returns timestamps in US/Eastern. Ask for 5-min bars across the
  // last 3 calendar days (covers weekends / overnight). We'll filter to the
  // latest session client-side.
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 86400000);
  const fmt = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day} 00:00`;
  };
  const url = `https://api.tradier.com/v1/markets/timesales?` + new URLSearchParams({
    symbol,
    interval: "5min",
    start: fmt(start),
    end: fmt(end),
    session_filter: "open",
  });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`tradier_${res.status}`);
  const json = await res.json();
  const raw = json?.series?.data;
  const arr: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr
    .filter((r) => r && r.time)
    .map((r) => ({
      t: String(r.time),
      o: Number(r.open),
      h: Number(r.high),
      l: Number(r.low),
      c: Number(r.close),
      v: Number(r.volume ?? 0),
    }))
    .filter((b) => Number.isFinite(b.o) && Number.isFinite(b.c));
}

// ---------- Math helpers ----------
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

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function pickLast(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) if (!isNaN(arr[i])) return arr[i];
  return NaN;
}

// ---------- Session slicing ----------
// Tradier `time` values look like "2025-06-22T09:30:00" already in ET.
function dateKeyOf(t: string): string {
  return t.slice(0, 10);
}

function minutesIntoSession(t: string): number {
  // Bars come on the 5-min grid starting 09:30 ET.
  const hm = t.slice(11, 16);
  const [h, m] = hm.split(":").map(Number);
  return (h - 9) * 60 + (m - 30);
}

// ---------- Verdict ----------
function buildIntradayPayload(bars: Bar[]) {
  if (bars.length === 0) {
    throw new Error("no intraday bars");
  }
  // Latest session only.
  const lastKey = dateKeyOf(bars[bars.length - 1].t);
  const session = bars.filter((b) => dateKeyOf(b.t) === lastKey);
  if (session.length === 0) throw new Error("empty session");

  const closes = session.map((b) => b.c);
  const last = closes[closes.length - 1];

  // VWAP across session
  let pv = 0, vv = 0;
  for (const b of session) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    vv += b.v;
  }
  const vwap = vv > 0 ? pv / vv : last;

  // Opening Range — first 30 min (6 × 5-min bars from session start)
  const orBars = session.filter((b) => minutesIntoSession(b.t) < 30);
  const orHigh = orBars.length ? Math.max(...orBars.map((b) => b.h)) : NaN;
  const orLow = orBars.length ? Math.min(...orBars.map((b) => b.l)) : NaN;

  // Session H/L
  const sessHigh = Math.max(...session.map((b) => b.h));
  const sessLow = Math.min(...session.map((b) => b.l));

  // EMAs on 5m closes
  const ema9 = pickLast(ema(closes, 9));
  const ema21 = pickLast(ema(closes, 21));

  // RSI on 5m closes
  const rsi14 = rsi(closes, 14);

  // Time of day (ET) from last bar
  const lastTime = session[session.length - 1].t;
  const [hh, mm] = lastTime.slice(11, 16).split(":").map(Number);
  const minutesET = hh * 60 + mm;
  // Standard cash session: 9:30-16:00 ET
  const sessionMinutes = Math.max(0, Math.min(390, minutesET - 9 * 60 - 30));
  const sessionPct = sessionMinutes / 390;
  let timeRisk: "low" | "medium" | "high" = "low";
  if (sessionPct > 0.85) timeRisk = "high";
  else if (sessionPct > 0.65) timeRisk = "medium";

  // ---- Scoring ----
  let score = 0;
  const reasons: { label: string; pts: number; bullish: boolean }[] = [];

  // Price vs VWAP
  if (last > vwap) {
    score += 20; reasons.push({ label: `Price above VWAP ($${vwap.toFixed(2)})`, pts: 20, bullish: true });
  } else if (last < vwap) {
    score -= 20; reasons.push({ label: `Price below VWAP ($${vwap.toFixed(2)})`, pts: -20, bullish: false });
  }

  // Opening Range break
  if (!isNaN(orHigh) && !isNaN(orLow)) {
    if (last > orHigh) {
      score += 20; reasons.push({ label: `Above opening range ($${orHigh.toFixed(2)})`, pts: 20, bullish: true });
    } else if (last < orLow) {
      score -= 20; reasons.push({ label: `Below opening range ($${orLow.toFixed(2)})`, pts: -20, bullish: false });
    } else {
      reasons.push({ label: `Inside opening range ($${orLow.toFixed(2)}–$${orHigh.toFixed(2)})`, pts: 0, bullish: false });
    }
  }

  // EMA cross
  if (!isNaN(ema9) && !isNaN(ema21)) {
    if (ema9 > ema21 && last > ema9) {
      score += 15; reasons.push({ label: "5m EMA9 > EMA21, price above EMA9", pts: 15, bullish: true });
    } else if (ema9 < ema21 && last < ema9) {
      score -= 15; reasons.push({ label: "5m EMA9 < EMA21, price below EMA9", pts: -15, bullish: false });
    }
  }

  // RSI extremes
  if (!isNaN(rsi14)) {
    if (rsi14 > 70) {
      score -= 8; reasons.push({ label: `5m RSI ${rsi14.toFixed(1)} (overbought)`, pts: -8, bullish: false });
    } else if (rsi14 < 30) {
      score += 8; reasons.push({ label: `5m RSI ${rsi14.toFixed(1)} (oversold)`, pts: 8, bullish: true });
    } else if (rsi14 >= 55) {
      score += 5; reasons.push({ label: `5m RSI ${rsi14.toFixed(1)} (bullish)`, pts: 5, bullish: true });
    } else if (rsi14 <= 45) {
      score -= 5; reasons.push({ label: `5m RSI ${rsi14.toFixed(1)} (bearish)`, pts: -5, bullish: false });
    }
  }

  // Time-of-day risk (deduction for 0DTE plays late in the day)
  if (timeRisk === "high") {
    score = Math.round(score * 0.6);
    reasons.push({ label: "Late-day theta crush — size down", pts: 0, bullish: false });
  } else if (timeRisk === "medium") {
    score = Math.round(score * 0.8);
    reasons.push({ label: "Afternoon session — theta accelerating", pts: 0, bullish: false });
  }

  if (score > 100) score = 100;
  if (score < -100) score = -100;
  const verdict = score >= 25 ? "bullish" : score <= -25 ? "bearish" : "neutral";

  return {
    verdict,
    intraday_score: Math.round(score),
    reasons,
    indicators: {
      price: last,
      vwap: +vwap.toFixed(3),
      vwap_dist_pct: +(((last - vwap) / vwap) * 100).toFixed(2),
      opening_range_high: isNaN(orHigh) ? null : +orHigh.toFixed(2),
      opening_range_low: isNaN(orLow) ? null : +orLow.toFixed(2),
      session_high: +sessHigh.toFixed(2),
      session_low: +sessLow.toFixed(2),
      ema9_5m: isNaN(ema9) ? null : +ema9.toFixed(3),
      ema21_5m: isNaN(ema21) ? null : +ema21.toFixed(3),
      rsi14_5m: isNaN(rsi14) ? null : +rsi14.toFixed(2),
    },
    time_of_day: {
      last_bar_et: lastTime,
      session_pct: +sessionPct.toFixed(3),
      risk: timeRisk,
    },
    session_date: lastKey,
    bars_used: session.length,
    recent_bars: session.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
  };
}

// ---------- HTTP handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const ticker = String(body?.ticker ?? "").trim().toUpperCase();
    const force = !!body?.force;
    if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
      return new Response(JSON.stringify({ error: "valid ticker required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!TRADIER_KEY) {
      return new Response(JSON.stringify({ error: "Tradier credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cached = cache.get(ticker);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ok: true, cached: true, payload: cached.payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bars = await fetchIntradayBars(ticker);
    if (bars.length < 6) {
      return new Response(JSON.stringify({ error: "Not enough intraday history", bars: bars.length }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const payload = buildIntradayPayload(bars);
    cache.set(ticker, { at: Date.now(), payload });

    return new Response(JSON.stringify({ ok: true, cached: false, payload }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("intraday-analysis error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
