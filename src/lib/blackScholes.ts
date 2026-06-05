// Black-Scholes pricing + projection helpers (no dividends).
// Pure functions — used by the Buy Option modal's profit calculator.

function erf(x: number): number {
  // Abramowitz & Stegun approximation
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 =  0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function cdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }

export type BSInput = {
  spot: number;         // underlying price
  strike: number;
  tYears: number;       // time to expiry in years
  iv: number;           // implied vol, decimal (0.45 = 45%)
  r?: number;           // risk-free rate, default 4.5%
  type: "call" | "put";
};

export function bsPrice({ spot, strike, tYears, iv, r = 0.045, type }: BSInput): number {
  if (tYears <= 0 || iv <= 0) {
    const intrinsic = type === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    return intrinsic;
  }
  const sigSqrtT = iv * Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * iv * iv) * tYears) / sigSqrtT;
  const d2 = d1 - sigSqrtT;
  if (type === "call") {
    return spot * cdf(d1) - strike * Math.exp(-r * tYears) * cdf(d2);
  }
  return strike * Math.exp(-r * tYears) * cdf(-d2) - spot * cdf(-d1);
}

export type ProjectionRow = {
  pctMove: number;         // -0.10, -0.05, 0, +0.05, +0.10
  underlying: number;
  optionPriceNow: number;        // today (tYears - 1d, or current if same)
  optionPriceAtExpiry: number;
  plNowPerContract: number;      // dollars per 1 contract (×100)
  plExpiryPerContract: number;
};

/**
 * Build a 5-row projection table at fixed % moves.
 * "Now" uses tYears - 1 day (or 0 if expiring today). "At expiry" uses tYears=0 (intrinsic).
 * If `iv` is null/invalid, returns rows with greeks-approx fallback flag (caller decides label).
 */
export function buildProjection(args: {
  spot: number;
  strike: number;
  tYears: number;
  iv: number | null;
  entryPremium: number;
  type: "call" | "put";
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null; // per day
}): { rows: ProjectionRow[]; method: "black_scholes" | "greeks_approx" | "none" } {
  const { spot, strike, tYears, iv, entryPremium, type } = args;
  const moves = [-0.10, -0.05, 0, 0.05, 0.10];
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(entryPremium) || entryPremium <= 0) {
    return { rows: [], method: "none" };
  }

  const useBS = iv != null && Number.isFinite(iv) && iv > 0 && tYears > 0;
  if (useBS) {
    const tNow = Math.max(0, tYears - 1 / 365);
    const rows = moves.map((pct) => {
      const underlying = spot * (1 + pct);
      const optNow = bsPrice({ spot: underlying, strike, tYears: tNow, iv: iv!, type });
      const optExp = bsPrice({ spot: underlying, strike, tYears: 0, iv: iv!, type });
      return {
        pctMove: pct,
        underlying,
        optionPriceNow: optNow,
        optionPriceAtExpiry: optExp,
        plNowPerContract: (optNow - entryPremium) * 100,
        plExpiryPerContract: (optExp - entryPremium) * 100,
      };
    });
    return { rows, method: "black_scholes" };
  }

  // Greeks-based fallback (approx). Δ + ½·Γ·ΔS² for option-price change.
  const d = args.delta ?? (type === "call" ? 0.5 : -0.5);
  const g = args.gamma ?? 0;
  const th = args.theta ?? 0;
  const rows = moves.map((pct) => {
    const underlying = spot * (1 + pct);
    const dS = underlying - spot;
    const dOpt = d * dS + 0.5 * g * dS * dS;
    const optNow = Math.max(0, entryPremium + dOpt + th * 1); // 1-day theta
    // crude expiry: extrapolate to intrinsic
    const intrinsic = type === "call" ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
    return {
      pctMove: pct,
      underlying,
      optionPriceNow: optNow,
      optionPriceAtExpiry: intrinsic,
      plNowPerContract: (optNow - entryPremium) * 100,
      plExpiryPerContract: (intrinsic - entryPremium) * 100,
    };
  });
  return { rows, method: "greeks_approx" };
}

export function breakeven(strike: number, entryPremium: number, type: "call" | "put"): number {
  return type === "call" ? strike + entryPremium : strike - entryPremium;
}

export function daysToExpiry(expiry: string | null | undefined): number {
  if (!expiry) return 0;
  const d = new Date(expiry + "T16:00:00-04:00").getTime();
  return Math.max(0, Math.round((d - Date.now()) / 86_400_000));
}
