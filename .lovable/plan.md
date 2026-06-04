# Contract Selection Engine — Plan (paper-only)

## Goal

Turn a signal (`NVDA CALL`) into a concrete, defensible paper contract:

> NVDA 225C · 28 DTE · Δ 0.58 · spread 4.1% · OI 8,420 · vol 1,210 · score 82 · rationale: "Near-money, balanced delta, tight spread, healthy liquidity"

Paper-only. No live orders. No scoring/threshold/scanner/lifecycle/hidden/guest/signal-generation changes.

## Provider priority (gracefully degrades)

1. **Unusual Whales** — chain, greeks, OI, volume, IV (primary)
2. **Alpaca Options** — snapshot/quote fallback when UW chain is empty/unavailable
3. **Unavailable** — do NOT invent data. Block approval with reason `contract_chain_unavailable`. Never fake premium/strike/delta/expiry.

Stamp `contract_source` on every snapshot: `unusual_whales` | `alpaca` | `unavailable`.

## Schema changes

Single new table (cleaner than bloating `signals` or `paper_trades`):

```text
contract_selection_snapshots
  id uuid pk
  signal_id uuid (nullable, indexed)
  paper_trade_id uuid (nullable, indexed)
  user_id uuid (nullable — null for system pre-selections)
  underlying text
  option_type text  -- CALL | PUT
  contract_symbol text
  strike numeric
  expiry date
  dte int
  delta numeric
  gamma numeric
  theta numeric
  vega numeric
  iv numeric
  iv_rank numeric (nullable)
  bid numeric
  ask numeric
  mid numeric
  spread_pct numeric
  volume bigint
  open_interest bigint
  premium numeric        -- entry premium snapshot
  contract_score int     -- 0..100
  liquidity_score int    -- 0..100
  rationale text         -- short human sentence
  rationale_factors jsonb -- {dte_fit, delta_fit, spread, liquidity, oi, vol, iv, affordability}
  contract_source text   -- unusual_whales | alpaca | unavailable
  candidates_considered int
  risk_profile text      -- developing|near_watchlist|watchlist|strong|elite
  selected_at timestamptz default now()
  created_at timestamptz default now()
```

Plus on `paper_trades`: add `contract_snapshot_id uuid` (nullable, FK soft). Optional on `signals`: `suggested_contract_snapshot_id uuid` (nullable) — only written by the selector, never by scanner.

RLS: SELECT auth (snapshots are non-sensitive analytics). INSERT/UPDATE service_role + owner via edge function. GRANTs for `authenticated` (SELECT) and `service_role` (ALL).

## Default contract preferences by confidence band — Hybrid philosophy

Lower confidence → safer (higher delta, more intrinsic, tighter liquidity). Higher confidence → allow more leverage.

| Band | Conf | DTE | Delta | Max spread % | Min OI | Min Vol |
|---|---|---|---|---|---|---|
| Developing | 50–64 | 30–45 | 0.65–0.75 | 5% | 500 | 100 |
| Near Watchlist | 65–69 | 28–45 | 0.55–0.70 | 6% | 400 | 100 |
| Watchlist | 70–79 | 21–40 | 0.50–0.65 | 7% | 300 | 75 |
| Strong | 80–89 | 14–35 | 0.45–0.60 | 8% | 250 | 50 |
| Elite | 90+ | 14–30 | 0.40–0.55 | 10% | 200 | 50 |

Universal v1 guards: contracts=1, no 0–6 DTE unless user manually overrides later, skip if `bid<=0` or `ask<=0`, skip if `premium*100 > 5000` (affordability cap for paper sanity), prefer monthly expiries when within DTE window.

## Scoring formula (0–100)

```text
score =
  0.25 * dte_fit          // triangular: 1.0 at center of band, 0 at edges
+ 0.25 * delta_fit        // triangular over band
+ 0.20 * liquidity        // log-scaled OI + volume vs band mins
+ 0.15 * spread_quality   // 1.0 if spread_pct <= half max, linear to 0 at max
+ 0.10 * affordability    // 1.0 if premium*100 <= 1000, linear to 0 at 5000
+ 0.05 * iv_sanity        // penalize IV in top decile vs underlying history when available
```

