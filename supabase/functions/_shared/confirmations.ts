// Multi-source confirmation engine. Purely additive metadata — never alters
// signal confidence, scoring, or threshold gating. Each configured provider
// returns a stance (bullish / bearish / neutral) plus a score 0..1 and reason.
// Unconfigured providers always return neutral with score 0 and a "not configured" reason.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Stance = "bullish" | "bearish" | "neutral";

export type SourceConfirmation = {
  score: number;
  stance: Stance;
  reason: string;
  last_updated?: string;
  configured?: boolean;
};

export type SourceKey =
  | "alpaca"
  | "options_flow"
  | "x_twitter"
  | "reddit"
  | "polymarket"
  | "kalshi"
  | "news"
  | "earnings";

export type ConfirmationMatrix = Record<SourceKey, SourceConfirmation>;

export type ConfirmationSummary = {
  matrix: ConfirmationMatrix;
  score: number;             // 0..100 — purely metadata, not added to confidence
  label: string;             // human-readable summary label
  agreeing: number;
  conflicting: number;
  configured_count: number;
};

const PROVIDER_TO_SOURCE: Record<string, SourceKey | undefined> = {
  alpaca: "alpaca",
  unusual_whales: "options_flow",
  x_twitter: "x_twitter",
  reddit: "reddit",
  polymarket: "polymarket",
  kalshi: "kalshi",
  news: "news",
  alpha_vantage: "earnings",
};

const ALL_SOURCES: SourceKey[] = [
  "alpaca", "options_flow", "x_twitter", "reddit",
  "polymarket", "kalshi", "news", "earnings",
];

function neutral(reason = "not configured"): SourceConfirmation {
  return { score: 0, stance: "neutral", reason, configured: false };
}

// Derive the Alpaca confirmation directly from already-computed signal numbers.
// We never recompute the score — we just translate its sign + magnitude.
function alpacaConfirmation(
  direction: "CALL" | "PUT",
  blendedScore: number,
  confidence: number,
): SourceConfirmation {
  const stance: Stance = direction === "CALL" ? "bullish" : "bearish";
  return {
    score: Math.max(0, Math.min(1, confidence / 100)),
    stance,
    reason: `Blended ${blendedScore >= 0 ? "+" : ""}${blendedScore.toFixed(2)} · confidence ${confidence}`,
    last_updated: new Date().toISOString(),
    configured: true,
  };
}

// Earnings confirmation is derived from the existing earnings_events table —
// purely informational, no boost is applied here.
async function earningsConfirmation(
  admin: SupabaseClient,
  ticker: string,
): Promise<SourceConfirmation> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const { data } = await admin
      .from("earnings_events")
      .select("report_date")
      .eq("ticker", ticker)
      .gte("report_date", today)
      .lte("report_date", horizon)
      .order("report_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!data?.report_date) {
      return {
        score: 0, stance: "neutral",
        reason: "no upcoming earnings",
        configured: true,
        last_updated: new Date().toISOString(),
      };
    }
    const days = Math.max(0, Math.ceil((+new Date(data.report_date) - Date.now()) / 86_400_000));
    return {
      score: days <= 7 ? 0.7 : 0.4,
      stance: "neutral", // earnings is a catalyst, not directional on its own
      reason: `Earnings in ${days}d (${data.report_date})`,
      configured: true,
      last_updated: new Date().toISOString(),
    };
  } catch {
    return neutral("earnings lookup failed");
  }
}

// Load which non-Alpaca providers are enabled, so we can correctly weight
// the configured_count. Failures → treat as unconfigured (safe default).
async function loadEnabledProviders(admin: SupabaseClient): Promise<Set<SourceKey>> {
  const enabled = new Set<SourceKey>(["alpaca", "earnings"]); // always counted
  try {
    const { data } = await admin
      .from("provider_configs")
      .select("provider, enabled, last_status");
    for (const row of data ?? []) {
      if (!row.enabled) continue;
      const key = PROVIDER_TO_SOURCE[row.provider as string];
      if (key) enabled.add(key);
    }
  } catch { /* leave defaults */ }
  return enabled;
}

export async function buildConfirmations(
  admin: SupabaseClient,
  args: {
    ticker: string;
    direction: "CALL" | "PUT";
    blendedScore: number;
    confidence: number;
  },
): Promise<ConfirmationSummary> {
  const enabled = await loadEnabledProviders(admin);

  // Start with neutral defaults for every source.
  const matrix: ConfirmationMatrix = {
    alpaca: neutral(),
    options_flow: neutral(),
    x_twitter: neutral(),
    reddit: neutral(),
    polymarket: neutral(),
    kalshi: neutral(),
    news: neutral(),
    earnings: neutral(),
  };

  // Alpaca (always primary source).
  matrix.alpaca = alpacaConfirmation(args.direction, args.blendedScore, args.confidence);

  // Earnings — derived from local catalog, safe to compute every time.
  matrix.earnings = await earningsConfirmation(admin, args.ticker);

  // All other sources stay neutral / "not configured" until their integrations land.
  // When a provider is *enabled* in provider_configs but its data fetch isn't built yet,
  // surface that distinction in the reason text so admins know it's pending wiring.
  for (const key of ["options_flow", "x_twitter", "reddit", "polymarket", "kalshi", "news"] as SourceKey[]) {
    if (enabled.has(key)) {
      matrix[key] = {
        score: 0, stance: "neutral",
        reason: "configured · awaiting data wiring",
        configured: true,
        last_updated: new Date().toISOString(),
      };
    }
  }

  // ---- Score formula (agreement vs conflict on configured sources only) ----
  const signalStance: Stance = args.direction === "CALL" ? "bullish" : "bearish";
  let agreeing = 0;
  let conflicting = 0;
  let configured = 0;
  for (const key of ALL_SOURCES) {
    const c = matrix[key];
    if (!c.configured) continue;
    configured++;
    if (c.stance === "neutral") continue;
    if (c.stance === signalStance) agreeing++;
    else conflicting++;
  }
  const denom = Math.max(1, configured);
  const raw = ((agreeing - conflicting) / denom) * 100;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  // ---- Label ----
  let label: string;
  if (conflicting >= 2) label = "Conflicting signal";
  else if (agreeing >= 3) label = "Strong confirmation";
  else if (agreeing === 2) label = "Confirmed by 2 sources";
  else if (conflicting === 1 && agreeing <= 1) label = "Conflicting signal";
  else label = "Single-source signal";

  return { matrix, score, label, agreeing, conflicting, configured_count: configured };
}
