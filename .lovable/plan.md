# Goal

Run `scan-signals` every **2 minutes** during US market hours (9:30–16:00 ET, Mon–Fri) without blowing through Unusual Whales / Finviz / Finnhub / Alpaca quotas.

# Current state (measured)

- Cron today: every **5 min** → ~78 runs/day
- Per-ticker calls inside scan-signals (worst case): Alpaca bars + Finviz CSV + Finnhub sentiment + Finnhub company-news + UW flow (+ UW chain if a candidate qualifies) ≈ **5–6 calls/ticker**
- Universe = `base_8` (SPY, QQQ, NVDA, TSLA, AMD, AAPL, META, MSFT) → ~40–48 calls per run
- Today's daily cost ≈ 78 × ~45 = **~3,500 calls/provider/day**

# Going to 2-min

- 2-min cron → **195 runs/day** (2.5×)
- Naive cost ≈ **~8,800 calls/provider/day** → risky for Finviz Elite and Finnhub free tiers; UW is fine but flow endpoint rate-limits at burst.

# Strategy: keep 2-min cadence, cut work per run

Four layered guardrails, all toggleable from `scanner_settings` (no UI rebuild — reuses existing row).

## 1. Cron — every 2 min, market hours only

```text
*/2 13-20 * * 1-5   (UTC = 9–16 ET, covers DST both ways with existing market-hours guard)
```

`scan-signals` already early-exits with `outside_hours` when market closed (45ms, ~0 calls). So weekends/nights cost nothing.

## 2. Tiered cadence per ticker (biggest saving)

Not every ticker needs a fresh scan every 2 min. Split universe into 3 tiers stored as a column on `tradable_universe` (or computed from existing rank):

| Tier | Tickers | Scanned every |
|---|---|---|
| Hot | SPY, QQQ + top 5 by today's UW flow | 2 min (every run) |
| Warm | rest of base_8 + watchlists | 6 min (every 3rd run) |
| Cold | top_100 mode tail | 10 min (every 5th run) |

Implementation: add `tier_cadence_minutes` int column; scanner skips a ticker if `now() - last_scanned_at < cadence`. Track `last_scanned_at` per ticker in a tiny `scanner_ticker_state` table (ticker pk, last_scanned_at).

**Effect:** at 2-min cadence with base_8, real per-run work ≈ 2 hot + (8/3) warm ≈ ~5 tickers × ~5 calls = **~25 calls/run** instead of 45. Daily ≈ 195 × 25 = **~4,900 calls/day** (only +40% vs today, not +150%).

## 3. Provider-level caching inside one run

- **Finviz CSV**: already per-ticker; add 90-second in-memory + Supabase KV cache (`scanner_cache` table, key=`finviz:TICKER`, expires_at). At 2-min cadence ~50% of Finviz calls become cache hits.
- **Finnhub news**: cache 5 min per ticker (news doesn't change that fast).
- **UW flow**: keep fresh (this is the alpha) — no cache.
- **Alpaca bars**: cache 60 s (bars are 1-min anyway).

Expected reduction: another **~40%** on Finviz/Finnhub, **0%** on UW.

## 4. Hard daily budget caps (circuit breaker)

New table `provider_budget_counters` (provider text pk, date date, calls int, daily_cap int).

Each provider wrapper increments the counter; if `calls >= daily_cap` the wrapper returns `null` with reason `budget_exhausted` and the scan run logs `skipped_due_to_budget`. Defaults:

| Provider | Daily cap |
|---|---|
| Unusual Whales | 8,000 |
| Finviz | 5,000 |
| Finnhub | 5,000 |
| Alpaca | 20,000 |

User can edit caps in Diagnostics later — for now hardcode + show in scan-run row.

## Combined projection

- Without tiering or cache: 8,800/provider/day → **OVER** Finnhub free
- With tiering + cache: **~3,000–4,000/provider/day** → comfortably under all current limits, even on `top_100` universe mode.

# Schema changes (one small migration)

```sql
create table public.scanner_ticker_state (
  ticker text primary key,
  last_scanned_at timestamptz,
  last_tier text
);
create table public.provider_budget_counters (
  provider text not null,
  date date not null,
  calls int not null default 0,
  daily_cap int not null,
  primary key (provider, date)
);
create table public.scanner_cache (
  cache_key text primary key,
  payload jsonb not null,
  expires_at timestamptz not null
);
-- grants + RLS service_role only; UI doesn't read these directly
```

Plus add `tier_cadence_minutes int default 2` to `tradable_universe`.

# Code changes

- `supabase/functions/scan-signals/index.ts`: tier filter loop, wrap provider calls with `withBudget()` + `withCache()` helpers
- `supabase/functions/_shared/budget.ts` (NEW): `incrementAndCheck(provider, cap)` + cache get/set
- Cron: update existing pg_cron entry from `*/5` to `*/2` (insert via supabase--insert because URL/anon-key specific)
- `SignalScannerPanel.tsx`: change subtitle "Runs every 5 min" → "Runs every 2 min", add small "Budget" badge showing today's call counts (read-only, reuses `provider_budget_counters`)

# Untouched (per your rules)

- Guest flows (`/join`, `/status`, `/booking`) — no changes
- `update-paper-marks` cron and logic — no changes
- Scoring weights, signal thresholds, lifecycle, hidden logic — no changes
- Existing 5-min run history rows stay intact

# Validation

1. Run migration → confirm tables/grants
2. Manually trigger `scan-signals` 3 times in a row → confirm 2nd/3rd hit cache, counters increment
3. Force `daily_cap = 5` on Finviz → confirm next call returns `budget_exhausted` and `signal_scan_runs.skipped_due_to_budget > 0`
4. Flip cron to `*/2` → watch 4 runs over 8 min, confirm tier skipping works
5. Compare 24h call totals vs today (should be ~+40%, not +150%)

# Decisions I need from you before coding

1. Approve **2-min cadence** with tiering (hot=2m, warm=6m, cold=10m) — or do you want everything every 2 min and trust the daily caps alone?
2. Approve the **default daily caps** (UW 8k / Finviz 5k / Finnhub 5k / Alpaca 20k), or set your own?
3. Approve the **3 new tables** (`scanner_ticker_state`, `provider_budget_counters`, `scanner_cache`)?
4. Should the panel keep showing "ok" status when a run is partially skipped due to budget, or surface a new `budget_throttled` status?

Say "go" and I implement exactly this — nothing more, nothing less.
