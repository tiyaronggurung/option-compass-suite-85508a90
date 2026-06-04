// Frontend mirror of supabase/functions/_shared/lifecycle.ts types + UI metadata.
import type { Signal } from "@/lib/signalHelpers";

export type LifecycleState = "fresh" | "active" | "weakening" | "expired" | "invalidated";

export const LIFECYCLE_ORDER: LifecycleState[] = [
  "fresh",
  "active",
  "weakening",
  "expired",
  "invalidated",
];

export const LIFECYCLE_META: Record<LifecycleState, {
  label: string;
  emoji: string;
  className: string;
  description: string;
}> = {
  fresh:       { label: "Fresh",       emoji: "🟢", className: "bg-bull/15 text-bull",       description: "Just published, thesis intact" },
  active:      { label: "Active",      emoji: "🔵", className: "bg-primary/15 text-primary", description: "Thesis intact, within window" },
  weakening:   { label: "Weakening",   emoji: "🟡", className: "bg-warn/15 text-warn",       description: "Confidence or flow softening" },
  expired:     { label: "Expired",     emoji: "⏳", className: "bg-muted text-muted-foreground", description: "TTL exceeded, no fresh confirmation" },
  invalidated: { label: "Invalidated", emoji: "🔴", className: "bg-bear/15 text-bear",       description: "Thesis broken" },
};

export function getLifecycleState(signal: Signal): LifecycleState {
  const raw = (signal as any).lifecycle_state as string | null | undefined;
  if (raw && (LIFECYCLE_ORDER as string[]).includes(raw)) return raw as LifecycleState;
  return "active";
}

export function isTerminalLifecycle(s: LifecycleState): boolean {
  return s === "expired" || s === "invalidated";
}

export function tierTtlHours(confidenceAtBirth: number | null | undefined): number {
  const c = confidenceAtBirth ?? 0;
  if (c >= 90) return 48;
  if (c >= 80) return 36;
  if (c >= 70) return 24;
  if (c >= 65) return 12;
  return 6;
}

export type LifecycleHistoryEntry = {
  state: LifecycleState;
  reason: string;
  at: string;
  confidence: number;
};

export function getLifecycleHistory(signal: Signal): LifecycleHistoryEntry[] {
  const raw = (signal as any).lifecycle_history;
  if (!Array.isArray(raw)) return [];
  return raw as LifecycleHistoryEntry[];
}
