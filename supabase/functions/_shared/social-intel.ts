// Social Intelligence engine — powers the Sentiment component (15%).
// Primary source: TwitterAPI.io. AI classifier: gemini-2.5-flash-lite via
// Lovable AI Gateway, with lexicon fallback. Safe-by-design: never throws
// into scoring; missing/auth/no_data → neutral 50.

import { fetchCashtagTweets, TAPI_CONFIGURED, type TAPITweet, type TAPIState } from "./twitterapi.ts";

const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";

export type SocialIntelResult = {
  score: number;            // 0..100 (direction-aware)
  configured: boolean;
  source: string;           // "twitterapi_io" | "neutral"
  reason: string;
  details: {
    source: string;
    provider_status: TAPIState | "missing_key";
    score: number;
    subscores: { polarity: number; velocity: number; kol: number; engagement: number };
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
    return neutral(ticker, fetched.state as any, reason);
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
  // Baseline heuristic: assume ~50 tweets/4h is normal cashtag baseline for major tickers.
  // (When we add a baseline table later, swap this for the rolling 7-day median.)
  const baseline = 50;
  const velocity = velocityScore(total, baseline);
  const kol = kolScore(tweets);
  const engagement = engagementMomentumScore(tweets);

  const finalScore = clamp100(
    polarity * 0.40 + velocity * 0.25 + kol.score * 0.20 + engagement * 0.15,
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
  const human_reason = buildHumanReason(ticker, direction, {
    bullPct, bearPct, velocityRatio, kolCount: kol.count, total,
  });
  const reason_code =
    polarity >= 70 && velocity >= 60 ? "strong_aligned_sentiment" :
    polarity <= 30 ? "sentiment_misaligned" :
    velocity >= 70 ? "high_velocity" :
    "moderate_signal";

  return {
    score: finalScore,
    configured: true,
    source: "twitterapi_io",
    reason: `${total} tweets · ${(bullPct * 100).toFixed(0)}% bull / ${(bearPct * 100).toFixed(0)}% bear · ${velocityRatio.toFixed(1)}x velocity · ${kol.count} KOLs`,
    details: {
      source: "twitterapi_io",
      provider_status: "active",
      score: finalScore,
      subscores: {
        polarity: Math.round(polarity),
        velocity: Math.round(velocity),
        kol: Math.round(kol.score),
        engagement: Math.round(engagement),
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
      reason_code,
      human_reason,
      classifier,
      // TwitterAPI.io ~ $0.00015/tweet (advanced search). Rough estimate.
      cost_estimate_usd: Math.round(total * 0.00015 * 100000) / 100000,
    },
  };
}

function buildHumanReason(
  ticker: string,
  direction: "CALL" | "PUT",
  s: { bullPct: number; bearPct: number; velocityRatio: number; kolCount: number; total: number },
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
  const aligned = direction === "CALL" ? s.bullPct >= s.bearPct : s.bearPct >= s.bullPct;
  const alignNote = aligned ? "" : ` Sentiment is misaligned with the ${direction} bias.`;
  return `Twitter/X sentiment is ${tone}. ${bullStr} vs ${bearStr}. ${velStr} ${kolStr}${alignNote}`.replace(/\s+/g, " ").trim();
}

function neutral(_ticker: string, status: TAPIState | "missing_key", reason: string): SocialIntelResult {
  return {
    score: 50,
    configured: status !== "missing_key",
    source: status === "missing_key" ? "neutral" : "twitterapi_io",
    reason: `neutral (${reason})`,
    details: {
      source: status === "missing_key" ? "neutral" : "twitterapi_io",
      provider_status: status,
      score: 50,
      subscores: { polarity: 50, velocity: 50, kol: 50, engagement: 50 },
      samples: {
        total_tweets: 0, bullish_count: 0, bearish_count: 0, neutral_count: 0,
        bullish_pct: 0, bearish_pct: 0, neutral_pct: 0,
        mention_velocity_ratio: 0, kol_count: 0, top_kol_tweets: [],
      },
      reason_code: status === "missing_key" ? "missing_key" : `tapi_${status}`,
      human_reason: `Social Intelligence neutral — ${reason}.`,
      classifier: "none",
    },
  };
}
