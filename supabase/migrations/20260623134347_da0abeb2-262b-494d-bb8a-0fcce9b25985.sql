
-- 1. Recreate trigger as BEFORE so NEW.entry_fee / NEW.exit_fee / NEW.realized_pl assignments persist.
DROP TRIGGER IF EXISTS paper_trades_cash_accounting_trg ON public.paper_trades;
DROP TRIGGER IF EXISTS paper_trades_cash_accounting ON public.paper_trades;

CREATE TRIGGER paper_trades_cash_accounting_trg
BEFORE INSERT OR UPDATE ON public.paper_trades
FOR EACH ROW EXECUTE FUNCTION public.paper_trades_cash_accounting();

-- 2. Backfill historical closed trades that were never charged fees.
WITH to_fix AS (
  SELECT id, user_id,
         COALESCE(total_cost, COALESCE(entry_premium, entry_price, 0) * COALESCE(multiplier,100) * COALESCE(contracts,1)) AS cost,
         COALESCE(exit_premium, exit_price, 0) * COALESCE(multiplier,100) * COALESCE(contracts,1) AS proceeds
    FROM public.paper_trades
   WHERE status <> 'OPEN'
     AND COALESCE(entry_fee, 0) = 0
     AND COALESCE(exit_fee, 0) = 0
)
UPDATE public.paper_trades pt
   SET entry_fee = 10,
       exit_fee = 10,
       realized_pl = (f.proceeds - 10) - (f.cost + 10),
       current_pl = (f.proceeds - 10) - (f.cost + 10),
       current_pl_pct = CASE WHEN f.cost > 0
                             THEN (((f.proceeds - 10) - (f.cost + 10)) / f.cost) * 100
                             ELSE 0 END
  FROM to_fix f
 WHERE pt.id = f.id;

-- 3. Deduct backfilled fees from each user's cash balance ($20 per closed trade backfilled).
WITH fee_totals AS (
  SELECT user_id, COUNT(*) * 20 AS total_fees
    FROM public.paper_trades
   WHERE status <> 'OPEN'
     AND entry_fee = 10
     AND exit_fee = 10
   GROUP BY user_id
)
UPDATE public.paper_accounts pa
   SET cash_balance = cash_balance - ft.total_fees,
       updated_at = now()
  FROM fee_totals ft
 WHERE pa.user_id = ft.user_id;
