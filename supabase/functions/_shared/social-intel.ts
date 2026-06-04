// Social Intelligence engine — powers the Sentiment component (15%).
// Primary source: TwitterAPI.io. AI classifier: gemini-2.5-flash-lite via
// Lovable AI Gateway, with lexicon fallback. Safe-by-design: never throws
// into scoring; missing/auth/no_data → neutral 50.

import {
  fetchCashtagTweets,
  fetchTrustedSourceTweets,
  TAPI_CONFIGURED,
  type TAPITweet,
  type TAPIState,
} from "./twitterapi.ts";
import {
  TRUSTED_ACCOUNTS,
  findTrustedAccount,
  tickerMatchesText,
  tierStats,
  type TrustedTier,
} from "./trusted-sources.ts";

const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";

export type TrustedHit = {
  account: string;
  tier: TrustedTier;
  weight: number;
  headline: string;
  sentiment: "bullish" | "bearish" | "neutral";
  engagement: number;
  followers: number;
  url?: string;
  created_at?: string;
  age_minutes?: number;
};

export type SocialIntelResult = {
  score: number;            // 0..100 (direction-aware)
  configured: boolean;
  source: string;           // "twitterapi_io" | "neutral"
  reason: string;
  details: {
    source: string;
    provider_status: TAPIState | "missing_key";
    score: number;
    subscores: {
      polarity: number;
      velocity: number;
      kol: number;
      engagement: number;
      trusted_source: number;
    };
    samples: {
      total_tweets: number;
      bullish_count: number;
      bearish_count: number;
      neutral_count: number;
      bullish_pct: number;
      bearish_pct: number;
      neutral_pct: number;
      mention_velocity_ratio: number;
      kol_count: number;
      top_kol_tweets: Array<{
        userName?: string;
        text: string;
        url?: string;
        followers: number;
        verified: boolean;
        engagement: number;
        sentiment?: "bullish" | "bearish" | "neutral";
      }>;
    };
    trusted_source_score: number;
    trusted_source_hits: number;
    trusted_source_accounts: string[];
    trusted_source_headlines: TrustedHit[];
    trusted_source_summary: string;
    trusted_tier_distribution: Record<string, number>;
    monitored_account_count: number;
    reason_code: string;
    human_reason: string;
    classifier: "llm" | "lexicon" | "none";
    cost_estimate_usd?: number;
  };
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const clamp100 = (n: number) => clamp(n, 0, 100);

// ---------- Lexicon fallback ----------
const BULL_WORDS = [
  "calls","call","bullish","bull","moon","rocket","🚀","🟢","green","breakout","squeeze",
  "long","buy","buying","accumulate","rip","ripping","pump","pumping","rally","rallying",
  "uptrend","support","bottom","oversold","reversal","ath","new high","gap up","beat","beats",
  "upgrade","upgraded","strong","leading","momentum",
];
const BEAR_WORDS = [
  "puts","put","bearish","bear","short","shorting","dump","dumping","sell","selling","red","🔴",
  "crash","crashing","tank","tanking","downtrend","resistance","top","overbought","gap down",
  "miss","missed","downgrade","downgraded","weak","collapse","bleeding","rejected",
];

function classifyLexicon(text: string): "bullish" | "bearish" | "neutral" {
  const t = text.toLowerCase();
  let b = 0, x = 0;
  for (const w of BULL_WORDS) if (t.includes(w)) b++;
  for (const w of BEAR_WORDS) if (t.includes(w)) x++;
  if (b > x && b >= 1) return "bullish";
  if (x > b && x >= 1) return "bearish";
  return "neutral";
}

// ---------- LLM classifier (Lovable AI Gateway, batched) ----------
async function classifyLLM(
  ticker: string,
  tweets: TAPITweet[],
): Promise<Array<"bullish" | "bearish" | "neutral"> | null> {
  if (!LOVABLE_AI_KEY) return null;
  const labels: Array<"bullish" | "bearish" | "neutral"> = new Array(tweets.length).fill("neutral");
  const BATCH = 50;
  try {
    for (let i = 0; i < tweets.length; i += BATCH) {
      const slice = tweets.slice(i, i + BATCH);
      const numbered = slice.map((t, idx) => `${idx + 1}. ${t.text.replace(/\s+/g, " ").slice(0, 280)}`).join("\n");
      const sys = `You classify finance tweets about $${ticker} as one of: bullish, bearish, neutral.
- "bullish" = the tweet implies upside, buying calls, long, breakout, positive catalyst.
- "bearish" = downside, puts, short, breakdown, negative catalyst.
- "neutral" = no clear directional view, news only, question, ambiguous.
Reply ONLY with a JSON array of strings of length ${slice.length}, in input order, no prose. Example: ["bullish","neutral","bearish"]`;
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_AI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            { role: "system", content: sys },
            { role: "user", content: numbered },
          ],
        }),
      });
      if (!res.ok) {
        // 429/402 → bail to lexicon for the rest
        await res.text().catch(() => "");
        return null;
      }
      const json = await res.json().catch(() => null);
      const content = json?.choices?.[0]?.message?.content ?? "";
      const match = String(content).match(/\[[\s\S]*\]/);
      if (!match) return null;
      let arr: any;
      try { arr = JSON.parse(match[0]); } catch { return null; }
      if (!Array.isArray(arr)) return null;
      for (let j = 0; j < slice.length; j++) {
        const v = String(arr[j] ?? "").toLowerCase();
        labels[i + j] = v === "bullish" ? "bullish" : v === "bearish" ? "bearish" : "neutral";
      }
    }
    return labels;
  } catch {
    return null;
  }
}

