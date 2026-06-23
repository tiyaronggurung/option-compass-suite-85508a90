// Regime-aware confidence adjustment (frontend-only re-rank).
// Layered on top of effectiveConfidence — does NOT mutate stored signal data.
// Goal: surface PUTs when the tape is bearish/volatile, and CALLs when it's bullish.

import type { TradeDirection } from "./techAdjust";

export type MarketRegime = "bull" | "bear" | "sideways" | "high_vol" | null;

/** Multipliers per (regime, direction). Conservative: ±7% / ±3%. */
export function regimeFactor(
  direction: TradeDirection | null | undefined,
  regime: MarketRegime,
): number {
  if (!direction || !regime || regime === "sideways") return 1.0;
  if (regime === "bear" || regime === "high_vol") {
    return direction === "PUT" ? 1.07 : 0.97;
  }
  if (regime === "bull") {
    return direction === "CALL" ? 1.07 : 0.97;
  }
  return 1.0;
}

/** Apply regime factor on top of an already-effective (tech-adjusted) confidence. */
export function regimeAdjustConfidence(
  effConfidence: number | null | undefined,
  direction: TradeDirection | null | undefined,
  regime: MarketRegime,
): number | null {
  if (effConfidence == null || Number.isNaN(effConfidence)) return null;
  return Math.max(1, Math.min(99, Math.round(effConfidence * regimeFactor(direction, regime))));
}
