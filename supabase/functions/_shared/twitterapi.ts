// TwitterAPI.io client — primary Social Intelligence source.
// Safe-by-design: never throws into scoring. All failures classify and degrade.
// Used ONLY to power the Sentiment component (15% weight). Does not touch
// Tradier paths, Unusual Whales paths, scoring weights, tier thresholds,
// scanner gate, or hidden flag logic.

const TAPI_KEY = Deno.env.get("TWITTERAPI_IO_API_KEY") ?? "";
const TAPI_BASE = "https://api.twitterapi.io";

export const TAPI_CONFIGURED = !!TAPI_KEY;

export type TAPIState =
  | "active"
  | "missing_key"
  | "auth_failed"
  | "rate_limited"
  | "degraded"
  | "no_data";

export type TAPITweet = {
  id: string;
  text: string;
  createdAt: string;
  lang?: string;
  author: {
    userName?: string;
    name?: string;
    followers?: number;
    verified?: boolean;
    isBlueVerified?: boolean;
    profileImage?: string;
  };
  engagement: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    views: number;
    bookmarks: number;
  };
  isReply?: boolean;
  isRetweet?: boolean;
  isQuote?: boolean;
  url?: string;
};

export type TAPIFetchResult = {
  state: TAPIState;
  status?: number;
  tweets?: TAPITweet[];
  error?: string;
  ms?: number;
  rate_limit?: { remaining?: number; reset?: number };
};

// In-memory cache: ticker → { ts, result }
const CACHE = new Map<string, { ts: number; result: TAPIFetchResult }>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function normalizeTweet(t: any): TAPITweet | null {
  if (!t || typeof t !== "object") return null;
  const a = t.author ?? {};
  return {
    id: String(t.id ?? t.id_str ?? ""),
    text: String(t.text ?? t.full_text ?? ""),
    createdAt: String(t.createdAt ?? t.created_at ?? ""),
    lang: t.lang ?? undefined,
    author: {
      userName: a.userName ?? a.screen_name ?? undefined,
      name: a.name ?? undefined,
      followers: Number(a.followers ?? a.followers_count ?? 0) || 0,
      verified: !!(a.verified ?? a.isVerified),
      isBlueVerified: !!(a.isBlueVerified ?? a.is_blue_verified),
      profileImage: a.profileImage ?? a.profile_image_url_https ?? undefined,
    },
    engagement: {
      likes: Number(t.likeCount ?? t.favorite_count ?? t.likes ?? 0) || 0,
      retweets: Number(t.retweetCount ?? t.retweet_count ?? t.retweets ?? 0) || 0,
      replies: Number(t.replyCount ?? t.reply_count ?? t.replies ?? 0) || 0,
      quotes: Number(t.quoteCount ?? t.quote_count ?? t.quotes ?? 0) || 0,
      views: Number(t.viewCount ?? t.view_count ?? t.views ?? 0) || 0,
      bookmarks: Number(t.bookmarkCount ?? 0) || 0,
    },
    isReply: !!t.isReply,
    isRetweet: !!t.isRetweet,
    isQuote: !!t.isQuote,
    url: t.url ?? (a.userName && t.id ? `https://x.com/${a.userName}/status/${t.id}` : undefined),
  };
}

/**
 * Fetch recent cashtag tweets via TwitterAPI.io advanced search.
 * Window: last `hours` hours, English, latest, target up to `limit` tweets.
 */
