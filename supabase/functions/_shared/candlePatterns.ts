// Candlestick pattern detection on daily OHLC bars.
// All detectors operate on the trailing 1-5 bars and return a list of matches
// with bias (bullish/bearish/neutral), strength, and a short note.
//
// A "trend context" is computed from a short EMA slope so reversal patterns
// at the right location score higher than the same shape mid-range.

export type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };
export type Bias = "bullish" | "bearish" | "neutral";
export type PatternKind = "reversal" | "continuation" | "indecision";

export interface CandleMatch {
  name: string;
  bias: Bias;
  kind: PatternKind;
  strength: number;          // 1..3
  bar_index: number;         // index in the bars array (last bar of the pattern)
  bar_date: string;          // ISO date of last bar
  note: string;
}

// ---------- helpers ----------
const body = (b: Bar) => Math.abs(b.c - b.o);
const range = (b: Bar) => Math.max(1e-9, b.h - b.l);
const upperWick = (b: Bar) => b.h - Math.max(b.o, b.c);
const lowerWick = (b: Bar) => Math.min(b.o, b.c) - b.l;
const isBull = (b: Bar) => b.c > b.o;
const isBear = (b: Bar) => b.c < b.o;
const midpoint = (b: Bar) => (b.o + b.c) / 2;

function avgBody(bars: Bar[], end: number, n = 14): number {
  const start = Math.max(0, end - n);
  let s = 0, k = 0;
  for (let i = start; i < end; i++) { s += body(bars[i]); k++; }
  return k ? s / k : body(bars[end]);
}

function emaSlope(bars: Bar[], end: number, period = 20): number {
  const start = Math.max(0, end - period * 3);
  const closes = bars.slice(start, end + 1).map(b => b.c);
  if (closes.length < period + 5) return 0;
  const k = 2 / (period + 1);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const series: number[] = [prev];
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    series.push(prev);
  }
  if (series.length < 6) return 0;
  const a = series[series.length - 6], b = series[series.length - 1];
  return a ? (b - a) / a : 0;
}

function trendAt(bars: Bar[], idx: number): "up" | "down" | "side" {
  const s = emaSlope(bars, idx, 20);
  if (s > 0.005) return "up";
  if (s < -0.005) return "down";
  return "side";
}

// ---------- single-bar ----------
function detectSingle(bars: Bar[], i: number, avgB: number): CandleMatch[] {
  const b = bars[i];
  const r = range(b);
  const bo = body(b);
  const uw = upperWick(b);
  const lw = lowerWick(b);
  const t = trendAt(bars, i);
  const out: CandleMatch[] = [];
  const date = b.t;

  const tiny = bo <= 0.1 * r;
  const small = bo <= 0.3 * r;

  // Doji family
  if (tiny) {
    if (uw > 2 * bo && lw < 0.1 * r) {
      out.push({ name: "Gravestone Doji", bias: "bearish", kind: "reversal", strength: t === "up" ? 3 : 2, bar_index: i, bar_date: date, note: "Long upper wick, no lower wick — buyers rejected." });
    } else if (lw > 2 * bo && uw < 0.1 * r) {
      out.push({ name: "Dragonfly Doji", bias: "bullish", kind: "reversal", strength: t === "down" ? 3 : 2, bar_index: i, bar_date: date, note: "Long lower wick, no upper wick — sellers rejected." });
    } else if (uw > r * 0.4 && lw > r * 0.4) {
      out.push({ name: "Long-Legged Doji", bias: "neutral", kind: "indecision", strength: 2, bar_index: i, bar_date: date, note: "Wide range, tiny body — strong indecision." });
    } else {
      out.push({ name: "Doji", bias: "neutral", kind: "indecision", strength: 1, bar_index: i, bar_date: date, note: "Open ≈ close — indecision." });
    }
  }

  // Spinning top / High wave
  if (!tiny && small && uw > bo && lw > bo) {
    if (uw > 2 * bo && lw > 2 * bo) {
      out.push({ name: "High Wave", bias: "neutral", kind: "indecision", strength: 2, bar_index: i, bar_date: date, note: "Long wicks both sides — volatile indecision." });
    } else {
      out.push({ name: "Spinning Top", bias: "neutral", kind: "indecision", strength: 1, bar_index: i, bar_date: date, note: "Small body between two wicks." });
    }
  }

  // Marubozu (full body, ~no wicks)
  if (bo >= 0.9 * r && bo >= avgB) {
    if (isBull(b)) out.push({ name: "Bullish Marubozu", bias: "bullish", kind: "continuation", strength: 2, bar_index: i, bar_date: date, note: "Full-bodied bull bar — buyers in control." });
    else if (isBear(b)) out.push({ name: "Bearish Marubozu", bias: "bearish", kind: "continuation", strength: 2, bar_index: i, bar_date: date, note: "Full-bodied bear bar — sellers in control." });
  }

  // Hammer / Hanging Man (long lower wick, small body near top)
  if (lw >= 2 * bo && uw <= 0.2 * r && bo > 0.05 * r) {
    if (t === "down") {
      out.push({ name: "Hammer", bias: "bullish", kind: "reversal", strength: 3, bar_index: i, bar_date: date, note: "Long lower wick rejects lows after downtrend." });
    } else if (t === "up") {
      out.push({ name: "Hanging Man", bias: "bearish", kind: "reversal", strength: 2, bar_index: i, bar_date: date, note: "Long lower wick after uptrend — warning." });
    }
  }

  // Shooting Star / Inverted Hammer (long upper wick, small body near bottom)
  if (uw >= 2 * bo && lw <= 0.2 * r && bo > 0.05 * r) {
    if (t === "up") {
      out.push({ name: "Shooting Star", bias: "bearish", kind: "reversal", strength: 3, bar_index: i, bar_date: date, note: "Long upper wick rejects highs after uptrend." });
    } else if (t === "down") {
      out.push({ name: "Inverted Hammer", bias: "bullish", kind: "reversal", strength: 2, bar_index: i, bar_date: date, note: "Upper wick test of resistance after downtrend." });
    }
  }

  return out;
}

