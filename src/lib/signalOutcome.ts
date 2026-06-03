import type { PaperTrade, Signal } from "./signalHelpers";

export type SignalOutcome = "open" | "won" | "lost" | "closed" | "approved" | "dismissed" | "none";

export function signalOutcome(
  signal: Signal,
  trades: PaperTrade[] | null | undefined,
  dismissedIds: Set<string> | null | undefined,
): SignalOutcome {
  const trade = trades?.find((t) => t.signal_id === signal.id);
  if (trade) {
    if (trade.status === "OPEN") return "open";
    if (trade.status === "WIN") return "won";
    if (trade.status === "LOSS") return "lost";
    return "closed";
  }
  if (dismissedIds?.has(signal.id)) return "dismissed";
  return "none";
}

export const OUTCOME_LABEL: Record<SignalOutcome, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
  closed: "Closed",
  approved: "Approved",
  dismissed: "Dismissed",
  none: "—",
};

export const OUTCOME_CLASS: Record<SignalOutcome, string> = {
  open: "bg-info/15 text-info",
  won: "bg-bull/15 text-bull",
  lost: "bg-bear/15 text-bear",
  closed: "bg-muted text-muted-foreground",
  approved: "bg-primary/15 text-primary",
  dismissed: "bg-muted text-muted-foreground",
  none: "hidden",
};