// ---------- Sub-score computations ----------
function polarityScore(bullPct: number, bearPct: number, direction: "CALL" | "PUT"): number {
  const directional = direction === "CALL" ? bullPct - bearPct : bearPct - bullPct;
  // directional ∈ [-1..1] → 0..100 centered on 50
  return clamp100(50 + directional * 50);
}

function velocityScore(currentCount: number, baseline: number): number {
  // ratio 1.0 → 50, 2x → 70, 3x → 80, 5x+ → 95. <0.5x → 30.
  const ratio = baseline > 0 ? currentCount / baseline : (currentCount > 10 ? 1.5 : 1);
  if (ratio <= 0.25) return 25;
  if (ratio <= 0.5) return 35;
  if (ratio <= 0.8) return 45;
  if (ratio <= 1.2) return 50;
  if (ratio <= 1.8) return 62;
  if (ratio <= 2.5) return 72;
  if (ratio <= 4) return 82;
  return 92;
}

function kolScore(tweets: TAPITweet[]): { score: number; count: number; weight: number } {
  let kolCount = 0;
  let weight = 0;
  for (const t of tweets) {
    const f = t.author.followers ?? 0;
    const isKol = (t.author.isBlueVerified || t.author.verified) && f >= 5000 || f >= 50_000;
    if (isKol) {
      kolCount++;
      const eng = t.engagement.likes + t.engagement.retweets * 2 + t.engagement.replies + t.engagement.views / 100;
      weight += eng * Math.log10(Math.max(f, 10));
    }
  }
  // Map weight to score: log scale
  const s = kolCount === 0 ? 40 : clamp100(45 + Math.log10(weight + 10) * 9);
  return { score: s, count: kolCount, weight };
}

function engagementMomentumScore(tweets: TAPITweet[]): number {
  if (tweets.length === 0) return 50;
  const per = tweets.map((t) =>
    t.engagement.likes + t.engagement.retweets * 2 + t.engagement.replies + t.engagement.views / 100,
  );
  per.sort((a, b) => a - b);
  const median = per[Math.floor(per.length / 2)];
  // Heuristic baseline median ~ 5; scale: higher median = stronger.
  const ratio = (median + 1) / 6;
  if (ratio <= 0.3) return 35;
  if (ratio <= 0.7) return 45;
  if (ratio <= 1.5) return 55;
  if (ratio <= 3) return 68;
  if (ratio <= 6) return 78;
  return 88;
}

