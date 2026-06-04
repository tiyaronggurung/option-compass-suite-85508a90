
# Social Intelligence v2 — TwitterAPI.io Primary

Replaces the prior Apify Kaito plan. TwitterAPI.io becomes the primary source feeding the existing **15% Sentiment** component. No scoring weights, thresholds, gates, or protected paths change.

## Scope (additive only)

**Touched:** Sentiment component logic, SignalDetailDialog, Diagnostics page, provider-debug probe.
**Untouched:** Options Flow (UW), Technical, News, Volatility, weights, tier thresholds, scanner gate (40), hidden-flag logic, regime engine, insider scoring, SEC Form 4, Tradier reserved paths, paper trades, live orders, guest flows, scoring architecture.

## Files

**New**
- `supabase/functions/_shared/twitterapi.ts` — auth, retries, rate-limit handling, error classification, 15-min ticker cache, never throws into scoring.
- `supabase/functions/_shared/social-intel.ts` — `scoreSocialIntelligence(ticker, direction)` returning the Sentiment block.
- `supabase/functions/twitterapi-health/index.ts` — health probe writing to `provider_configs`.

**Modified**
- `supabase/functions/_shared/scoring.ts` — replace neutral-50 sentiment path with `scoreSocialIntelligence()`. Same component slot, same 15% weight. Direction-aware (CALL rewards bullish, PUT rewards bearish). Same fallback ladder used for UW.
- `supabase/functions/provider-debug/index.ts` — add `twitterapi_io` probe.
- `src/pages/Diagnostics.tsx` — add TwitterAPI.io card (status, latency, last refresh, errors).
- `src/components/SignalDetailDialog.tsx` — add "Social Intelligence — X/Twitter" block.

## Social Intelligence engine

- **Universe:** NVDA, TSLA, AMD, META, AAPL, MSFT, SPY, QQQ (cashtag `$TICKER`)
- **Window:** last 4 hours, latest tweets, English, target 200/ticker
- **Cache:** 15 min per ticker (in-memory + `kv_cache` table if present, else memory only)
- **Sentiment classifier:** `google/gemini-2.5-flash-lite` via Lovable AI Gateway, batched ~50 tweets/call; lexicon fallback on LLM failure
- **Baselines:** 7-day rolling mention count & engagement medians stored per ticker

## Sub-scores (Sentiment 0–100)

| Sub-score | Weight | Inputs |
|---|---|---|
| Polarity | 40% | bullish/bearish/neutral % (direction-aware) |
| Mention velocity | 25% | current 4h count ÷ baseline |
| KOL activity | 20% | verified / blue / followers>50k count + Σ engagement × log(followers) |
| Engagement momentum | 15% | (likes + 2×RT + replies + views/100) vs 7-day median |

## Provider states

`active` · `missing_key` · `auth_failed` · `rate_limited` · `degraded` · `no_data`

On `missing_key` / `auth_failed` / `no_data` → neutral 50 (preserves current behavior).

## Stored metadata (`score_components.components.sentiment`)

```
{
  source: "twitterapi_io",
  provider_status,
  score,
  subscores: { polarity, velocity, kol, engagement },
  samples: { total_tweets, bullish_count, bearish_count, neutral_count, top_kol_tweets[3] },
  reason_code,
  human_reason
}
```

Example `human_reason`:
> "Twitter/X sentiment is strongly bullish. 68% bullish vs 14% bearish. Mention velocity 2.3× normal. 12 verified KOLs actively discussing NVDA."

## UI

**SignalDetailDialog** — new "Social Intelligence — X/Twitter" section: score, bullish/bearish/neutral %, mention count, velocity ratio, KOL count, engagement score, top 3 KOL tweets, human reason.

**Diagnostics** — TwitterAPI.io card: status, latency, response count, rate-limit headers, last refresh, errors.

## Validation (no DB writes, no signals inserted)

Run `score-debug` for: NVDA CALL, TSLA CALL, AMD CALL, META CALL, SPY PUT, QQQ PUT.

Report:
- TwitterAPI.io provider status
- Sentiment before vs after
- Final confidence before vs after
- Signals crossing 70+
- Dashboard visible count vs Developing count
- Estimated API cost
- Cache hit ratio

## Future (not implemented now)

Apify Kaito fallback, Reddit, StockTwits, Discord, influencer tracking, narrative clustering. Architecture left pluggable.

---

`TWITTERAPI_IO_API_KEY` is saved. Reply **"go"** to implement, or request changes.
