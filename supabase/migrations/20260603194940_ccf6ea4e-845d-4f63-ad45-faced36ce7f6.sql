-- 1. Extend provider_id enum with 4 new placeholder providers
ALTER TYPE public.provider_id ADD VALUE IF NOT EXISTS 'x_twitter';
ALTER TYPE public.provider_id ADD VALUE IF NOT EXISTS 'reddit';
ALTER TYPE public.provider_id ADD VALUE IF NOT EXISTS 'polymarket';
ALTER TYPE public.provider_id ADD VALUE IF NOT EXISTS 'kalshi';

-- 2. Add confirmation metadata columns to signals (purely additive — no scoring change)
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS source_confirmations jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS confirmation_score integer,
  ADD COLUMN IF NOT EXISTS confirmation_label text;