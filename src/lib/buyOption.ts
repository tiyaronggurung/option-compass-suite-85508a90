// Helper to open a paper option trade with a user-selected contract from the
// Buy Option modal. Bypasses the contract-selection engine (the user picked
// the strike) but still runs risk guards and persists a trade_alerts plan so
// the existing evaluator handles the lifecycle.
//
// This sits alongside approveSignalAsPaperTrade — the original 1-click flow
// is preserved as a fallback when option chain data is unavailable.

import { supabase } from "@/integrations/supabase/client";
import { checkRiskGuards, type RiskSettingsLike } from "@/lib/riskGuard";
import { paperTestClassFor } from "@/lib/approveSignal";
import type { Signal } from "@/lib/signalHelpers";

export type SelectedContract = {
  symbol: string | null;
  strike: number;
  expiry: string;          // YYYY-MM-DD
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  mid: number;             // execution premium per share
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  open_interest: number | null;
  volume: number | null;
};

export type BuyOptionInput = {
  userId: string;
  signal: Signal;
  risk: RiskSettingsLike;
  openTradesCount: number;
  todayRealizedPL: number;
  contract: SelectedContract;
  contracts: number;
  cashBalance: number;     // for buying-power check
};

export type BuyOptionReceipt = {
  tradeId: string | null;
  ticker: string;
  optionType: "CALL" | "PUT";
  strike: number;
  expiry: string;
  contracts: number;
  fillPremium: number;
  totalCost: number;
  remainingCash: number;
  status: string;
  filledAt: string;
};

export type BuyOptionResult =
  | { ok: true; receipt: BuyOptionReceipt }
  | { ok: false; reason: string };

export async function buyOptionAsPaperTrade(input: BuyOptionInput): Promise<BuyOptionResult> {
  const qty = Math.max(1, Math.floor(input.contracts));
  const premium = input.contract.mid;
  if (!Number.isFinite(premium) || premium <= 0) {
    return { ok: false, reason: "Selected contract has no usable premium" };
  }
  const multiplier = 100;
  const totalCost = premium * multiplier * qty;

  // Buying power: allow any amount strictly less than the full account cash.
  if (totalCost >= input.cashBalance) {
    return { ok: false, reason: `Order ($${totalCost.toFixed(2)}) must be less than account cash ($${input.cashBalance.toFixed(2)}).` };
  }

  // Risk guards (use intendedRisk = totalCost so the user can't bypass the
  // per-trade cap by picking a huge premium).
  const guard = checkRiskGuards({
    risk: input.risk,
    openTradesCount: input.openTradesCount,
    todayRealizedPL: input.todayRealizedPL,
    intendedRisk: totalCost,
  });
  if (!guard.ok) return { ok: false, reason: (guard as { reason: string }).reason };

  const s = input.signal;
  const c = input.contract;
  const confidenceSnapshot = Number(s.confidence ?? 0);
  const optionTypeUpper = c.type === "put" ? "PUT" : "CALL";
  const openedAt = new Date().toISOString();

  const { data: inserted, error } = await supabase.from("paper_trades").insert({
    user_id: input.userId,
    signal_id: s.id,
    ticker: s.ticker,
    direction: s.direction,
    contract_idea: c.symbol,
    entry_price: premium,
    stop_idea: premium * 0.6,
    target_idea: premium * 1.8,
    risk_amount: totalCost,
    paper_test_class: paperTestClassFor(confidenceSnapshot),
    confidence_at_approval: confidenceSnapshot,
    is_option: true,
    option_type: optionTypeUpper,
    strike: c.strike,
    expiry: c.expiry,
    contracts: qty,
    multiplier,
    entry_premium: premium,
    total_cost: totalCost,
    bid: c.bid,
    ask: c.ask,
    mid: premium,
    delta: c.delta,
    gamma: c.gamma,
    theta: c.theta,
    vega: c.vega,
    iv: c.iv,
    open_interest: c.open_interest,
    option_volume: c.volume,
    current_premium: premium,
    current_value: totalCost,
    unrealized_pl: 0,
    unrealized_pl_pct: 0,
    current_pl: 0,
    current_pl_pct: 0,
    last_mark_price: premium,
    last_mark_at: openedAt,
  } as any).select("id").single();
  if (error) return { ok: false, reason: error.message };

  // Best-effort trade alert plan so the evaluator tracks targets/stop/expire.
  try {
    const { buildAlertPlan } = await import("@/lib/tradeAlertPlan");
    const plan = buildAlertPlan(s as any, {
      contract_symbol: c.symbol,
      strike: c.strike,
      expiry: c.expiry,
      premium,
      bid: c.bid,
      ask: c.ask,
      mid: premium,
      delta: c.delta,
      iv: c.iv,
      spread_pct: c.bid && c.ask && c.ask > 0 ? ((c.ask - c.bid) / ((c.ask + c.bid) / 2)) * 100 : null,
      rationale: "User-selected from chain",
    });
    await (supabase as any).from("trade_alerts").insert({
      user_id: input.userId,
      signal_id: s.id,
      paper_trade_id: inserted?.id ?? null,
      ticker: s.ticker,
      option_side: plan.option_side,
      strike: c.strike,
      expiry: c.expiry,
      contract_symbol: c.symbol,
      underlying_trigger_price: plan.underlying_trigger_price,
      trigger_direction: plan.trigger_direction,
      entry_contract_price_min: plan.entry_contract_price_min,
      entry_contract_price_max: plan.entry_contract_price_max,
      stop_loss_contract_price: plan.stop_loss_contract_price,
      target_1_contract_price: plan.target_1_contract_price,
      target_2_contract_price: plan.target_2_contract_price,
      target_3_contract_price: plan.target_3_contract_price,
      invalidation_underlying_price: plan.invalidation_underlying_price,
      alert_status: "entered",
      triggered_at: new Date().toISOString(),
      entered_at: new Date().toISOString(),
      expires_at: plan.expires_at,
      confidence_score: confidenceSnapshot,
      trade_rationale: plan.trade_rationale,
      plan_metadata: plan.plan_metadata,
    });
  } catch (e) {
    console.warn("[buyOption] trade_alert plan failed:", e);
  }

  return { ok: true };
}
