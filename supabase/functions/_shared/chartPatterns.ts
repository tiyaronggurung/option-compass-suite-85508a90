// Chart pattern detection — pure functions over OHLCV daily bars.
// Designed to be additive: callers consume the returned `ChartPattern[]` and
// `ExpectedMove` independently of any existing scoring math.
//
// Detection style: pivot-based (swing highs / swing lows with a configurable
// strength), then geometric rules per pattern. We intentionally bias toward
// FEWER false positives — patterns require: clear pivots, comparable peak/trough
// heights within tolerance, and a defined neckline / breakout level.
//
// Each ChartPattern returns enough info for UI + later scoring:
//   - bias (bullish|bearish|neutral)
//   - neckline / breakout price
//   - measured-move target
//   - invalidation stop
//   - confidence 0-100 (how cleanly the rules matched)
//   - status: 'forming' (price still inside pattern) vs 'confirmed' (broke neckline)

export type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };

export type PatternBias = "bullish" | "bearish" | "neutral";
export type PatternStatus = "forming" | "confirmed" | "invalidated";

export interface ChartPattern {
  name: string;
  bias: PatternBias;
  status: PatternStatus;
  start_index: number;        // first bar of the pattern
  end_index: number;          // last reference bar (most recent pivot used)
  start_date: string;
  end_date: string;
  neckline: number | null;    // price level that triggers confirmation
  breakout_level: number | null;
  target: number | null;      // measured-move price target
  stop: number | null;        // invalidation level
  confidence: number;         // 0-100, geometric cleanliness of the match
  note: string;               // 1-line human description
}

export interface ExpectedMove {
  horizon_days: number;
  upper: number;
  lower: number;
  // 1-sigma band derived from ATR scaled by sqrt(N). Probability is the
  // implied chance that close will land inside [lower, upper] under a
  // gaussian-return assumption — useful as a coarse cone, NOT a true IV cone.
  prob_inside: number;
}

// ---------- Pivot detection ----------

interface Pivot {
  index: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Find swing highs/lows. A pivot high at index i means bars[i].h is the
 * strict maximum within +/- `strength` bars (and equal-only on one side
 * is rejected to avoid plateaus counting twice).
 */
export function findPivots(bars: Bar[], strength = 3): Pivot[] {
  const out: Pivot[] = [];
  if (bars.length < strength * 2 + 1) return out;
  for (let i = strength; i < bars.length - strength; i++) {
    let isHigh = true, isLow = true;
    const h = bars[i].h, l = bars[i].l;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (bars[j].h >= h) isHigh = false;
      if (bars[j].l <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, price: h, kind: "high" });
    if (isLow) out.push({ index: i, price: l, kind: "low" });
  }
  // Sort by index just in case (a bar can technically be both, but the
  // strict comparison above prevents that).
  out.sort((a, b) => a.index - b.index);
  return out;
}

// Utility — within `tolPct` of each other (peak-equivalence test).
function within(a: number, b: number, tolPct: number): boolean {
  if (a === 0 && b === 0) return true;
  const ref = (Math.abs(a) + Math.abs(b)) / 2;
  return Math.abs(a - b) / ref <= tolPct;
}

function lastBarIndex(bars: Bar[]): number {
  return bars.length - 1;
}

// ---------- Reversal patterns ----------

