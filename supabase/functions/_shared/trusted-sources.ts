// Trusted Source Intelligence registry — institutional-grade Twitter/X handles.
// Used by social-intel.ts to compute a trusted_source_score (0..100) that
// boosts the Sentiment component when high-credibility accounts confirm a
// ticker move. Additive only — does NOT alter weights, gates, or thresholds.

export type TrustedTier = 1 | 2 | 3 | 4 | 5;

export type TrustedAccount = {
  handle: string;       // lowercase, no @
  tier: TrustedTier;
  weight: number;       // 100/90/80/70/60
  label?: string;
};

export const TRUSTED_ACCOUNTS: TrustedAccount[] = [
  // Tier 1 — official institutions
  { handle: "federalreserve", tier: 1, weight: 100, label: "Federal Reserve" },
  { handle: "secgov",         tier: 1, weight: 100, label: "U.S. SEC" },
  { handle: "reutersbiz",     tier: 1, weight: 100, label: "Reuters Business" },

  // Tier 2 — macro / breaking news
  { handle: "walterbloomberg", tier: 2, weight: 90, label: "Walter Bloomberg" },
  { handle: "deltaone",        tier: 2, weight: 90, label: "DeltaOne" },
  { handle: "firstsquawk",     tier: 2, weight: 90, label: "First Squawk" },
  { handle: "financialjuice",  tier: 2, weight: 90, label: "Financial Juice" },

  // Tier 3 — professional options-flow intelligence
  { handle: "unusual_whales", tier: 3, weight: 80, label: "Unusual Whales" },
  { handle: "flowalgo",       tier: 3, weight: 80, label: "FlowAlgo" },
  { handle: "spotgamma",      tier: 3, weight: 80, label: "SpotGamma" },
  { handle: "cheddarflow",    tier: 3, weight: 80, label: "Cheddar Flow" },

  // Tier 4 — companies & leadership
  { handle: "nvidia",       tier: 4, weight: 70, label: "NVIDIA" },
  { handle: "lisasu",       tier: 4, weight: 70, label: "Lisa Su (AMD)" },
  { handle: "palantirtech", tier: 4, weight: 70, label: "Palantir" },
  { handle: "openai",       tier: 4, weight: 70, label: "OpenAI" },
  { handle: "elonmusk",     tier: 4, weight: 70, label: "Elon Musk" },

  // Tier 5 — market news / earnings
  { handle: "benzinga",          tier: 5, weight: 60, label: "Benzinga" },
  { handle: "stockmktnewz",      tier: 5, weight: 60, label: "Stock Market News" },
  { handle: "earningswhispers",  tier: 5, weight: 60, label: "Earnings Whispers" },
];

export const TRUSTED_HANDLE_SET = new Set(TRUSTED_ACCOUNTS.map((a) => a.handle));

export function findTrustedAccount(userName?: string | null): TrustedAccount | null {
  if (!userName) return null;
  const h = String(userName).toLowerCase().replace(/^@/, "");
  return TRUSTED_ACCOUNTS.find((a) => a.handle === h) ?? null;
}

// Ticker → company name aliases (extend as needed). Match is case-insensitive
// word-boundary on company name; cashtag/symbol matching is done separately.
export const TICKER_ALIASES: Record<string, string[]> = {
  NVDA: ["nvidia"],
  AMD:  ["amd", "advanced micro devices"],
  TSLA: ["tesla"],
  META: ["meta", "facebook"],
  AAPL: ["apple"],
  MSFT: ["microsoft"],
  GOOGL:["google", "alphabet"],
  GOOG: ["google", "alphabet"],
  AMZN: ["amazon"],
  SPY:  ["s&p 500", "s&p500"],
  QQQ:  ["nasdaq 100", "nasdaq-100"],
  PLTR: ["palantir"],
  NFLX: ["netflix"],
  AVGO: ["broadcom"],
};

export function tickerMatchesText(ticker: string, text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const tk = ticker.toUpperCase();
  if (t.includes(`$${tk.toLowerCase()}`)) return true;
  // word-boundary symbol match
  if (new RegExp(`\\b${tk.toLowerCase()}\\b`).test(t)) return true;
  for (const alias of TICKER_ALIASES[tk] ?? []) {
    if (t.includes(alias)) return true;
  }
  return false;
}

export function tierStats(hits: Array<{ tier: TrustedTier }>) {
  const dist: Record<TrustedTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const h of hits) dist[h.tier] = (dist[h.tier] ?? 0) + 1;
  return dist;
}
