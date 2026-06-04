
ALTER TABLE public.contract_selection_snapshots
  ADD COLUMN IF NOT EXISTS selection_mode text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS below_band boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warning text,
  ADD COLUMN IF NOT EXISTS rejection_counts jsonb NOT NULL DEFAULT '{}'::jsonb;
