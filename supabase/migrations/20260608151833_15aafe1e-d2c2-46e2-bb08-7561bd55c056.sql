
CREATE OR REPLACE FUNCTION public.get_leaderboard(_window text DEFAULT 'all')
RETURNS TABLE (
  user_id uuid,
  display_name text,
  realized_pl numeric,
  live_equity numeric,
  closed_trades bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH window_cutoff AS (
    SELECT CASE
      WHEN _window = '7d' THEN now() - interval '7 days'
      WHEN _window = '30d' THEN now() - interval '30 days'
      ELSE 'epoch'::timestamptz
    END AS cutoff
  ),
  realized AS (
    SELECT pt.user_id,
           COALESCE(SUM(pt.current_pl), 0)::numeric AS realized_pl,
           COUNT(*)::bigint AS closed_trades
    FROM public.paper_trades pt
    LEFT JOIN public.signals s ON s.id = pt.signal_id
    , window_cutoff w
    WHERE pt.status <> 'OPEN'
      AND COALESCE(pt.closed_at, pt.opened_at) >= w.cutoff
      AND COALESCE(s.is_demo, false) = false
    GROUP BY pt.user_id
  ),
  open_value AS (
    SELECT user_id,
           COALESCE(SUM(COALESCE(current_value, 0)), 0)::numeric AS open_val
    FROM public.paper_trades
    WHERE status = 'OPEN'
    GROUP BY user_id
  ),
  base AS (
    SELECT pa.user_id,
           (COALESCE(pa.cash_balance, 0) + COALESCE(ov.open_val, 0))::numeric AS live_equity
    FROM public.paper_accounts pa
    LEFT JOIN open_value ov ON ov.user_id = pa.user_id
  )
  SELECT
    b.user_id,
    COALESCE(p.display_name, 'Anonymous')::text AS display_name,
    COALESCE(r.realized_pl, 0)::numeric AS realized_pl,
    b.live_equity,
    COALESCE(r.closed_trades, 0)::bigint AS closed_trades
  FROM base b
  LEFT JOIN realized r ON r.user_id = b.user_id
  LEFT JOIN public.profiles p ON p.id = b.user_id
  ORDER BY COALESCE(r.realized_pl, 0) DESC, b.live_equity DESC
  LIMIT 100
$$;

REVOKE ALL ON FUNCTION public.get_leaderboard(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_leaderboard(text) TO authenticated;