export async function fetchCashtagTweets(
  ticker: string,
  opts: { limit?: number; hours?: number; useCache?: boolean } = {},
): Promise<TAPIFetchResult> {
  if (!TAPI_KEY) return { state: "missing_key", error: "TWITTERAPI_IO_API_KEY not configured" };
  const limit = Math.min(Math.max(opts.limit ?? 200, 20), 400);
  const hours = opts.hours ?? 4;
  const useCache = opts.useCache ?? true;

  const cacheKey = `${ticker}:${limit}:${hours}`;
  if (useCache) {
    const hit = CACHE.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return { ...hit.result, ms: 0 };
    }
  }

  const since = new Date(Date.now() - hours * 3600 * 1000)
    .toISOString().replace(/\.\d+Z$/, "_UTC").replace(/[-:T]/g, "_");
  // TwitterAPI.io accepts standard Twitter advanced search operators in `query`.
  const query = `$${ticker} lang:en -is:retweet`;
  const url = `${TAPI_BASE}/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`;

  const t0 = Date.now();
  let tweets: TAPITweet[] = [];
  let cursor: string | undefined;
  let lastStatus = 0;
  let rate_limit: TAPIFetchResult["rate_limit"];

  try {
    // Paginate up to ~5 pages or until we have enough or run out.
    for (let page = 0; page < 5 && tweets.length < limit; page++) {
      const pagedUrl = cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch(pagedUrl, {
        headers: { "X-API-Key": TAPI_KEY, "Accept": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      lastStatus = res.status;
      const rlRem = Number(res.headers.get("x-ratelimit-remaining") ?? "");
      const rlRst = Number(res.headers.get("x-ratelimit-reset") ?? "");
      if (!Number.isNaN(rlRem) || !Number.isNaN(rlRst)) {
        rate_limit = { remaining: Number.isNaN(rlRem) ? undefined : rlRem, reset: Number.isNaN(rlRst) ? undefined : rlRst };
      }
      if (res.status === 401 || res.status === 403) {
        const t = await res.text().catch(() => "");
        const result: TAPIFetchResult = { state: "auth_failed", status: res.status, error: t.slice(0, 200), ms: Date.now() - t0, rate_limit };
        CACHE.set(cacheKey, { ts: Date.now(), result });
        return result;
      }
      if (res.status === 429) {
        const result: TAPIFetchResult = { state: "rate_limited", status: 429, error: "rate limited", ms: Date.now() - t0, rate_limit };
        return result; // don't cache rate limits
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        const result: TAPIFetchResult = { state: "degraded", status: res.status, error: t.slice(0, 200), ms: Date.now() - t0, rate_limit };
        return result;
      }
      const json = await res.json().catch(() => null);
      const items: any[] = json?.tweets ?? json?.data ?? json?.results ?? [];
      for (const it of items) {
        const nt = normalizeTweet(it);
        if (nt && nt.text) tweets.push(nt);
        if (tweets.length >= limit) break;
      }
      cursor = json?.next_cursor ?? json?.cursor ?? undefined;
      if (!cursor || items.length === 0) break;

      // Time-window filter: stop paging if we've passed the window.
      const last = items[items.length - 1];
      const ts = Date.parse(last?.createdAt ?? last?.created_at ?? "");
      if (!Number.isNaN(ts) && ts < Date.now() - hours * 3600 * 1000) break;
    }

    // Filter by hours just in case API returns older tweets.
    const cutoff = Date.now() - hours * 3600 * 1000;
    tweets = tweets.filter((t) => {
      const ts = Date.parse(t.createdAt);
      return Number.isNaN(ts) ? true : ts >= cutoff;
    });

    if (tweets.length === 0) {
      const result: TAPIFetchResult = { state: "no_data", status: lastStatus, tweets: [], ms: Date.now() - t0, rate_limit };
      CACHE.set(cacheKey, { ts: Date.now(), result });
      return result;
    }
    const result: TAPIFetchResult = { state: "active", status: lastStatus, tweets, ms: Date.now() - t0, rate_limit };
    CACHE.set(cacheKey, { ts: Date.now(), result });
    return result;
  } catch (e) {
    return { state: "degraded", error: (e as Error).message.slice(0, 200), ms: Date.now() - t0 };
  }
}

export function cacheStats() {
  return { entries: CACHE.size, ttl_ms: CACHE_TTL_MS };
}