// ---------- two-bar ----------
function detectTwo(bars: Bar[], i: number, avgB: number): CandleMatch[] {
  if (i < 1) return [];
  const a = bars[i - 1], b = bars[i];
  const t = trendAt(bars, i - 1);
  const out: CandleMatch[] = [];
  const date = b.t;

  // Engulfing
  if (isBear(a) && isBull(b) && b.o <= a.c && b.c >= a.o && body(b) > body(a)) {
    out.push({ name: "Bullish Engulfing", bias: "bullish", kind: "reversal", strength: t === "down" ? 3 : 2, bar_index: i, bar_date: date, note: "Bull bar fully engulfs prior bear bar." });
  }
  if (isBull(a) && isBear(b) && b.o >= a.c && b.c <= a.o && body(b) > body(a)) {
    out.push({ name: "Bearish Engulfing", bias: "bearish", kind: "reversal", strength: t === "up" ? 3 : 2, bar_index: i, bar_date: date, note: "Bear bar fully engulfs prior bull bar." });
  }

  // Harami (inside body)
  if (isBull(a) && isBear(b) && b.o <= a.c && b.c >= a.o && body(b) < body(a) * 0.6) {
    out.push({ name: "Bearish Harami", bias: "bearish", kind: "reversal", strength: t === "up" ? 2 : 1, bar_index: i, bar_date: date, note: "Small bear bar inside prior bull body." });
  }
  if (isBear(a) && isBull(b) && b.o >= a.c && b.c <= a.o && body(b) < body(a) * 0.6) {
    out.push({ name: "Bullish Harami", bias: "bullish", kind: "reversal", strength: t === "down" ? 2 : 1, bar_index: i, bar_date: date, note: "Small bull bar inside prior bear body." });
  }

  // Piercing Line / Dark Cloud Cover
  if (isBear(a) && isBull(b) && b.o < a.l && b.c > midpoint(a) && b.c < a.o) {
    out.push({ name: "Piercing Line", bias: "bullish", kind: "reversal", strength: t === "down" ? 3 : 2, bar_index: i, bar_date: date, note: "Gap down then closes above prior midpoint." });
  }
  if (isBull(a) && isBear(b) && b.o > a.h && b.c < midpoint(a) && b.c > a.o) {
    out.push({ name: "Dark Cloud Cover", bias: "bearish", kind: "reversal", strength: t === "up" ? 3 : 2, bar_index: i, bar_date: date, note: "Gap up then closes below prior midpoint." });
  }

  // Tweezer Top / Bottom
  const tol = 0.001 * Math.max(a.c, b.c);
  if (Math.abs(a.h - b.h) <= tol && isBull(a) && isBear(b) && t === "up") {
    out.push({ name: "Tweezer Top", bias: "bearish", kind: "reversal", strength: 2, bar_index: i, bar_date: date, note: "Matching highs reject resistance." });
  }
  if (Math.abs(a.l - b.l) <= tol && isBear(a) && isBull(b) && t === "down") {
    out.push({ name: "Tweezer Bottom", bias: "bullish", kind: "reversal", strength: 2, bar_index: i, bar_date: date, note: "Matching lows hold support." });
  }

  // Kicker (gap with opposite full bodies)
  if (isBear(a) && isBull(b) && b.o > a.o && body(b) > avgB && body(a) > avgB * 0.7) {
    out.push({ name: "Bullish Kicker", bias: "bullish", kind: "reversal", strength: 3, bar_index: i, bar_date: date, note: "Gap-up bull bar reverses prior bear bar." });
  }
  if (isBull(a) && isBear(b) && b.o < a.o && body(b) > avgB && body(a) > avgB * 0.7) {
    out.push({ name: "Bearish Kicker", bias: "bearish", kind: "reversal", strength: 3, bar_index: i, bar_date: date, note: "Gap-down bear bar reverses prior bull bar." });
  }

  return out;
}

