
CREATE TABLE public.trade_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  signal_id uuid,
  contract_snapshot_id uuid,
  paper_trade_id uuid,

  ticker text NOT NULL,
  option_side text NOT NULL CHECK (option_side IN ('call','put')),
  strike numeric,
  expiry date,
  contract_symbol text,

  underlying_trigger_price numeric,
  trigger_direction text CHECK (trigger_direction IN ('above','below')),

  entry_contract_price_min numeric,
  entry_contract_price_max numeric,
  stop_loss_contract_price numeric,
  target_1_contract_price numeric,
  target_2_contract_price numeric,
  target_3_contract_price numeric,
  invalidation_underlying_price numeric,

  alert_status text NOT NULL DEFAULT 'watching'
    CHECK (alert_status IN ('watching','triggered','entered','hit_t1','hit_t2','hit_t3','stopped','expired','cancelled')),
  triggered_at timestamptz,
  entered_at timestamptz,
  hit_t1_at timestamptz,
  hit_t2_at timestamptz,
  hit_t3_at timestamptz,
  stopped_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz,

  confidence_score integer,
  trade_rationale text,
  plan_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  last_evaluated_at timestamptz,
  last_notified_status text,
  last_underlying_price numeric,
  last_contract_mid numeric,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trade_alerts_user_idx ON public.trade_alerts (user_id, alert_status, created_at DESC);
CREATE INDEX trade_alerts_status_idx ON public.trade_alerts (alert_status) WHERE alert_status IN ('watching','triggered','entered');
CREATE INDEX trade_alerts_ticker_idx ON public.trade_alerts (ticker);

GRANT SELECT, INSERT, UPDATE ON public.trade_alerts TO authenticated;
GRANT ALL ON public.trade_alerts TO service_role;

ALTER TABLE public.trade_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY trade_alerts_select_own
  ON public.trade_alerts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY trade_alerts_select_admin
  ON public.trade_alerts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY trade_alerts_insert_own
  ON public.trade_alerts FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY trade_alerts_update_own
  ON public.trade_alerts FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.trade_alerts_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trade_alerts_updated_at
  BEFORE UPDATE ON public.trade_alerts
  FOR EACH ROW EXECUTE FUNCTION public.trade_alerts_set_updated_at();
