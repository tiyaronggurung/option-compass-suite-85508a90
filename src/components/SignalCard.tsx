import { ArrowDownRight, ArrowUpRight, Clock, Flame, Radio, ShieldAlert, TestTube, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtPrice, type Signal, timeAgo } from "@/lib/signalHelpers";

type Props = {
  signal: Signal;
  onApprove: (s: Signal) => void;
  onReject?: (s: Signal) => void;
};

export function SignalCard({ signal, onApprove, onReject }: Props) {
  const isCall = signal.direction === "CALL";
  const dirColor = isCall ? "text-bull" : "text-bear";
  const ring =
    signal.confidence >= 80 ? "ring-bull/40" : signal.confidence >= 65 ? "ring-primary/30" : "ring-border";

  return (
    <div className={cn("glass-card p-4 ring-1 transition hover:ring-primary/40", ring)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-lg font-bold ticker-mono",
              isCall ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear",
            )}
          >
            {isCall ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="ticker-mono text-lg font-semibold">{signal.ticker}</span>
              <Badge variant="outline" className={cn("border-0 text-xs font-medium", isCall ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear")}>
                {signal.direction}
              </Badge>
              {signal.dte === 0 && (
                <Badge className="bg-warn/15 text-warn border-0 text-xs">0DTE</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
              <Clock className="h-3 w-3" />
              {timeAgo(signal.created_at)} · ${fmtPrice(Number(signal.price))} · {signal.contract_symbol ?? "—"}
            </div>
          </div>
        </div>

        <ConfidenceRing value={signal.confidence} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <RiskBadge level={signal.risk_level} />
        {signal.confidence >= 80 && (
          <Badge className="bg-primary/15 text-primary border-0 gap-1">
            <Flame className="h-3 w-3" /> High conviction
          </Badge>
        )}
        {signal.dte != null && (
          <Badge variant="outline" className="border-border text-muted-foreground">
            {signal.dte}DTE
          </Badge>
        )}
        {Array.isArray(signal.reasons) && signal.reasons.length > 0 && (
          <span className="text-xs text-muted-foreground line-clamp-1">
            · {(signal.reasons as string[]).slice(0, 2).join(" · ")}
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" className={cn(isCall ? "bg-bull text-bull-foreground hover:bg-bull/90" : "bg-bear text-bear-foreground hover:bg-bear/90")}
          onClick={() => onApprove(signal)}>
          Approve paper trade
        </Button>
        {onReject && (
          <Button size="sm" variant="ghost" onClick={() => onReject(signal)}>
            <X className="h-4 w-4 mr-1" /> Reject
          </Button>
        )}
      </div>
    </div>
  );
}

function ConfidenceRing({ value }: { value: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const dash = (value / 100) * c;
  const color = value >= 80 ? "hsl(var(--bull))" : value >= 65 ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))";
  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg viewBox="0 0 44 44" className="h-12 w-12 -rotate-90">
        <circle cx="22" cy="22" r={r} stroke="hsl(var(--border))" strokeWidth="4" fill="none" />
        <circle cx="22" cy="22" r={r} stroke={color} strokeWidth="4" fill="none" strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-[11px] font-semibold ticker-mono">{value}</div>
    </div>
  );
}

function RiskBadge({ level }: { level: Signal["risk_level"] }) {
  const map: Record<string, string> = {
    LOW: "bg-bull/15 text-bull",
    MEDIUM: "bg-warn/15 text-warn",
    HIGH: "bg-bear/15 text-bear",
  };
  return (
    <Badge className={cn("border-0 gap-1", map[level])}>
      <ShieldAlert className="h-3 w-3" /> {level} risk
    </Badge>
  );
}
