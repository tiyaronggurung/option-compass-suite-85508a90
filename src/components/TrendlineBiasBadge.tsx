// Live trendline-based exit/hold guidance for an OPEN option trade.
// Polls /intraday-bias on a DTE-aware cadence and renders a compact badge
// plus a reason tooltip. Pure advisory — never auto-closes the trade.

import { useEffect, useState } from "react";
import { AlertOctagon, ShieldAlert, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Verdict = "HOLD" | "TIGHTEN" | "EXIT";
type Direction = "CALL" | "PUT";

type BiasPayload = {
  verdict: Verdict;
  reversal_probability: number;
  direction: Direction;
  dte_bucket: "0dte" | "short" | "swing";
  reasons: string[];
  indicators: {
    last_close: number;
    vwap: number;
    vwap_dist_pct: number;
    descending_trendline: number | null;
    ascending_trendline: number | null;
    candle_run: { greens: number; reds: number; bias: "bull" | "bear" | "mixed" };
    volume_ratio: number;
    session_pct: number;
    theta_weight: number;
  };
  last_bar_et: string;
  bars_used: number;
};

type Props = {
  ticker: string;
  direction: Direction;
  dte: number;
};

function pollMsForDTE(dte: number): number {
  if (dte <= 0) return 30_000;
  if (dte <= 2) return 60_000;
  return 90_000;
}

function verdictStyles(v: Verdict) {
  if (v === "EXIT") return { bg: "bg-bear/15", text: "text-bear", border: "border-bear/40", icon: AlertOctagon, label: "EXIT NOW" };
  if (v === "TIGHTEN") return { bg: "bg-warn/15", text: "text-warn", border: "border-warn/40", icon: ShieldAlert, label: "TIGHTEN STOP" };
  return { bg: "bg-bull/10", text: "text-bull", border: "border-bull/30", icon: ShieldCheck, label: "HOLD" };
}

export function TrendlineBiasBadge({ ticker, direction, dte }: Props) {
  const [bias, setBias] = useState<BiasPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function load() {
      setLoading(true);
      try {
        const { data, error } = await supabase.functions.invoke("intraday-bias", {
          body: { ticker, direction, dte },
        });
        if (cancelled) return;
        if (error) throw error;
        const payload = (data as any)?.payload as BiasPayload | undefined;
        if (payload) {
          setBias(payload);
          setError(null);
        } else {
          setError((data as any)?.error ?? "no payload");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = pollMsForDTE(dte);
    timer = window.setInterval(load, interval);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [ticker, direction, dte]);

  if (error && !bias) {
    return null; // fail silent — don't clutter the card on transient errors
  }
  if (!bias) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card-elevated/30 p-2 text-[10px] text-muted-foreground">
        {loading ? "Reading 1m trendline…" : "Trendline bias loading…"}
      </div>
    );
  }

  const styles = verdictStyles(bias.verdict);
  const Icon = styles.icon;
  const DirIcon = bias.indicators.candle_run.bias === "bull" ? TrendingUp : TrendingDown;
  const tlPrice = direction === "PUT" ? bias.indicators.descending_trendline : bias.indicators.ascending_trendline;
  const tlLabel = direction === "PUT" ? "Descending TL" : "Ascending TL";
  const bucketLabel = bias.dte_bucket === "0dte" ? "0DTE" : bias.dte_bucket === "short" ? "≤2 DTE" : "Swing";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "rounded-md border p-2 flex items-center justify-between gap-2 cursor-help",
              styles.bg,
              styles.border,
              bias.verdict === "EXIT" && bias.dte_bucket === "0dte" && "animate-pulse ring-2 ring-bear/40",
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Icon className={cn("h-4 w-4 shrink-0", styles.text)} />
              <div className="min-w-0">
                <div className={cn("text-[11px] font-semibold leading-tight", styles.text)}>
                  {styles.label}{" "}
                  <span className="opacity-70 font-normal">· {bias.reversal_probability}% reversal</span>
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {bucketLabel} · {tlLabel} {tlPrice != null ? `$${tlPrice.toFixed(2)}` : "—"} · close ${bias.indicators.last_close.toFixed(2)}
                </div>
              </div>
            </div>
            <DirIcon className={cn("h-3.5 w-3.5 shrink-0", bias.indicators.candle_run.bias === "bull" ? "text-bull" : "text-bear")} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1.5">
            <div className="text-xs font-semibold">
              {bias.verdict === "EXIT" && "Exit suggested"}
              {bias.verdict === "TIGHTEN" && "Tighten your stop"}
              {bias.verdict === "HOLD" && "Thesis intact"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Reversal probability {bias.reversal_probability}% over next ~15 min
              {bias.dte_bucket === "0dte" && " · 0DTE thresholds applied"}
            </div>
            <ul className="text-[11px] space-y-0.5 pt-1 list-disc list-inside">
              {bias.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/50">
              VWAP ${bias.indicators.vwap.toFixed(2)} ({bias.indicators.vwap_dist_pct >= 0 ? "+" : ""}{bias.indicators.vwap_dist_pct.toFixed(2)}%) · Vol {bias.indicators.volume_ratio.toFixed(1)}× avg · {bias.bars_used} bars
            </div>
            <div className="text-[10px] text-muted-foreground italic">Advisory only — you decide when to close.</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
