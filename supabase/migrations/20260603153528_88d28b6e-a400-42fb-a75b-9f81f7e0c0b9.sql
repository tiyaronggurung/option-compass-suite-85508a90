ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS current_pl_pct numeric,
  ADD COLUMN IF NOT EXISTS last_mark_price numeric,
  ADD COLUMN IF NOT EXISTS last_mark_at timestamptz,
  ADD COLUMN IF NOT EXISTS mark_source text;