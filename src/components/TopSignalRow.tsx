import { ArrowDownRight, ArrowUpRight, Brain, Info, ShieldAlert, Timer, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtPrice, timeAgo, type Signal } from "@/lib/signalHelpers";
import { getCountdownLabel, getFreshness } from "@/lib/signalFreshness";
import type { RankBreakdown } from "@/lib/rankSignals";
import { getContractMeta } from "@/lib/rankSignals";
import { SignalRadar } from "@/components/SignalRadar";
import { StillBestBadge } from "@/components/StillBestBadge";
import { useStillBest } from "@/lib/stillBest";

type Props = {
  rank: number;
  signal: Signal;
  breakdown: RankBreakdown;
  onApprove: (s: Signal) => void;
  onReject?: (s: Signal) => void;
  onDetails: (s: Signal, b: RankBreakdown) => void;
};

function fmtExpiry(d?: string | null): string | null {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TopSignalRow({ rank, signal, breakdown, onApprove, onReject, onDetails }: Props) {
  const isCall = signal.direction === "CALL";
  const contract = getContractMeta(signal);
  const freshness = getFreshness(signal);
  const countdown = getCountdownLabel(signal);
  const stillBest = useStillBest(signal, rank === 1);
  const freshClass =
    freshness === "fresh" ? "bg-bull/15 text-bull"
    : freshness === "aging" ? "bg-warn/15 text-warn"
    : "bg-muted text-muted-foreground";
  const riskMap: Record<string, string> = {
    LOW: "bg-bull/15 text-bull",
    MEDIUM: "bg-warn/15 text-warn",
    HIGH: "bg-bear/15 text-bear",
  };
  const expiryLabel = fmtExpiry(signal.expiry as any);
  const strikeLabel = signal.strike != null ? `$${Number(signal.strike).toFixed(0)}` : null;

  const isHot = (breakdown?.total ?? 0) >= 70;
  return (
    <div className={cn("glass-card p-3 md:p-4 ring-1 ring-border hover:ring-primary/40 transition", isHot && "animate-buzz ring-primary/60")}>

      <div className="flex items-start gap-3 md:gap-4">
        <div className="w-8 text-center text-lg font-semibold text-muted-foreground ticker-mono shrink-0 pt-1">
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
            {strikeLabel && (
              <Badge variant="outline" className="border-border/60 text-[11px] ticker-mono">
                {strikeLabel} strike
              </Badge>
            )}
            {expiryLabel && (
              <Badge variant="outline" className="border-border/60 text-[11px]">
                Exp {expiryLabel}{signal.dte != null ? ` · ${signal.dte}d` : ""}
              </Badge>
            )}
            <Badge className={cn("border-0 gap-1 text-[10px]", riskMap[signal.risk_level])}>
              <ShieldAlert className="h-3 w-3" /> {signal.risk_level}
            </Badge>
            <Badge className={cn("border-0 gap-1 text-[10px]", freshClass)} title={`Expires in ${countdown}`}>
              <Timer className="h-3 w-3" /> {countdown}
            </Badge>
          </div>

          <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
            {signal.contract_symbol ? (
              <span className="ticker-mono text-foreground/80">{signal.contract_symbol}</span>
            ) : (
              <span>No contract match</span>
            )}
            {contract?.delta != null && <span>Δ {Number(contract.delta).toFixed(2)}</span>}
            {signal.premium != null && <span>${fmtPrice(Number(signal.premium))} mid</span>}
            {contract?.spread_pct != null && <span>spread {Number(contract.spread_pct).toFixed(1)}%</span>}
            {contract?.liquidity_score != null && <span>liq {Math.round(Number(contract.liquidity_score))}</span>}
            <span>· {timeAgo(signal.created_at)}</span>
          </div>

          {Array.isArray(signal.reasons) && signal.reasons.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
              {(signal.reasons as string[]).slice(0, 3).map((r, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-bull mt-px">✓</span>
                  <span className="line-clamp-1">{r}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="hidden md:block w-40 shrink-0">
          <SignalRadar signal={signal} compact />
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          <Button
            size="sm"
            className={cn(isCall ? "bg-bull text-bull-foreground hover:bg-bull/90" : "bg-bear text-bear-foreground hover:bg-bear/90")}
            onClick={() => onApprove(signal)}
          >
            Approve
          </Button>
          {onReject && (
            <Button size="sm" variant="ghost" onClick={() => onReject(signal)}>
              <X className="h-4 w-4 mr-1" /> Reject
            </Button>
          )}
          <Button size="sm" variant="outline" className="bg-transparent gap-1" asChild>
            <Link to={`/app/analyst?signal=${signal.id}`}>
              <Brain className="h-3.5 w-3.5" /> Analyze
            </Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDetails(signal, breakdown)}>
            <Info className="h-4 w-4 mr-1" /> Details
          </Button>
        </div>
      </div>
    </div>
  );
}