// ---------- Trusted Source scoring ----------
async function computeTrustedSource(
  ticker: string,
  direction: "CALL" | "PUT",
  cashtagTweets: TAPITweet[],
  cashtagLabels: Array<"bullish" | "bearish" | "neutral">,
): Promise<{ score: number; hits: TrustedHit[] }> {
  // Step 1: harvest any trusted-account tweets already present in the
  // cashtag pull (cheap — no extra API call).
  const hits: TrustedHit[] = [];
  const seen = new Set<string>();

  function addHit(t: TaPITweetLike, sentiment: "bullish" | "bearish" | "neutral") {
    const acct = findTrustedAccount(t.author?.userName);
    if (!acct) return;
    if (!tickerMatchesText(ticker, t.text)) return;
    const id = String((t as any).id ?? `${acct.handle}:${t.text.slice(0, 40)}`);
    if (seen.has(id)) return;
    seen.add(id);
    const eng = (t.engagement.likes ?? 0) + (t.engagement.retweets ?? 0) * 2 +
                (t.engagement.replies ?? 0) + (t.engagement.views ?? 0) / 100;
    const created = (t as any).createdAt as string | undefined;
    const ageMin = created ? Math.max(0, Math.round((Date.now() - Date.parse(created)) / 60000)) : undefined;
    hits.push({
      account: acct.handle,
      tier: acct.tier,
      weight: acct.weight,
      headline: t.text.replace(/\s+/g, " ").slice(0, 220),
      sentiment,
      engagement: Math.round(eng),
      followers: t.author?.followers ?? 0,
      url: (t as any).url,
      created_at: created,
      age_minutes: ageMin,
    });
  }

  for (let i = 0; i < cashtagTweets.length; i++) {
    addHit(cashtagTweets[i] as TaPITweetLike, cashtagLabels[i] ?? "neutral");
  }

  // Step 2: dedicated trusted-source query (covers handles that didn't post a
  // cashtag but mentioned the ticker by name/symbol).
  const handles = TRUSTED_ACCOUNTS.map((a) => a.handle);
  const tsFetch = await fetchTrustedSourceTweets(ticker, handles, { hours: 4, limit: 60 });
  if (tsFetch.state === "active" && tsFetch.tweets && tsFetch.tweets.length) {
    // Classify these trusted tweets (lexicon — small set, no extra LLM cost).
    for (const t of tsFetch.tweets) {
      const s = classifyLexicon(t.text);
      addHit(t as TaPITweetLike, s);
    }
  }

  if (hits.length === 0) {
    return { score: 50, hits: [] }; // neutral when no trusted coverage
  }

  // Step 3: aggregate. Each hit contributes:
  //   contribution = (weight/100) * directional_alignment * recency * engagement_boost
  // Aggregate via diminishing returns: 1 - exp(-k * sum).
  let bullContrib = 0;
  let bearContrib = 0;
  for (const h of hits) {
    const recency = h.age_minutes == null ? 0.7 : Math.max(0.4, 1 - h.age_minutes / 240);
    const engBoost = 1 + Math.min(1.5, Math.log10((h.engagement || 0) + 10) / 4);
    const base = (h.weight / 100) * recency * engBoost;
    if (h.sentiment === "bullish") bullContrib += base;
    else if (h.sentiment === "bearish") bearContrib += base;
    else { bullContrib += base * 0.15; bearContrib += base * 0.15; } // neutral = mild coverage credit both ways
  }

  // Direction-aware: CALL rewards bullish, PUT rewards bearish.
  const aligned = direction === "CALL" ? bullContrib : bearContrib;
  const opposed = direction === "CALL" ? bearContrib : bullContrib;
  const net = aligned - opposed * 0.6;

  // Saturating curve: 1 hit ≈ 60-70, 3 strong aligned hits ≈ 85-92, 5+ ≈ 95+.
  // Floor at 50 (neutral) when net is non-positive but we still have coverage.
  let score: number;
  if (net <= 0) {
    score = clamp100(45 - Math.min(20, opposed * 8));
  } else {
    score = clamp100(55 + (1 - Math.exp(-0.55 * net)) * 45);
  }
  return { score: Math.round(score), hits };
}

type TaPITweetLike = TAPITweet;

function buildTrustedSummary(
  ticker: string,
  hits: TrustedHit[],
  direction: "CALL" | "PUT",
): string {
  if (hits.length === 0) return `No trusted institutional sources have posted on ${ticker} in the last 4 hours.`;
  const accounts = Array.from(new Set(hits.map((h) => h.account)));
  const bull = hits.filter((h) => h.sentiment === "bullish").length;
  const bear = hits.filter((h) => h.sentiment === "bearish").length;
  const tone =
    bull > bear * 1.5 ? "bullish" :
    bear > bull * 1.5 ? "bearish" :
    "mixed";
  const top = accounts.slice(0, 3).join(", ");
  const tail = accounts.length > 3 ? `, +${accounts.length - 3} more` : "";
  const dirNote =
    (direction === "CALL" && tone === "bullish") || (direction === "PUT" && tone === "bearish")
      ? ` aligned with the ${direction} bias`
      : tone === "mixed" ? "" : ` (counter to the ${direction} bias)`;
  return `${hits.length} trusted-source post${hits.length === 1 ? "" : "s"} on ${ticker} — ${top}${tail} — leaning ${tone}${dirNote}.`;
}

