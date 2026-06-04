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
  const confidenceSnapshot = Number(s.confidence ?? 0);
  const testClass = paperTestClassFor(confidenceSnapshot);
  const optionType = String(s.direction).toUpperCase() === "PUT" ? "PUT" : "CALL";
  const multiplier = 100;

  // Contract Selection Engine — paper-only. Picks best contract (UW → Alpaca),
  // returns rationale + snapshot id. If engine fails we fall back to whatever
  // contract the signal already carries so we don't regress the existing path.
  let snapshotId: string | null = null;
  let bestContract: any = null;
  let contractSource: string | null = null;
  try {
    const { data: sel, error: selErr } = await supabase.functions.invoke("select-contract", {
      body: {
        signal_id: s.id,
        ticker: s.ticker,
        option_type: optionType,
        confidence: confidenceSnapshot,
        persist: true,
      },
    });
    if (!selErr && sel && (sel as any).ok) {
      snapshotId = (sel as any).snapshot_id ?? null;
      bestContract = (sel as any).best ?? null;
      contractSource = (sel as any).contract_source ?? null;
    } else if (sel && (sel as any).reason) {
      console.warn("select-contract:", (sel as any).reason);
    }
  } catch (e) {
    console.warn("select-contract invoke failed", e);
  }

  // Resolve final fields. Prefer engine, fall back to signal-provided values.
  const finalPremium = bestContract?.premium != null
    ? Number(bestContract.premium)
    : (s.premium != null ? Number(s.premium) : null);

  if (finalPremium == null || !Number.isFinite(finalPremium) || finalPremium <= 0) {
    return {
      ok: false,
      reason: contractSource == null && s.premium == null
        ? "No option chain available right now — paper trade not created"
        : "No option premium available — cannot open paper option trade",
    };
  }

  const finalStrike = bestContract?.strike != null ? Number(bestContract.strike) : (s.strike ?? null);
  const finalExpiry = bestContract?.expiry ?? s.expiry ?? null;
  const finalSymbol = bestContract?.contract_symbol ?? s.contract_symbol ?? null;
  const totalCost = finalPremium * multiplier * contracts;

  const { error } = await supabase.from("paper_trades").insert({
    user_id: input.userId,
    signal_id: s.id,
    ticker: s.ticker,
    direction: s.direction,
    contract_idea: finalSymbol,
    // Legacy column kept in sync so existing UI/queries keep working.
    entry_price: finalPremium,
    stop_idea: finalPremium * 0.6,
    target_idea: finalPremium * 1.8,
    risk_amount: intendedRisk,
    paper_test_class: testClass,
    confidence_at_approval: confidenceSnapshot,
    // Option-trade fields.
    is_option: true,
    option_type: optionType,
    strike: finalStrike,
    expiry: finalExpiry,
    contracts,
    multiplier,
    entry_premium: finalPremium,
    total_cost: totalCost,
    contract_snapshot_id: snapshotId,
  } as any);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
