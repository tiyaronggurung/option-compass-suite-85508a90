# Auto-Entry Engine — Plan

Goal: when a fresh signal matches user-defined rules, auto-buy the contract as a **paper** trade — no manual Approve click. Whitelist-only, dry-run by default, fully opt-in. Existing manual approve + buy flow stays unchanged.

## Guarantees (what does NOT change)
- No edits to signal generation, scan engines, ranking, contract picker, or the manual Approve / Buy flow.
- No changes to public guest flows (join, status, booking).
- Existing `risk_settings` rules are honored, not bypassed.
- Defaults: engine disabled, dry-run on, whitelist empty → does literally nothing until the user configures it.

## Scope
1. New table `auto_entry_rules` (one row per user) with global controls + thresholds.
2. New table `auto_entry_whitelist` (user_id, ticker) — explicit allow-list. Empty = engine no-ops.
3. New table `auto_entry_log` — every fire (or would-fire in dry-run) recorded for review.
4. New edge function `auto-entry-engine` — picks up fresh signals, evaluates rules, calls existing buy path.
5. New cron (every minute, market hours only — function self-gates).
6. New Settings panel **"Auto-entry rules"** with toggles + thresholds + whitelist manager + recent-fires log.
7. Small badge on signals that would qualify (read-only "Auto-buy armed" hint).

## Rules supported (all must pass for a buy to fire)
- **Whitelist match** — signal's ticker must be in `auto_entry_whitelist` for the user.
- **Min tier** — e.g. only `ELITE` and `GOLD`.
- **Min confidence** — e.g. ≥ 80.
- **Direction filter** — calls only / puts only / both.
- **Max premium $ per contract** — skip if picked contract premium exceeds.
- **Max $ risk per trade** — overrides if it exceeds `risk_settings.max_risk_per_trade`, take the smaller.
- **Time-of-day window (ET)** — e.g. only 10:00–15:00 to avoid open/close chop.
- **Per-ticker cooldown (minutes)** — no re-entry on same ticker within N minutes (looks at `auto_entry_log` and `paper_trades.opened_at`).
- **Skip if open position exists** — never stack multiple paper trades on same ticker.
- **Signal age cap** — must be < N minutes old (default 5) to avoid acting on stale signals.

## Hard safety gates (not user-toggleable)
- Mon–Fri 09:30–16:00 ET only.
- Honors `risk_settings.kill_switch` — engine no-ops.
- Honors `risk_settings.max_open_trades` — counts current OPEN paper trades, blocks if at cap.
- Honors `risk_settings.daily_loss_cap` — if today's realized losses ≥ cap, blocks.
- Daily caps from `auto_entry_rules`: `max_trades_per_day`, `daily_spend_cap_usd`.
- Idempotent: each signal can only fire **once per user** (unique on `auto_entry_log(user_id, signal_id)`).
- Dry-run mode → log only, no DB write to `paper_trades`.
- Re-uses the existing buy path (same insert shape as the manual Buy dialog), so cash accounting trigger, marks, and auto-exit all just work.

## Technical details

### Migration
```text
auto_entry_rules
  user_id UUID PK -> auth.users
  enabled BOOL default false
  dry_run BOOL default true
  min_tier TEXT null               -- 'ELITE' | 'GOLD' | 'SILVER' | null
  min_confidence INT null          -- 0..100
  allowed_directions TEXT[] null   -- {CALL,PUT} or subset
  max_premium_usd NUMERIC null
  max_risk_usd NUMERIC null
  start_time_et TIME null
  end_time_et TIME null
  cooldown_minutes INT default 30
  max_signal_age_minutes INT default 5
  max_trades_per_day INT default 5
  daily_spend_cap_usd NUMERIC default 2000
  block_if_open_on_ticker BOOL default true
  created_at, updated_at

auto_entry_whitelist
  id UUID PK
  user_id UUID -> auth.users
  ticker TEXT
  created_at
  UNIQUE(user_id, ticker)

auto_entry_log
  id UUID PK
  user_id UUID -> auth.users
  signal_id UUID -> signals
  ticker TEXT
  status TEXT       -- 'dry_run' | 'fired' | 'skipped'
  skip_reason TEXT  -- e.g. 'cooldown', 'cap_reached', 'killswitch', 'no_match'
  paper_trade_id UUID null
  rule_snapshot JSONB
  created_at
  UNIQUE(user_id, signal_id)   -- idempotency
```
RLS: users see/edit only their own rows. service_role full access. authenticated GRANTs.

### Edge function `auto-entry-engine`
- Auth: service-role (cron) or admin user (manual trigger).
- Market-hours gate (re-uses pattern from auto-exit/update-paper-marks).
- For each user with `auto_entry_rules.enabled = true`:
  - Check kill switch, max open trades, daily loss cap → skip user if any fail.
  - Load whitelist; skip if empty.
  - Load fresh signals: created in last `max_signal_age_minutes`, not yet in this user's `auto_entry_log`, ticker in whitelist, is_demo=false.
  - For each candidate signal, evaluate filters in order. On first failure → write `skipped` row to log with reason and move on.
  - On full match:
    - Resolve contract from the signal's existing pick (same source the manual Buy dialog reads).
    - Compute contracts qty from `max_risk_usd` (capped by `risk_settings.max_risk_per_trade`).
    - If `dry_run`: insert `auto_entry_log` row with status `dry_run`. No paper_trade write.
    - Else: insert into `paper_trades` mirroring the manual Buy payload (status='OPEN', is_option=true, entry_premium, total_cost, multiplier, contracts, strike, expiry, option_type, signal_id, etc.). Then insert `auto_entry_log` with status `fired` and `paper_trade_id`.
- Returns summary `{ scanned, fired, dry_run, skipped }`.

### Cron
- Every minute via pg_cron + pg_net (insert tool, not migration).

### UI
- New `AutoEntryRulesPanel.tsx` mounted in `Settings.tsx` under "Account & Security" (just below Auto-exit panel).
  - Toggles: enable, dry-run.
  - Threshold inputs.
  - Whitelist manager: chip input to add/remove tickers.
  - "Recent activity" table: last 20 `auto_entry_log` rows (status, ticker, reason or trade link, time).
- Small `<Badge>` on signal cards showing **"Auto-buy armed"** (purely informational; client-side check against the rules + whitelist).

## Rollout
1. Migration (3 tables + GRANTs + RLS).
2. Edge function + cron (no-op until user configures).
3. Settings UI.
4. Signal-card armed badge.
5. User: add 1–2 tickers to whitelist, keep dry-run ON, watch log for a week, then flip dry-run OFF.

## Future (NOT in this round)
- Broker execution mode (`paper` | `alpaca` | `tradier`) — just an enum + adapter swap when ready.
- Auto-entry on patterns (e.g. signal + confirmation matrix score thresholds beyond confidence).
- Per-ticker overrides (different risk $ per ticker).
- Notifications on fire.

## What I will NOT touch
- `src/lib/buyOption.ts`, `BuyOptionDialog`, `approveSignal`, or any existing signal/trade UI's behavior.
- `risk_settings`, `paper_accounts`, `paper_trades` schema (read-only — new columns are additive only if absolutely needed; current plan needs none).
- Existing edge functions (no edits).
