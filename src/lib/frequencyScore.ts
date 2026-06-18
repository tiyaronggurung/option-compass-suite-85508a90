// Signal Frequency / Persistence — pure, display-only helper.
// Surfaces how often and how consistently a signal direction has been firing
// recently for a given ticker. Produces a ranking-only "consideration" value
// that DOES NOT replace currentStrength. Selection, ordering of buys, and
// trade execution must keep using currentStrength.

export const FREQUENCY_THRESHOLDS = {
  ACTIONABLE_STRENGTH: 50,
  WINDOW: 10,
  DISPERSION_NORM: 20,
  MAX_BOOST: 0.30,
  PERSISTENT: 0.66,
} as const;

export type FrequencyLabel = "one-off" | "building" | "persistent";

export type FrequencyObservation = {
  strength: number;
  direction: "CALL" | "PUT";
};

export type FrequencyResult = {
  occurrences: number;
  agreement: number;       // 0..1 — share of recent actionable obs in same direction as current
  consistency: number;     // 0..1 — 1 minus normalized strength dispersion
  streak: number;          // consecutive same-direction actionable obs from most recent
  frequencyScore: number;  // 0..100
  consideration: number;   // ranking-only: current.strength * (1 + boost)
  label: FrequencyLabel;
};

/**
 * Compute frequency / persistence for the current signal vs its recent history.
 * `history` should be ordered MOST RECENT FIRST and exclude `current`.
 */
export function computeFrequency(
  current: FrequencyObservation,
  history: FrequencyObservation[],
): FrequencyResult {
  const T = FREQUENCY_THRESHOLDS;
  const recent = [current, ...history].slice(0, T.WINDOW);
  const actionable = recent.filter((o) => o.strength >= T.ACTIONABLE_STRENGTH);
  const occurrences = actionable.length;

  if (occurrences <= 1) {
    return {
      occurrences,
      agreement: occurrences === 1 ? 1 : 0,
      consistency: 1,
      streak: occurrences,
      frequencyScore: 0,
      consideration: current.strength,
      label: "one-off",
    };
  }

  const sameDir = actionable.filter((o) => o.direction === current.direction).length;
  const agreement = sameDir / actionable.length;

  const strengths = actionable.map((o) => o.strength);
  const mean = strengths.reduce((a, b) => a + b, 0) / strengths.length;
  const variance =
    strengths.reduce((s, v) => s + (v - mean) ** 2, 0) / strengths.length;
  const std = Math.sqrt(variance);
  const consistency = Math.max(0, Math.min(1, 1 - std / T.DISPERSION_NORM));

  let streak = 0;
  for (const o of recent) {
    if (o.direction === current.direction && o.strength >= T.ACTIONABLE_STRENGTH) {
      streak++;
    } else {
      break;
    }
  }

  const density = Math.min(1, occurrences / T.WINDOW);
  const streakNorm = Math.min(1, streak / T.WINDOW);

  const frequencyScore = Math.round(
    100 * (0.35 * density + 0.25 * agreement + 0.2 * consistency + 0.2 * streakNorm),
  );

  const boost = (frequencyScore / 100) * T.MAX_BOOST;
  const consideration = current.strength * (1 + boost);

  const label: FrequencyLabel =
    frequencyScore >= T.PERSISTENT * 100
      ? "persistent"
      : occurrences <= 1
        ? "one-off"
        : "building";

  return {
    occurrences,
    agreement,
    consistency,
    streak,
    frequencyScore,
    consideration,
    label,
  };
}

export const FREQUENCY_LABEL: Record<FrequencyLabel, string> = {
  "one-off": "One-off",
  building: "Building",
  persistent: "Persistent",
};

export const FREQUENCY_ICON: Record<FrequencyLabel, string> = {
  "one-off": "⚪",
  building: "🟡",
  persistent: "🟢",
};

export const FREQUENCY_CLASS: Record<FrequencyLabel, string> = {
  "one-off": "bg-muted text-muted-foreground border-border",
  building: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  persistent: "bg-bull/15 text-bull border-bull/30",
};
