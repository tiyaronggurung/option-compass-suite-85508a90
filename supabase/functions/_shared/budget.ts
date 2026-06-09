// Per-provider daily budget guard for scan-signals.
// Safe to call from any edge function; never throws — failures degrade to "allowed=true"
// so an outage of the counter table never breaks the scanner.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type Provider = "unusual_whales" | "finviz" | "finnhub" | "alpaca";

export const DEFAULT_CAPS: Record<Provider, number> = {
  unusual_whales: 8000,
  finviz: 5000,
  finnhub: 5000,
  alpaca: 20000,
};

export type BudgetResult = { allowed: boolean; calls: number; cap: number };

/**
 * Atomically increments today's counter for `provider` and returns whether the
 * call is still within the daily cap. If the counter row doesn't exist it is
 * created with `DEFAULT_CAPS[provider]`.
 *
 * Failure mode: if Supabase is unreachable, returns `{ allowed: true }` so the
 * scanner keeps working. The cap is a guardrail, not a critical path.
 */
export async function bumpBudget(
  admin: SupabaseClient,
  provider: Provider,
  amount = 1,
): Promise<BudgetResult> {
  try {
    const { data, error } = await admin.rpc("bump_provider_budget", {
      p_provider: provider,
      p_amount: amount,
      p_default_cap: DEFAULT_CAPS[provider],
    });
    if (error || !data || !Array.isArray(data) || data.length === 0) {
      return { allowed: true, calls: 0, cap: DEFAULT_CAPS[provider] };
    }
    const row = data[0] as { allowed: boolean; calls: number; daily_cap: number };
    return { allowed: !!row.allowed, calls: row.calls ?? 0, cap: row.daily_cap ?? DEFAULT_CAPS[provider] };
  } catch {
    return { allowed: true, calls: 0, cap: DEFAULT_CAPS[provider] };
  }
}

/**
 * Lightweight non-blocking counter bump (fire & forget) — used to TRACK calls
 * made by deeply nested helpers without changing their return signatures.
 */
export function trackBudget(admin: SupabaseClient, provider: Provider, amount = 1): void {
  bumpBudget(admin, provider, amount).catch(() => { /* swallow */ });
}

// ---------------- Ticker cadence (tier-based skip) ----------------

export type Tier = "hot" | "warm" | "cold";

const HOT_TICKERS = new Set(["SPY", "QQQ"]);

export function tierFor(ticker: string, universeMode: string): Tier {
  if (HOT_TICKERS.has(ticker)) return "hot";
  if (universeMode === "base_8") return "warm";
  // top_100 / top_250 / top_500: anything past the base is cold
  return "cold";
}

export const CADENCE_SECONDS: Record<Tier, number> = {
  hot: 120,   // 2 min
  warm: 360,  // 6 min
  cold: 600,  // 10 min
};

export type CadenceFilter = {
  due: string[];
  skipped: string[];
  states: Map<string, { last_scanned_at: string | null; tier: Tier }>;
};

export async function filterByCadence(
  admin: SupabaseClient,
  tickers: string[],
  universeMode: string,
  force: boolean,
): Promise<CadenceFilter> {
  if (force || tickers.length === 0) {
    const states = new Map<string, { last_scanned_at: string | null; tier: Tier }>();
    for (const t of tickers) states.set(t, { last_scanned_at: null, tier: tierFor(t, universeMode) });
    return { due: tickers, skipped: [], states };
  }
  const { data } = await admin
    .from("scanner_ticker_state")
    .select("ticker, last_scanned_at")
    .in("ticker", tickers);
  const lastMap = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ ticker: string; last_scanned_at: string }>) {
    if (row.last_scanned_at) lastMap.set(row.ticker, row.last_scanned_at);
  }
  const now = Date.now();
  const due: string[] = [];
  const skipped: string[] = [];
  const states = new Map<string, { last_scanned_at: string | null; tier: Tier }>();
  for (const t of tickers) {
    const tier = tierFor(t, universeMode);
    const last = lastMap.get(t);
    const ageSec = last ? (now - new Date(last).getTime()) / 1000 : Infinity;
    states.set(t, { last_scanned_at: last ?? null, tier });
    if (ageSec >= CADENCE_SECONDS[tier]) due.push(t);
    else skipped.push(t);
  }
  return { due, skipped, states };
}

export async function markScanned(
  admin: SupabaseClient,
  tickers: string[],
  tiers: Map<string, { tier: Tier }>,
): Promise<void> {
  if (tickers.length === 0) return;
  const now = new Date().toISOString();
  const rows = tickers.map((t) => ({
    ticker: t,
    last_scanned_at: now,
    last_tier: tiers.get(t)?.tier ?? "warm",
  }));
  try {
    await admin.from("scanner_ticker_state").upsert(rows, { onConflict: "ticker" });
  } catch { /* non-critical */ }
}