// ---------- Main entry ----------
export async function scoreSocialIntelligence(
  ticker: string,
  direction: "CALL" | "PUT",
): Promise<SocialIntelResult> {
  if (!TAPI_CONFIGURED) {
    return neutral(ticker, "missing_key", "TwitterAPI.io key not configured");
  }
  const fetched = await fetchCashtagTweets(ticker, { limit: 200, hours: 4 });
  if (fetched.state !== "active" || !fetched.tweets || fetched.tweets.length === 0) {
    const reason =
      fetched.state === "auth_failed" ? "auth failed" :
      fetched.state === "rate_limited" ? "rate limited" :
      fetched.state === "no_data" ? "no recent cashtag tweets" :
      fetched.error ?? "degraded";
    // Even if the cashtag pull is empty, trusted sources may still cover the ticker.
    const ts = await computeTrustedSource(ticker, direction, [], []);
    return neutral(ticker, fetched.state as any, reason, ts);
  }
  const tweets = fetched.tweets;

  // Classify
  let labels = await classifyLLM(ticker, tweets);
  let classifier: "llm" | "lexicon" = "llm";
  if (!labels) {
    classifier = "lexicon";
    labels = tweets.map((t) => classifyLexicon(t.text));
  }

  let bull = 0, bear = 0, neu = 0;
  for (const l of labels) { if (l === "bullish") bull++; else if (l === "bearish") bear++; else neu++; }
  const total = labels.length;
  const bullPct = bull / total;
  const bearPct = bear / total;
  const neuPct = neu / total;

  // Sub-scores
  const polarity = polarityScore(bullPct, bearPct, direction);
  const baseline = 50;
  const velocity = velocityScore(total, baseline);
  const kol = kolScore(tweets);
  const engagement = engagementMomentumScore(tweets);
  const trusted = await computeTrustedSource(ticker, direction, tweets, labels);

  // New v3 weights: Polarity 35 / Velocity 20 / KOL 15 / Engagement 10 / Trusted 20
  const finalScore = clamp100(
    polarity * 0.35 +
    velocity * 0.20 +
    kol.score * 0.15 +
    engagement * 0.10 +
    trusted.score * 0.20,
  );

  // Top KOL tweets (by followers × engagement)
  const enriched = tweets.map((t, i) => {
    const eng = t.engagement.likes + t.engagement.retweets * 2 + t.engagement.replies + t.engagement.views / 100;
    const f = t.author.followers ?? 0;
    return { t, i, rank: eng * Math.log10(Math.max(f, 10)) };
  }).sort((a, b) => b.rank - a.rank).slice(0, 3);
  const topKolTweets = enriched.map(({ t, i }) => ({
    userName: t.author.userName,
    text: t.text.slice(0, 240),
    url: t.url,
    followers: t.author.followers ?? 0,
    verified: !!(t.author.verified || t.author.isBlueVerified),
    engagement: t.engagement.likes + t.engagement.retweets + t.engagement.replies,
    sentiment: labels![i],
  }));

  const velocityRatio = total / baseline;
  const trustedAccounts = Array.from(new Set(trusted.hits.map((h) => h.account)));
  const trustedSummary = buildTrustedSummary(ticker, trusted.hits, direction);
  const human_reason = buildHumanReason(ticker, direction, {
    bullPct, bearPct, velocityRatio, kolCount: kol.count, total,
    trustedHits: trusted.hits.length, trustedAccounts,
  });
  const reason_code =
    trusted.score >= 80 && trusted.hits.length >= 2 ? "trusted_source_confirmation" :
    polarity >= 70 && velocity >= 60 ? "strong_aligned_sentiment" :
    polarity <= 30 ? "sentiment_misaligned" :
    velocity >= 70 ? "high_velocity" :
    "moderate_signal";

  // Sort trusted hits: tier asc (1 best) then engagement desc; keep top 6 for UI.
  const headlinesForUI = [...trusted.hits]
    .sort((a, b) => (a.tier - b.tier) || (b.engagement - a.engagement))
    .slice(0, 6);

  return {
    score: finalScore,
    configured: true,
    source: "twitterapi_io",
    reason: `${total} tweets · ${(bullPct * 100).toFixed(0)}% bull / ${(bearPct * 100).toFixed(0)}% bear · ${velocityRatio.toFixed(1)}x velocity · ${kol.count} KOLs · ${trusted.hits.length} trusted`,
    details: {
      source: "twitterapi_io",
      provider_status: "active",
      score: finalScore,
      subscores: {
        polarity: Math.round(polarity),
        velocity: Math.round(velocity),
        kol: Math.round(kol.score),
        engagement: Math.round(engagement),
        trusted_source: Math.round(trusted.score),
      },
      samples: {
        total_tweets: total,
        bullish_count: bull,
        bearish_count: bear,
        neutral_count: neu,
        bullish_pct: Math.round(bullPct * 1000) / 10,
        bearish_pct: Math.round(bearPct * 1000) / 10,
        neutral_pct: Math.round(neuPct * 1000) / 10,
        mention_velocity_ratio: Math.round(velocityRatio * 100) / 100,
        kol_count: kol.count,
        top_kol_tweets: topKolTweets,
      },
      trusted_source_score: Math.round(trusted.score),
      trusted_source_hits: trusted.hits.length,
      trusted_source_accounts: trustedAccounts,
      trusted_source_headlines: headlinesForUI,
      trusted_source_summary: trustedSummary,
      trusted_tier_distribution: tierStats(trusted.hits) as unknown as Record<string, number>,
      monitored_account_count: TRUSTED_ACCOUNTS.length,
      reason_code,
      human_reason,
      classifier,
      cost_estimate_usd: Math.round((total + trusted.hits.length) * 0.00015 * 100000) / 100000,
    },
  };
}

