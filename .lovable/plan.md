# Auto-Exit Engine — Plan

Goal: automatically close OPEN paper trades when user-defined rules fire. Fully opt-in. Everything that works today keeps working unchanged.

## Guarantees (what does NOT change)
- No edits to existing close logic, cash accounting trigger, or mark engine.
- No changes to public guest flows (join, status, booking).
- No changes to signal generation, approval, or buy flow.
- Existing trades are untouched until the user turns rules on.
- Defaults: every rule OFF. Engine in **dry-run** mode for the first session.

## Scope (what gets added)
1. New table `auto_exit_rules` (per user, one row).
2. New columns on `paper_trades` (nullable, additive): `auto_exit_armed_rule TEXT`, `auto_exit_closed_by TEXT`, `auto_exit_peak_premium NUMERIC`.
3. New edge function `auto-exit-engine` — runs every minute during market hours, evaluates OPEN trades, closes via the same path the manual close uses.
4. New cron job for the function (market hours only).
5. New Settings panel **"Auto-Exit Rules"** with toggles + thresholds + dry-run switch + kill switch.
6. Small badge on each open trade in `Trades.tsx` showing which rule is armed (read-only display).

## Rules supported (each independently toggleable)
- **Stop-loss %** — close when P/L% ≤ user threshold (e.g. -50%).
- **Take-profit %** — close when P/L% ≥ user threshold (e.g. +100%).
- **Trailing stop %** — track peak premium since entry; close when pullback from peak ≥ threshold.
- **Time-based exit** — for 0DTE, close at user-chosen ET time (default 15:30).
- **Theta burn** — close when |theta|/premium ≥ threshold per day (optional, off by default).

## Safety gates (hard-coded, not user-toggleable)
- Only runs Mon–Fri during 09:30–16:00 ET.
- Honors existing `risk_settings.kill_switch` (already in DB) — if on, engine no-ops.
- Per-user `enabled` flag in `auto_exit_rules` (default false).
- Per-user `dry_run` flag (default true on first enable) — logs intended closes without acting.
- Idempotent: re-checks `status='OPEN'` inside the close path; won't double-close.
- Closes use existing exit_premium = latest mark, same code path as manual close, so cash accounting trigger handles P/L exactly as today.

## Technical details

### Migration
```text
auto_exit_rules
  user_id UUID PK -> auth.users
  enabled BOOL default false
  dry_run BOOL default true
  stop_loss_pct NUMERIC null         -- e.g. -50
  take_profit_pct NUMERIC null       -- e.g. 100
  trailing_stop_pct NUMERIC null     -- e.g. 25
  time_exit_et TIME null             -- e.g. '15:30' (only for DTE<=0)
  theta_burn_pct NUMERIC null        -- e.g. 0.05
  created_at, updated_at
RLS: user can select/insert/update own row only.
GRANTs: authenticated + service_role.

paper_trades  (ALTER, all nullable, no defaults that affect existing rows)
  + auto_exit_armed_rule TEXT
  + auto_exit_closed_by TEXT
  + auto_exit_peak_premium NUMERIC
```

### Edge function `auto-exit-engine`
- Auth via shared `requireAdmin` cron path (service-role token from pg_cron).
- For each user with `enabled=true`:
  - Skip if `risk_settings.kill_switch=true`.
  - Load OPEN paper_trades for that user.
  - For each trade, update `auto_exit_peak_premium = max(peak, current_premium)`.
  - Evaluate rules in priority order: stop_loss → take_profit → trailing_stop → time_exit → theta_burn.
  - On first match: if `dry_run`, log to `mark_engine_runs` (reuse table). Else update the trade row with `status='WIN'/'LOSS'/'BREAKEVEN'`, `exit_premium=current_premium`, `closed_at=now()`, `auto_exit_closed_by=<rule>`. The existing `paper_trades_cash_accounting` trigger handles cash + realized_pl.

### Cron
- Every minute 09:30–16:00 ET Mon–Fri via pg_cron + pg_net (using insert tool, not migration).

### UI
- New `AutoExitRulesPanel.tsx` mounted in `Settings.tsx` under the "Account & Security" section.
- New small `<AutoExitBadge>` in the open-trade card showing armed rule (read-only).

## Rollout
1. Migration (table + columns).
2. Edge function + cron (cron starts but defaults dry_run=true and enabled=false, so no-op).
3. Settings UI.
4. Trade card badge.
5. User flips `enabled=true` with `dry_run=true` first to watch behavior, then turns dry_run off.

## Out of scope (for this round)
- Partial exits / scale-outs.
- Per-trade rule overrides (only global per-user rules for now).
- Notifications on auto-close (can layer in with #2 Smart Alerts later).
