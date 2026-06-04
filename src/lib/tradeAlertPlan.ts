// Trade Alert Plan generator — paper-only.
//
// Turns a (signal, selected contract) into a full actionable plan:
//   underlying trigger price + direction,
//   contract entry zone,
//   stop-loss contract price,
//   target_1/2/3 contract prices (1R/2R/3R),
//   invalidation underlying price,
//   rationale + fallback flags.
//
// This module is pure — no I/O, no Supabase calls. Imported by approveSignal
// and (later) by any preview UI that wants to show the plan before insert.

export type Direction = "BULLISH" | "BEARISH" | "CALL" | "PUT" | string;

export type SignalLike = {
  id?: string | null;
  ticker: string;
  direction: Direction;
  confidence?: number | null;
  price?: number | null;                          // underlying last
  reasons?: unknown;
  technical_metrics?: Record<string, unknown> | null;
  expires_at?: string | null;
};

export type SelectedContractLike = {
  contract_symbol?: string | null;
  strike?: number | null;
  expiry?: string | null;                         // YYYY-MM-DD
  premium?: number | null;                        // mid (per share)
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  delta?: number | null;
  iv?: number | null;
  spread_pct?: number | null;
  rationale?: string | null;
};

export type AlertPlan = {
  option_side: "call" | "put";
  underlying_trigger_price: number | null;
  trigger_direction: "above" | "below";
  entry_contract_price_min: number;
  entry_contract_price_max: number;
  stop_loss_contract_price: number;
  target_1_contract_price: number;
  target_2_contract_price: number;
  target_3_contract_price: number;
  invalidation_underlying_price: number | null;
  trade_rationale: string;
  plan_metadata: {
    spot: number | null;
    mid: number;
    spread: number | null;
    delta: number | null;
    r_value: number;
    targets_basis: "1R/2R/3R";
    fallback_used: string[];
    notes: string[];
    technicals: { vwap: number | null; ema9: number | null; ema21: number | null };
  };
  expires_at: string | null;
};

