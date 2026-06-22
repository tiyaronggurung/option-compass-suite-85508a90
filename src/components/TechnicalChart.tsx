import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  ColorType,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

export interface ChartBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OverlayPattern {
  name: string;
  bias: "bullish" | "bearish" | "neutral";
  status: "forming" | "confirmed" | "invalidated";
  start_date: string;
  end_date: string;
  neckline: number | null;
  target: number | null;
  stop: number | null;
}

export interface OverlayExpectedMove {
  horizon_days: number;
  upper: number;
  lower: number;
}

interface Props {
  bars: ChartBar[];
  height?: number;
  patterns?: OverlayPattern[];
  expectedMove?: OverlayExpectedMove[];
}

// ---- Indicator helpers ----
function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += values[j];
      prev = s / period;
      out.push(prev);
      continue;
    }
    prev = values[i] * k + (prev as number) * (1 - k);
    out.push(prev);
  }
  return out;
}

function bollinger(values: number[], period = 20, mult = 2) {
  const mid: (number | null)[] = [];
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { mid.push(null); upper.push(null); lower.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const m = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    mid.push(m);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  }
  return { mid, upper, lower };
}

function toTs(dateStr: string): UTCTimestamp {
  return Math.floor(new Date(dateStr).getTime() / 1000) as UTCTimestamp;
}

// ---- Fib channel ----
// Find swing low/high indices in the trailing `lookback` bars and return
// baseline anchors + the channel height for projecting parallel rails.
function computeFibChannel(bars: ChartBar[], lookback = 90) {
  const n = bars.length;
  if (n < 10) return null;
  const start = Math.max(0, n - lookback);
  let loIdx = start, hiIdx = start;
  for (let i = start; i < n; i++) {
    if (bars[i].l < bars[loIdx].l) loIdx = i;
    if (bars[i].h > bars[hiIdx].h) hiIdx = i;
  }
  if (loIdx === hiIdx) return null;

  const tLo = toTs(bars[loIdx].t);
  const tHi = toTs(bars[hiIdx].t);
  const pLo = bars[loIdx].l;
  const pHi = bars[hiIdx].h;

  // baseline: low → high; slope in price/sec
  const dt = (tHi as number) - (tLo as number);
  if (dt === 0) return null;
  const slope = (pHi - pLo) / dt;
  const height = pHi - pLo; // channel width
  const uptrend = slope >= 0;

  const t0 = toTs(bars[0].t);
  const tEnd = toTs(bars[n - 1].t);
  const baseAt = (t: UTCTimestamp) => pLo + slope * ((t as number) - (tLo as number));

  const buildLine = (offset: number) => [
    { time: t0, value: baseAt(t0) + offset },
    { time: tEnd, value: baseAt(tEnd) + offset },
  ];

  // 0 rail = baseline (along the swing low side), 1.0 rail = parallel through swing high.
  // Direction: in uptrend channel rails go upward; in downtrend, downward.
  const dir = uptrend ? 1 : -1;
  return {
    uptrend,
    rails: [
      { name: "0", color: "#10b981", data: buildLine(0) },
      { name: "0.382", color: "#3b82f6", data: buildLine(dir * 0.382 * Math.abs(height)) },
      { name: "0.618", color: "#a855f7", data: buildLine(dir * 0.618 * Math.abs(height)) },
      { name: "1.0", color: "#f59e0b", data: buildLine(dir * 1.0 * Math.abs(height)) },
      { name: "1.618", color: "#ef4444", data: buildLine(dir * 1.618 * Math.abs(height)) },
    ],
  };
}

