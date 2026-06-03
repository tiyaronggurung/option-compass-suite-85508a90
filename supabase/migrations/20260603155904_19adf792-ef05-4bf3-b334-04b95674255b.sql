CREATE TABLE public.options_contracts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol text NOT NULL,
  underlying text NOT NULL,
  expiry date NOT NULL,
  strike numeric NOT NULL,
  type text NOT NULL CHECK (type IN ('call','put')),
  bid numeric,
  ask numeric,
  last numeric,
  volume bigint,
  open_interest bigint,
  delta numeric,
  gamma numeric,
  theta numeric,
  vega numeric,
  iv numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (underlying, expiry, strike, type)
);

GRANT SELECT ON public.options_contracts TO authenticated;
GRANT ALL ON public.options_contracts TO service_role;

ALTER TABLE public.options_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY options_contracts_select_auth
  ON public.options_contracts FOR SELECT
  TO authenticated USING (true);

CREATE INDEX idx_options_contracts_underlying_expiry
  ON public.options_contracts (underlying, expiry);