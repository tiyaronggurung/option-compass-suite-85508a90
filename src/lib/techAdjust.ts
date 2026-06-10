// Single source of truth for technical-trend confidence adjustment.
// Used by both the edge function (via a copy in supabase/functions/_shared/techAdjust.ts)
// and the frontend (TechnicalTrendCard, SignalCard, etc).
//
// Rule: technicals that ALIGN with the trade direction nudge confidence up;
// technicals that OPPOSE the trade direction nudge it down.

export type TechVerdict = "bullish" | "neutral" | "bearish";
export type TradeDirection = "CALL" | "PUT";

export const TECH_FACTORS = {
  aligned:  1.05,   // CALL+bullish OR PUT+bearish  → +5%
  opposed:  0.90,   // CALL+bearish OR PUT+bullish  → −10%
  neutral:  1.00,
} as const;

export function alignment(
  direction: TradeDirection | null | undefined,
  verdict: TechVerdict | null | undefined,
): "aligned" | "opposed" | "neutral" {
  if (!direction || !verdict || verdict === "neutral") return "neutral";
  if (direction === "CALL") return verdict === "bullish" ? "aligned" : "opposed";
  return verdict === "bearish" ? "aligned" : "opposed";
}

export function techFactor(
  direction: TradeDirection | null | undefined,
  verdict: TechVerdict | null | undefined,
): number {
  const a = alignment(direction, verdict);
  return TECH_FACTORS[a];
}

/** Apply the tech factor to a base confidence and clamp to [1, 99]. */
export function techAdjustConfidence(
  baseConfidence: number | null | undefined,
  direction: TradeDirection | null | undefined,
  verdict: TechVerdict | null | undefined,
): number | null {
  if (baseConfidence == null || Number.isNaN(baseConfidence)) return null;
  const factor = techFactor(direction, verdict);
  return Math.max(1, Math.min(99, Math.round(baseConfidence * factor)));
}

/** Pick the effective confidence shown to users: stored adjusted (if any) else raw. */
export function effectiveConfidence(s: {
  confidence?: number | null;
  tech_adjusted_confidence?: number | null;
}): number | null {
  if (s.tech_adjusted_confidence != null) return s.tech_adjusted_confidence;
  return s.confidence ?? null;
}
