# Phase 1 + Phase 2 — Data Foundation Build

No scoring math changes. No weight changes. No tier/scanner/Tradier/UW/paper/live/guest touches. Everything below is **collect + store + display + explain** plus passive outcome tracking.

---

## Phase 1 — Insider Intelligence

### 1.1 Schema (one migration)

**Table: `insider_transactions`**
- `ticker` text, `insider_name` text, `role` text (CEO/CFO/Director/Officer/10%/Other)
- `transaction_type` text (P-Purchase / S-Sale / A-Grant / M-Option Exercise / G-Gift / Other)
- `filing_date` date, `transaction_date` date
- `shares` numeric, `price` numeric, `total_value` numeric
- `direction` text ('buy' | 'sell')
- `source` text ('finviz' | 'sec_form4' | 'manual' | future…)
- `external_ref` text (dedupe key: source + filing hash)
- standard id/created_at/updated_at
- Unique index on `(ticker, insider_name, transaction_date, transaction_type, shares, source)` for idempotent upserts
- RLS: select for authenticated; insert/update via service role only (edge functions)
- GRANTs: select to authenticated, all to service_role

**Table: `insider_strength_scores`** (metadata cache — NOT wired into confidence)
- `ticker` text PK
- `score` int 0–100, `label` text (`strong_buy` | `buy` | `neutral` | `sell` | `strong_sell`)
- `signals` jsonb (array of `{ kind, weight, detail }`: CEO_buy, CFO_buy, director_buy, cluster_30d, large_dollar, multiple_insiders, option_exercise_weak, grant_weak, small_buy_weak)
- `window_days` int default 90
- `as_of` timestamptz
- RLS: select for authenticated; service-role writes
- This is a derived view used purely for display + explanation.

### 1.2 Ingestion edge function: `insider-sync`

- Admin-gated POST (also cron-callable with `SIGNAL_INGEST_SECRET`)
- For each watchlist/universe ticker:
  - **Finviz** (`insidertrading.ashx?t=TICKER&v=2`) — already in `_shared/finviz-extras.ts` insider fetch; extend to capture full row schema and write to `insider_transactions`
  - **SEC Form 4 architecture stub** — typed adapter interface `InsiderAdapter` with `name`, `fetch(ticker)`, `parse(raw)`; ship `finvizAdapter` working + `secForm4Adapter` returning `{ available: false, reason: "not yet implemented" }`. This is the future-ready hook the user asked for.
- Compute `insider_strength_scores` per ticker from last 90 days:
  - +25 CEO buy, +20 CFO buy, +12 Director buy, +10 multiple insiders (≥3 buyers), +15 cluster (≥3 buys / 30d), +10 large dollar (>$500k), −10 option exercise dominant, −5 grants dominant, −5 only-small purchases
  - Clamp 0–100, map to label
- Idempotent upserts via `external_ref`

### 1.3 Display + Explain (read-only UI)

- **New tab** in `SignalDetailDialog`: "Insider Activity" block
  - Strength score pill (color-coded), label, last 30/90 day buy vs sell counts
  - Top 5 recent transactions table (date, name, role, type, shares, $value)
  - Signals breakdown: each contributing factor shown with sign + label (e.g. "CEO buy +25", "Cluster (3 in 30d) +15")
  - Explicit footer note: "Metadata only — does not affect confidence score"
- **New admin page**: `/app/diagnostics/insiders` — last sync, row counts per source, last error per ticker

---

## Phase 2 — Historical Performance Tracking

### 2.1 Schema (same migration)

**Table: `signal_outcomes`**
- `signal_id` uuid PK references `signals(id)`
- `ticker` text, `direction` text, `confidence` int, `tier` text
- `score_components` jsonb (snapshot at creation — copy of `signals.score_components`)
- `entry_price` numeric, `entry_at` timestamptz
- `price_1d`, `price_3d`, `price_5d`, `price_10d`, `price_30d` numeric (nullable)
- `return_1d`, `return_3d`, `return_5d`, `return_10d`, `return_30d` numeric (nullable, % signed by direction so CALL up = positive, PUT down = positive)
- `win_1d`, `win_3d`, `win_5d`, `win_10d`, `win_30d` boolean (nullable; null = pending)
- `status` text (`pending` | `partial` | `final` | `errored`)
- `last_updated_at` timestamptz
- RLS: select to authenticated, writes service-role only

**Materialized stats are computed on-read** (no extra table needed for v1).

### 2.2 Ingestion hook

- **At signal creation**: trigger function copies `signals` row → `signal_outcomes` with `entry_price = signals.price`, `entry_at = signals.created_at`, status `pending`. This is a `AFTER INSERT` trigger on `signals` — does NOT modify scanner logic or signals table itself.
- **Edge function `outcome-tracker`** (cron, every 30 min during market hours, also admin-trigger):
  - Pulls all `pending`/`partial` outcomes
  - For each: compute hours since `entry_at`; for any milestone window now ≥ that age, fetch close price from Alpaca bars (already integrated), compute return, set win bool by direction
  - Marks `final` once `price_30d` populated
  - Uses Alpaca only (already wired) — no new provider dependency

### 2.3 Performance dashboard (admin)

- **New page**: `/app/diagnostics/performance`
  - Overall: win rate + avg return per window (1/3/5/10/30 day)
  - **Confidence buckets**: 60–69, 70–79, 80–89, 90+ → win rate + avg return per window (the "67%/81%" view the user wants)
  - **Best/worst component drivers**: bucket by `score_components.components.options_flow.score` quartile etc. → win rate per quartile
  - Direction split (CALL vs PUT)
  - Tier split (elite vs strong vs watchlist)
  - Sample-size column always shown; gray-out cells with n<10
- Read-only. Pure analytics. No write paths.

---

## What this build deliberately does NOT do

- Does not touch `_shared/scoring.ts` math, weights, regime adjust, or tier function
- Does not change `signals` insert path beyond an additive `AFTER INSERT` trigger that writes to a separate table
- Does not change scanner gate, hidden flag, or any reserved Tradier/UW/paper/live/guest code
- Insider strength is **never** read by `scoreInstitutional()` in this phase

---

## Order of execution

1. Create migration (both tables + trigger + GRANTs + RLS) → wait for approval
2. Build `insider-sync` edge function + extend `finviz-extras` adapter shape
3. Build `outcome-tracker` edge function
4. Wire `SignalDetailDialog` "Insider Activity" block
5. Build `/app/diagnostics/insiders` and `/app/diagnostics/performance` pages
6. Backfill: run `insider-sync` once across watchlist; run `outcome-tracker` once to populate windows for existing signals
7. Smoke-test with `score-debug` to confirm no scoring regression

---

## Confirm or adjust

Reply **go** to execute as-is, or tell me what to change. Common knobs you might want to tune:

- Insider score weights (CEO +25 etc.) — I picked sane defaults; tell me if you want different
- Outcome windows (1/3/5/10/30 day) — confirm or change
- Confidence buckets (60s/70s/80s/90+) — confirm or change
- Cron frequency for `outcome-tracker` — 30 min default
- Diagnostics pages admin-only? (defaulting yes, matching `/app/diagnostics`)
