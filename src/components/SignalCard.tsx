import { ArrowDownRight, ArrowUpRight, Clock, Flame, Info, Radio, ShieldAlert, TestTube, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtPrice, type Signal, timeAgo } from "@/lib/signalHelpers";
import { deriveTags, type TagId } from "@/lib/signalTags";
import { OUTCOME_CLASS, OUTCOME_LABEL, type SignalOutcome } from "@/lib/signalOutcome";
import { getFreshness } from "@/lib/signalFreshness";
import { ConfirmationBadge } from "@/components/ConfirmationBadge";
import type { ConfirmationMatrix } from "@/lib/confirmations";
import { getTier, TIER_META } from "@/lib/signalTiers";

type Props = {
  signal: Signal;
  onApprove: (s: Signal) => void;
  onReject?: (s: Signal) => void;
  onDetails?: (s: Signal) => void;
  watchlist?: Set<string>;
  outcome?: SignalOutcome;
  subLabel?: string;
};

export function SignalCard({ signal, onApprove, onReject, onDetails, watchlist, outcome = "none", subLabel }: Props) {
  const isCall = signal.direction === "CALL";
  const tier = getTier(signal);
  const tierMeta = TIER_META[tier];
  const ring = tierMeta.ringClass;
  const tags: TagId[] = deriveTags(signal, watchlist ?? new Set());
  const freshness = getFreshness(signal);
  const freshClass =
    freshness === "fresh" ? "bg-bull/15 text-bull"
    : freshness === "aging" ? "bg-warn/15 text-warn"
    : "bg-muted text-muted-foreground";
  const freshLabel = freshness === "fresh" ? "Fresh" : freshness === "aging" ? "Aging" : "Expired";

  return (
    <div className={cn("glass-card p-3 sm:p-4 ring-1 transition hover:ring-primary/40", ring)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <div
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md font-bold ticker-mono shrink-0",
              isCall ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear",
            )}
          >
            {isCall ? <ArrowUpRight className="h-4.5 w-4.5" /> : <ArrowDownRight className="h-4.5 w-4.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="ticker-mono text-base sm:text-lg font-semibold leading-none">{signal.ticker}</span>
              <Badge variant="outline" className={cn("border-0 text-[10px] font-medium px-1.5 py-0", isCall ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear")}>
                {signal.direction}
              </Badge>
              {tier !== "rejected" && (
                <Badge className={cn("border-0 text-[10px] px-1.5 py-0 gap-1", tierMeta.className)}>
                  <span>{tierMeta.emoji}</span> {tierMeta.label}
                </Badge>
              )}
              {signal.dte === 0 && (
                <Badge className="bg-warn/15 text-warn border-0 text-[10px] px-1.5 py-0">0DTE</Badge>
              )}
              {signal.is_demo ? (
                <Badge variant="outline" className="border-border text-muted-foreground gap-1 text-[10px] px-1.5 py-0" title="Seeded demo signal">
                  <TestTube className="h-3 w-3" /> Demo
                </Badge>
              ) : (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-0 gap-1 text-[10px] px-1.5 py-0" title={signal.source ?? "Live"}>
                  <Radio className="h-3 w-3" /> Live
                </Badge>
              )}
              {outcome !== "none" && (
                <Badge className={cn("border-0 text-[10px] px-1.5 py-0", OUTCOME_CLASS[outcome])} title={`Trade outcome: ${OUTCOME_LABEL[outcome]}`}>
                  {OUTCOME_LABEL[outcome]}
                </Badge>
              )}
              <Badge className={cn("border-0 gap-1 text-[10px] px-1.5 py-0", freshClass)} title={`Signal freshness: ${freshLabel}`}>
                <Timer className="h-3 w-3" /> {freshLabel}
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-x-2 gap-y-0.5 mt-1 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {timeAgo(signal.created_at)}
              </span>
              <span className="ticker-mono">${fmtPrice(Number(signal.price))}</span>
              {signal.contract_symbol && signal.strike != null ? (
                <span className="ticker-mono">
                  · {signal.direction} {Number(signal.strike).toFixed(0)}
                  {signal.dte != null ? ` · ${signal.dte}d` : ""}
                  {signal.premium != null ? ` · $${fmtPrice(Number(signal.premium))} mid` : ""}
                </span>
              ) : (
                <span>· No contract yet</span>
              )}
            </div>
          </div>
        </div>

        <ConfidenceRing value={signal.confidence} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <RiskBadge level={signal.risk_level} />
        {signal.confidence >= 80 && (
          <Badge className="bg-primary/15 text-primary border-0 gap-1 text-[10px] px-1.5 py-0">
            <Flame className="h-3 w-3" /> High conviction
          </Badge>
        )}
        {tags.filter((t) => t !== "High Risk" && t !== "0DTE").map((t) => (
          <Badge key={t} variant="outline" className="border-border/60 text-[10px] text-muted-foreground px-1.5 py-0">
            {t}
          </Badge>
        ))}
        {signal.dte != null && signal.dte !== 0 && (
          <Badge variant="outline" className="border-border text-muted-foreground text-[10px] px-1.5 py-0">
            {signal.dte}DTE
          </Badge>
        )}
      </div>

      <ConfirmationBadge
        className="mt-2"
        matrix={(signal as any).source_confirmations as ConfirmationMatrix | null}
        direction={signal.direction as "CALL" | "PUT"}
      />

      {Array.isArray(signal.reasons) && signal.reasons.length > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground line-clamp-2">
          {(signal.reasons as string[]).slice(0, 2).join(" · ")}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Button size="sm" className={cn("flex-1 sm:flex-none min-w-0", isCall ? "bg-bull text-bull-foreground hover:bg-bull/90" : "bg-bear text-bear-foreground hover:bg-bear/90")}
          onClick={() => onApprove(signal)}>
          Approve paper trade
        </Button>
        {onReject && (
          <Button size="sm" variant="ghost" onClick={() => onReject(signal)}>
            <X className="h-4 w-4 mr-1" /> Reject
          </Button>
        )}
        {onDetails && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onDetails(signal)}>
            <Info className="h-4 w-4" />
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
