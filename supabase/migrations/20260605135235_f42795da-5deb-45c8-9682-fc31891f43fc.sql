
-- 1. Table
CREATE TABLE public.paper_accounts (
  user_id uuid PRIMARY KEY,
  starting_balance numeric NOT NULL DEFAULT 100000,
  cash_balance numeric NOT NULL DEFAULT 100000,
  day_start_equity numeric NOT NULL DEFAULT 100000,
  day_start_date date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.paper_accounts TO authenticated;
GRANT ALL ON public.paper_accounts TO service_role;

ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY paper_accounts_select_own ON public.paper_accounts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY paper_accounts_insert_own ON public.paper_accounts
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY paper_accounts_update_own ON public.paper_accounts
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.paper_accounts_set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER paper_accounts_updated_at
BEFORE UPDATE ON public.paper_accounts
FOR EACH ROW EXECUTE FUNCTION public.paper_accounts_set_updated_at();

-- 2. Hook into handle_new_user
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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

  INSERT INTO public.paper_accounts (user_id) VALUES (NEW.id)
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

-- 3. Trigger: cash accounting on paper_trades
CREATE OR REPLACE FUNCTION public.paper_trades_cash_accounting()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cost numeric;
  proceeds numeric;
  mult integer;
  qty integer;
BEGIN
  -- Ensure an account row exists
  INSERT INTO public.paper_accounts (user_id) VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;

  mult := COALESCE(NEW.multiplier, 100);
  qty  := COALESCE(NEW.contracts, 1);

  IF TG_OP = 'INSERT' THEN
    cost := COALESCE(NEW.total_cost,
                     COALESCE(NEW.entry_premium, NEW.entry_price, 0) * mult * qty);
    IF cost > 0 THEN
      UPDATE public.paper_accounts
         SET cash_balance = cash_balance - cost
       WHERE user_id = NEW.user_id;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Transition from OPEN to a closed status
    IF OLD.status = 'OPEN' AND NEW.status <> 'OPEN' THEN
      proceeds := COALESCE(NEW.exit_premium, NEW.exit_price, 0) * mult * qty;
      IF proceeds > 0 THEN
        UPDATE public.paper_accounts
           SET cash_balance = cash_balance + proceeds
         WHERE user_id = NEW.user_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER paper_trades_cash_accounting_trg
AFTER INSERT OR UPDATE ON public.paper_trades
FOR EACH ROW EXECUTE FUNCTION public.paper_trades_cash_accounting();

-- 4. Backfill existing users
INSERT INTO public.paper_accounts (user_id, starting_balance, cash_balance, day_start_equity)
SELECT
  p.id,
  100000,
  100000
    - COALESCE((
        SELECT SUM(COALESCE(pt.total_cost, COALESCE(pt.entry_premium, pt.entry_price, 0) * COALESCE(pt.multiplier,100) * COALESCE(pt.contracts,1)))
        FROM public.paper_trades pt
        WHERE pt.user_id = p.id AND pt.status = 'OPEN'
      ), 0)
    + COALESCE((
        SELECT SUM(COALESCE(pt.realized_pl, pt.realized_pl_dollars, 0))
        FROM public.paper_trades pt
        WHERE pt.user_id = p.id AND pt.status <> 'OPEN'
      ), 0),
  100000
FROM public.profiles p
ON CONFLICT (user_id) DO NOTHING;

-- 5. Reset function
CREATE OR REPLACE FUNCTION public.reset_paper_account()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  DELETE FROM public.trade_alerts WHERE user_id = auth.uid();
  DELETE FROM public.paper_trades WHERE user_id = auth.uid();

  INSERT INTO public.paper_accounts (user_id) VALUES (auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET
    starting_balance = 100000,
    cash_balance = 100000,
    day_start_equity = 100000,
    day_start_date = (now() AT TIME ZONE 'America/New_York')::date,
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_paper_account() TO authenticated;

-- 6. Realtime
ALTER TABLE public.paper_accounts REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_accounts;
