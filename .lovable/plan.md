# Technical Trend Analysis

Goal: produce a Bullish / Neutral / Bearish verdict per ticker from real indicators, surface it in the UI, and let it nudge the signal confidence score.

## 1. Backend — new edge function `technical-analysis`

Inputs: `{ ticker, timeframe? }`. Output: JSON with raw indicators + a verdict + a numeric `tech_score` in [-100, +100].

Data source: Alpaca historical bars (already wired, no new API needed). Pull ~250 daily candles + ~200 hourly for short-term context.

Indicators computed server-side (using `technicalindicators` via `npm:` import):
- Trend: EMA20, EMA50, EMA200, slope of EMA50, price vs EMAs, golden/death-cross state
- Momentum: RSI(14), MACD(12,26,9) line/signal/histogram
- Volatility: Bollinger Bands(20,2), ATR(14), %B
- Structure: rolling 20/50-day support & resistance (recent swing highs/lows), distance to each
- Volume: 20-day avg volume, today vs avg, simple volume-profile POC over last 60 bars

Verdict rule (transparent weighting, all visible to user):
- +pts for: price > EMA20 > EMA50 > EMA200, MACD hist > 0 and rising, RSI 50–70, near support, above-avg volume on up days
- -pts for the symmetric bearish conditions; RSI > 75 or < 25 flagged as extreme
- Sum → `tech_score`. Buckets: ≥ +30 Bullish, ≤ -30 Bearish, else Neutral

Cached in a new `technical_snapshots` table (ticker, computed_at, payload jsonb) with a 15-min TTL so we don't refetch on every click.

## 2. Score integration (opt-in, conservative)

In the existing signal scoring path, multiply confidence by an alignment factor:
- Long signal + Bullish tech → ×1.05 (capped at 99)
- Long signal + Bearish tech → ×0.90
- Short/PUT signal: mirror
- Neutral → no change

The raw confidence and the adjustment are both stored on the signal (`tech_adjustment` field on `signals.score_components`) so nothing is hidden and old signals are unaffected.

## 3. Frontend

**a) `TechnicalTrendCard` component** — shows verdict badge, score gauge, and a compact grid of indicator readings with green/red coloring and one-line plain-English explanations.

**b) SignalDetailDialog** — new "Technical Trend" section using the card. Fetches on open; cached.

**c) New `/technical` page** — ticker search box + the same card, plus a lightweight `lightweight-charts` price chart with EMA20/50/200 overlays and Bollinger Bands. Link from sidebar.

## 4. What does NOT change

- Public guest flows (join, status, booking) untouched.
- Performance page, Leaderboard, SignalRadar untouched.
- Existing signal rows keep working; `tech_adjustment` is additive metadata.

## Open question before I build

The score-impact factors above (×1.05 / ×0.90) are conservative defaults. OK with those, or want stronger/weaker influence?

Reply "go" to start. I'll implement in this order: migration → edge function → score hook → UI card → /technical page.