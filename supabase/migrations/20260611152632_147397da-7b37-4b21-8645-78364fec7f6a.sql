
-- Macro regime snapshots (written every 60s by fetch-macro-quotes)
CREATE TABLE public.macro_regime_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  spy_price numeric, spy_5m_ret numeric, spy_above_5m_vwap boolean,
  qqq_price numeric, qqq_5m_ret numeric, qqq_above_5m_vwap boolean,
  smh_price numeric, smh_5m_ret numeric, smh_above_5m_vwap boolean,
  xlk_price numeric, xlk_5m_ret numeric,
  vix_spot numeric,
  dxy_1d_ret numeric,
  macro_tailwind_score numeric,
  components jsonb,
  source_errors jsonb
);
CREATE INDEX idx_macro_regime_snapshots_captured_at ON public.macro_regime_snapshots (captured_at DESC);

GRANT SELECT ON public.macro_regime_snapshots TO authenticated;
GRANT ALL ON public.macro_regime_snapshots TO service_role;

ALTER TABLE public.macro_regime_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view macro snapshots"
  ON public.macro_regime_snapshots FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Trade exit decisions log (one row per evaluation, including holds)
CREATE TABLE public.trade_exit_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id uuid NOT NULL REFERENCES public.paper_trades(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  composite_score numeric,
  macro_score numeric,
  macro_snapshot_id uuid REFERENCES public.macro_regime_snapshots(id) ON DELETE SET NULL,
  hard_trigger text,
  reason_string text NOT NULL,
  executed boolean NOT NULL DEFAULT false,
  context jsonb
);
CREATE INDEX idx_trade_exit_decisions_trade ON public.trade_exit_decisions (trade_id, decided_at DESC);
CREATE INDEX idx_trade_exit_decisions_user ON public.trade_exit_decisions (user_id, decided_at DESC);

GRANT SELECT ON public.trade_exit_decisions TO authenticated;
GRANT ALL ON public.trade_exit_decisions TO service_role;

ALTER TABLE public.trade_exit_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own exit decisions"
  ON public.trade_exit_decisions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