Tiebreak: higher OI, then tighter spread, then closer-to-target delta.

Reject candidate if: spread_pct > band max, OI < band min, volume < band min, expiry within 6 DTE, bid<=0, ask<=0.

Engine returns top-1 plus up to 4 alternates for UI.

## Approval flow

1. User clicks Approve on a signal.
2. `approveSignal.ts` checks: does signal have `suggested_contract_snapshot_id`?
   - Yes → reuse snapshot (re-validate freshness; if >5 min old re-fetch quote).
   - No → call new edge function `select-contract`.
3. `select-contract`:
   - Try UW chain for underlying → score candidates → pick best.
   - If UW empty → try Alpaca options chain.
   - If both empty → return `{ ok:false, reason:'contract_chain_unavailable' }`.
4. On success: insert `contract_selection_snapshots` row, then create `paper_trades` row with `contract_snapshot_id`, `entry_premium`, `strike`, `expiry`, `option_type`, `contracts=1`, `multiplier=100`, `total_cost`, `paper_test_class`, `confidence_at_approval`.
5. On failure: surface a non-blocking toast + dialog: "No tradable contract found for NVDA right now (chain unavailable). Paper trade not created." No fake fallback.

## UI changes (paper-only, additive)

- **SignalDetailDialog**: new `ContractRecommendationPanel` showing top pick + 2 alternates: strike, DTE, Δ, spread %, OI, vol, score, one-line rationale. "Use this contract" button. Three safety badges: Paper Option Trade · Simulation Only · No real money executed.
- **OptionTradeCard**: when `contract_snapshot_id` present, render small "Why this contract" expandable with factor bars (dte fit, delta fit, liquidity, spread).
- **Trades page**: existing card unchanged behaviorally; just gains rationale section.

No changes to: scanner UI, lifecycle UI, hidden signals, guest /join /status /booking flows.

## Validation plan

Run `select-contract` for: NVDA CALL, AMD CALL, TSLA PUT, SPY CALL, QQQ PUT (all paper-only, hidden+demo seeded if needed). Report a table:

```text
ticker  dir  strike  DTE  Δ      spread%  OI      vol    score  source  reason
NVDA    C    225     28   0.58   3.9%     8420    1210   82     uw      "Balanced near-money, tight spread"
AMD     C    ...
TSLA    P    ...
SPY     C    ...
QQQ     P    ...
```

Then approve one (NVDA dev-band, hidden/demo), confirm `contract_selection_snapshots` row + `paper_trades.contract_snapshot_id` linkage, run `update-paper-marks`, close, verify realized P/L + analytics card still excludes demo.

## Protected / untouched

- Live trading, real orders
- Scoring weights, thresholds, scanner logic, signal generation, lifecycle, hidden logic
- Guest flows (join, status, booking)
- `update-paper-marks` math (only reads new snapshot, doesn't change P/L logic)

## Files to be created / edited (preview only — no edits yet)

- NEW migration: `contract_selection_snapshots` + `paper_trades.contract_snapshot_id`
- NEW `supabase/functions/select-contract/index.ts`
- NEW `src/lib/contractSelection/scoring.ts` (pure scoring helpers, used by edge + UI preview)
- NEW `src/lib/contractSelection/bands.ts` (the hybrid table above)
- NEW `src/components/ContractRecommendationPanel.tsx`
- EDIT `src/lib/approveSignal.ts` — wire selector + snapshot linkage
- EDIT `src/components/OptionTradeCard.tsx` — render rationale section
- EDIT `src/components/SignalDetailDialog.tsx` — mount panel

## Decisions needed from you before code

1. Approve the **Hybrid** band table as-is, or send edits.
2. Approve **contracts=1** default and **$5,000 max premium** affordability cap for paper v1.
3. Approve a **new `contract_selection_snapshots` table** (vs cramming into `paper_trades`).
4. Approve the **block-on-unavailable** behavior (no synthetic fallback).

On your "go" I will implement exactly this — nothing more, nothing less.