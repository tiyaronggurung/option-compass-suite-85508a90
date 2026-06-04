# Signal Lifecycle Engine — Implementation Plan

Replaces the current freshness-by-age heuristic with a thesis-aware lifecycle. Signals are never deleted; they transition through states and remain queryable for outcome tracking, paper history, and analytics.

## Lifecycle states

`fresh` · `active` · `weakening` · `expired` · `invalidated`

State is recomputed on every scan (and on-demand for individual signals) by a pure evaluator that reads the latest scoring snapshot and compares it to the snapshot stored at signal birth.

## 1. Schema changes (single migration)

Additive columns on `public.signals`:

- `lifecycle_state text not null default 'fresh'`
- `lifecycle_reason text` — short machine code (e.g. `confidence_drop_15`, `flow_flip`, `time_exceeded`, `breakout_lost`)
- `lifecycle_updated_at timestamptz not null default now()`
- `confidence_at_birth integer` — backfilled to `confidence` for existing rows
- `flow_at_birth jsonb default '{}'::jsonb` — snapshot of UW bias/premium/sweeps
- `technical_at_birth jsonb default '{}'::jsonb` — breakout/breakdown level + side
- `lifecycle_history jsonb not null default '[]'::jsonb` — append-only `{state, reason, at, confidence}` entries (capped at last 20 client-side)

Index: `create index signals_lifecycle_state_idx on public.signals(lifecycle_state);`

Backfill in same migration:
- `confidence_at_birth = confidence`
- `flow_at_birth = score_components->'options_flow'` (if present)
- `technical_at_birth = score_components->'technical'` (if present)
- Initial `lifecycle_state`:
  - age < 2h → `fresh`
  - age within tier soft limit → `active`
  - age > tier soft limit → `expired`

No changes to `tier`, `confidence`, `hidden`, `status`, scoring weights, scanner gate, or RLS. Existing GRANTs already cover the new columns.

## 2. Lifecycle evaluator

New file: `supabase/functions/_shared/lifecycle.ts`

Pure function:
```
evaluateLifecycle({
  signal,           // current row incl. *_at_birth snapshots
  currentScoring,   // fresh score_components from this scan
  nowMs
}) => { state, reason, transitioned }
```

Tier → soft max age (hours): developing 6 · near_watchlist 12 · watchlist 24 · strong 36 · elite 48. Tier derived from `confidence_at_birth` to keep the budget stable.

Evaluation order (first match wins, strongest signal first):

1. **Invalidated**
   - `confidence_drop >= 15`
   - UW flow flip: bullish↔bearish bias reversal OR net premium sign flip
   - Technical break: CALL breakout level lost, or PUT breakdown level reclaimed (from `technical_at_birth`)
2. **Weakening**
   - `confidence_drop` between 5 and 14
   - UW: sweep activity disappeared OR premium magnitude halved
   - Sentiment/trusted-source score collapsed below neutral
3. **Expired** — `age > tierMaxHours` AND no upgrade signal (confidence not rising, flow not strengthening). Time alone does NOT expire if confirmations remain strong (confidence stable ±4 and flow intact) → stays `active`.
4. **Fresh** — `age < 2h` and no weakening/invalidation
5. **Active** — default

Terminal rule: once `invalidated` or `expired`, no transitions back. `weakening → active` allowed if confirmations recover.

## 3. Scan-time integration

Touch only `supabase/functions/scan-signals/index.ts`:

- After the existing institutional scoring pass, fetch all non-terminal signals for the universe being scanned (state in `fresh|active|weakening`).
- For each, run `evaluateLifecycle` against the freshly computed `score_components` for that ticker/direction (already in memory for the scan).
- Batch-update changed rows with `{lifecycle_state, lifecycle_reason, lifecycle_updated_at, lifecycle_history = lifecycle_history || new_entry}`.
- Append per-scan counters to `signal_scan_runs.avg_components.lifecycle` (transitions by state) for observability. No new table required.

Cost: 1 extra select + 1 batched update per scan. No extra provider calls — uses scoring already computed.

Off-scan: a lightweight evaluator pass also runs from `update-paper-marks` (already cron'd) so lifecycle keeps moving between scans without new infra.

## 4. UI

Files touched:

- `src/lib/signalLifecycle.ts` (new) — types, labels, colors, badge meta. Mirrors `signalTiers.ts` style.
- `src/components/SignalCard.tsx` — render lifecycle badge next to freshness badge. Freshness badge stays (different concept: age-only). Lifecycle badge takes precedence visually when state ≠ `active`.
- `src/components/SignalDetailDialog.tsx` — new "Lifecycle" section showing current state, reason, age vs tier budget, and `lifecycle_history` timeline.
- `src/pages/Dashboard.tsx` — add lifecycle filter chips (All · Fresh · Active · Weakening · Expired · Invalidated). Default view hides `expired` + `invalidated` from main grids; Developing Signals section unchanged otherwise.
- `src/pages/OutcomeAnalytics.tsx` — new "Lifecycle Win-Rate Comparison" card: n, win rate, avg return for each state, joined from `signal_outcomes` on `signal_id`.

No changes to: SignalCard approve button copy, paper approval flow, public guest flows, scanner gate, hidden logic, scoring components.

## 5. Behavior for existing signals

- Migration backfills `*_at_birth` and an initial `lifecycle_state` from age + tier.
- First scan after deploy re-evaluates and may move rows to `weakening`/`invalidated` if current scoring already shows decay vs birth snapshot.
- No existing signal is hidden, deleted, or has its `confidence`/`tier` changed.

## 6. Out of scope (explicitly untouched)

scoring weights · tier thresholds · scanner gate · `hidden` logic · paper/live trade rules · UW/Twitter/insider/SEC Form 4/Tradier scoring · public guest flows (`join`, `status`, `booking`).

## Files

**New**
- `supabase/functions/_shared/lifecycle.ts`
- `src/lib/signalLifecycle.ts`
- one migration file (schema + backfill)

**Modified**
- `supabase/functions/scan-signals/index.ts` (lifecycle pass)
- `supabase/functions/update-paper-marks/index.ts` (between-scan refresh)
- `src/components/SignalCard.tsx`
- `src/components/SignalDetailDialog.tsx`
- `src/pages/Dashboard.tsx`
- `src/pages/OutcomeAnalytics.tsx`

Reply **go** to proceed, or tell me what to change.
