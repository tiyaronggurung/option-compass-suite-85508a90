
-- 1. Per-ticker last-scanned watermark for tiered cadence
CREATE TABLE public.scanner_ticker_state (
  ticker text PRIMARY KEY,
  last_scanned_at timestamptz,
  last_tier text
);
GRANT ALL ON public.scanner_ticker_state TO service_role;
ALTER TABLE public.scanner_ticker_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages ticker state"
  ON public.scanner_ticker_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Per-provider daily call counter with cap
CREATE TABLE public.provider_budget_counters (
  provider text NOT NULL,
  date date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  calls int NOT NULL DEFAULT 0,
  daily_cap int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, date)
);
GRANT SELECT ON public.provider_budget_counters TO authenticated;
GRANT ALL ON public.provider_budget_counters TO service_role;
ALTER TABLE public.provider_budget_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins view budget counters"
  ON public.provider_budget_counters FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "service role manages budget"
  ON public.provider_budget_counters FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Atomic bump + cap check
CREATE OR REPLACE FUNCTION public.bump_provider_budget(
  p_provider text,
  p_amount int,
  p_default_cap int
) RETURNS TABLE(allowed boolean, calls int, daily_cap int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_calls int;
  v_cap int;
BEGIN
  INSERT INTO public.provider_budget_counters (provider, date, calls, daily_cap)
  VALUES (p_provider, v_today, 0, p_default_cap)
  ON CONFLICT (provider, date) DO NOTHING;

  SELECT c.calls, c.daily_cap INTO v_calls, v_cap
    FROM public.provider_budget_counters c
   WHERE c.provider = p_provider AND c.date = v_today
   FOR UPDATE;

  IF v_calls + p_amount > v_cap THEN
    RETURN QUERY SELECT false, v_calls, v_cap;
    RETURN;
  END IF;

  UPDATE public.provider_budget_counters
     SET calls = calls + p_amount, updated_at = now()
   WHERE provider = p_provider AND date = v_today;

  RETURN QUERY SELECT true, v_calls + p_amount, v_cap;
END;
$$;
GRANT EXECUTE ON FUNCTION public.bump_provider_budget(text, int, int) TO service_role;

-- 4. Diagnostics column
ALTER TABLE public.signal_scan_runs
  ADD COLUMN IF NOT EXISTS skipped_due_to_budget int NOT NULL DEFAULT 0;
ALTER TABLE public.signal_scan_runs
  ADD COLUMN IF NOT EXISTS skipped_due_to_cadence int NOT NULL DEFAULT 0;
