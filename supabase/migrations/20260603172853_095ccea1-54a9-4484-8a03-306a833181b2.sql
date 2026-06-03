-- Add alpha_vantage to provider enum
ALTER TYPE public.provider_id ADD VALUE IF NOT EXISTS 'alpha_vantage';

-- Earnings events cache
CREATE TABLE IF NOT EXISTS public.earnings_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  report_date date NOT NULL,
  fiscal_date_ending date,
  estimate numeric,
  currency text DEFAULT 'USD',
  source text NOT NULL DEFAULT 'alpha_vantage',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earnings_events_ticker_report_unique UNIQUE (ticker, report_date)
);

CREATE INDEX IF NOT EXISTS earnings_events_ticker_date_idx
  ON public.earnings_events (ticker, report_date);

GRANT SELECT ON public.earnings_events TO authenticated;
GRANT ALL ON public.earnings_events TO service_role;

ALTER TABLE public.earnings_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY earnings_events_select_auth ON public.earnings_events
  FOR SELECT TO authenticated USING (true);
