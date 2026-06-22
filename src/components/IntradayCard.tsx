import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, TrendingUp, TrendingDown, Minus, Clock, AlertTriangle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface IntradayPayload {
  verdict: "bullish" | "bearish" | "neutral";
  intraday_score: number;
  reasons: { label: string; pts: number; bullish: boolean }[];
  indicators: {
    price: number;
    vwap: number;
    vwap_dist_pct: number;
    opening_range_high: number | null;
    opening_range_low: number | null;
    session_high: number;
    session_low: number;
    ema9_5m: number | null;
    ema21_5m: number | null;
    rsi14_5m: number | null;
  };
  time_of_day: {
    last_bar_et: string;
    session_pct: number;
    risk: "low" | "medium" | "high";
  };
  session_date: string;
  bars_used: number;
}

interface Props {
  ticker: string;
  signalDirection?: "CALL" | "PUT" | null;
}

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function verdictMeta(v: string) {
  if (v === "bullish") return { label: "Bullish intraday", cls: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30", Icon: TrendingUp };
  if (v === "bearish") return { label: "Bearish intraday", cls: "bg-rose-500/15 text-rose-500 border-rose-500/30", Icon: TrendingDown };
  return { label: "Neutral intraday", cls: "bg-muted text-muted-foreground border-border", Icon: Minus };
}

function alignmentBadge(direction: "CALL" | "PUT" | null | undefined, verdict: string) {
  if (!direction || verdict === "neutral") return null;
  const aligned = (direction === "CALL" && verdict === "bullish") || (direction === "PUT" && verdict === "bearish");
  return aligned
    ? { label: `Aligned with ${direction}`, cls: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" }
    : { label: `Against ${direction}`, cls: "bg-rose-500/15 text-rose-500 border-rose-500/30" };
}

export function IntradayCard({ ticker, signalDirection }: Props) {
  const [data, setData] = useState<IntradayPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const { data: resp, error: err } = await supabase.functions.invoke("intraday-analysis", {
        body: { ticker, force },
      });
      if (err) throw err;
      if ((resp as any)?.error) throw new Error((resp as any).error);
      setData((resp as any).payload as IntradayPayload);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load intraday analysis");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (ticker) load(false); /* eslint-disable-next-line */ }, [ticker]);

  if (loading && !data) {
    return <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">Computing intraday structure…</div>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-border p-3 text-xs space-y-2">
        <div className="text-rose-500">{error}</div>
        <Button size="sm" variant="outline" onClick={() => load(true)}>Retry</Button>
      </div>
    );
  }
  if (!data) return null;

  const ind = data.indicators;
  const meta = verdictMeta(data.verdict);
  const VIcon = meta.Icon;
  const align = alignmentBadge(signalDirection ?? null, data.verdict);
  const tod = data.time_of_day;

  const inOR = ind.opening_range_high != null && ind.opening_range_low != null
    && ind.price >= ind.opening_range_low && ind.price <= ind.opening_range_high;
  const aboveOR = ind.opening_range_high != null && ind.price > ind.opening_range_high;
  const belowOR = ind.opening_range_low != null && ind.price < ind.opening_range_low;

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-600 bg-amber-500/10">
            <Zap className="h-3 w-3" /> 0DTE / Same-day
          </Badge>
          <Badge variant="outline" className={cn("gap-1", meta.cls)}>
            <VIcon className="h-3 w-3" />
            {meta.label}
          </Badge>
          {align && (
            <Badge variant="outline" className={cn("gap-1", align.cls)}>
              {align.label}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            Score <span className={cn("font-semibold", data.intraday_score > 0 ? "text-emerald-500" : data.intraday_score < 0 ? "text-rose-500" : "text-foreground")}>{data.intraday_score > 0 ? "+" : ""}{data.intraday_score}</span>
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
          className={cn("absolute inset-y-0", data.intraday_score >= 0 ? "left-1/2 bg-emerald-500" : "right-1/2 bg-rose-500")}
          style={{ width: `${Math.abs(data.intraday_score) / 2}%` }}
        />
      </div>

      {/* Time-of-day strip */}
      <div className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs",
        tod.risk === "high" && "bg-rose-500/10 text-rose-500",
        tod.risk === "medium" && "bg-amber-500/10 text-amber-600",
        tod.risk === "low" && "bg-muted/40 text-muted-foreground",
      )}>
        <span className="flex items-center gap-1.5">
          {tod.risk === "high" ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          {tod.risk === "high" ? "Late session — theta crush" :
           tod.risk === "medium" ? "Afternoon — theta accelerating" :
           "Morning/Midday session"}
        </span>
        <span className="font-mono text-[10px] opacity-80">
          {tod.last_bar_et.slice(11, 16)} ET · {Math.round(tod.session_pct * 100)}% through session
        </span>
      </div>

      {/* Indicator grid */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <Row k="Price" v={`$${fmt(ind.price)}`} />
        <Row k="VWAP" v={`$${fmt(ind.vwap)} (${ind.vwap_dist_pct > 0 ? "+" : ""}${fmt(ind.vwap_dist_pct)}%)`} tone={ind.price > ind.vwap ? "good" : "bad"} />
        <Row k="Opening Range" v={
          ind.opening_range_high != null && ind.opening_range_low != null
            ? `$${fmt(ind.opening_range_low)} – $${fmt(ind.opening_range_high)}`
            : "—"
        } />
        <Row k="OR position" v={
          aboveOR ? "Broken above" : belowOR ? "Broken below" : inOR ? "Inside" : "—"
        } tone={aboveOR ? "good" : belowOR ? "bad" : undefined} />
        <Row k="Session High" v={`$${fmt(ind.session_high)}`} />
        <Row k="Session Low" v={`$${fmt(ind.session_low)}`} />
        <Row k="5m EMA9" v={ind.ema9_5m != null ? `$${fmt(ind.ema9_5m)}` : "—"} tone={ind.ema9_5m != null ? (ind.price > ind.ema9_5m ? "good" : "bad") : undefined} />
        <Row k="5m EMA21" v={ind.ema21_5m != null ? `$${fmt(ind.ema21_5m)}` : "—"} tone={ind.ema21_5m != null ? (ind.price > ind.ema21_5m ? "good" : "bad") : undefined} />
        <Row k="5m RSI(14)" v={fmt(ind.rsi14_5m, 1)} tone={
          ind.rsi14_5m == null ? undefined
          : ind.rsi14_5m > 70 ? "warn"
          : ind.rsi14_5m < 30 ? "warn"
          : ind.rsi14_5m >= 55 ? "good"
          : ind.rsi14_5m <= 45 ? "bad" : undefined
        } />
        <Row k="Bars (5m)" v={String(data.bars_used)} />
      </div>

      {/* Reasons */}
      {data.reasons.length > 0 && (
        <div className="pt-2 border-t border-amber-500/20 space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Why this intraday verdict</div>
          <ul className="space-y-1">
            {data.reasons.map((r, i) => (
              <li key={i} className="flex items-center justify-between text-xs gap-2">
                <span className="text-foreground/85">{r.label}</span>
                {r.pts !== 0 && (
                  <span className={cn(
                    "font-mono text-[11px] px-1.5 py-0.5 rounded",
                    r.bullish ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500",
                  )}>
                    {r.pts > 0 ? "+" : ""}{r.pts}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground">
        Session {data.session_date} · 5-min bars from Tradier · Cached ~60s · Educational use only.
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