function isCall(direction: Direction): boolean {
  const d = String(direction ?? "").toUpperCase();
  return d === "CALL" || d === "BULLISH";
}

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function extractTechnicals(s: SignalLike): {
  vwap: number | null; ema9: number | null; ema21: number | null;
} {
  const tm = (s.technical_metrics ?? {}) as Record<string, unknown>;
  const comps = (tm.components ?? {}) as Record<string, any>;
  const levels = comps.levels ?? {};
  const trend = comps.trend ?? {};
  return {
    vwap: n(levels.vwap) ?? n(tm.vwap),
    ema9: n(trend.ema9) ?? n(tm.ema9),
    ema21: n(trend.ema21) ?? n(tm.ema21),
  };
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
function round4(x: number): number { return Math.round(x * 10000) / 10000; }

/**
 * Build a complete alert plan from a signal + the contract chosen by the
 * Contract Selection Engine. Never invents premium or strike: those must come
 * from the selected contract. Underlying trigger and invalidation may fall
 * back to percentage moves off `signal.price` when technicals are missing —
 * fallback usage is recorded in plan_metadata.fallback_used so the UI and
 * notification can warn the user.
 */
export function buildAlertPlan(signal: SignalLike, contract: SelectedContractLike): AlertPlan {
  const fallback_used: string[] = [];
  const notes: string[] = [];
  const call = isCall(signal.direction);
  const side: "call" | "put" = call ? "call" : "put";

  const spot = n(signal.price);
  const tech = extractTechnicals(signal);

  // ── Underlying trigger ──────────────────────────────────────────
  // CALL: break ABOVE max(spot*1.005, vwap, ema21). PUT: break BELOW min(spot*0.995, vwap, ema21).
  let trigger: number | null = null;
  const trigger_direction: "above" | "below" = call ? "above" : "below";
  if (spot != null) {
    const above = [spot * 1.005, tech.vwap, tech.ema21].filter((v): v is number => v != null && Number.isFinite(v));
    const below = [spot * 0.995, tech.vwap, tech.ema21].filter((v): v is number => v != null && Number.isFinite(v));
    trigger = round2(call ? Math.max(...above) : Math.min(...below));
    if (tech.vwap == null && tech.ema21 == null) {
      fallback_used.push("trigger_from_spot_only");
      notes.push("No VWAP/EMA available — trigger derived from spot ±0.5%.");
    } else {
      notes.push(call ? "Trigger = break above VWAP/EMA21 confirmation" : "Trigger = break below VWAP/EMA21 confirmation");
    }
  } else {
    fallback_used.push("trigger_missing_spot");
    notes.push("Spot price missing — underlying trigger not set.");
  }

  // ── Invalidation underlying ─────────────────────────────────────
  let invalidation: number | null = null;
  if (spot != null) {
    if (call) {
      const candidates = [tech.ema21, tech.vwap].filter((v): v is number => v != null);
      const base = candidates.length ? Math.min(...candidates) : spot * 0.97;
      invalidation = round2(Math.min(base * 0.99, spot * 0.97));
      if (!candidates.length) fallback_used.push("invalidation_pct_fallback");
    } else {
      const candidates = [tech.ema21, tech.vwap].filter((v): v is number => v != null);
      const base = candidates.length ? Math.max(...candidates) : spot * 1.03;
      invalidation = round2(Math.max(base * 1.01, spot * 1.03));
      if (!candidates.length) fallback_used.push("invalidation_pct_fallback");
    }
  } else {
    fallback_used.push("invalidation_missing_spot");
  }

  // ── Contract entry zone ─────────────────────────────────────────
  const mid = n(contract.mid) ?? n(contract.premium) ?? n(contract.ask) ?? n(contract.bid);
  if (mid == null || mid <= 0) {
    throw new Error("Cannot build alert plan: contract has no usable premium/mid.");
  }
  const bid = n(contract.bid);
  const ask = n(contract.ask);
  const spread = bid != null && ask != null && ask >= bid ? ask - bid : null;
  // Entry zone = mid ± half-spread, with a floor of 3% of mid for tight quotes.
  const halfSpread = spread != null ? spread / 2 : null;
  const buffer = Math.max(halfSpread ?? 0, mid * 0.03);
  let entryMin = round2(Math.max(0.01, mid - buffer));
  let entryMax = round2(mid + buffer);
  if (bid != null) entryMin = Math.max(entryMin, round2(bid));      // never below current bid
  if (ask != null) entryMax = Math.min(entryMax, round2(ask));      // never above current ask
  if (entryMax <= entryMin) entryMax = round2(entryMin + 0.05);

  // ── Stop loss (delta + invalidation aware) ──────────────────────
  // Preferred: stop = entry - |delta| * (trigger - invalidation) -- option price drop implied
  // by underlying moving from trigger to invalidation. Floors at 40% of mid.
  const delta = n(contract.delta);
  let stop: number;
  if (delta != null && trigger != null && invalidation != null) {
    const underlyingMove = Math.abs(trigger - invalidation);
    const optionMove = Math.abs(delta) * underlyingMove;
    // Use mid as basis (we may enter anywhere in the zone)
    stop = round2(Math.max(mid * 0.40, mid - optionMove));
    notes.push(`Stop derived from |Δ|·(trigger−invalidation) = ${round4(optionMove)} → drop from mid.`);
  } else {
    stop = round2(mid * 0.50);
    fallback_used.push("stop_pct_fallback");
    notes.push("Stop = 50% of mid (delta or technicals unavailable).");
  }
  if (stop >= entryMin) stop = round2(entryMin * 0.7); // ensure stop strictly below entry zone

  // ── Targets: 1R / 2R / 3R off the midpoint of the entry zone ───
  const entryRef = (entryMin + entryMax) / 2;
  const R = Math.max(0.05, entryRef - stop);
  const t1 = round2(entryRef + R);
  const t2 = round2(entryRef + 2 * R);
  const t3 = round2(entryRef + 3 * R);

  // ── Rationale ───────────────────────────────────────────────────
  const reasonsArr = Array.isArray(signal.reasons) ? (signal.reasons as unknown[]).map(String) : [];
  const reasonLine = reasonsArr.length ? reasonsArr.slice(0, 3).join(" · ") : "Signal scored above threshold";
  const triggerLine = trigger != null
    ? `Enter when ${signal.ticker} ${trigger_direction === "above" ? "breaks above" : "breaks below"} $${trigger.toFixed(2)}`
    : `Enter on confirmation (trigger price unavailable)`;
  const contractLine = contract.rationale ? ` · Contract: ${contract.rationale}` : "";
  const trade_rationale = `${reasonLine}. ${triggerLine}.${contractLine}`;

  // ── Expiry/TTL for the alert itself (separate from option expiry) ──
  // Use signal.expires_at if present, otherwise 7 days.
  let expires_at: string | null = signal.expires_at ?? null;
  if (!expires_at) {
    const d = new Date(Date.now() + 7 * 86_400_000);
    expires_at = d.toISOString();
    notes.push("Alert TTL defaulted to 7 days.");
  }

  return {
    option_side: side,
    underlying_trigger_price: trigger,
    trigger_direction,
    entry_contract_price_min: entryMin,
    entry_contract_price_max: entryMax,
    stop_loss_contract_price: stop,
    target_1_contract_price: t1,
    target_2_contract_price: t2,
    target_3_contract_price: t3,
    invalidation_underlying_price: invalidation,
    trade_rationale,
    plan_metadata: {
      spot,
      mid: round4(mid),
      spread: spread != null ? round4(spread) : null,
      delta: delta != null ? round4(delta) : null,
      r_value: round4(R),
      targets_basis: "1R/2R/3R",
      fallback_used,
      notes,
      technicals: tech,
    },
    expires_at,
  };
}