// ---------- three-bar ----------
function detectThree(bars: Bar[], i: number, avgB: number): CandleMatch[] {
  if (i < 2) return [];
  const a = bars[i - 2], m = bars[i - 1], b = bars[i];
  const t = trendAt(bars, i - 2);
  const out: CandleMatch[] = [];
  const date = b.t;

  const mSmall = body(m) <= body(a) * 0.4;
  const mDoji = body(m) <= range(m) * 0.1;

  // Morning Star
  if (isBear(a) && mSmall && isBull(b) && b.c > midpoint(a)) {
    out.push({
      name: mDoji ? "Morning Doji Star" : "Morning Star",
      bias: "bullish", kind: "reversal",
      strength: t === "down" ? 3 : 2,
      bar_index: i, bar_date: date,
      note: "Bear bar → small/doji → bull bar closing in prior body.",
    });
  }
  // Evening Star
  if (isBull(a) && mSmall && isBear(b) && b.c < midpoint(a)) {
    out.push({
      name: mDoji ? "Evening Doji Star" : "Evening Star",
      bias: "bearish", kind: "reversal",
      strength: t === "up" ? 3 : 2,
      bar_index: i, bar_date: date,
      note: "Bull bar → small/doji → bear bar closing in prior body.",
    });
  }

  // Three White Soldiers
  if (isBull(a) && isBull(m) && isBull(b)
      && m.o > a.o && m.o < a.c && b.o > m.o && b.o < m.c
      && b.c > m.c && m.c > a.c
      && body(a) > avgB * 0.6 && body(m) > avgB * 0.6 && body(b) > avgB * 0.6) {
    out.push({ name: "Three White Soldiers", bias: "bullish", kind: "reversal", strength: 3, bar_index: i, bar_date: date, note: "Three strong consecutive bull bars." });
  }
  // Three Black Crows
  if (isBear(a) && isBear(m) && isBear(b)
      && m.o < a.o && m.o > a.c && b.o < m.o && b.o > m.c
      && b.c < m.c && m.c < a.c
      && body(a) > avgB * 0.6 && body(m) > avgB * 0.6 && body(b) > avgB * 0.6) {
    out.push({ name: "Three Black Crows", bias: "bearish", kind: "reversal", strength: 3, bar_index: i, bar_date: date, note: "Three strong consecutive bear bars." });
  }

  // Three Inside Up / Down (Harami + confirm)
  if (isBear(a) && isBull(m) && m.o >= a.c && m.c <= a.o && isBull(b) && b.c > a.o) {
    out.push({ name: "Three Inside Up", bias: "bullish", kind: "reversal", strength: t === "down" ? 3 : 2, bar_index: i, bar_date: date, note: "Bullish harami confirmed by next close above bar 1 open." });
  }
  if (isBull(a) && isBear(m) && m.o <= a.c && m.c >= a.o && isBear(b) && b.c < a.o) {
    out.push({ name: "Three Inside Down", bias: "bearish", kind: "reversal", strength: t === "up" ? 3 : 2, bar_index: i, bar_date: date, note: "Bearish harami confirmed by next close below bar 1 open." });
  }

  // Three Outside Up / Down (Engulfing + confirm)
  if (isBear(a) && isBull(m) && m.o <= a.c && m.c >= a.o && body(m) > body(a) && isBull(b) && b.c > m.c) {
    out.push({ name: "Three Outside Up", bias: "bullish", kind: "reversal", strength: t === "down" ? 3 : 2, bar_index: i, bar_date: date, note: "Bullish engulfing confirmed by higher close." });
  }
  if (isBull(a) && isBear(m) && m.o >= a.c && m.c <= a.o && body(m) > body(a) && isBear(b) && b.c < m.c) {
    out.push({ name: "Three Outside Down", bias: "bearish", kind: "reversal", strength: t === "up" ? 3 : 2, bar_index: i, bar_date: date, note: "Bearish engulfing confirmed by lower close." });
  }

  return out;
}

