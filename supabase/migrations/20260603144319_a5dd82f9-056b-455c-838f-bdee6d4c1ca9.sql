ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS external_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS signals_external_id_unique
  ON public.signals (external_id)
  WHERE external_id IS NOT NULL;