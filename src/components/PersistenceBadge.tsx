import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  FREQUENCY_CLASS,
  FREQUENCY_ICON,
  FREQUENCY_LABEL,
  type FrequencyResult,
} from "@/lib/frequencyScore";

type Props = {
  frequency: FrequencyResult | null;
  className?: string;
};

/**
 * Display-only "Signal Frequency / Persistence" badge.
 * Renders "— needs history" when no history is available.
 * Does NOT influence selection, ordering, or buying.
 */
export function PersistenceBadge({ frequency, className }: Props) {
  if (!frequency) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-medium",
          "bg-muted/40 text-muted-foreground border-border",
          className,
        )}
        title="No recent history for this ticker yet"
      >
        — needs history
      </span>
    );
  }

  const { label, frequencyScore, occurrences, agreement, consistency, streak, consideration } =
    frequency;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-semibold cursor-help",
              FREQUENCY_CLASS[label],
              className,
            )}
            aria-label={`Signal persistence: ${FREQUENCY_LABEL[label]}`}
          >
            <span>{FREQUENCY_ICON[label]}</span>
            <span>{FREQUENCY_LABEL[label]}</span>
            <span className="opacity-70">· {frequencyScore}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          <div className="font-semibold mb-1">
            Signal frequency · {FREQUENCY_LABEL[label]}
          </div>
          <ul className="space-y-0.5 text-muted-foreground">
            <li>Occurrences: {occurrences}</li>
            <li>Agreement: {(agreement * 100).toFixed(0)}%</li>
            <li>Consistency: {(consistency * 100).toFixed(0)}%</li>
            <li>Streak: {streak}</li>
            <li>Consideration (ranking-only): {consideration.toFixed(1)}</li>
          </ul>
          <div className="mt-1 text-[10px] text-foreground/70">
            Display only — does not affect selection or buying.
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
