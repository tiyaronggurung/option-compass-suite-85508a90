// Shared paper-trade approval helper. Used by Dashboard and TopSignals.
// No live orders — only inserts into paper_trades after risk-guard checks.
// Option-aware: persists strike/expiry/option_type/contracts and entry_premium
// so the mark engine can track Robinhood-style option P/L.

import { supabase } from "@/integrations/supabase/client";
import { checkRiskGuards, type RiskSettingsLike } from "@/lib/riskGuard";
import type { Signal } from "@/lib/signalHelpers";

export type PaperTestClass = "developing" | "near_watchlist" | "watchlist" | "strong" | "elite";

export function paperTestClassFor(confidence: number): PaperTestClass {
  if (confidence >= 90) return "elite";
  if (confidence >= 80) return "strong";
  if (confidence >= 70) return "watchlist";
  if (confidence >= 65) return "near_watchlist";
  return "developing";
}

export type ApproveInput = {
  userId: string;
  signal: Signal;
  risk: RiskSettingsLike;
  openTradesCount: number;
  todayRealizedPL: number;
  intendedRisk?: number; // defaults to 100, matches existing Dashboard behavior
  contracts?: number;    // defaults to 1 — no quantity picker yet
};

export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function approveSignalAsPaperTrade(input: ApproveInput): Promise<ApproveResult> {
  const intendedRisk = input.intendedRisk ?? 100;
  const contracts = Math.max(1, Math.floor(input.contracts ?? 1));
  const guard = checkRiskGuards({
    risk: input.risk,
    openTradesCount: input.openTradesCount,
    todayRealizedPL: input.todayRealizedPL,
    intendedRisk,
  });
  if (!guard.ok) return { ok: false, reason: (guard as { reason: string }).reason };

  const s = input.signal;
  const entryPremium = s.premium != null ? Number(s.premium) : null;

  // Hard block: never fake P/L on missing premium.
  if (entryPremium == null || !Number.isFinite(entryPremium) || entryPremium <= 0) {
    return {
      ok: false,
      reason: "No option premium available — cannot open paper option trade",
    };
  }

  const optionType = s.direction; // CALL | PUT
  const multiplier = 100;
  const totalCost = entryPremium * multiplier * contracts;

  const confidenceSnapshot = Number(s.confidence ?? 0);
  const testClass = paperTestClassFor(confidenceSnapshot);

  const { error } = await supabase.from("paper_trades").insert({
    user_id: input.userId,
    signal_id: s.id,
    ticker: s.ticker,
    direction: s.direction,
    contract_idea: s.contract_symbol,
    // Legacy column kept in sync so existing UI/queries keep working.
    entry_price: entryPremium,
    stop_idea: entryPremium * 0.6,
    target_idea: entryPremium * 1.8,
    risk_amount: intendedRisk,
    paper_test_class: testClass,
    confidence_at_approval: confidenceSnapshot,
    // New option-trade fields.
    is_option: true,
    option_type: optionType,
    strike: s.strike ?? null,
    expiry: s.expiry ?? null,
    contracts,
    multiplier,
    entry_premium: entryPremium,
    total_cost: totalCost,
  } as any);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
