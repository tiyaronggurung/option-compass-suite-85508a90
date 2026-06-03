-- 1. Add classification flags to signals
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden  BOOLEAN NOT NULL DEFAULT false;

-- Backfill: anything that wasn't posted by the live Alpaca engine is demo
UPDATE public.signals
SET is_demo = true
WHERE source IS NULL OR source NOT ILIKE 'Alpaca%';

CREATE INDEX IF NOT EXISTS signals_is_demo_idx ON public.signals (is_demo);
CREATE INDEX IF NOT EXISTS signals_hidden_idx  ON public.signals (hidden);

-- Allow admins to update signals (only meaningful for `hidden`)
CREATE POLICY signals_update_admin
  ON public.signals FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 2. Global app settings (single row)
CREATE TYPE public.signal_view_mode AS ENUM ('demo','live','both');

CREATE TABLE public.app_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  signal_mode public.signal_view_mode NOT NULL DEFAULT 'both',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_singleton CHECK (id = 'global')
);

GRANT SELECT ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_settings_select_auth
  ON public.app_settings FOR SELECT TO authenticated USING (true);

CREATE POLICY app_settings_update_admin
  ON public.app_settings FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY app_settings_insert_admin
  ON public.app_settings FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.app_settings (id) VALUES ('global')
ON CONFLICT (id) DO NOTHING;