// ---------- five-bar (Rising/Falling Three Methods) ----------
function detectFive(bars: Bar[], i: number, avgB: number): CandleMatch[] {
  if (i < 4) return [];
  const [a, b, c, d, e] = [bars[i - 4], bars[i - 3], bars[i - 2], bars[i - 1], bars[i]];
  const out: CandleMatch[] = [];
  const date = e.t;

  // Rising Three Methods
  if (isBull(a) && body(a) > avgB * 0.8
      && [b, c, d].every(x => isBear(x) && body(x) < body(a) * 0.6 && x.h <= a.h && x.l >= a.l)
      && isBull(e) && e.c > a.c && body(e) > avgB * 0.6) {
    out.push({ name: "Rising Three Methods", bias: "bullish", kind: "continuation", strength: 3, bar_index: i, bar_date: date, note: "Pullback inside bar 1 then continuation higher." });
  }
  // Falling Three Methods
  if (isBear(a) && body(a) > avgB * 0.8
      && [b, c, d].every(x => isBull(x) && body(x) < body(a) * 0.6 && x.h <= a.h && x.l >= a.l)
      && isBear(e) && e.c < a.c && body(e) > avgB * 0.6) {
    out.push({ name: "Falling Three Methods", bias: "bearish", kind: "continuation", strength: 3, bar_index: i, bar_date: date, note: "Bounce inside bar 1 then continuation lower." });
  }

  return out;
}

// ---------- public entry ----------
// Scans the last `lookback` bars and returns matches sorted by recency desc.
export function detectCandlePatterns(bars: Bar[], lookback = 5): CandleMatch[] {
  if (!bars || bars.length < 25) return [];
  const out: CandleMatch[] = [];
  const start = Math.max(25, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    const avgB = avgBody(bars, i, 14);
    out.push(...detectSingle(bars, i, avgB));
    out.push(...detectTwo(bars, i, avgB));
    out.push(...detectThree(bars, i, avgB));
    out.push(...detectFive(bars, i, avgB));
  }
  // Dedup identical name on same bar
  const seen = new Set<string>();
  const dedup: CandleMatch[] = [];
  for (const m of out) {
    const k = `${m.bar_index}::${m.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(m);
  }
  return dedup.sort((x, y) => y.bar_index - x.bar_index || y.strength - x.strength);
}

// Aggregate detected matches into a directional summary the scorer can use.
export function summarizeCandles(matches: CandleMatch[]) {
  let bullScore = 0, bearScore = 0;
  for (const m of matches) {
    // Weight reversal > continuation > indecision; recent bars weigh more
    const kindW = m.kind === "reversal" ? 1.0 : m.kind === "continuation" ? 0.7 : 0.3;
    const w = m.strength * kindW;
    if (m.bias === "bullish") bullScore += w;
    else if (m.bias === "bearish") bearScore += w;
  }
  const net = bullScore - bearScore;
  return { bullScore: +bullScore.toFixed(2), bearScore: +bearScore.toFixed(2), net: +net.toFixed(2) };
}
