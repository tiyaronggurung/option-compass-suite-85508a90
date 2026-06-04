
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'fresh',
  ADD COLUMN IF NOT EXISTS lifecycle_reason text,
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS confidence_at_birth integer,
  ADD COLUMN IF NOT EXISTS flow_at_birth jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS technical_at_birth jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lifecycle_history jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS signals_lifecycle_state_idx ON public.signals(lifecycle_state);

-- Backfill birth snapshots from current row state (best-effort; safe for nulls).
UPDATE public.signals
SET
  confidence_at_birth = COALESCE(confidence_at_birth, confidence),
  flow_at_birth = CASE
    WHEN flow_at_birth = '{}'::jsonb
      THEN COALESCE(score_components->'components'->'options_flow', '{}'::jsonb)
    ELSE flow_at_birth
  END,
  technical_at_birth = CASE
    WHEN technical_at_birth = '{}'::jsonb
      THEN COALESCE(score_components->'components'->'technical', '{}'::jsonb)
    ELSE technical_at_birth
  END
WHERE confidence_at_birth IS NULL
   OR flow_at_birth = '{}'::jsonb
   OR technical_at_birth = '{}'::jsonb;

-- Initial lifecycle_state derived from age + confidence-tier soft TTL.
-- Soft TTL (hours): developing(<65)=6, near_watchlist(65-69)=12,
-- watchlist(70-79)=24, strong(80-89)=36, elite(90+)=48.
UPDATE public.signals
SET lifecycle_state = CASE
  WHEN EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 < 2 THEN 'fresh'
  WHEN EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 <
       CASE
         WHEN COALESCE(confidence_at_birth, confidence) >= 90 THEN 48
         WHEN COALESCE(confidence_at_birth, confidence) >= 80 THEN 36
         WHEN COALESCE(confidence_at_birth, confidence) >= 70 THEN 24
         WHEN COALESCE(confidence_at_birth, confidence) >= 65 THEN 12
         ELSE 6
       END
    THEN 'active'
  ELSE 'expired'
END,
lifecycle_reason = 'backfill_initial',
lifecycle_updated_at = now()
WHERE lifecycle_state = 'fresh' AND lifecycle_reason IS NULL;
