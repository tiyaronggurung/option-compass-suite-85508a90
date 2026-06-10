import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { SOURCE_META, SOURCE_ORDER, summarize, isWired, type ConfirmationMatrix, type SourceKey } from "@/lib/confirmations";

type Props = {
  matrix: ConfirmationMatrix | null | undefined;
  direction: "CALL" | "PUT";
  className?: string;
};

export function ConfirmationBadge({ matrix, direction, className }: Props) {
  const { agreeing, conflicting, configured } = summarize(matrix, direction);
  if (!configured) return null;

  const hasConflict = conflicting > 0;
  const strong = agreeing >= 3;
  const moderate = agreeing === 2;

  const Icon = hasConflict ? ShieldAlert : strong || moderate ? ShieldCheck : ShieldQuestion;
  const color = hasConflict
    ? "bg-bear/15 text-bear"
    : strong
      ? "bg-bull/20 text-bull"
      : moderate
        ? "bg-primary/15 text-primary"
        : "bg-muted text-muted-foreground";

  const label = hasConflict
    ? `Conflict (${conflicting})`
    : `${agreeing}/${configured} confirm`;

  const wanted = direction === "CALL" ? "bullish" : "bearish";

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <Badge
        className={cn("border-0 gap-1 text-[10px] px-1.5 py-0", color)}
        title={`${agreeing} agree, ${conflicting} disagree across ${configured} wired source${configured === 1 ? "" : "s"}. More sources coming soon.`}
      >
        <Icon className="h-3 w-3" /> {label}
      </Badge>
      <div className="flex items-center gap-0.5">
        {SOURCE_ORDER.map((k: SourceKey) => {
          if (!isWired(k)) return null;
          const c = matrix?.[k];
          if (!c?.configured) return null;
          const agree = c.stance === wanted;
          const conflict = c.stance !== "neutral" && c.stance !== wanted;
          const dotColor = conflict ? "bg-bear" : agree ? "bg-bull" : "bg-muted-foreground/40";
          return (
            <span
              key={k}
              className={cn("inline-block h-1.5 w-1.5 rounded-full", dotColor)}
              title={`${SOURCE_META[k].label}: ${c.stance} — ${c.reason}`}
            />
          );
        })}
      </div>
    </div>
  );
}
