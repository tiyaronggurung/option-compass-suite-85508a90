# Top Signals Leaderboard — Plan

## 1. New route
- Add `/app/top-signals` route in `src/App.tsx`.
- New page `src/pages/TopSignals.tsx`.
- Add nav link in `AppShell.tsx` ("Top Signals").

## 2. Ranking utility
Create `src/lib/rankSignals.ts`:

```
ranking_score =
  0.35 * confidence              // signal.confidence (0–100)
+ 0.20 * liquidity_score         // from technical_metrics.contract.liquidity_score
+ 0.15 * delta_match             // 100 - min(|delta - 0.35|/0.35, 1)*100
+ 0.15 * spread_quality          // 100 - min(spread_pct/25, 1)*100
+ 0.10 * freshness               // 100 if <15m, linear decay to 0 at 6h
- 0.05 * risk_penalty            // LOW=0, MEDIUM=50, HIGH=100
```
Returns `{ score, breakdown: { confidence, liquidity, delta, spread, freshness, riskPenalty } }`.

If a contract is missing on the signal, those component contributions fall to 0 (not unlimited credit) — signal can still appear but ranks lower.

## 3. Page structure
`TopSignals.tsx`:
- Header with tabs: **Top Calls** | **Top Puts** | **All**
- Filter bar:
  - Watchlist only (toggle)
  - Min ranking score (slider 0–100)
  - Max risk level (LOW/MEDIUM/HIGH)
  - Fresh only (<1h toggle)
  - Include demo/expired (admin/debug toggle, off by default)
- Query: `signals` where `status='LIVE'`, `hidden=false`, `expires_at > now()` unless debug toggle on.
- Compute ranking client-side, sort desc, show top 10 per tab (All shows top 20).

## 4. Row card
Reuse styling from `SignalCard`. New compact `TopSignalRow` component shows:
rank · ticker · direction badge · ranking score (big) · confidence · contract symbol · DTE · delta · premium · spread% · liquidity · freshness badge · risk badge · top 2 reasons · [View] [Approve paper trade].

Approve action reuses existing Dashboard approve flow (extract a small helper `src/lib/approveSignal.ts` so both Dashboard and TopSignals call the same code path — risk guard + paper_trades insert + contract_idea copy). No changes to approval rules.

## 5. Detail dialog breakdown
Extend `SignalDetailDialog` with an optional "Ranking breakdown" section (only rendered when caller passes a `breakdown` prop). Shows each contribution as a labeled bar:
- Confidence (35%)
- Liquidity (20%)
- Delta match (15%)
- Spread quality (15%)
- Freshness (10%)
- Risk penalty (−5%)
- Total

## 6. Safety
- No live orders, paper approval only via shared helper.
- No edits to: ingest webhook, scanner scoring, contract picker, signal deletion.
- Read-only queries against `signals` + embedded `technical_metrics.contract`.

## Files
- new: `src/pages/TopSignals.tsx`
- new: `src/lib/rankSignals.ts`
- new: `src/lib/approveSignal.ts` (extracted from Dashboard)
- new: `src/components/TopSignalRow.tsx`
- edit: `src/App.tsx` (route)
- edit: `src/components/AppShell.tsx` (nav link)
- edit: `src/components/SignalDetailDialog.tsx` (optional breakdown section)
- edit: `src/pages/Dashboard.tsx` (use shared approve helper — behavior unchanged)

Confirm to proceed.
