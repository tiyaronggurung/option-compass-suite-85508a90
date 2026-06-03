// Pure risk-gate logic for paper-trade approvals.
// No live orders — this only blocks INSERTs into paper_trades.

export type RiskSettingsLike = {
  kill_switch?: boolean | null;
  max_open_trades?: number | null;
  max_risk_per_trade?: number | string | null;
  daily_loss_cap?: number | string | null;
} | null | undefined;

export const RISK_FALLBACK = {
  kill_switch: false,
  max_open_trades: 5,
  max_risk_per_trade: 100,
  daily_loss_cap: 500,
} as const;

export type EffectiveRisk = {
  kill_switch: boolean;
  max_open_trades: number;
  max_risk_per_trade: number;
  daily_loss_cap: number;
};

/** Merge a (possibly null) settings row with safe fallbacks. Missing != unlimited. */
export function effectiveRisk(r: RiskSettingsLike): EffectiveRisk {
  return {
    kill_switch: r?.kill_switch ?? RISK_FALLBACK.kill_switch,
    max_open_trades: Number(r?.max_open_trades ?? RISK_FALLBACK.max_open_trades),
    max_risk_per_trade: Number(r?.max_risk_per_trade ?? RISK_FALLBACK.max_risk_per_trade),
    daily_loss_cap: Number(r?.daily_loss_cap ?? RISK_FALLBACK.daily_loss_cap),
  };
}

export type GuardInput = {
  risk: RiskSettingsLike;
  openTradesCount: number;
  /** Sum of realized P/L (current_pl) for paper trades closed today. Negative = loss. */
  todayRealizedPL: number;
  /** Risk amount the candidate paper trade will commit. */
  intendedRisk: number;
};

export type GuardResult =
  | { ok: true; effective: EffectiveRisk }
  | { ok: false; reason: string; effective: EffectiveRisk };

export function checkRiskGuards(input: GuardInput): GuardResult {
  const e = effectiveRisk(input.risk);

  if (e.kill_switch) {
    return { ok: false, reason: "Kill switch is active", effective: e };
  }
  if (input.openTradesCount >= e.max_open_trades) {
    return { ok: false, reason: "Max open trades reached", effective: e };
  }
  if (input.intendedRisk > e.max_risk_per_trade) {
    return { ok: false, reason: "Trade risk exceeds max risk per trade", effective: e };
  }
  // Daily loss cap: realized loss today (positive number) reaches/exceeds cap → block
  const realizedLoss = Math.max(0, -input.todayRealizedPL);
  if (realizedLoss >= e.daily_loss_cap) {
    return { ok: false, reason: "Daily loss cap reached", effective: e };
  }
  return { ok: true, effective: e };
}

/** Sum of current_pl for paper trades closed today (closed_at in local day). */
export function sumTodayRealizedPL(
  trades: Array<{ status?: string | null; closed_at?: string | null; current_pl?: number | string | null }>,
): number {
  const today = new Date().toDateString();
  let sum = 0;
  for (const t of trades) {
    if (!t.closed_at) continue;
    if ((t.status ?? "").toUpperCase() === "OPEN") continue;
    if (new Date(t.closed_at).toDateString() !== today) continue;
    sum += Number(t.current_pl ?? 0);
  }
  return sum;
}
