import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { techAdjustConfidence, techFactor } from "@/lib/techAdjust";

export interface TechSnapshot {
  ticker: string;
  computed_at: string;
  payload: {
    verdict: "bullish" | "bearish" | "neutral";
    tech_score: number;
    reasons: { label: string; pts: number; bullish: boolean }[];
    indicators: {
      price: number;
      ema20: number; ema50: number; ema200: number;
      ema50_slope_pct: number;
      rsi14: number | null;
      macd: { line: number | null; signal: number | null; hist: number | null; rising: boolean };
      bollinger: { upper: number; mid: number; lower: number; percent_b: number };
      atr14: number | null;
      atr_pct: number;
      support: number;
      resistance: number;
      dist_to_support_pct: number;
      dist_to_resistance_pct: number;
      avg_volume_20: number;
      last_volume: number;
      volume_ratio: number;
    };
    recent_bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[];
  };
}

interface Props {
  ticker: string;
  signalDirection?: "CALL" | "PUT" | null;
  baseConfidence?: number | null;
  onSnapshot?: (s: TechSnapshot) => void;
}

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function verdictMeta(v: string) {
  if (v === "bullish") return { label: "Bullish", cls: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30", Icon: TrendingUp };
  if (v === "bearish") return { label: "Bearish", cls: "bg-rose-500/15 text-rose-500 border-rose-500/30", Icon: TrendingDown };
  return { label: "Neutral", cls: "bg-muted text-muted-foreground border-border", Icon: Minus };
}

export function TechnicalTrendCard({ ticker, signalDirection, baseConfidence, onSnapshot }: Props) {
  const [snap, setSnap] = useState<TechSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.functions.invoke("technical-analysis", {
        body: { ticker, force },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const s = (data as any).snapshot as TechSnapshot;
      setSnap(s);
      onSnapshot?.(s);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load technical analysis");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (ticker) load(false); /* eslint-disable-next-line */ }, [ticker]);

  if (loading && !snap) {
    return <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Computing technical trend…</div>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-border p-3 text-xs space-y-2">
        <div className="text-rose-500">{error}</div>
        <Button size="sm" variant="outline" onClick={() => load(true)}>Retry</Button>
      </div>
    );
  }
  if (!snap) return null;

  const p = snap.payload;
  const ind = p.indicators;
  const meta = verdictMeta(p.verdict);
  const VIcon = meta.Icon;

  // Tech-adjusted display confidence (display only — does not mutate stored signal)
  let adjusted: number | null = null;
  let adjFactor = 1;
  if (baseConfidence != null && signalDirection) {
    const longLike = signalDirection === "CALL";
    if (p.verdict === "bullish") adjFactor = longLike ? 1.05 : 0.90;
    else if (p.verdict === "bearish") adjFactor = longLike ? 0.90 : 1.05;
    adjusted = Math.max(1, Math.min(99, Math.round(baseConfidence * adjFactor)));
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("gap-1", meta.cls)}>
            <VIcon className="h-3 w-3" />
            {meta.label}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Tech score <span className={cn("font-semibold", p.tech_score > 0 ? "text-emerald-500" : p.tech_score < 0 ? "text-rose-500" : "text-foreground")}>{p.tech_score > 0 ? "+" : ""}{p.tech_score}</span>
          </span>
        </div>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => load(true)} disabled={loading}>
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Score bar */}
      <div className="relative h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        <div
          className={cn("absolute inset-y-0", p.tech_score >= 0 ? "left-1/2 bg-emerald-500" : "right-1/2 bg-rose-500")}
          style={{ width: `${Math.abs(p.tech_score) / 2}%` }}
        />
      </div>

      {adjusted != null && (
        <div className="rounded-md bg-muted/40 px-2 py-1.5 text-xs flex items-center justify-between">
          <span className="text-muted-foreground">Tech-adjusted confidence</span>
          <span className="font-medium">
            {baseConfidence} → <span className={cn(adjFactor > 1 ? "text-emerald-500" : adjFactor < 1 ? "text-rose-500" : "")}>{adjusted}</span>
            <span className="text-muted-foreground ml-1">({adjFactor > 1 ? "+" : ""}{Math.round((adjFactor - 1) * 100)}%)</span>
          </span>
        </div>
      )}

      {/* Indicator grid */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <Row k="Price" v={`$${fmt(ind.price)}`} />
        <Row k="RSI(14)" v={fmt(ind.rsi14, 1)} tone={ind.rsi14 == null ? undefined : ind.rsi14 > 70 ? "warn" : ind.rsi14 < 30 ? "warn" : ind.rsi14 >= 50 ? "good" : "bad"} />
        <Row k="EMA20" v={`$${fmt(ind.ema20)}`} tone={ind.price > ind.ema20 ? "good" : "bad"} />
        <Row k="EMA50" v={`$${fmt(ind.ema50)}`} tone={ind.price > ind.ema50 ? "good" : "bad"} />
        <Row k="EMA200" v={`$${fmt(ind.ema200)}`} tone={ind.price > ind.ema200 ? "good" : "bad"} />
        <Row k="EMA50 slope" v={`${ind.ema50_slope_pct > 0 ? "+" : ""}${fmt(ind.ema50_slope_pct, 3)}%`} tone={ind.ema50_slope_pct > 0 ? "good" : "bad"} />
        <Row k="MACD hist" v={fmt(ind.macd.hist, 3)} tone={ind.macd.hist == null ? undefined : ind.macd.hist > 0 ? "good" : "bad"} />
        <Row k="MACD trend" v={ind.macd.rising ? "Rising" : "Falling"} tone={ind.macd.rising ? "good" : "bad"} />
        <Row k="BB %B" v={fmt(ind.bollinger.percent_b, 2)} />
        <Row k="ATR %" v={`${fmt(ind.atr_pct)}%`} />
        <Row k="Support" v={`$${fmt(ind.support)}`} />
        <Row k="Resistance" v={`$${fmt(ind.resistance)}`} />
        <Row k="Dist to support" v={`${fmt(ind.dist_to_support_pct)}%`} />
        <Row k="Dist to resistance" v={`${fmt(ind.dist_to_resistance_pct)}%`} />
        <Row k="Vol vs 20d avg" v={`${fmt(ind.volume_ratio)}×`} tone={ind.volume_ratio >= 1.5 ? "good" : undefined} />
      </div>

      {/* Reasons */}
      {p.reasons.length > 0 && (
        <div className="pt-2 border-t border-border space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Why this verdict</div>
          <ul className="space-y-1">
            {p.reasons.map((r, i) => (
              <li key={i} className="flex items-center justify-between text-xs gap-2">
                <span className="text-foreground/85">{r.label}</span>
                <span className={cn("font-mono text-[11px] px-1.5 py-0.5 rounded", r.bullish ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500")}>
                  {r.pts > 0 ? "+" : ""}{r.pts}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground">
        Computed {new Date(snap.computed_at).toLocaleString()} · Educational use only, not financial advice.
      </div>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn(
        "font-mono",
        tone === "good" && "text-emerald-500",
        tone === "bad" && "text-rose-500",
        tone === "warn" && "text-amber-500",
      )}>{v}</span>
    </div>
  );
}
