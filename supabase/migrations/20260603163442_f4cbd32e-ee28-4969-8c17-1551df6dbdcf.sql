
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_signals_expires_at ON public.signals (expires_at);

-- Backfill existing rows
UPDATE public.signals
SET expires_at = created_at + CASE
    WHEN dte = 0 THEN interval '30 minutes'
    WHEN dte BETWEEN 1 AND 7 THEN interval '1 hour'
    WHEN dte BETWEEN 8 AND 30 THEN interval '4 hours'
    ELSE interval '2 hours'
  END
WHERE expires_at IS NULL;
