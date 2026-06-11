import { Check, AlertTriangle, Clock, ShieldX, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { StillBestVerdict } from "@/lib/stillBest";

type Props = {
  verdict: StillBestVerdict | null;
  className?: string;
};

const STYLES: Record<StillBestVerdict["state"], { cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  still_best:     { cls: "bg-bull/15 text-bull",                       Icon: Check },
  stale:          { cls: "bg-warn/15 text-warn",                       Icon: Clock },
  degraded:       { cls: "bg-warn/15 text-warn",                       Icon: AlertTriangle },
  macro_blocks:   { cls: "bg-bear/15 text-bear",                       Icon: ShieldX },
  outside_window: { cls: "bg-muted text-muted-foreground",             Icon: Moon },
};

export function StillBestBadge({ verdict, className }: Props) {
  if (!verdict) return null;
  const { cls, Icon } = STYLES[verdict.state];
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border-0 cursor-help",
              cls,
              className,
            )}
          >
            <Icon className="h-3 w-3" />
            {verdict.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px] text-xs">
          {verdict.reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
