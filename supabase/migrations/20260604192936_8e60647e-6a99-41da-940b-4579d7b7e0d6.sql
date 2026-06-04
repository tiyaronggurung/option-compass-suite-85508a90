ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS max_confidence_seen integer,
  ADD COLUMN IF NOT EXISTS min_confidence_seen integer,
  ADD COLUMN IF NOT EXISTS max_tier_seen text,
  ADD COLUMN IF NOT EXISTS min_tier_seen text;

-- Backfill: use confidence + confidence_at_birth as the known extremes
UPDATE public.signals
SET
  max_confidence_seen = GREATEST(COALESCE(confidence_at_birth, confidence), confidence),
  min_confidence_seen = LEAST(COALESCE(confidence_at_birth, confidence), confidence),
  max_tier_seen = COALESCE(max_tier_seen, tier),
  min_tier_seen = COALESCE(min_tier_seen, tier)
WHERE max_confidence_seen IS NULL
   OR min_confidence_seen IS NULL
   OR max_tier_seen IS NULL
   OR min_tier_seen IS NULL;