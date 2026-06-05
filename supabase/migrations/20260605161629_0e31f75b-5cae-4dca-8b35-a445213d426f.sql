
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS flow_type text,
  ADD COLUMN IF NOT EXISTS raw_provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_by_both boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_with_signal_id uuid;

CREATE INDEX IF NOT EXISTS signals_confirm_lookup_idx
  ON public.signals (ticker, direction, created_at DESC)
  WHERE confirmed_by_both = false;

CREATE INDEX IF NOT EXISTS signals_source_created_idx
  ON public.signals (source, created_at DESC);
