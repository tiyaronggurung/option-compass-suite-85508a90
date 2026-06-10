CREATE OR REPLACE FUNCTION public.get_user_trade_history(_user_id uuid)
RETURNS TABLE(
  id uuid,
  status text,
  closed_at timestamptz,
  opened_at timestamptz,
  current_pl numeric,
  realized_pl numeric,
  ticker text,
  direction text,
  option_type text,
  strike numeric,
  expiry date,
  contracts integer,
  entry_premium numeric,
  exit_premium numeric,
  entry_price numeric,
  exit_price numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pt.id,
    pt.status::text,
    pt.closed_at,
    pt.opened_at,
    pt.current_pl,
    pt.realized_pl,
    pt.ticker,
    pt.direction::text,
    pt.option_type::text,
    pt.strike,
    pt.expiry,
    pt.contracts,
    pt.entry_premium,
    pt.exit_premium,
    pt.entry_price,
    pt.exit_price
  FROM public.paper_trades pt
  LEFT JOIN public.signals s ON s.id = pt.signal_id
  WHERE pt.user_id = _user_id
    AND pt.status <> 'OPEN'
    AND COALESCE(s.is_demo, false) = false
  ORDER BY COALESCE(pt.closed_at, pt.opened_at) DESC
  LIMIT 2000
$$;

REVOKE ALL ON FUNCTION public.get_user_trade_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_trade_history(uuid) TO authenticated;