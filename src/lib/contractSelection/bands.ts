// Contract Selection Engine — band preferences (Hybrid philosophy).
// Lower confidence  -> safer (higher delta, more intrinsic, tighter liquidity).
// Higher confidence -> allow more leverage.
//
// Paper-only. These do NOT affect scoring, thresholds, scanner, or signal generation.

export type RiskProfile =
  | "developing"
  | "near_watchlist"
  | "watchlist"
  | "strong"
  | "elite";

export type BandPrefs = {
  dteMin: number;
  dteMax: number;
  deltaMin: number;
  deltaMax: number;
  maxSpreadPct: number; // e.g. 5 means 5%
  minOI: number;
  minVolume: number;
};

export const BAND_PREFS: Record<RiskProfile, BandPrefs> = {
  developing:     { dteMin: 30, dteMax: 45, deltaMin: 0.65, deltaMax: 0.75, maxSpreadPct: 5,  minOI: 500, minVolume: 100 },
  near_watchlist: { dteMin: 28, dteMax: 45, deltaMin: 0.55, deltaMax: 0.70, maxSpreadPct: 6,  minOI: 400, minVolume: 100 },
  watchlist:      { dteMin: 21, dteMax: 40, deltaMin: 0.50, deltaMax: 0.65, maxSpreadPct: 7,  minOI: 300, minVolume: 75  },
  strong:         { dteMin: 14, dteMax: 35, deltaMin: 0.45, deltaMax: 0.60, maxSpreadPct: 8,  minOI: 250, minVolume: 50  },
  elite:          { dteMin: 14, dteMax: 30, deltaMin: 0.40, deltaMax: 0.55, maxSpreadPct: 10, minOI: 200, minVolume: 50  },
};

export const MIN_DTE_FLOOR = 6;           // never select 0-6 DTE in v1
export const MAX_PREMIUM_DOLLARS = 5000;  // affordability cap (per 1 contract = premium*100)

export function profileForConfidence(c: number): RiskProfile {
  if (c >= 90) return "elite";
  if (c >= 80) return "strong";
  if (c >= 70) return "watchlist";
  if (c >= 65) return "near_watchlist";
  return "developing";
}