function buildHumanReason(
  ticker: string,
  direction: "CALL" | "PUT",
  s: {
    bullPct: number; bearPct: number; velocityRatio: number;
    kolCount: number; total: number;
    trustedHits: number; trustedAccounts: string[];
  },
): string {
  const bullStr = `${Math.round(s.bullPct * 100)}% bullish`;
  const bearStr = `${Math.round(s.bearPct * 100)}% bearish`;
  let tone: string;
  if (s.bullPct >= s.bearPct + 0.25) tone = "strongly bullish";
  else if (s.bullPct >= s.bearPct + 0.1) tone = "leaning bullish";
  else if (s.bearPct >= s.bullPct + 0.25) tone = "strongly bearish";
  else if (s.bearPct >= s.bullPct + 0.1) tone = "leaning bearish";
  else tone = "mixed";
  const velStr = s.velocityRatio >= 1.5 ? `Mention velocity is ${s.velocityRatio.toFixed(1)}x normal.` :
                 s.velocityRatio <= 0.7 ? `Mention velocity is below normal (${s.velocityRatio.toFixed(1)}x).` : "";
  const kolStr = s.kolCount > 0 ? `${s.kolCount} verified KOL account${s.kolCount === 1 ? "" : "s"} actively discussing ${ticker}.` : "";
  const trustedStr = s.trustedHits > 0
    ? ` ${s.trustedAccounts.slice(0, 3).join(", ")}${s.trustedAccounts.length > 3 ? " and others" : ""} (trusted institutional sources) posted on ${ticker} in the last 4 hours.`
    : "";
  const aligned = direction === "CALL" ? s.bullPct >= s.bearPct : s.bearPct >= s.bullPct;
  const alignNote = aligned ? "" : ` Sentiment is misaligned with the ${direction} bias.`;
  return `Twitter/X sentiment is ${tone}. ${bullStr} vs ${bearStr}. ${velStr} ${kolStr}${trustedStr}${alignNote}`.replace(/\s+/g, " ").trim();
}

function neutral(
  _ticker: string,
  status: TAPIState | "missing_key",
  reason: string,
  trusted?: { score: number; hits: TrustedHit[] },
): SocialIntelResult {
  const ts = trusted ?? { score: 50, hits: [] };
  const trustedAccounts = Array.from(new Set(ts.hits.map((h) => h.account)));
  return {
    score: 50,
    configured: status !== "missing_key",
    source: status === "missing_key" ? "neutral" : "twitterapi_io",
    reason: `neutral (${reason})`,
    details: {
      source: status === "missing_key" ? "neutral" : "twitterapi_io",
      provider_status: status,
      score: 50,
      subscores: { polarity: 50, velocity: 50, kol: 50, engagement: 50, trusted_source: Math.round(ts.score) },
      samples: {
        total_tweets: 0, bullish_count: 0, bearish_count: 0, neutral_count: 0,
        bullish_pct: 0, bearish_pct: 0, neutral_pct: 0,
        mention_velocity_ratio: 0, kol_count: 0, top_kol_tweets: [],
      },
      trusted_source_score: Math.round(ts.score),
      trusted_source_hits: ts.hits.length,
      trusted_source_accounts: trustedAccounts,
      trusted_source_headlines: ts.hits.slice(0, 6),
      trusted_source_summary: buildTrustedSummary(_ticker, ts.hits, "CALL"),
      trusted_tier_distribution: tierStats(ts.hits) as unknown as Record<string, number>,
      monitored_account_count: TRUSTED_ACCOUNTS.length,
      reason_code: status === "missing_key" ? "missing_key" : `tapi_${status}`,
      human_reason: `Social Intelligence neutral — ${reason}.`,
      classifier: "none",
    },
  };
}
