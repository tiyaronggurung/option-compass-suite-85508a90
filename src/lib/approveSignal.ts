// Shared paper-trade approval helper. Used by Dashboard and TopSignals.
// No live orders — only inserts into paper_trades after risk-guard checks.

import { supabase } from "@/integrations/supabase/client";
import { checkRiskGuards, type RiskSettingsLike } from "@/lib/riskGuard";
import type { Signal } from "@/lib/signalHelpers";

export type ApproveInput = {
  userId: string;
  signal: Signal;
  risk: RiskSettingsLike;
  openTradesCount: number;
  todayRealizedPL: number;
  intendedRisk?: number; // defaults to 100, matches existing Dashboard behavior
};

export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function approveSignalAsPaperTrade(input: ApproveInput): Promise<ApproveResult> {
  const intendedRisk = input.intendedRisk ?? 100;
  const guard = checkRiskGuards({
    risk: input.risk,
    openTradesCount: input.openTradesCount,
    todayRealizedPL: input.todayRealizedPL,
    intendedRisk,
  });
  if (!guard.ok) return { ok: false, reason: (guard as { reason: string }).reason };

  const s = input.signal;
  const { error } = await supabase.from("paper_trades").insert({
    user_id: input.userId,
    signal_id: s.id,
    ticker: s.ticker,
    direction: s.direction,
    contract_idea: s.contract_symbol,
    entry_price: s.premium ?? s.price,
    stop_idea: s.premium ? Number(s.premium) * 0.6 : null,
    target_idea: s.premium ? Number(s.premium) * 1.8 : null,
    risk_amount: intendedRisk,
  });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
