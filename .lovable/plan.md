## Scope: 0.35-Delta Options Contract Picker

Goal: when `scan-signals` creates a LIVE signal, look up the cached `options_contracts` row that best matches a ~0.35 delta, liquid, 14–30 DTE contract, and attach it to the signal. Show breakdown in UI. Admin can force a chain refresh + re-pick.

Note: this project uses **Alpaca options snapshots** (not Tradier). Wherever the brief says "Tradier", I'll treat it as "the configured options provider" — currently Alpaca via the existing `fetch-options-chain` function. If `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` are unset, picker is a no-op and the signal is created with `No contract match yet.`

---

### 1. Shared picker utility

New file: `supabase/functions/_shared/pickContract.ts`

```ts
pickBestContract({
  underlying, direction: 'CALL'|'PUT', admin,
  targetDelta = 0.35, dteMin = 14, dteMax = 30, dteIdeal = 21
}) -> { contract, reason, liquidityScore } | null
```

Logic:
1. Query `options_contracts` where `underlying = ticker`, `type = call|put`, `expiry` between today+dteMin and today+dteMax.
2. Filter liquidity: `open_interest > 100`, `volume > 10`, `bid > 0`, `ask > 0`, `(ask-bid) / mid <= 0.25`, `delta` not null.
3. For PUTs, compare against `Math.abs(delta)` since put deltas are negative.
4. Score each candidate (lower = better):
   - `deltaDist = |abs(delta) - 0.35| * 100`
   - `dteDist   = |dte - 21| * 0.3`
   - `spreadPct = (ask-bid)/mid * 100`
   - `liquidityPenalty = 1/log10(OI+10) + 1/log10(volume+10)`
   - `score = deltaDist*2 + dteDist + spreadPct*0.5 + liquidityPenalty`
5. Return best + human reason: `"Δ 0.34, 21 DTE, spread 4.2%, OI 1.2k"`.
6. If no rows pass filters, retry once with relaxed liquidity (`OI>10`, `vol>0`, `spread<=40%`). Still none → return `null`.

### 2. Integration in `scan-signals`

After a signal passes the scoring threshold, **before** insert:
- Call `pickBestContract` for that ticker/direction.
- If match: include `contract_symbol`, `expiry`, `strike`, `premium = (bid+ask)/2`, `dte`, and add to `technical_metrics`:
  ```json
  "contract": { "delta": .., "iv": .., "bid": .., "ask": .., "mid": .., "dte": .., "liquidity_score": .., "reason": ".." }
  ```
- If no match: insert signal as-is (existing fields stay null). Add reason `"No contract match yet."` to `reasons` array.
- Wrapped in try/catch — picker failure never blocks signal creation. Scoring logic itself is untouched.

### 3. New edge function: `pick-contract` (admin)

`supabase/functions/pick-contract/index.ts` — admin-only. Body: `{ signal_id }`.
- Load signal. If `options_contracts` has < N fresh rows (updated within 24h) for that underlying, internally invoke `fetch-options-chain` first to refresh.
- Run `pickBestContract`. Update the signal row with new contract fields + `technical_metrics.contract`.
- Returns the picked contract + reason.

### 4. UI changes

- `SignalCard.tsx`: if `contract_symbol` present, show small line: `CALL 580 · 21d · $4.25 mid`.
- `SignalDetailDialog.tsx`: new "Recommended contract" section showing symbol, strike, expiry, DTE, delta, IV, bid/ask/mid, liquidity score, and the picker reason. Falls back to "No contract match yet." if absent.
- Admin-only button **"Refresh chain + pick contract"** invoking `pick-contract` edge function, with toast on success/error and a re-fetch of the signal.

### 5. Hard guarantees (preserved)

- No live orders.
- Ingest webhook untouched.
- Scanner scoring math untouched — picker runs strictly after scoring.
- Paper approval flow unchanged. (Existing `contract_idea` field on `paper_trades` will naturally use the new `contract_symbol` since the dashboard already reads from the signal.)
- Public guest flows untouched.
- Expiry / TTL rules unchanged.
- If provider unconfigured → picker is a clean no-op, signals still created.

### Files

- new: `supabase/functions/_shared/pickContract.ts`
- new: `supabase/functions/pick-contract/index.ts`
- edit: `supabase/functions/scan-signals/index.ts` (call picker post-scoring, attach fields)
- edit: `src/components/SignalCard.tsx` (one-line contract summary)
- edit: `src/components/SignalDetailDialog.tsx` (recommended contract section + admin refresh button)

No DB migration needed — all required columns already exist on `signals` and `options_contracts`.

---

**Confirm to proceed**, or tell me to adjust weights / DTE band / liquidity thresholds first.
