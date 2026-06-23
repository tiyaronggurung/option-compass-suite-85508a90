// POST /functions/v1/intraday-bias
// Body: { ticker: string, direction: "CALL" | "PUT", dte: number, force?: boolean }
//
// Returns a forward-looking bias for an OPEN option trade based on:
//   - 1m candle runs (last 3 bodies)
//   - Short-term trendline fit (DTE-aware lookback)
//   - VWAP distance
//   - Volume on the most recent candle
//   - Time-of-day theta weighting
//
// Verdict is direction-aware:
//   - CALL trade + bearish reversal probability  → EXIT / TIGHTEN
//   - PUT  trade + bullish reversal probability  → EXIT / TIGHTEN
//
// Cached ~30s in-memory per (ticker, direction, dte-bucket).
// Pure read-only. NEVER touches scanner, scoring, lifecycle, or paper trades.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const CACHE_TTL_MS = 30_000;

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };

const cache = new Map<string, { at: number; payload: unknown }>();

function dteBucket(dte: number): "0dte" | "short" | "swing" {
  if (dte <= 0) return "0dte";
  if (dte <= 2) return "short";
  return "swing";
}

function lookbackMinForDTE(dte: number): number {
  const b = dteBucket(dte);
  if (b === "0dte") return 30;
  if (b === "short") return 60;
  return 120;
}

async function fetch1mBars(symbol: string, lookbackMin: number): Promise<Bar[]> {
  // Pull a generous window so we always have lookback + context (use 6h buffer).
  const toET = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
  };
  const now = new Date();
  const start = new Date(now.getTime() - Math.max(lookbackMin + 60, 180) * 60_000);
  const params = new URLSearchParams({
    symbol,
    interval: "1min",
    start: toET(start),
    end: toET(now),
    session_filter: "open",
  });
  const url = `https://api.tradier.com/v1/markets/timesales?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tradier_${res.status}: ${body.slice(0, 160)}`);
  }
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

// Find swing highs (descending trendline anchors) using a small fractal window.
function swingHighs(bars: Bar[], k = 3): { i: number; price: number }[] {
  const out: { i: number; price: number }[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const h = bars[i].h;
    let ok = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].h >= h) { ok = false; break; }
    }
    if (ok) out.push({ i, price: h });
  }
  return out;
}

function swingLows(bars: Bar[], k = 3): { i: number; price: number }[] {
  const out: { i: number; price: number }[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const l = bars[i].l;
    let ok = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].l <= l) { ok = false; break; }
    }
    if (ok) out.push({ i, price: l });
  }
  return out;
}

