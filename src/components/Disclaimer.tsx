import { ShieldAlert } from "lucide-react";

export const DISCLAIMER_TEXT =
  "OptionFlow AI Pro is educational software for research and paper trading. Signals are not financial advice. Options are risky and can expire worthless. Past performance and backtests do not guarantee future results.";

export function DisclaimerBar({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-muted-foreground">
      <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-warn" />
      <p className={compact ? "line-clamp-2" : ""}>{DISCLAIMER_TEXT}</p>
    </div>
  );
}
