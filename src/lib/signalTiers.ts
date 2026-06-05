// Tier helpers for the institutional signal engine.
import type { Signal } from "@/lib/signalHelpers";

export type Tier = "elite" | "strong" | "watchlist" | "rejected";

export function tierFor(confidence: number): Tier {
  if (confidence >= 90) return "elite";
  if (confidence >= 80) return "strong";
  if (confidence >= 70) return "watchlist";
  return "rejected";
}

export function getTier(signal: Signal): Tier {
  const t = (signal as any).tier as Tier | undefined | null;
  if (t && (t in TIER_META)) return t;
  return tierFor(signal.confidence);
}

export const TIER_META: Record<Tier, { label: string; emoji: string; className: string; ringClass: string }> = {
  elite:     { label: "Elite",     emoji: "🔥", className: "bg-bear/15 text-bear",        ringClass: "ring-bear/40" },
  strong:    { label: "Strong",    emoji: "🚀", className: "bg-bull/15 text-bull",        ringClass: "ring-bull/40" },
  watchlist: { label: "Watchlist", emoji: "👀", className: "bg-primary/15 text-primary",  ringClass: "ring-primary/30" },
  rejected:  { label: "Rejected",  emoji: "—",  className: "bg-muted text-muted-foreground", ringClass: "ring-border" },
};
