import { useEffect, useRef } from "react";
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

interface Props {
  bars: ChartBar[];
  height?: number;
}

// ---- Indicator helpers (mirror the edge function math, run on the bars we already have) ----
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
  // Alpaca returns ISO timestamps; convert to seconds for lightweight-charts.
  return Math.floor(new Date(dateStr).getTime() / 1000) as UTCTimestamp;
}

export function TechnicalChart({ bars, height = 380 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

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

    // --- Bollinger Bands (area fill) ---
    const bb = bollinger(closes, 20, 2);

    const upperSeries = chart.addSeries(LineSeries, {
      color: muted,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "BB Upper",
    });
    upperSeries.setData(
      bb.upper
        .map((v, i) => (v == null ? null : { time: times[i], value: v }))
        .filter(Boolean) as { time: UTCTimestamp; value: number }[],
    );

    const lowerSeries = chart.addSeries(LineSeries, {
      color: muted,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "BB Lower",
    });
    lowerSeries.setData(
      bb.lower
        .map((v, i) => (v == null ? null : { time: times[i], value: v }))
        .filter(Boolean) as { time: UTCTimestamp; value: number }[],
    );

    // Soft fill via an area series on the midline (visual hint only)
    const midSeries = chart.addSeries(AreaSeries, {
      topColor: "rgba(148, 163, 184, 0.08)",
      bottomColor: "rgba(148, 163, 184, 0.0)",
      lineColor: "rgba(148, 163, 184, 0.0)",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    midSeries.setData(
      bb.mid
        .map((v, i) => (v == null ? null : { time: times[i], value: v }))
        .filter(Boolean) as { time: UTCTimestamp; value: number }[],
    );

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
  }, [bars, height]);

  if (!bars || bars.length === 0) {
    return (
      <div className="rounded-md border border-border p-6 text-center text-xs text-muted-foreground">
        No price history available for this ticker.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium">Price · EMAs · Bollinger Bands</div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <Legend swatch="#3b82f6" label="EMA20" />
          <Legend swatch="#f59e0b" label="EMA50" />
          <Legend swatch="#ef4444" label="EMA200" />
          <Legend swatch="hsl(var(--muted-foreground))" label="BB(20,2)" dashed />
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height }} />
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
