// Cost efficiency analysis for option contracts.
// Pure, display-only helper. No selector, sort, or filter behavior depends on this yet —
// the badge in the UI is the only consumer. If/when sorting or the edge-function
// selector adopts the same rule, they MUST import from here so the verdict stays
// in sync with what the user sees.

export type CostEfficiencyVerdict = "efficient" | "marginal" | "theta_trap";

export type CostEfficiencyInput = {
  premium: number;           // per-share option premium (mid/entry), e.g. 1.25
  strike: number;
  spot: number;
  dte: number;               // calendar days to expiry
  theta?: number | null;     // per-day, sign-agnostic (we take |theta|)
  type: "call" | "put";
  equity?: number | null;    // account equity, optional. If absent, premium% rule is skipped.
};

export type CostEfficiencyResult = {
  thetaDragPct: number | null;       // |theta| / premium, as % per day
  breakevenMovePct: number | null;   // % underlying must move to breakeven
  premiumPctOfEquity: number | null; // contract notional cost (premium × 100) / equity, %
  verdict: CostEfficiencyVerdict;
  reasons: string[];                  // human-readable diagnostics
};

// Thresholds — central source of truth.
// NOTE: DTE_SHORT is intentionally a *soft* signal (marginal at worst) because some
// legitimate short-dated momentum plays would otherwise get an undeserved theta_trap.
// Theta drag and breakeven% are the hard rules.
export const COST_EFFICIENCY_THRESHOLDS = {
  THETA_DRAG_TRAP_PCT: 1.0,        // |theta|/premium > 1%/day → theta_trap
  THETA_DRAG_MARGINAL_PCT: 0.5,    // 0.5–1%/day → marginal
  BREAKEVEN_TRAP_PCT: 5.0,         // breakeven > 5% move → theta_trap
  BREAKEVEN_MARGINAL_PCT: 3.0,     // 3–5% → marginal
  PREMIUM_PCT_TRAP: 10.0,          // contract > 10% of equity → theta_trap
  PREMIUM_PCT_MARGINAL: 5.0,       // 5–10% → marginal
  DTE_SHORT: 14,                   // < 14 DTE → at most marginal
} as const;

export function analyzeCostEfficiency(input: CostEfficiencyInput): CostEfficiencyResult {
  const { premium, strike, spot, dte, theta, type, equity } = input;
  const reasons: string[] = [];

  const validPremium = Number.isFinite(premium) && premium > 0;
  const validSpot = Number.isFinite(spot) && spot > 0;

  const thetaDragPct =
    validPremium && theta != null && Number.isFinite(theta)
      ? (Math.abs(theta) / premium) * 100
      : null;

  const breakeven = type === "call" ? strike + premium : strike - premium;
  const breakevenMovePct =
    validSpot && validPremium && Number.isFinite(strike)
      ? Math.abs((breakeven - spot) / spot) * 100
      : null;

  const premiumPctOfEquity =
    validPremium && equity != null && Number.isFinite(equity) && equity > 0
      ? ((premium * 100) / equity) * 100
      : null;

  const T = COST_EFFICIENCY_THRESHOLDS;
  let level: 0 | 1 | 2 = 0; // 0 efficient, 1 marginal, 2 trap

  if (thetaDragPct != null) {
    if (thetaDragPct > T.THETA_DRAG_TRAP_PCT) {
      level = Math.max(level, 2) as 0 | 1 | 2;
      reasons.push(`Theta drag ${thetaDragPct.toFixed(2)}%/day exceeds ${T.THETA_DRAG_TRAP_PCT}%`);
    } else if (thetaDragPct > T.THETA_DRAG_MARGINAL_PCT) {
      level = Math.max(level, 1) as 0 | 1 | 2;
      reasons.push(`Theta drag ${thetaDragPct.toFixed(2)}%/day is elevated`);
    }
  }

  if (breakevenMovePct != null) {
    if (breakevenMovePct > T.BREAKEVEN_TRAP_PCT) {
      level = Math.max(level, 2) as 0 | 1 | 2;
      reasons.push(`Breakeven needs ${breakevenMovePct.toFixed(2)}% move`);
    } else if (breakevenMovePct > T.BREAKEVEN_MARGINAL_PCT) {
      level = Math.max(level, 1) as 0 | 1 | 2;
      reasons.push(`Breakeven needs ${breakevenMovePct.toFixed(2)}% move`);
    }
  }

  if (premiumPctOfEquity != null) {
    if (premiumPctOfEquity > T.PREMIUM_PCT_TRAP) {
      level = Math.max(level, 2) as 0 | 1 | 2;
      reasons.push(`Contract is ${premiumPctOfEquity.toFixed(1)}% of equity`);
    } else if (premiumPctOfEquity > T.PREMIUM_PCT_MARGINAL) {
      level = Math.max(level, 1) as 0 | 1 | 2;
      reasons.push(`Contract is ${premiumPctOfEquity.toFixed(1)}% of equity`);
    }
  }

  // Short DTE is a soft signal — caps influence at marginal, never trap on its own.
  if (Number.isFinite(dte) && dte < T.DTE_SHORT) {
    level = Math.max(level, 1) as 0 | 1 | 2;
    reasons.push(`Short DTE (${dte}d) — accelerated theta risk`);
  }

  const verdict: CostEfficiencyVerdict =
    level === 2 ? "theta_trap" : level === 1 ? "marginal" : "efficient";

  if (verdict === "efficient" && reasons.length === 0) {
    reasons.push("Cost profile looks balanced");
  }

  return { thetaDragPct, breakevenMovePct, premiumPctOfEquity, verdict, reasons };
}

export const COST_EFFICIENCY_LABEL: Record<CostEfficiencyVerdict, string> = {
  efficient: "Efficient",
  marginal: "Marginal",
  theta_trap: "Theta trap",
};

export const COST_EFFICIENCY_ICON: Record<CostEfficiencyVerdict, string> = {
  efficient: "✓",
  marginal: "⚠",
  theta_trap: "✗",
};

export const COST_EFFICIENCY_CLASS: Record<CostEfficiencyVerdict, string> = {
  efficient: "bg-bull/15 text-bull border-bull/30",
  marginal: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  theta_trap: "bg-bear/15 text-bear border-bear/30",
};