export function TechnicalChart({ bars, height = 380, patterns, expectedMove }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [showFib, setShowFib] = useState(false);
  const [showPatterns, setShowPatterns] = useState(false);


  useEffect(() => {
    if (!containerRef.current || !bars || bars.length === 0) return;

    const el = containerRef.current;
    const styles = getComputedStyle(document.documentElement);
    const fg = `hsl(${styles.getPropertyValue("--foreground").trim() || "0 0% 100%"})`;
    const border = `hsl(${styles.getPropertyValue("--border").trim() || "0 0% 20%"})`;
    const muted = `hsl(${styles.getPropertyValue("--muted-foreground").trim() || "0 0% 60%"})`;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: fg,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: border, style: 1 },
        horzLines: { color: border, style: 1 },
      },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: false, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: false,
    });
    chartRef.current = chart;

    // --- Candles ---
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "hsl(142 71% 45%)",
      downColor: "hsl(0 72% 51%)",
      wickUpColor: "hsl(142 71% 45%)",
      wickDownColor: "hsl(0 72% 51%)",
      borderVisible: false,
    });
    candleSeries.setData(
      bars.map((b) => ({
        time: toTs(b.t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
      })),
    );

    const closes = bars.map((b) => b.c);
    const times = bars.map((b) => toTs(b.t));

    // --- EMAs ---
    const pushLine = (color: string, period: number, title: string) => {
      const series = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        title,
      });
      const vals = ema(closes, period);
      const data = vals
        .map((v, i) => (v == null ? null : { time: times[i], value: v }))
        .filter(Boolean) as { time: UTCTimestamp; value: number }[];
      series.setData(data);
    };
    pushLine("#3b82f6", 20, "EMA20");
    pushLine("#f59e0b", 50, "EMA50");
    pushLine("#ef4444", 200, "EMA200");

    // --- Bollinger Bands ---
    const bb = bollinger(closes, 20, 2);
    const bbUpper = chart.addSeries(LineSeries, {
      color: muted, lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false, title: "BB Upper",
    });
    bbUpper.setData(
      bb.upper.map((v, i) => (v == null ? null : { time: times[i], value: v })).filter(Boolean) as any,
    );
    const bbLower = chart.addSeries(LineSeries, {
      color: muted, lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false, title: "BB Lower",
    });
    bbLower.setData(
      bb.lower.map((v, i) => (v == null ? null : { time: times[i], value: v })).filter(Boolean) as any,
    );
    const bbMidArea = chart.addSeries(AreaSeries, {
      topColor: "rgba(148, 163, 184, 0.08)",
      bottomColor: "rgba(148, 163, 184, 0.0)",
      lineColor: "rgba(148, 163, 184, 0.0)",
      priceLineVisible: false, lastValueVisible: false,
    });
    bbMidArea.setData(
      bb.mid.map((v, i) => (v == null ? null : { time: times[i], value: v })).filter(Boolean) as any,
    );

    // --- Fib Channel (optional) ---
    if (showFib) {
      const fc = computeFibChannel(bars, 90);
      if (fc) {
        for (const rail of fc.rails) {
          const s = chart.addSeries(LineSeries, {
            color: rail.color,
            lineWidth: rail.name === "0" || rail.name === "1.0" ? 2 : 1,
            lineStyle: rail.name === "0.382" || rail.name === "0.618" ? 2 : 0,
            priceLineVisible: false,
            lastValueVisible: false,
            title: `Fib ${rail.name}`,
            autoscaleInfoProvider: () => null,
          });
          s.setData(rail.data as any);
        }
      }
    }

    // --- Chart-pattern overlay (optional, OFF by default) ---
    // Draws each pattern's neckline / target / stop as horizontal-ish lines
    // spanning the pattern's date range, plus an expected-move cone shaded
    // forward from the last bar.
    if (showPatterns && patterns && patterns.length > 0) {
      const t0 = times[0];
      const tLast = times[times.length - 1];
      const colorFor = (bias: string) =>
        bias === "bullish" ? "#10b981" : bias === "bearish" ? "#ef4444" : "#94a3b8";
      for (const p of patterns) {
        const start = (toTs(p.start_date) as number) < (t0 as number) ? t0 : toTs(p.start_date);
        const end = (toTs(p.end_date) as number) > (tLast as number) ? tLast : toTs(p.end_date);
        if (p.neckline != null) {
          const s = chart.addSeries(LineSeries, {
            color: colorFor(p.bias),
            lineWidth: p.status === "confirmed" ? 2 : 1,
            lineStyle: p.status === "confirmed" ? 0 : 2,
            priceLineVisible: false, lastValueVisible: false,
            title: `${p.name} neckline`,
            autoscaleInfoProvider: () => null,
          });
          s.setData([
            { time: start, value: p.neckline },
            { time: end, value: p.neckline },
          ] as any);
        }
        if (p.target != null) {
          const s = chart.addSeries(LineSeries, {
            color: "#10b981", lineWidth: 1, lineStyle: 3,
            priceLineVisible: false, lastValueVisible: false,
            title: `${p.name} target`,
            autoscaleInfoProvider: () => null,
          });
          s.setData([
            { time: end, value: p.target },
            { time: tLast, value: p.target },
          ] as any);
        }
        if (p.stop != null) {
          const s = chart.addSeries(LineSeries, {
            color: "#ef4444", lineWidth: 1, lineStyle: 3,
            priceLineVisible: false, lastValueVisible: false,
            title: `${p.name} stop`,
            autoscaleInfoProvider: () => null,
          });
          s.setData([
            { time: end, value: p.stop },
            { time: tLast, value: p.stop },
          ] as any);
        }
      }
    }

    // --- Expected-move cone (optional, shares the patterns toggle) ---
    if (showPatterns && expectedMove && expectedMove.length > 0) {
      const last = bars[bars.length - 1];
      const tLastSec = toTs(last.t) as number;
      const lastPx = last.c;
      // Build forward time points. Use 1d steps (~86400s) so cones project to
      // the right of the last bar even though we don't have future bars.
      const sorted = [...expectedMove].sort((a, b) => a.horizon_days - b.horizon_days);
      const maxH = sorted[sorted.length - 1].horizon_days;
      const points = (kind: "upper" | "lower") => {
        const arr = [{ time: tLastSec as UTCTimestamp, value: lastPx }];
        for (const em of sorted) {
          arr.push({ time: (tLastSec + em.horizon_days * 86400) as UTCTimestamp, value: em[kind] });
        }
        return arr;
      };
      const up = chart.addSeries(LineSeries, {
        color: "#10b981", lineWidth: 1, lineStyle: 2,
        priceLineVisible: false, lastValueVisible: false,
        title: `EM +1σ (${maxH}d)`,
        autoscaleInfoProvider: () => null,
      });
      up.setData(points("upper") as any);
      const dn = chart.addSeries(LineSeries, {
        color: "#ef4444", lineWidth: 1, lineStyle: 2,
        priceLineVisible: false, lastValueVisible: false,
        title: `EM −1σ (${maxH}d)`,
        autoscaleInfoProvider: () => null,
      });
      dn.setData(points("lower") as any);
    }

    chart.timeScale().fitContent();


    const ro = new ResizeObserver(() => {
      if (chartRef.current && el) {
        chartRef.current.applyOptions({ width: el.clientWidth, height });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, height, showFib, showPatterns, patterns, expectedMove]);

  if (!bars || bars.length === 0) {
    return (
      <div className="rounded-md border border-border p-6 text-center text-xs text-muted-foreground">
        No price history available for this ticker.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs font-medium">Price · EMAs · Bollinger Bands</div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <Legend swatch="#3b82f6" label="EMA20" />
          <Legend swatch="#f59e0b" label="EMA50" />
          <Legend swatch="#ef4444" label="EMA200" />
          <Legend swatch="hsl(var(--muted-foreground))" label="BB(20,2)" dashed />
          <button
            onClick={() => setShowFib((v) => !v)}
            className={`px-2 py-0.5 rounded border text-[10px] transition-colors ${
              showFib
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-accent"
            }`}
            title="Toggle Fibonacci channel overlay"
          >
            Fib channel {showFib ? "ON" : "OFF"}
          </button>
          {((patterns && patterns.length > 0) || (expectedMove && expectedMove.length > 0)) && (
            <button
              onClick={() => setShowPatterns((v) => !v)}
              className={`px-2 py-0.5 rounded border text-[10px] transition-colors ${
                showPatterns
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border hover:bg-accent"
              }`}
              title="Toggle chart-pattern necklines / targets / expected-move cone"
            >
              Patterns {showPatterns ? "ON" : "OFF"}
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height }} />
      {showFib && (
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground pt-1 border-t border-border">
          <Legend swatch="#10b981" label="0 (baseline)" />
          <Legend swatch="#3b82f6" label="0.382" dashed />
          <Legend swatch="#a855f7" label="0.618" dashed />
          <Legend swatch="#f59e0b" label="1.0 rail" />
          <Legend swatch="#ef4444" label="1.618 ext" />
          <span className="opacity-70">Anchors: swing low/high in last 90 bars</span>
        </div>
      )}
      {showPatterns && ((patterns && patterns.length > 0) || (expectedMove && expectedMove.length > 0)) && (
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground pt-1 border-t border-border">
          <Legend swatch="#10b981" label="bullish neckline / target" />
          <Legend swatch="#ef4444" label="bearish neckline / stop" />
          <Legend swatch="#94a3b8" label="neutral" />
          <span className="opacity-70">Dotted = forming · solid = confirmed · projected cone right of last bar</span>
        </div>
      )}
    </div>
  );
}

function Legend({ swatch, label, dashed }: { swatch: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block w-3 h-0.5"
        style={{
          background: dashed ? undefined : swatch,
          borderTop: dashed ? `1.5px dashed ${swatch}` : undefined,
        }}
      />
      {label}
    </span>
  );
}
