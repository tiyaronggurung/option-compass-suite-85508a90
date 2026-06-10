
-- 1) Harden the cash trigger:
--    - On INSERT with non-OPEN status, also credit proceeds (defensive).
--    - On UPDATE while already closed, credit/debit the delta if exit_premium changes.
--    - On UPDATE transitioning to closed, pin current_pl to realized_pl.
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
BEGIN
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
    -- If inserted directly as a closed trade (rare), also credit proceeds.
    IF NEW.status <> 'OPEN' THEN
      proceeds := COALESCE(NEW.exit_premium, NEW.exit_price, 0) * mult * qty;
      IF proceeds > 0 THEN
        UPDATE public.paper_accounts
           SET cash_balance = cash_balance + proceeds
         WHERE user_id = NEW.user_id;
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Transition OPEN -> closed: credit proceeds and pin current_pl to realized.
    IF OLD.status = 'OPEN' AND NEW.status <> 'OPEN' THEN
      proceeds := COALESCE(NEW.exit_premium, NEW.exit_price, 0) * mult * qty;
      IF proceeds > 0 THEN
        UPDATE public.paper_accounts
           SET cash_balance = cash_balance + proceeds
         WHERE user_id = NEW.user_id;
      END IF;
      realized := proceeds - COALESCE(NEW.total_cost,
                                      COALESCE(NEW.entry_premium, NEW.entry_price, 0) * mult * qty);
      NEW.realized_pl := realized;
      NEW.current_pl := realized;
      NEW.current_pl_pct := CASE WHEN COALESCE(NEW.total_cost,0) > 0
                                 THEN (realized / NEW.total_cost) * 100 ELSE 0 END;
    -- Already closed, but exit_premium changed: credit/debit the delta.
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
      realized := proceeds - COALESCE(NEW.total_cost,
                                      COALESCE(NEW.entry_premium, NEW.entry_price, 0) * mult * qty);
      NEW.realized_pl := realized;
      NEW.current_pl := realized;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) One-time reconciliation: sync current_pl = realized_pl on closed trades.
--    Disable the trigger temporarily so this UPDATE doesn't re-trigger cash logic.
ALTER TABLE public.paper_trades DISABLE TRIGGER USER;

UPDATE public.paper_trades
   SET current_pl = realized_pl,
       current_pl_pct = CASE WHEN COALESCE(total_cost,0) > 0
                             THEN (realized_pl / total_cost) * 100 ELSE 0 END
 WHERE status <> 'OPEN'
   AND realized_pl IS NOT NULL
   AND (current_pl IS DISTINCT FROM realized_pl);

ALTER TABLE public.paper_trades ENABLE TRIGGER USER;

-- 3) Reconcile cash_balance for every paper account from ground truth.
--    cash = starting + sum(proceeds on closed) - sum(total_cost on all trades)
WITH agg AS (
  SELECT
    pa.user_id,
    pa.starting_balance,
    COALESCE((
      SELECT SUM(COALESCE(pt.exit_premium, pt.exit_price, 0)
                 * COALESCE(pt.multiplier, 100)
                 * COALESCE(pt.contracts, 1))
      FROM public.paper_trades pt
      WHERE pt.user_id = pa.user_id AND pt.status <> 'OPEN'
    ), 0) AS proceeds,
    COALESCE((
      SELECT SUM(COALESCE(pt.total_cost,
                          COALESCE(pt.entry_premium, pt.entry_price, 0)
                          * COALESCE(pt.multiplier, 100)
                          * COALESCE(pt.contracts, 1)))
      FROM public.paper_trades pt
      WHERE pt.user_id = pa.user_id
    ), 0) AS debits
  FROM public.paper_accounts pa
)
UPDATE public.paper_accounts pa
   SET cash_balance = ROUND(agg.starting_balance + agg.proceeds - agg.debits, 2),
       updated_at = now()
  FROM agg
 WHERE pa.user_id = agg.user_id
   AND ROUND(pa.cash_balance, 2) <> ROUND(agg.starting_balance + agg.proceeds - agg.debits, 2);
