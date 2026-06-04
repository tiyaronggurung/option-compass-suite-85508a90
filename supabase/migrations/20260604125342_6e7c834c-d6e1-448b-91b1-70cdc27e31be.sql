
-- Add new provider IDs (keep unusual_whales intact for future use)
ALTER TYPE provider_id ADD VALUE IF NOT EXISTS 'finviz';
ALTER TYPE provider_id ADD VALUE IF NOT EXISTS 'finnhub';
ALTER TYPE provider_id ADD VALUE IF NOT EXISTS 'apify';

-- Signal tier + score breakdown
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS tier text,
  ADD COLUMN IF NOT EXISTS score_components jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS signals_tier_created_idx ON public.signals (tier, created_at DESC);

-- Market regime (single row keyed 'global')
CREATE TABLE IF NOT EXISTS public.market_regime (
  id text PRIMARY KEY DEFAULT 'global',
  regime text NOT NULL DEFAULT 'sideways',
  spy_trend numeric,
  qqq_trend numeric,
  vix_level numeric,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.market_regime TO authenticated;
GRANT ALL ON public.market_regime TO service_role;

ALTER TABLE public.market_regime ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS market_regime_select_auth ON public.market_regime;
CREATE POLICY market_regime_select_auth ON public.market_regime
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.market_regime (id, regime) VALUES ('global', 'sideways')
ON CONFLICT (id) DO NOTHING;
