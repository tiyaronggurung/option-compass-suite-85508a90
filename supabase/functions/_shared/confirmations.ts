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
  score: number;
  label: string;
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
      stance: "neutral",
      reason: `Earnings in ${days}d (${data.report_date})`,
      configured: true,
      last_updated: new Date().toISOString(),
    };
  } catch {
    return neutral("earnings lookup failed");
  }
}

// Options-flow confirmation — derive stance from net premium bias on the
// already-computed options_flow component. Positive bias = bullish flow.
function optionsFlowConfirmation(componentData: any): SourceConfirmation {
  const details = componentData?.options_flow?.details ?? null;
  const bias = typeof details?.net_premium_bias === "number" ? details.net_premium_bias : null;
  const bull = Number(details?.bullish_premium) || 0;
  const bear = Number(details?.bearish_premium) || 0;
  if (bias == null && bull === 0 && bear === 0) {
    return { score: 0, stance: "neutral", reason: "no flow data", configured: true, last_updated: new Date().toISOString() };
  }
  const b = bias ?? (bull - bear) / Math.max(1, bull + bear);
  const stance: Stance = Math.abs(b) < 0.1 ? "neutral" : b > 0 ? "bullish" : "bearish";
  const dollars = bull + bear;
  return {
    score: Math.min(1, Math.abs(b)),
    stance,
    reason: `Net bias ${(b * 100).toFixed(0)}% · $${(dollars / 1_000_000).toFixed(1)}M flow`,
    configured: true,
    last_updated: new Date().toISOString(),
  };
}

// News confirmation — derive stance from news component score (0..100, 50 neutral).
function newsConfirmation(componentData: any): SourceConfirmation {
  const news = componentData?.news ?? null;
  const score = typeof news?.score === "number" ? news.score : null;
  if (score == null) {
    return { score: 0, stance: "neutral", reason: "no news data", configured: true, last_updated: new Date().toISOString() };
  }
  const stance: Stance = score >= 55 ? "bullish" : score <= 45 ? "bearish" : "neutral";
  const articleCount = news?.details?.article_count ?? null;
  return {
    score: Math.min(1, Math.abs(score - 50) / 50),
    stance,
    reason: `Sentiment ${score}${articleCount ? ` · ${articleCount} articles` : ""}`,
    configured: true,
    last_updated: new Date().toISOString(),
  };
}

async function loadEnabledProviders(admin: SupabaseClient): Promise<Set<SourceKey>> {
  const enabled = new Set<SourceKey>(["alpaca", "earnings"]);
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
    componentData?: any;
  },
): Promise<ConfirmationSummary> {
  const enabled = await loadEnabledProviders(admin);

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

  matrix.alpaca = alpacaConfirmation(args.direction, args.blendedScore, args.confidence);
  matrix.earnings = await earningsConfirmation(admin, args.ticker);
  matrix.options_flow = optionsFlowConfirmation(args.componentData);
  matrix.news = newsConfirmation(args.componentData);

  for (const key of ["x_twitter", "reddit", "polymarket", "kalshi"] as SourceKey[]) {
    if (enabled.has(key)) {
      matrix[key] = {
        score: 0, stance: "neutral",
        reason: "configured · awaiting data wiring",
        configured: true,
        last_updated: new Date().toISOString(),
      };
    }
  }

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

  let label: string;
  if (conflicting >= 2) label = "Conflicting signal";
  else if (agreeing >= 3) label = "Strong confirmation";
  else if (agreeing === 2) label = "Confirmed by 2 sources";
  else if (conflicting === 1 && agreeing <= 1) label = "Conflicting signal";
  else label = "Single-source signal";

  return { matrix, score, label, agreeing, conflicting, configured_count: configured };
}
