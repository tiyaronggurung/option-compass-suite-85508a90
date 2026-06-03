CREATE TABLE public.signal_scan_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  trigger text NOT NULL DEFAULT 'cron',
  tickers_scanned text[] NOT NULL DEFAULT '{}',
  signals_created integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error text,
  duration_ms integer
);

GRANT SELECT ON public.signal_scan_runs TO authenticated;
GRANT ALL ON public.signal_scan_runs TO service_role;

ALTER TABLE public.signal_scan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY signal_scan_runs_select_auth
  ON public.signal_scan_runs FOR SELECT
  TO authenticated USING (true);

CREATE INDEX idx_signal_scan_runs_ran_at ON public.signal_scan_runs (ran_at DESC);