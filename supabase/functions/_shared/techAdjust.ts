// Edge-function copy of src/lib/techAdjust.ts — keep the two in sync.
// Single source of truth for the technical-trend confidence adjustment factors.

export type TechVerdict = "bullish" | "neutral" | "bearish";
export type TradeDirection = "CALL" | "PUT";

export const TECH_FACTORS = {
  aligned: 1.05,
  opposed: 0.90,
  neutral: 1.00,
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
  return TECH_FACTORS[alignment(direction, verdict)];
}

export function techAdjustConfidence(
  baseConfidence: number | null | undefined,
  direction: TradeDirection | null | undefined,
  verdict: TechVerdict | null | undefined,
): number | null {
  if (baseConfidence == null || Number.isNaN(baseConfidence)) return null;
  return Math.max(1, Math.min(99, Math.round(baseConfidence * techFactor(direction, verdict))));
}