// Fit trendline through the two most-recent extrema, return slope+intercept (y = m*i + b).
function trendlineFromTwo(pts: { i: number; price: number }[]): { m: number; b: number; p1: { i: number; price: number }; p2: { i: number; price: number } } | null {
  if (pts.length < 2) return null;
  const p2 = pts[pts.length - 1];
  const p1 = pts[pts.length - 2];
  if (p1.i === p2.i) return null;
  const m = (p2.price - p1.price) / (p2.i - p1.i);
  const b = p1.price - m * p1.i;
  return { m, b, p1, p2 };
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

function buildBias(bars: Bar[], direction: "CALL" | "PUT", dte: number) {
  const lookback = lookbackMinForDTE(dte);
  const tail = bars.slice(-lookback);
  if (tail.length < 10) throw new Error("not enough 1m bars");

  const last = tail[tail.length - 1];
  const lastClose = last.c;

  // VWAP across tail
  let pv = 0, vv = 0;
  for (const b of tail) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    vv += b.v;
  }
  const vwap = vv > 0 ? pv / vv : lastClose;
  const vwapDistPct = ((lastClose - vwap) / vwap) * 100;

  // Trendline — descending from swing highs, ascending from swing lows.
  const highs = swingHighs(tail);
  const lows = swingLows(tail);
  const descTL = trendlineFromTwo(highs.filter((p, idx, arr) => idx >= arr.length - 4));
  const ascTL = trendlineFromTwo(lows.filter((p, idx, arr) => idx >= arr.length - 4));
  // Project trendline value at last bar index.
  const lastIdx = tail.length - 1;
  const descTLAtLast = descTL ? descTL.m * lastIdx + descTL.b : null;
  const ascTLAtLast = ascTL ? ascTL.m * lastIdx + ascTL.b : null;

  // Candle run — last 3 bodies' direction
  const last3 = tail.slice(-3);
  const greens = last3.filter((b) => b.c > b.o).length;
  const reds = last3.filter((b) => b.c < b.o).length;
  const runBias: "bull" | "bear" | "mixed" = greens >= 2 ? "bull" : reds >= 2 ? "bear" : "mixed";

  // Volume on last bar vs 20-bar avg
  const volAvg20 = avg(tail.slice(-21, -1).map((b) => b.v));
  const volRatio = volAvg20 > 0 ? last.v / volAvg20 : 1;

  // Time-of-day theta weight (ET minutes)
  const hm = last.t.slice(11, 16).split(":").map(Number);
  const minutesET = hm[0] * 60 + hm[1];
  const sessionPct = Math.max(0, Math.min(1, (minutesET - (9 * 60 + 30)) / 390));
  const thetaWeight = sessionPct > 0.85 ? 1.4 : sessionPct > 0.65 ? 1.2 : 1.0;

  // ---- Build reversal probability (against the trade) ----
  // We compute a 0..100 "reversal probability" — likelihood the underlying
  // moves AGAINST the option (CALL → down; PUT → up) in the next ~15 min.
  let reversal = 30; // baseline
  const reasons: string[] = [];

  if (direction === "PUT") {
    // Reversal AGAINST a PUT = bullish move.
    if (descTLAtLast != null) {
      const through = lastClose - descTLAtLast;
      if (through > 0) {
        reversal += 25;
        reasons.push(`Closed above descending trendline ($${descTLAtLast.toFixed(2)})`);
      } else if (last.h > descTLAtLast) {
        reversal += 10;
        reasons.push(`Wicked through descending trendline ($${descTLAtLast.toFixed(2)})`);
      } else {
        reversal -= 10;
        reasons.push(`Below descending trendline ($${descTLAtLast.toFixed(2)})`);
      }
    }
    if (runBias === "bull") { reversal += 18; reasons.push(`Last 3 candles ${greens} green / ${reds} red`); }
    else if (runBias === "bear") { reversal -= 12; reasons.push(`Last 3 candles ${reds} red — thesis intact`); }
    if (vwapDistPct > 0.05) { reversal += 8; reasons.push(`Price above VWAP (+${vwapDistPct.toFixed(2)}%)`); }
    else if (vwapDistPct < -0.05) { reversal -= 8; reasons.push(`Price below VWAP (${vwapDistPct.toFixed(2)}%)`); }
    if (volRatio > 1.5 && last.c > last.o) { reversal += 10; reasons.push(`Heavy green volume (${volRatio.toFixed(1)}× avg)`); }
  } else {
    // CALL: reversal = bearish move
    if (ascTLAtLast != null) {
      const through = ascTLAtLast - lastClose;
      if (through > 0) {
        reversal += 25;
        reasons.push(`Closed below ascending trendline ($${ascTLAtLast.toFixed(2)})`);
      } else if (last.l < ascTLAtLast) {
        reversal += 10;
        reasons.push(`Wicked through ascending trendline ($${ascTLAtLast.toFixed(2)})`);
      } else {
        reversal -= 10;
        reasons.push(`Above ascending trendline ($${ascTLAtLast.toFixed(2)})`);
      }
    }
    if (runBias === "bear") { reversal += 18; reasons.push(`Last 3 candles ${reds} red / ${greens} green`); }
    else if (runBias === "bull") { reversal -= 12; reasons.push(`Last 3 candles ${greens} green — thesis intact`); }
    if (vwapDistPct < -0.05) { reversal += 8; reasons.push(`Price below VWAP (${vwapDistPct.toFixed(2)}%)`); }
    else if (vwapDistPct > 0.05) { reversal -= 8; reasons.push(`Price above VWAP (+${vwapDistPct.toFixed(2)}%)`); }
    if (volRatio > 1.5 && last.c < last.o) { reversal += 10; reasons.push(`Heavy red volume (${volRatio.toFixed(1)}× avg)`); }
  }

  // Theta weight amplifies reversal late in day (premium decays faster on stalled moves)
  reversal = Math.round(reversal * thetaWeight);
  if (reversal > 95) reversal = 95;
  if (reversal < 5) reversal = 5;

  // DTE-aware verdict
  const bucket = dteBucket(dte);
  let verdict: "HOLD" | "TIGHTEN" | "EXIT" = "HOLD";
  if (bucket === "0dte") {
    if (reversal >= 60) verdict = "EXIT";
    else if (reversal >= 45) verdict = "TIGHTEN";
  } else if (bucket === "short") {
    if (reversal >= 70) verdict = "EXIT";
    else if (reversal >= 55) verdict = "TIGHTEN";
  } else {
    if (reversal >= 80) verdict = "EXIT";
    else if (reversal >= 65) verdict = "TIGHTEN";
  }

  return {
    verdict,
    reversal_probability: reversal,
    direction,
    dte_bucket: bucket,
    reasons: reasons.slice(0, 6),
    indicators: {
      last_close: +lastClose.toFixed(2),
      vwap: +vwap.toFixed(2),
      vwap_dist_pct: +vwapDistPct.toFixed(2),
      descending_trendline: descTLAtLast != null ? +descTLAtLast.toFixed(2) : null,
      ascending_trendline: ascTLAtLast != null ? +ascTLAtLast.toFixed(2) : null,
      candle_run: { greens, reds, bias: runBias },
      volume_ratio: +volRatio.toFixed(2),
      session_pct: +sessionPct.toFixed(2),
      theta_weight: thetaWeight,
    },
    last_bar_et: last.t,
    bars_used: tail.length,
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
    const ticker = String(body?.ticker ?? "").trim().toUpperCase();
    const direction = String(body?.direction ?? "").toUpperCase() === "PUT" ? "PUT" : "CALL";
    const dte = Number(body?.dte ?? 0);
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

    const key = `${ticker}:${direction}:${dteBucket(dte)}`;
    const cached = cache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ok: true, cached: true, payload: cached.payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bars = await fetch1mBars(ticker, lookbackMinForDTE(dte));
    if (bars.length < 10) {
      return new Response(JSON.stringify({ ok: true, skipped: "no_bars", bars: bars.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const payload = buildBias(bars, direction as "CALL" | "PUT", dte);
    cache.set(key, { at: Date.now(), payload });

    return new Response(JSON.stringify({ ok: true, cached: false, payload }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("intraday-bias error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
