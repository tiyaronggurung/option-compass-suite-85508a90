CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t TEXT;
  is_first BOOLEAN;
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(NEW.email, '@', 1)));

  FOREACH t IN ARRAY ARRAY['SPY','QQQ','NVDA','TSLA','AMD','AAPL','META','MSFT'] LOOP
    INSERT INTO public.watchlist_items (user_id, ticker) VALUES (NEW.id, t)
    ON CONFLICT (user_id, ticker) DO NOTHING;
  END LOOP;

  INSERT INTO public.alert_settings (user_id, notify_email) VALUES (NEW.id, NEW.email)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.risk_settings (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.paper_accounts (user_id, starting_balance, cash_balance, day_start_equity)
  VALUES (NEW.id, 10000, 10000, 10000)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin') INTO is_first;
  IF is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin')
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

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