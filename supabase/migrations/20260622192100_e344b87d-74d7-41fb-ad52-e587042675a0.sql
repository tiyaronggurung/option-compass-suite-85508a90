CREATE OR REPLACE FUNCTION public.paper_trades_cash_accounting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cost numeric;
  proceeds numeric;
  old_proceeds numeric;
  delta numeric;
  mult integer;
  qty integer;
  realized numeric;
  flat_fee numeric := 10;  -- $10 flat per side, regardless of contract count
  entry_fee_calc numeric;
  exit_fee_calc numeric;
BEGIN
  INSERT INTO public.paper_accounts (user_id) VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;

  mult := COALESCE(NEW.multiplier, 100);
  qty  := COALESCE(NEW.contracts, 1);
  entry_fee_calc := flat_fee;
  exit_fee_calc  := flat_fee;

  IF TG_OP = 'INSERT' THEN
    cost := COALESCE(NEW.total_cost,
                     COALESCE(NEW.entry_premium, NEW.entry_price, 0) * mult * qty);
    NEW.entry_fee := entry_fee_calc;
    IF cost + entry_fee_calc > 0 THEN
      UPDATE public.paper_accounts
         SET cash_balance = cash_balance - (cost + entry_fee_calc)
       WHERE user_id = NEW.user_id;
    END IF;
    IF NEW.status <> 'OPEN' THEN
      proceeds := COALESCE(NEW.exit_premium, NEW.exit_price, 0) * mult * qty;
      NEW.exit_fee := exit_fee_calc;
      IF proceeds - exit_fee_calc <> 0 THEN
        UPDATE public.paper_accounts
           SET cash_balance = cash_balance + (proceeds - exit_fee_calc)
         WHERE user_id = NEW.user_id;
      END IF;
      realized := (proceeds - exit_fee_calc)
                - (COALESCE(NEW.total_cost,
                            COALESCE(NEW.entry_premium, NEW.entry_price, 0) * mult * qty)
                   + entry_fee_calc);
      NEW.realized_pl := realized;
      NEW.current_pl := realized;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'OPEN' AND NEW.status <> 'OPEN' THEN
      proceeds := COALESCE(NEW.exit_premium, NEW.exit_price, 0) * mult * qty;
      NEW.exit_fee := exit_fee_calc;
      IF proceeds - exit_fee_calc <> 0 THEN
        UPDATE public.paper_accounts
           SET cash_balance = cash_balance + (proceeds - exit_fee_calc)
         WHERE user_id = NEW.user_id;
      END IF;
      realized := (proceeds - exit_fee_calc)
                - (COALESCE(NEW.total_cost,
                            COALESCE(NEW.entry_premium, NEW.entry_price, 0) * mult * qty)
                   + COALESCE(NEW.entry_fee, 0));
      NEW.realized_pl := realized;
      NEW.current_pl := realized;
      NEW.current_pl_pct := CASE WHEN COALESCE(NEW.total_cost,0) > 0
                                 THEN (realized / NEW.total_cost) * 100 ELSE 0 END;
    ELSIF OLD.status <> 'OPEN' AND NEW.status <> 'OPEN'
          AND COALESCE(NEW.exit_premium, NEW.exit_price, 0)
              <> COALESCE(OLD.exit_premium, OLD.exit_price, 0) THEN
      proceeds     := COALESCE(NEW.exit_premium, NEW.exit_price, 0) * mult * qty;
      old_proceeds := COALESCE(OLD.exit_premium, OLD.exit_price, 0) * mult * qty;
      delta := proceeds - old_proceeds;
      IF delta <> 0 THEN
        UPDATE public.paper_accounts
           SET cash_balance = cash_balance + delta
         WHERE user_id = NEW.user_id;
      END IF;
      realized := (proceeds - COALESCE(NEW.exit_fee, 0))
                - (COALESCE(NEW.total_cost,
                            COALESCE(NEW.entry_premium, NEW.entry_price, 0) * mult * qty)
                   + COALESCE(NEW.entry_fee, 0));
      NEW.realized_pl := realized;
      NEW.current_pl := realized;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;