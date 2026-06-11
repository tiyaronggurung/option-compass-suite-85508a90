// Pure helper + react-query hook that evaluates whether the #1-ranked signal
// is "still the best decision right now". Read-only: no engine, no writes.
//
// States are intentionally coarse — we never expose the raw fallback count,
// penalty number, or macro score to the user.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Signal } from "@/lib/signalHelpers";

export type StillBestState =
  | "still_best"      // green: fresh, in window, macro OK, data quality good
  | "stale"           // amber: signal too old for auto-entry
  | "outside_window"  // muted: outside 10:00–15:00 ET
  | "macro_blocks"    // red: latest macro snapshot is against the direction
  | "degraded";       // amber: current fallback_count >= 2 (subtle warning)

export type StillBestVerdict = {
  state: StillBestState;
  label: string;
  reason: string; // short tooltip line, no raw numbers
};

const MAX_AGE_MIN = 5;            // matches default rules.max_signal_age_minutes
const MACRO_FRESH_MIN = 30;       // ignore macro check if snapshot older than this
const MACRO_BLOCK_THRESHOLD = 1;  // |tailwind| > 1 against direction blocks
const WINDOW_START_HOUR_ET = 10;
const WINDOW_END_HOUR_ET = 15;

function nyHourNow(): number {
  // Hour in America/New_York, 24h.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(h, 10);
}

type MacroSnap = {
  captured_at: string | null;
  macro_tailwind_score: number | null;
} | null;

export function evaluateStillBest(signal: Signal, macro: MacroSnap): StillBestVerdict {
  const now = Date.now();

  // 1. Outside trading window — muted, lowest urgency.
  const hour = nyHourNow();
  if (hour < WINDOW_START_HOUR_ET || hour >= WINDOW_END_HOUR_ET) {
    return {
      state: "outside_window",
      label: "Outside window",
      reason: "Auto-entry only runs 10:00–15:00 ET.",
    };
  }

  // 2. Stale — older than the auto-entry max age.
  const ageMs = now - new Date(signal.created_at).getTime();
  if (ageMs > MAX_AGE_MIN * 60_000) {
    return {
      state: "stale",
      label: "Stale",
      reason: "Signal is older than the auto-entry freshness window.",
    };
  }

  // 3. Macro blocks — only if snapshot itself is fresh enough to trust.
  if (macro && macro.captured_at && macro.macro_tailwind_score != null) {
    const macroAgeMin = (now - new Date(macro.captured_at).getTime()) / 60_000;
    if (macroAgeMin <= MACRO_FRESH_MIN) {
      const tw = Number(macro.macro_tailwind_score);
      const dir = String(signal.direction ?? "").toUpperCase();
      const against =
        (dir === "CALL" && tw < -MACRO_BLOCK_THRESHOLD) ||
        (dir === "PUT" && tw > MACRO_BLOCK_THRESHOLD);
      if (against) {
        return {
          state: "macro_blocks",
          label: "Macro blocks",
          reason: "Current market regime is against this direction.",
        };
      }
    }
  }

  // 4. Degraded data quality — score is partially estimated.
  const fc = Number(signal.fallback_count ?? 0);
  if (fc >= 2) {
    return {
      state: "degraded",
      label: "Partial data",
      reason: "Score is partially estimated — some inputs unavailable.",
    };
  }

  // 5. Still best.
  return {
    state: "still_best",
    label: "Still best",
    reason: "Fresh, in window, macro neutral, full data.",
  };
}

export function useStillBest(signal: Signal | null, enabled: boolean): StillBestVerdict | null {
  const { data: macro } = useQuery({
    queryKey: ["macro-latest-for-still-best"],
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<MacroSnap> => {
      const { data } = await supabase
        .from("macro_regime_snapshots")
        .select("captured_at, macro_tailwind_score")
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as MacroSnap;
    },
  });

  if (!signal || !enabled) return null;
  return evaluateStillBest(signal, macro ?? null);
}
