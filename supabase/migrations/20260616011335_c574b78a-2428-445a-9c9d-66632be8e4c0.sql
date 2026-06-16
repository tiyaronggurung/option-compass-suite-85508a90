CREATE OR REPLACE FUNCTION public.credit_paper_cash_for_partial(p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN;
  END IF;
  UPDATE public.paper_accounts
     SET cash_balance = cash_balance + p_amount,
         updated_at = now()
   WHERE user_id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION public.credit_paper_cash_for_partial(numeric) TO authenticated;