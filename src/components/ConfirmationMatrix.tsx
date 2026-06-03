import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { SOURCE_META, SOURCE_ORDER, summarize, type ConfirmationMatrix as Matrix } from "@/lib/confirmations";

type Props = {
  matrix: Matrix | null | undefined;
  direction: "CALL" | "PUT";
  score?: number | null;
  label?: string | null;
};

export function ConfirmationMatrix({ matrix, direction, score, label }: Props) {
  const { agreeing, conflicting, configured } = summarize(matrix, direction);
  const wanted = direction === "CALL" ? "bullish" : "bearish";

  return (
    <div className="pt-2 border-t border-border">
      <div className="text-xs text-muted-foreground mb-1.5 flex items-center justify-between">
        <span>Source confirmation</span>
        <span className={cn(
          "ticker-mono text-xs",
          (score ?? 0) >= 60 ? "text-bull" : (score ?? 0) >= 30 ? "text-primary" : "text-muted-foreground",
        )}>
          {score != null ? `${score}/100` : "—"}
        </span>
      </div>

      {label && (
        <div className="text-[11px] text-muted-foreground mb-2">
          {label} · {agreeing} agree / {conflicting} disagree / {configured} configured
        </div>
      )}

      <div className="rounded border border-border/60 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr>
              <th className="text-left px-2 py-1.5 font-normal">Source</th>
              <th className="text-left font-normal">Stance</th>
              <th className="text-right font-normal">Score</th>
              <th className="text-left px-2 font-normal">Reason</th>
            </tr>
          </thead>
          <tbody>
            {SOURCE_ORDER.map((k) => {
              const meta = SOURCE_META[k];
              const c = matrix?.[k];
              const stance = c?.stance ?? "neutral";
              const isAgree = stance === wanted;
              const isConflict = stance !== "neutral" && stance !== wanted;
              const stanceClass = isAgree
                ? "text-bull"
                : isConflict
                  ? "text-bear"
                  : "text-muted-foreground";
              return (
                <tr key={k} className="border-t border-border/40">
                  <td className="px-2 py-1.5">
                    <span className="mr-1">{meta.icon}</span>
                    <span>{meta.label}</span>
                    {meta.noisy && (
                      <span className="ml-1 text-[9px] text-warn" title="Social data is noisy and manipulable">
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className={cn("uppercase tracking-wide text-[10px]", stanceClass)}>
                    {stance}
                  </td>
                  <td className="text-right ticker-mono pr-2">
                    {c ? c.score.toFixed(2) : "—"}
                  </td>
                  <td className="px-2 text-[11px] text-foreground/70">
                    {c?.reason ?? "—"}
                    {c?.last_updated && (
                      <span className="text-muted-foreground/60 ml-1">
                        · {new Date(c.last_updated).toLocaleTimeString()}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
        <AlertTriangle className="h-3 w-3 mt-px text-warn shrink-0" />
        <span>
          Social and prediction-market data are noisy and manipulable. Alpaca remains the primary source;
          other channels only confirm or conflict and never create signals alone.
        </span>
      </div>
    </div>
  );
}
