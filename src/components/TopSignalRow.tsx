import { ArrowDownRight, ArrowUpRight, Info, ShieldAlert, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtPrice, timeAgo, type Signal } from "@/lib/signalHelpers";
import { getFreshness } from "@/lib/signalFreshness";
import type { RankBreakdown } from "@/lib/rankSignals";
import { getContractMeta } from "@/lib/rankSignals";

type Props = {
  rank: number;
  signal: Signal;
  breakdown: RankBreakdown;
  onApprove: (s: Signal) => void;
  onDetails: (s: Signal, b: RankBreakdown) => void;
};

export function TopSignalRow({ rank, signal, breakdown, onApprove, onDetails }: Props) {
  const isCall = signal.direction === "CALL";
  const contract = getContractMeta(signal);
  const freshness = getFreshness(signal);
  const freshClass =
    freshness === "fresh" ? "bg-bull/15 text-bull"
    : freshness === "aging" ? "bg-warn/15 text-warn"
    : "bg-muted text-muted-foreground";
  const riskMap: Record<string, string> = {
    LOW: "bg-bull/15 text-bull",
    MEDIUM: "bg-warn/15 text-warn",
    HIGH: "bg-bear/15 text-bear",
  };

  return (
    <div className="glass-card p-3 md:p-4 ring-1 ring-border hover:ring-primary/40 transition">
      <div className="flex items-center gap-3 md:gap-4">
        <div className="w-8 text-center text-lg font-semibold text-muted-foreground ticker-mono shrink-0">
          {rank}
        </div>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
            isCall ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear",
          )}
        >
          {isCall ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="ticker-mono text-lg font-semibold">{signal.ticker}</span>
            <Badge variant="outline" className={cn("border-0 text-xs", isCall ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear")}>
              {signal.direction}
            </Badge>
            <Badge className={cn("border-0 gap-1 text-[10px]", riskMap[signal.risk_level])}>
              <ShieldAlert className="h-3 w-3" /> {signal.risk_level}
            </Badge>
            <Badge className={cn("border-0 gap-1 text-[10px]", freshClass)}>
              <Timer className="h-3 w-3" /> {freshness}
            </Badge>
          </div>

          <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
            {signal.contract_symbol ? (
              <span className="ticker-mono text-foreground/80">{signal.contract_symbol}</span>
            ) : (
              <span>No contract match</span>
            )}
            {signal.dte != null && <span>DTE {signal.dte}</span>}
            {contract?.delta != null && <span>Δ {Number(contract.delta).toFixed(2)}</span>}
            {signal.premium != null && <span>${fmtPrice(Number(signal.premium))} mid</span>}
            {contract?.spread_pct != null && <span>spread {Number(contract.spread_pct).toFixed(1)}%</span>}
            {contract?.liquidity_score != null && <span>liq {Math.round(Number(contract.liquidity_score))}</span>}
            <span>· {timeAgo(signal.created_at)}</span>
          </div>

          {Array.isArray(signal.reasons) && signal.reasons.length > 0 && (
            <div className="mt-1 text-[11px] text-muted-foreground line-clamp-1">
              {(signal.reasons as string[]).slice(0, 2).join(" · ")}
            </div>
          )}
        </div>

        <div className="hidden sm:flex flex-col items-end shrink-0 w-20">
          <div className={cn(
            "text-2xl font-semibold ticker-mono",
            breakdown.total >= 75 ? "text-bull" : breakdown.total >= 50 ? "text-primary" : "text-muted-foreground",
          )}>
            {breakdown.total.toFixed(0)}
          </div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">rank</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">conf {signal.confidence}</div>
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          <Button
            size="sm"
            className={cn(isCall ? "bg-bull text-bull-foreground hover:bg-bull/90" : "bg-bear text-bear-foreground hover:bg-bear/90")}
            onClick={() => onApprove(signal)}
          >
            Approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDetails(signal, breakdown)}>
            <Info className="h-4 w-4 mr-1" /> Details
          </Button>
        </div>
      </div>
    </div>
  );
}
