
-- Phase 6: Market-wide scanner universe

-- 1. Tradable universe table
CREATE TABLE public.tradable_universe (
  ticker text PRIMARY KEY,
  company_name text,
  exchange text,
  asset_class text,
  optionable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  tradable boolean NOT NULL DEFAULT true,
  avg_volume bigint,
  market_cap numeric,
  last_price numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tradable_universe_optionable ON public.tradable_universe (optionable) WHERE optionable = true;
CREATE INDEX idx_tradable_universe_avg_volume ON public.tradable_universe (avg_volume DESC NULLS LAST);
CREATE INDEX idx_tradable_universe_active ON public.tradable_universe (active, tradable) WHERE active = true AND tradable = true;

GRANT SELECT ON public.tradable_universe TO authenticated;
GRANT ALL ON public.tradable_universe TO service_role;

ALTER TABLE public.tradable_universe ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tradable_universe_select_auth"
  ON public.tradable_universe FOR SELECT TO authenticated USING (true);

-- 2. Scanner universe mode enum
CREATE TYPE public.scanner_universe_mode AS ENUM (
  'base_8',
  'watchlist_earnings',
  'top_100',
  'top_250',
  'top_500'
);

-- 3. scanner_settings: add universe_mode (default base_8 per user requirement)
ALTER TABLE public.scanner_settings
  ADD COLUMN universe_mode public.scanner_universe_mode NOT NULL DEFAULT 'base_8';

-- 4. signal_scan_runs: add universe tracking columns
ALTER TABLE public.signal_scan_runs
  ADD COLUMN universe_mode text,
  ADD COLUMN universe_count integer,
  ADD COLUMN watchlist_count integer,
  ADD COLUMN earnings_count integer,
  ADD COLUMN skipped_due_to_cap integer DEFAULT 0;

-- 5. Scan overlap lock table (single-row advisory)
CREATE TABLE public.scan_locks (
  id text PRIMARY KEY,
  locked_at timestamptz NOT NULL DEFAULT now(),
  locked_by text
);

GRANT SELECT ON public.scan_locks TO authenticated;
GRANT ALL ON public.scan_locks TO service_role;

ALTER TABLE public.scan_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scan_locks_select_auth"
  ON public.scan_locks FOR SELECT TO authenticated USING (true);
