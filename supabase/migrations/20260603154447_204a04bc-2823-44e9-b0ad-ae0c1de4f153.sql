-- Marking engine config (singleton)
CREATE TABLE IF NOT EXISTS public.mark_engine_config (
  id TEXT PRIMARY KEY DEFAULT 'global',
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.mark_engine_config TO authenticated;
GRANT ALL ON public.mark_engine_config TO service_role;

ALTER TABLE public.mark_engine_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY mark_engine_config_select_auth ON public.mark_engine_config
  FOR SELECT TO authenticated USING (true);
CREATE POLICY mark_engine_config_update_admin ON public.mark_engine_config
  FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY mark_engine_config_insert_admin ON public.mark_engine_config
  FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

INSERT INTO public.mark_engine_config (id, enabled) VALUES ('global', true)
  ON CONFLICT (id) DO NOTHING;

-- Run log
CREATE TABLE IF NOT EXISTS public.mark_engine_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL, -- ok | outside_hours | disabled | error | no_open_trades
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  missing_prices TEXT[] NOT NULL DEFAULT '{}',
  error TEXT,
  trigger TEXT NOT NULL DEFAULT 'cron', -- cron | manual
  duration_ms INTEGER
);

GRANT SELECT ON public.mark_engine_runs TO authenticated;
GRANT ALL ON public.mark_engine_runs TO service_role;

ALTER TABLE public.mark_engine_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY mark_engine_runs_select_auth ON public.mark_engine_runs
  FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS mark_engine_runs_ran_at_idx ON public.mark_engine_runs (ran_at DESC);