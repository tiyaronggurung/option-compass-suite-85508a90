# Institutional Signal Engine v2

Big build. Confirming scope before any code changes (per your standing rule).

## Hard safety rules (no exceptions)
- Do NOT remove, modify, or break the `unusual_whales` provider row, enum value, panel entry, or shared-helper stub. It stays exactly as-is for future use.
- Do NOT touch: ingest webhook, contract picker, paper approval, AI analyst, risk manager, public guest flows, live orders. Paper-only.
- Alpaca remains primary market-data source. Existing scanner keeps working throughout — new engine layers on top.

## 1. New providers (placeholders + real wiring path)
DB migration adds these `provider_id` enum values + `provider_configs` rows (all start `enabled=false`, `mode=simulated`, `last_status=unknown`):
- `finviz` — screener / technical / sector / news
- `tradier` — already exists in `provider_kind` for chains; add `provider_configs` row for confirmation matrix
- `finnhub` — news + fundamentals + analyst actions
- `apify` — X/Twitter sentiment

`unusual_whales` row untouched.

Secrets prompted via `add_secret` only after you say go: `FINVIZ_API_KEY`, `TRADIER_API_KEY`, `FINNHUB_API_KEY`, `APIFY_API_TOKEN`.
If a key is missing, that source returns neutral 50, never blocks the signal.

## 2. Scoring engine (rewrite `scan-signals` scorer)
New shared helper `supabase/functions/_shared/scoring.ts` with 5 components:

| Component       | Weight | Primary source                    |
|-----------------|--------|-----------------------------------|
| Options Flow    | 30%    | Tradier (UW kept dormant)         |
| Technical       | 25%    | Alpaca + Alpha Vantage + Finviz   |
| News            | 20%    | Finnhub + Finviz news             |
| Sentiment       | 15%    | Apify X/Twitter                   |
| Volatility      | 10%    | Tradier IV/Greeks                 |

Final = weighted sum, clamped 0–100. Each component 0–100; missing source → neutral 50 + reason "not configured".
Per-component breakdown stored in `signals.technical_metrics.scoring_v2 = { options_flow, technical, news, sentiment, volatility, sources_used[], final }`.

## 3. Tiers
New columns: `signals.tier text`, `signals.score_components jsonb`.
- ≥90 → `elite`
- 80–89 → `strong`
- 70–79 → `watchlist`
- <70 → `rejected` (`hidden=true`, kept for analytics, never on dashboard)

## 4. Market regime detector
New edge function `detect-market-regime` (cron every 15min during market hours) using Alpaca SPY/QQQ/VIX bars.
Writes `market_regime` table (single row, `id='global'`): `regime` (`bull|bear|sideways|high_vol`), `spy_trend`, `qqq_trend`, `vix_level`, `updated_at`.
Applied as multiplier in scoring, **capped at ±5 points**:
- Bull: CALL ×1.05, PUT ×0.95
- Bear: PUT ×1.05, CALL ×0.95
- High Vol: raise display threshold to 75 for watchlist tier
- Sideways: neutral

## 5. Explanation engine
`signals.reasons[]` populated from actual triggers (Tradier confirms flow, Finviz confirms breakout, RelVol 3.2×, etc). Never empty.
Rendered in `SignalCard` + `SignalDetailDialog`. Source attribution shown per reason.

## 6. Dashboard reorganization (`Dashboard.tsx`)
Top-down sections: Market Overview strip (SPY/QQQ/VIX + regime badge) → Elite → Strong → Watchlist. Existing filters preserved.

## 7. Alerts
Bump alert dispatch floor: only send for `confidence >= 80`. User can still raise their personal threshold.

## 8. Confirmation panel update
`ConfirmationProvidersPanel`: keep Unusual Whales card (label it "reserved — future use"), add Finviz, Tradier, Finnhub, Apify cards. X/Twitter card now backed by Apify. Reddit/Polymarket/Kalshi/Alpha Vantage/News stay as placeholders.

## 9. Self-learning v1 (lightweight, no auto-rebalance)
Extend `SignalLearningPanel` to compute per-component win rate from closed paper trades. Show drift suggestions only — weights stay hardcoded until you approve a change.

## Files

**New**
- `supabase/functions/_shared/scoring.ts`
- `supabase/functions/_shared/regime.ts`
- `supabase/functions/detect-market-regime/index.ts`
- `supabase/functions/finviz-health/index.ts`
- `supabase/functions/tradier-health/index.ts` (if missing)
- `supabase/functions/finnhub-health/index.ts`
- `supabase/functions/apify-sentiment-health/index.ts`
- `src/components/MarketOverviewStrip.tsx`
- `src/components/TierSection.tsx`
- `src/lib/signalTiers.ts`
- migration: add enum values, provider_configs rows, `market_regime` table, signal columns

**Modified**
- `supabase/functions/scan-signals/index.ts` (call new scorer, write tier + components)
- `src/components/SignalCard.tsx` (tier badge, reasons)
- `src/components/SignalDetailDialog.tsx` (component breakdown table)
- `src/components/ConfirmationProvidersPanel.tsx` (add 4 new cards, keep UW)
- `src/pages/Dashboard.tsx` (tier sections, market overview)
- `src/components/SignalLearningPanel.tsx` (per-component win rate)

**Untouched** (verified)
- `ingest-signal`, `pick-contract`, `analyze-signal`, `review-trade`, `update-paper-marks`, `approveSignal.ts`, `riskGuard.ts`, all guest/public flows, Unusual Whales references.

## Open decisions before I start
1. **Backwards compat**: leave old signals' `confidence` alone, new engine applies to newly scanned signals only? (recommended yes)
2. **Rejected signals**: store full row with `hidden=true tier=rejected`? (recommended yes — needed for win-rate analytics)
3. **Secrets**: prompt for all 4 keys now (Finviz/Tradier/Finnhub/Apify), or scaffold stubs first and prompt later when you're ready to wire each? (recommended: scaffold stubs first, prompt per-source when you say so)
4. **Regime multiplier ±5 cap**: OK as proposed?

Reply "go with defaults" or specify changes, and I'll build it.