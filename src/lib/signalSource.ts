// Cross-source classification for signals (UI side).
// Mirrors supabase/functions/_shared/crossSourceMatch.ts.

export type SourceClass = "alpaca" | "unusual_whales" | "other";

export function classifySignalSource(source: string | null | undefined): SourceClass {
  const s = (source ?? "").toLowerCase();
  if (s.includes("unusual") && s.includes("whales")) return "unusual_whales";
  if (s.includes("uw_flow") || s === "unusual_whales") return "unusual_whales";
  if (s.includes("alpaca")) return "alpaca";
  return "other";
}

export type SourceFilter = "all" | "alpaca" | "unusual_whales" | "confirmed_by_both";

export const SOURCE_FILTER_OPTIONS: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "confirmed_by_both", label: "Confirmed by both" },
  { id: "unusual_whales", label: "Unusual Whales" },
  { id: "alpaca", label: "Alpaca" },
];

export function matchesSourceFilter(
  signal: { source?: string | null; confirmed_by_both?: boolean | null },
  filter: SourceFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "confirmed_by_both") return !!signal.confirmed_by_both;
  return classifySignalSource(signal.source) === filter;
}

// Sort key: confirmed_by_both > unusual_whales > alpaca > other, then confidence desc.
export function sourcePriority(
  signal: { source?: string | null; confirmed_by_both?: boolean | null; confidence?: number | null },
): number {
  if (signal.confirmed_by_both) return 0;
  const k = classifySignalSource(signal.source);
  if (k === "unusual_whales") return 1;
  if (k === "alpaca") return 2;
  return 3;
}

export function sortSignalsBySourcePriority<T extends { source?: string | null; confirmed_by_both?: boolean | null; confidence?: number | null }>(
  signals: T[],
): T[] {
  return [...signals].sort((a, b) => {
    const pa = sourcePriority(a);
    const pb = sourcePriority(b);
    if (pa !== pb) return pa - pb;
    return (Number(b.confidence ?? 0)) - (Number(a.confidence ?? 0));
  });
}
