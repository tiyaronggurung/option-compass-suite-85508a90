ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS tech_verdict TEXT,
  ADD COLUMN IF NOT EXISTS tech_score INTEGER,
  ADD COLUMN IF NOT EXISTS tech_adjusted_confidence INTEGER;

COMMENT ON COLUMN public.signals.tech_verdict IS 'Technical trend verdict at signal time: bullish | neutral | bearish';
COMMENT ON COLUMN public.signals.tech_score IS 'Technical score in [-100, +100] from technical-analysis edge function';
COMMENT ON COLUMN public.signals.tech_adjusted_confidence IS 'confidence × tech alignment factor (1.05 / 1.00 / 0.90), capped 1-99';