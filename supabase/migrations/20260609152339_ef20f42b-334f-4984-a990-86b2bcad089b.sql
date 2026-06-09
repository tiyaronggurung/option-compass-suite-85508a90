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

  UPDATE public.provider_budget_counters c
     SET calls = c.calls + p_amount, updated_at = now()
   WHERE c.provider = p_provider AND c.date = v_today;

  RETURN QUERY SELECT true, v_calls + p_amount, v_cap;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.bump_provider_budget(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_provider_budget(text, int, int) TO service_role;