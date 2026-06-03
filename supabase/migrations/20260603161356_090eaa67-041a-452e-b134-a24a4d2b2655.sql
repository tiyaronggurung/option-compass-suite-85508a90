CREATE UNIQUE INDEX IF NOT EXISTS uniq_signals_external_id
  ON public.signals (external_id) WHERE external_id IS NOT NULL;