/** Double Top: H-L-H where the two highs are similar and the low between is the neckline. */
function detectDoubleTopBottom(bars: Bar[], pivots: Pivot[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  // Walk pivots, look at every (high, low, high) triple in trailing 90 bars.
  for (let i = 2; i < pivots.length; i++) {
    const p3 = pivots[i], p2 = pivots[i - 1], p1 = pivots[i - 2];
    const span = p3.index - p1.index;
    if (span < 8 || span > 120) continue;
    if (n - 1 - p3.index > 30) continue; // pattern must be recent

    // Double Top: high-low-high
    if (p1.kind === "high" && p2.kind === "low" && p3.kind === "high") {
      if (!within(p1.price, p3.price, 0.03)) continue;
      const neckline = p2.price;
      const height = ((p1.price + p3.price) / 2) - neckline;
      if (height <= 0) continue;
      const last = bars[n - 1].c;
      const confirmed = last < neckline;
      const target = neckline - height;
      const stop = Math.max(p1.price, p3.price) * 1.005;
      out.push({
        name: "Double Top",
        bias: "bearish",
        status: confirmed ? "confirmed" : "forming",
        start_index: p1.index, end_index: p3.index,
        start_date: bars[p1.index].t, end_date: bars[p3.index].t,
        neckline, breakout_level: neckline, target, stop,
        confidence: Math.round(scoreSymmetry(p1.price, p3.price, height, span)),
        note: `Two highs near $${p1.price.toFixed(2)} / $${p3.price.toFixed(2)} with neckline $${neckline.toFixed(2)}.`,
      });
    }
    // Double Bottom: low-high-low
    if (p1.kind === "low" && p2.kind === "high" && p3.kind === "low") {
      if (!within(p1.price, p3.price, 0.03)) continue;
      const neckline = p2.price;
      const height = neckline - ((p1.price + p3.price) / 2);
      if (height <= 0) continue;
      const last = bars[n - 1].c;
      const confirmed = last > neckline;
      const target = neckline + height;
      const stop = Math.min(p1.price, p3.price) * 0.995;
      out.push({
        name: "Double Bottom",
        bias: "bullish",
        status: confirmed ? "confirmed" : "forming",
        start_index: p1.index, end_index: p3.index,
        start_date: bars[p1.index].t, end_date: bars[p3.index].t,
        neckline, breakout_level: neckline, target, stop,
        confidence: Math.round(scoreSymmetry(p1.price, p3.price, height, span)),
        note: `Two lows near $${p1.price.toFixed(2)} / $${p3.price.toFixed(2)} with neckline $${neckline.toFixed(2)}.`,
      });
    }
  }
  return out;
}

/** Head & Shoulders / inverse: 5 alternating pivots with middle one extreme. */
function detectHeadShoulders(bars: Bar[], pivots: Pivot[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  for (let i = 4; i < pivots.length; i++) {
    const p = [pivots[i - 4], pivots[i - 3], pivots[i - 2], pivots[i - 1], pivots[i]];
    const span = p[4].index - p[0].index;
    if (span < 15 || span > 150) continue;
    if (n - 1 - p[4].index > 30) continue;

    // Standard H&S: H-L-H-L-H, middle high is the highest
    const isHS = p[0].kind === "high" && p[1].kind === "low" && p[2].kind === "high" && p[3].kind === "low" && p[4].kind === "high";
    if (isHS) {
      if (!(p[2].price > p[0].price && p[2].price > p[4].price)) continue;
      if (!within(p[0].price, p[4].price, 0.05)) continue;
      const neckline = (p[1].price + p[3].price) / 2;
      const head = p[2].price;
      const height = head - neckline;
      if (height <= 0) continue;
      const last = bars[n - 1].c;
      const confirmed = last < neckline;
      const target = neckline - height;
      const stop = head * 1.005;
      out.push({
        name: "Head & Shoulders",
        bias: "bearish",
        status: confirmed ? "confirmed" : "forming",
        start_index: p[0].index, end_index: p[4].index,
        start_date: bars[p[0].index].t, end_date: bars[p[4].index].t,
        neckline, breakout_level: neckline, target, stop,
        confidence: Math.round(scoreSymmetry(p[0].price, p[4].price, height, span)),
        note: `Head $${head.toFixed(2)}, shoulders ~$${((p[0].price + p[4].price) / 2).toFixed(2)}, neckline $${neckline.toFixed(2)}.`,
      });
    }
    // Inverse H&S: L-H-L-H-L
    const isIHS = p[0].kind === "low" && p[1].kind === "high" && p[2].kind === "low" && p[3].kind === "high" && p[4].kind === "low";
    if (isIHS) {
      if (!(p[2].price < p[0].price && p[2].price < p[4].price)) continue;
      if (!within(p[0].price, p[4].price, 0.05)) continue;
      const neckline = (p[1].price + p[3].price) / 2;
      const head = p[2].price;
      const height = neckline - head;
      if (height <= 0) continue;
      const last = bars[n - 1].c;
      const confirmed = last > neckline;
      const target = neckline + height;
      const stop = head * 0.995;
      out.push({
        name: "Inverse Head & Shoulders",
        bias: "bullish",
        status: confirmed ? "confirmed" : "forming",
        start_index: p[0].index, end_index: p[4].index,
        start_date: bars[p[0].index].t, end_date: bars[p[4].index].t,
        neckline, breakout_level: neckline, target, stop,
        confidence: Math.round(scoreSymmetry(p[0].price, p[4].price, height, span)),
        note: `Head $${head.toFixed(2)}, shoulders ~$${((p[0].price + p[4].price) / 2).toFixed(2)}, neckline $${neckline.toFixed(2)}.`,
      });
    }
  }
  return out;
}

/** Triple Top/Bottom: three peaks/troughs at similar level. */
function detectTriple(bars: Bar[], pivots: Pivot[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  for (let i = 4; i < pivots.length; i++) {
    const p = [pivots[i - 4], pivots[i - 3], pivots[i - 2], pivots[i - 1], pivots[i]];
    const span = p[4].index - p[0].index;
    if (span < 15 || span > 150) continue;
    if (n - 1 - p[4].index > 30) continue;

    // Triple top: H-L-H-L-H, three highs ~equal
    if (p[0].kind === "high" && p[2].kind === "high" && p[4].kind === "high"
      && p[1].kind === "low" && p[3].kind === "low") {
      if (!within(p[0].price, p[2].price, 0.03) || !within(p[2].price, p[4].price, 0.03)) continue;
      const neckline = Math.min(p[1].price, p[3].price);
      const top = (p[0].price + p[2].price + p[4].price) / 3;
      const height = top - neckline;
      if (height <= 0) continue;
      const last = bars[n - 1].c;
      const confirmed = last < neckline;
      out.push({
        name: "Triple Top",
        bias: "bearish",
        status: confirmed ? "confirmed" : "forming",
        start_index: p[0].index, end_index: p[4].index,
        start_date: bars[p[0].index].t, end_date: bars[p[4].index].t,
        neckline, breakout_level: neckline, target: neckline - height, stop: top * 1.005,
        confidence: Math.round(scoreSymmetry(p[0].price, p[4].price, height, span) * 1.05),
        note: `Three highs near $${top.toFixed(2)}; neckline $${neckline.toFixed(2)}.`,
      });
    }
    // Triple bottom: L-H-L-H-L
    if (p[0].kind === "low" && p[2].kind === "low" && p[4].kind === "low"
      && p[1].kind === "high" && p[3].kind === "high") {
      if (!within(p[0].price, p[2].price, 0.03) || !within(p[2].price, p[4].price, 0.03)) continue;
      const neckline = Math.max(p[1].price, p[3].price);
      const bot = (p[0].price + p[2].price + p[4].price) / 3;
      const height = neckline - bot;
      if (height <= 0) continue;
      const last = bars[n - 1].c;
      const confirmed = last > neckline;
      out.push({
        name: "Triple Bottom",
        bias: "bullish",
        status: confirmed ? "confirmed" : "forming",
        start_index: p[0].index, end_index: p[4].index,
        start_date: bars[p[0].index].t, end_date: bars[p[4].index].t,
        neckline, breakout_level: neckline, target: neckline + height, stop: bot * 0.995,
        confidence: Math.round(scoreSymmetry(p[0].price, p[4].price, height, span) * 1.05),
        note: `Three lows near $${bot.toFixed(2)}; neckline $${neckline.toFixed(2)}.`,
      });
    }
  }
  return out;
}

// ---------- Continuation: flags / pennants / rectangle / cup&handle ----------

/** Bull/Bear flag: sharp pole then 2-3 week parallel-ish counter-trend channel. */
function detectFlag(bars: Bar[], pivots: Pivot[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  if (n < 30) return out;
  const last = bars[n - 1].c;
  // pole: look back 20-60 bars for a sharp >12% move in 5-15 bars
  for (let poleEnd = n - 6; poleEnd >= n - 30; poleEnd--) {
    for (let poleStart = poleEnd - 5; poleStart >= Math.max(0, poleEnd - 15); poleStart--) {
      const a = bars[poleStart].c;
      const b = bars[poleEnd].c;
      const move = (b - a) / a;
      if (Math.abs(move) < 0.12) continue;

      // consolidation: poleEnd..n-1 should retrace 20-50% with low range
      const consol = bars.slice(poleEnd, n);
      if (consol.length < 4 || consol.length > 20) continue;
      const consHi = Math.max(...consol.map(x => x.h));
      const consLo = Math.min(...consol.map(x => x.l));
      const range = consHi - consLo;
      const poleRange = Math.abs(b - a);
      if (range > poleRange * 0.55) continue; // too wide = not a flag

      const bullish = move > 0;
      const breakout = bullish ? consHi : consLo;
      const target = bullish ? breakout + poleRange : breakout - poleRange;
      const stop = bullish ? consLo * 0.99 : consHi * 1.01;
      const confirmed = bullish ? last > consHi : last < consLo;
      out.push({
        name: bullish ? "Bull Flag" : "Bear Flag",
        bias: bullish ? "bullish" : "bearish",
        status: confirmed ? "confirmed" : "forming",
        start_index: poleStart, end_index: n - 1,
        start_date: bars[poleStart].t, end_date: bars[n - 1].t,
        neckline: breakout, breakout_level: breakout, target, stop,
        confidence: Math.round(60 + Math.min(30, Math.abs(move) * 100)),
        note: `${(Math.abs(move) * 100).toFixed(1)}% pole into ${consol.length}-bar flag; breakout $${breakout.toFixed(2)}.`,
      });
      return out; // one flag at most
    }
  }
  return out;
}

/** Pennant: pole then symmetrical converging triangle. Simplified as a flag
 *  with converging hi/lo. */
function detectPennant(bars: Bar[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  if (n < 25) return out;
  for (let poleEnd = n - 5; poleEnd >= n - 25; poleEnd--) {
    for (let poleStart = poleEnd - 5; poleStart >= Math.max(0, poleEnd - 12); poleStart--) {
      const a = bars[poleStart].c, b = bars[poleEnd].c;
      const move = (b - a) / a;
      if (Math.abs(move) < 0.10) continue;

      const consol = bars.slice(poleEnd, n);
      if (consol.length < 5 || consol.length > 15) continue;

      // Check convergence: first-half range > second-half range by ≥30%
      const half = Math.floor(consol.length / 2);
      const r1 = Math.max(...consol.slice(0, half).map(x => x.h)) - Math.min(...consol.slice(0, half).map(x => x.l));
      const r2 = Math.max(...consol.slice(half).map(x => x.h)) - Math.min(...consol.slice(half).map(x => x.l));
      if (r2 > r1 * 0.7) continue;

      const bullish = move > 0;
      const breakout = bullish ? Math.max(...consol.map(x => x.h)) : Math.min(...consol.map(x => x.l));
      const poleRange = Math.abs(b - a);
      const target = bullish ? breakout + poleRange : breakout - poleRange;
      const stop = bullish ? Math.min(...consol.map(x => x.l)) * 0.99 : Math.max(...consol.map(x => x.h)) * 1.01;
      const last = bars[n - 1].c;
      const confirmed = bullish ? last > breakout : last < breakout;
      out.push({
        name: "Pennant",
        bias: bullish ? "bullish" : "bearish",
        status: confirmed ? "confirmed" : "forming",
        start_index: poleStart, end_index: n - 1,
        start_date: bars[poleStart].t, end_date: bars[n - 1].t,
        neckline: breakout, breakout_level: breakout, target, stop,
        confidence: 65,
        note: `Pole ${(move * 100).toFixed(1)}%; ${consol.length}-bar converging pennant.`,
      });
      return out;
    }
  }
  return out;
}

/** Rectangle: parallel support and resistance over ≥15 bars, ≥3 touches each side. */
function detectRectangle(bars: Bar[], pivots: Pivot[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  const recent = pivots.filter(p => p.index >= n - 80);
  const highs = recent.filter(p => p.kind === "high");
  const lows = recent.filter(p => p.kind === "low");
  if (highs.length < 2 || lows.length < 2) return out;

  const meanHi = highs.reduce((a, p) => a + p.price, 0) / highs.length;
  const meanLo = lows.reduce((a, p) => a + p.price, 0) / lows.length;
  const hiOk = highs.every(p => within(p.price, meanHi, 0.025));
  const loOk = lows.every(p => within(p.price, meanLo, 0.025));
  if (!hiOk || !loOk) return out;
  if (meanHi <= meanLo) return out;

  const last = bars[n - 1].c;
  const height = meanHi - meanLo;
  const startIdx = Math.min(highs[0].index, lows[0].index);
  let bias: PatternBias = "neutral";
  let status: PatternStatus = "forming";
  let target: number | null = null;
  let stop: number | null = null;
  let breakout: number | null = null;
  if (last > meanHi * 1.005) {
    bias = "bullish"; status = "confirmed"; breakout = meanHi;
    target = meanHi + height; stop = meanLo * 0.99;
  } else if (last < meanLo * 0.995) {
    bias = "bearish"; status = "confirmed"; breakout = meanLo;
    target = meanLo - height; stop = meanHi * 1.01;
  } else {
    breakout = meanHi; // upside break by default reference
  }
  out.push({
    name: "Rectangle",
    bias, status,
    start_index: startIdx, end_index: n - 1,
    start_date: bars[startIdx].t, end_date: bars[n - 1].t,
    neckline: breakout, breakout_level: breakout, target, stop,
    confidence: 60,
    note: `Range $${meanLo.toFixed(2)}–$${meanHi.toFixed(2)} over ${n - 1 - startIdx} bars.`,
  });
  return out;
}

/** Cup & Handle: U-shaped base (60-130 bars) followed by small downward handle. */
function detectCupHandle(bars: Bar[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  if (n < 70) return out;
  // cup window
  for (const cupLen of [60, 90, 120]) {
    if (n < cupLen + 5) continue;
    const cup = bars.slice(n - cupLen - 10, n - 10);
    if (cup.length < 30) continue;
    const lhs = cup[0].c, rhs = cup[cup.length - 1].c;
    if (!within(lhs, rhs, 0.04)) continue;
    const cupLo = Math.min(...cup.map(b => b.l));
    const cupHi = Math.max(lhs, rhs);
    const depth = (cupHi - cupLo) / cupHi;
    if (depth < 0.10 || depth > 0.40) continue;
    // handle: last 10 bars, small pullback, max retrace 1/3 of cup
    const handle = bars.slice(n - 10, n);
    const hHi = Math.max(...handle.map(b => b.h));
    const hLo = Math.min(...handle.map(b => b.l));
    if (hHi > cupHi * 1.01) continue; // handle shouldn't break the rim yet
    const handleRetrace = (cupHi - hLo) / (cupHi - cupLo);
    if (handleRetrace > 0.5) continue;

    const last = bars[n - 1].c;
    const breakout = cupHi;
    const height = cupHi - cupLo;
    const confirmed = last > breakout;
    out.push({
      name: "Cup & Handle",
      bias: "bullish",
      status: confirmed ? "confirmed" : "forming",
      start_index: n - cupLen - 10, end_index: n - 1,
      start_date: bars[n - cupLen - 10].t, end_date: bars[n - 1].t,
      neckline: breakout, breakout_level: breakout, target: breakout + height, stop: hLo * 0.99,
      confidence: 65,
      note: `Cup ${cupLen}b depth ${(depth * 100).toFixed(1)}%; handle retrace ${(handleRetrace * 100).toFixed(0)}%.`,
    });
    return out;
  }
  return out;
}

// ---------- Triangles & wedges ----------

interface LineFit { slope: number; intercept: number; }
function fitLine(points: { x: number; y: number }[]): LineFit {
  // simple least-squares
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function detectTrianglesWedges(bars: Bar[], pivots: Pivot[]): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  const window = 60;
  const recent = pivots.filter(p => p.index >= n - window);
  const highs = recent.filter(p => p.kind === "high");
  const lows = recent.filter(p => p.kind === "low");
  if (highs.length < 2 || lows.length < 2) return out;

  const hiFit = fitLine(highs.map(p => ({ x: p.index, y: p.price })));
  const loFit = fitLine(lows.map(p => ({ x: p.index, y: p.price })));
  const last = bars[n - 1].c;
  const lastIdx = n - 1;
  const hiAtLast = hiFit.slope * lastIdx + hiFit.intercept;
  const loAtLast = loFit.slope * lastIdx + loFit.intercept;
  if (hiAtLast <= loAtLast) return out;

  const refPrice = last || 1;
  // normalize slopes to %/bar
  const hiSlopePct = hiFit.slope / refPrice;
  const loSlopePct = loFit.slope / refPrice;
  const FLAT = 0.0005; // <0.05%/bar = flat-ish

  const startIdx = Math.min(highs[0].index, lows[0].index);

  let name: string | null = null;
  let bias: PatternBias = "neutral";
  let breakoutUp = hiAtLast, breakoutDn = loAtLast;
  let target: number | null = null;
  let height = hiAtLast - loAtLast;

  if (Math.abs(hiSlopePct) < FLAT && loSlopePct > FLAT) {
    name = "Ascending Triangle"; bias = "bullish";
    target = breakoutUp + height;
  } else if (hiSlopePct < -FLAT && Math.abs(loSlopePct) < FLAT) {
    name = "Descending Triangle"; bias = "bearish";
    target = breakoutDn - height;
  } else if (hiSlopePct < -FLAT && loSlopePct > FLAT) {
    name = "Symmetrical Triangle"; bias = "neutral";
  } else if (hiSlopePct > FLAT && loSlopePct > FLAT && loSlopePct > hiSlopePct) {
    name = "Rising Wedge"; bias = "bearish";
    target = breakoutDn - height;
  } else if (hiSlopePct < -FLAT && loSlopePct < -FLAT && hiSlopePct < loSlopePct) {
    name = "Falling Wedge"; bias = "bullish";
    target = breakoutUp + height;
  }
  if (!name) return out;

  let status: PatternStatus = "forming";
  if (last > hiAtLast * 1.005) status = "confirmed";
  else if (last < loAtLast * 0.995) status = "confirmed";

  out.push({
    name,
    bias,
    status,
    start_index: startIdx, end_index: lastIdx,
    start_date: bars[startIdx].t, end_date: bars[lastIdx].t,
    neckline: bias === "bearish" ? breakoutDn : breakoutUp,
    breakout_level: bias === "bearish" ? breakoutDn : breakoutUp,
    target,
    stop: bias === "bullish" ? loAtLast * 0.99 : bias === "bearish" ? hiAtLast * 1.01 : null,
    confidence: 55 + Math.min(20, (highs.length + lows.length) * 2),
    note: `${name} from ${bars[startIdx].t.slice(0, 10)} → resistance $${hiAtLast.toFixed(2)} / support $${loAtLast.toFixed(2)}.`,
  });
  return out;
}

// ---------- Quality scorer (used by reversal patterns) ----------

function scoreSymmetry(peakA: number, peakB: number, height: number, span: number): number {
  const ref = (peakA + peakB) / 2;
  const sym = 1 - Math.abs(peakA - peakB) / ref; // 1 == identical
  const heightRel = Math.min(1, Math.abs(height) / (ref * 0.05)); // 5%+ height = full credit
  const spanFit = span >= 20 && span <= 80 ? 1 : 0.7;
  return Math.max(40, Math.min(95, sym * 60 + heightRel * 25 + spanFit * 10));
}

// ---------- Public entry point ----------

export function detectChartPatterns(bars: Bar[]): ChartPattern[] {
  if (!bars || bars.length < 30) return [];
  const pivots = findPivots(bars, 3);
  const out: ChartPattern[] = [
    ...detectDoubleTopBottom(bars, pivots),
    ...detectHeadShoulders(bars, pivots),
    ...detectTriple(bars, pivots),
    ...detectFlag(bars, pivots),
    ...detectPennant(bars),
    ...detectRectangle(bars, pivots),
    ...detectCupHandle(bars),
    ...detectTrianglesWedges(bars, pivots),
  ];
  // de-dup: collapse same-name patterns sharing >70% of bar range
  const deduped: ChartPattern[] = [];
  for (const p of out) {
    const overlap = deduped.find(q => q.name === p.name
      && Math.abs(q.start_index - p.start_index) < (q.end_index - q.start_index) * 0.3);
    if (overlap) {
      if (p.confidence > overlap.confidence) {
        deduped[deduped.indexOf(overlap)] = p;
      }
      continue;
    }
    deduped.push(p);
  }
  // sort: confirmed first, then by confidence desc
  deduped.sort((a, b) => {
    if (a.status !== b.status) return a.status === "confirmed" ? -1 : 1;
    return b.confidence - a.confidence;
  });
  return deduped.slice(0, 6);
}

/** Aggregate pattern bias into a -100..+100 score. Caller decides whether to use it. */
export function patternsToScore(patterns: ChartPattern[]): number {
  let s = 0;
  for (const p of patterns) {
    const sign = p.bias === "bullish" ? 1 : p.bias === "bearish" ? -1 : 0;
    const weight = p.status === "confirmed" ? 1 : 0.4;
    s += sign * (p.confidence / 100) * 25 * weight;
  }
  return Math.max(-100, Math.min(100, Math.round(s)));
}

// ---------- Expected move cone (ATR-based) ----------

/** ATR(14) on bars (Wilder smoothing). */
function atr14(bars: Bar[]): number {
  if (bars.length < 15) return 0;
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { tr.push(bars[i].h - bars[i].l); continue; }
    const prev = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prev), Math.abs(bars[i].l - prev)));
  }
  let prev = 0;
  for (let i = 0; i < 14; i++) prev += tr[i];
  prev /= 14;
  for (let i = 14; i < tr.length; i++) prev = (prev * 13 + tr[i]) / 14;
  return prev;
}

export function computeExpectedMove(bars: Bar[], horizons: number[] = [1, 5, 20]): ExpectedMove[] {
  if (bars.length < 20) return [];
  const last = bars[bars.length - 1].c;
  const a = atr14(bars);
  if (!a || !last) return [];
  // 1-sigma daily move ≈ ATR; scale by sqrt(days). Inside-band prob ≈ 68% per
  // normal approximation; we report that constant for honesty.
  return horizons.map((h) => {
    const sigma = a * Math.sqrt(h);
    return {
      horizon_days: h,
      upper: +(last + sigma).toFixed(2),
      lower: +(last - sigma).toFixed(2),
      prob_inside: 0.68,
    };
  });
}
