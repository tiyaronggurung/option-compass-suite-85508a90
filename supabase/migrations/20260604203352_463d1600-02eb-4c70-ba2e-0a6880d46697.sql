
CREATE TABLE IF NOT EXISTS public.contract_selection_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid NULL,
  paper_trade_id uuid NULL,
  user_id uuid NULL,
  underlying text NOT NULL,
  option_type text NOT NULL CHECK (option_type IN ('CALL','PUT')),
  contract_symbol text NULL,
  strike numeric NULL,
  expiry date NULL,
  dte integer NULL,
  delta numeric NULL,
  gamma numeric NULL,
  theta numeric NULL,
  vega numeric NULL,
  iv numeric NULL,
  iv_rank numeric NULL,
  bid numeric NULL,
  ask numeric NULL,
  mid numeric NULL,
  spread_pct numeric NULL,
  volume bigint NULL,
  open_interest bigint NULL,
  premium numeric NULL,
  contract_score integer NULL,
  liquidity_score integer NULL,
  rationale text NULL,
  rationale_factors jsonb NOT NULL DEFAULT '{}'::jsonb,
  contract_source text NOT NULL DEFAULT 'unavailable',
  candidates_considered integer NOT NULL DEFAULT 0,
  risk_profile text NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_css_signal ON public.contract_selection_snapshots(signal_id);
CREATE INDEX IF NOT EXISTS idx_css_paper_trade ON public.contract_selection_snapshots(paper_trade_id);
CREATE INDEX IF NOT EXISTS idx_css_user ON public.contract_selection_snapshots(user_id);

GRANT SELECT ON public.contract_selection_snapshots TO authenticated;
GRANT ALL ON public.contract_selection_snapshots TO service_role;

ALTER TABLE public.contract_selection_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY css_select_auth
  ON public.contract_selection_snapshots
  FOR SELECT
  TO authenticated
  USING (true);

-- Link columns
ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS contract_snapshot_id uuid NULL;

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS suggested_contract_snapshot_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_paper_trades_contract_snapshot ON public.paper_trades(contract_snapshot_id);
