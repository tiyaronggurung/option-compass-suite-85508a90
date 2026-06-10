// Client-side helpers + types for the multi-source confirmation matrix.
// Mirrors supabase/functions/_shared/confirmations.ts. Purely presentational —
// confirmation_score is metadata only; it does NOT modify signal confidence.

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

export type ConfirmationMatrix = Partial<Record<SourceKey, SourceConfirmation>>;

export const SOURCE_META: Record<SourceKey, { label: string; icon: string; noisy?: boolean }> = {
  alpaca:       { label: "Alpaca",        icon: "📊" },
  options_flow: { label: "Options Flow",  icon: "💰" },
  x_twitter:    { label: "X / Twitter",   icon: "𝕏", noisy: true },
  reddit:       { label: "Reddit",        icon: "👥", noisy: true },
  polymarket:   { label: "Polymarket",    icon: "🎯" },
  kalshi:       { label: "Kalshi",        icon: "📈" },
  news:         { label: "News",          icon: "📰" },
  earnings:     { label: "Earnings",      icon: "📅" },
};

export const SOURCE_ORDER: SourceKey[] = [
  "alpaca", "options_flow", "x_twitter", "reddit",
  "polymarket", "kalshi", "news", "earnings",
];

// Sources that actually return real directional data today. Others are
// configured but awaiting data-wiring — we exclude them from the public
// confirmation badge math so the denominator stays honest.
// Flip a source to wired by adding its key here once its integration ships.
export const WIRED_SOURCES: ReadonlySet<SourceKey> = new Set<SourceKey>([
  "alpaca",
  "options_flow",
  "x_twitter",
  "news",
  "earnings",
]);

export function isWired(key: SourceKey): boolean {
  return WIRED_SOURCES.has(key);
}

export function emptyMatrix(): Record<SourceKey, SourceConfirmation> {
  const neutral: SourceConfirmation = { score: 0, stance: "neutral", reason: "not configured", configured: false };
  return {
    alpaca: neutral, options_flow: neutral, x_twitter: neutral, reddit: neutral,
    polymarket: neutral, kalshi: neutral, news: neutral, earnings: neutral,
  };
}

export function summarize(
  matrix: ConfirmationMatrix | null | undefined,
  direction: "CALL" | "PUT",
): { agreeing: number; conflicting: number; configured: number; total: number } {
  const wanted: Stance = direction === "CALL" ? "bullish" : "bearish";
  let agreeing = 0, conflicting = 0, configured = 0;
  const total = WIRED_SOURCES.size;
  for (const key of SOURCE_ORDER) {
    if (!isWired(key)) continue;
    const c = matrix?.[key];
    if (!c || !c.configured) continue;
    configured++;
    if (c.stance === "neutral") continue;
    if (c.stance === wanted) agreeing++; else conflicting++;
  }
  return { agreeing, conflicting, configured, total };
}
