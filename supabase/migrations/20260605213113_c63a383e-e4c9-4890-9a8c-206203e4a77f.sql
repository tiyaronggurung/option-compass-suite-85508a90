CREATE OR REPLACE FUNCTION public.reset_paper_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  DELETE FROM public.trade_alerts WHERE user_id = auth.uid();
  DELETE FROM public.paper_trades WHERE user_id = auth.uid();

  INSERT INTO public.paper_accounts (user_id, starting_balance, cash_balance, day_start_equity)
  VALUES (auth.uid(), 10000, 10000, 10000)
  ON CONFLICT (user_id) DO UPDATE SET
    starting_balance = 10000,
    cash_balance = 10000,
    day_start_equity = 10000,
    day_start_date = (now() AT TIME ZONE 'America/New_York')::date,
    updated_at = now();
END;
$function$;

ALTER TABLE public.paper_accounts ALTER COLUMN starting_balance SET DEFAULT 10000;
ALTER TABLE public.paper_accounts ALTER COLUMN cash_balance SET DEFAULT 10000;
ALTER TABLE public.paper_accounts ALTER COLUMN day_start_equity SET DEFAULT 10000;