ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS is_option boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS option_type text,
  ADD COLUMN IF NOT EXISTS strike numeric,
  ADD COLUMN IF NOT EXISTS expiry date,
  ADD COLUMN IF NOT EXISTS contracts integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS multiplier integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS entry_premium numeric,
  ADD COLUMN IF NOT EXISTS current_premium numeric,
  ADD COLUMN IF NOT EXISTS exit_premium numeric,
  ADD COLUMN IF NOT EXISTS total_cost numeric,
  ADD COLUMN IF NOT EXISTS current_value numeric,
  ADD COLUMN IF NOT EXISTS unrealized_pl numeric,
  ADD COLUMN IF NOT EXISTS unrealized_pl_pct numeric,
  ADD COLUMN IF NOT EXISTS day_open_premium numeric,
  ADD COLUMN IF NOT EXISTS day_open_date date,
  ADD COLUMN IF NOT EXISTS day_pl numeric,
  ADD COLUMN IF NOT EXISTS day_pl_pct numeric,
  ADD COLUMN IF NOT EXISTS realized_pl numeric,
  ADD COLUMN IF NOT EXISTS realized_pl_dollars numeric,
  ADD COLUMN IF NOT EXISTS bid numeric,
  ADD COLUMN IF NOT EXISTS ask numeric,
  ADD COLUMN IF NOT EXISTS mid numeric,
  ADD COLUMN IF NOT EXISTS iv numeric,
  ADD COLUMN IF NOT EXISTS delta numeric,
  ADD COLUMN IF NOT EXISTS gamma numeric,
  ADD COLUMN IF NOT EXISTS theta numeric,
  ADD COLUMN IF NOT EXISTS vega numeric,
  ADD COLUMN IF NOT EXISTS open_interest bigint,
  ADD COLUMN IF NOT EXISTS option_volume bigint,
  ADD COLUMN IF NOT EXISTS quote_source text,
  ADD COLUMN IF NOT EXISTS quote_updated_at timestamptz;

-- Backfill option fields for existing rows. Legacy approveSignal stored the
-- option premium in entry_price, so we mirror it into entry_premium and seed
-- total_cost using the existing direction/contract conventions.
UPDATE public.paper_trades
SET
  option_type    = COALESCE(option_type, direction::text),
  contracts      = COALESCE(contracts, 1),
  multiplier     = COALESCE(multiplier, 100),
  entry_premium  = COALESCE(entry_premium, entry_price),
  total_cost     = COALESCE(total_cost, entry_price * 100 * COALESCE(contracts, 1))
WHERE is_option = true
  AND entry_price IS NOT NULL;