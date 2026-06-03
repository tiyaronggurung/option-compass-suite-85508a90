
-- Scanner profile enum
DO $$ BEGIN
  CREATE TYPE public.scanner_profile AS ENUM ('conservative','balanced','active_mvp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Settings table (single global row)
CREATE TABLE IF NOT EXISTS public.scanner_settings (
  id text PRIMARY KEY DEFAULT 'global',
  profile public.scanner_profile NOT NULL DEFAULT 'balanced',
  debug_mode boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.scanner_settings TO authenticated;
GRANT ALL ON public.scanner_settings TO service_role;

ALTER TABLE public.scanner_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scanner_settings_select_auth ON public.scanner_settings;
CREATE POLICY scanner_settings_select_auth ON public.scanner_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS scanner_settings_insert_admin ON public.scanner_settings;
CREATE POLICY scanner_settings_insert_admin ON public.scanner_settings
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS scanner_settings_update_admin ON public.scanner_settings;
CREATE POLICY scanner_settings_update_admin ON public.scanner_settings
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

INSERT INTO public.scanner_settings (id) VALUES ('global')
ON CONFLICT (id) DO NOTHING;

-- Telemetry columns on scan runs
ALTER TABLE public.signal_scan_runs
  ADD COLUMN IF NOT EXISTS would_have_created integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates_scanned integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_score numeric,
  ADD COLUMN IF NOT EXISTS skipped_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS profile text,
  ADD COLUMN IF NOT EXISTS threshold integer;
