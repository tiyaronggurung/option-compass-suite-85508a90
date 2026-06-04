-- ============= Phase 1: Insider Intelligence =============

CREATE TABLE public.insider_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  insider_name text NOT NULL,
  role text,
  transaction_type text NOT NULL,
  filing_date date,
  transaction_date date NOT NULL,
  shares numeric,
  price numeric,
  total_value numeric,
  direction text NOT NULL CHECK (direction IN ('buy','sell','neutral')),
  source text NOT NULL DEFAULT 'finviz',
  external_ref text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX insider_tx_dedupe
  ON public.insider_transactions (ticker, insider_name, transaction_date, transaction_type, COALESCE(shares,0), source);
CREATE INDEX insider_tx_ticker_date ON public.insider_transactions (ticker, transaction_date DESC);

GRANT SELECT ON public.insider_transactions TO authenticated;
GRANT ALL    ON public.insider_transactions TO service_role;
ALTER TABLE public.insider_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY insider_tx_select_auth ON public.insider_transactions
  FOR SELECT TO authenticated USING (true);

-- =============================================

CREATE TABLE public.insider_strength_scores (
  ticker text PRIMARY KEY,
  score integer NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
  label text NOT NULL DEFAULT 'neutral',
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_days integer NOT NULL DEFAULT 90,
  buy_count_30d integer NOT NULL DEFAULT 0,
  sell_count_30d integer NOT NULL DEFAULT 0,
  buy_count_90d integer NOT NULL DEFAULT 0,
  sell_count_90d integer NOT NULL DEFAULT 0,
  total_buy_value_90d numeric NOT NULL DEFAULT 0,
  as_of timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.insider_strength_scores TO authenticated;
GRANT ALL    ON public.insider_strength_scores TO service_role;
ALTER TABLE public.insider_strength_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY insider_strength_select_auth ON public.insider_strength_scores
  FOR SELECT TO authenticated USING (true);

-- ============= Phase 2: Historical Performance =============

CREATE TABLE public.signal_outcomes (
  signal_id uuid PRIMARY KEY REFERENCES public.signals(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  direction text NOT NULL,
  confidence integer NOT NULL,
  tier text,
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_price numeric,
  entry_at timestamptz NOT NULL,
  price_1d numeric, price_3d numeric, price_5d numeric, price_10d numeric, price_30d numeric,
  return_1d numeric, return_3d numeric, return_5d numeric, return_10d numeric, return_30d numeric,
  win_1d boolean, win_3d boolean, win_5d boolean, win_10d boolean, win_30d boolean,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','final','errored')),
  last_error text,
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signal_outcomes_status_entry ON public.signal_outcomes (status, entry_at);
CREATE INDEX signal_outcomes_confidence ON public.signal_outcomes (confidence);

GRANT SELECT ON public.signal_outcomes TO authenticated;
GRANT ALL    ON public.signal_outcomes TO service_role;
ALTER TABLE public.signal_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY signal_outcomes_select_auth ON public.signal_outcomes
  FOR SELECT TO authenticated USING (true);

-- Additive trigger: on every new signal, seed an outcome row (pending). Never modifies signals.
CREATE OR REPLACE FUNCTION public.seed_signal_outcome()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Skip demo and hidden signals to keep the outcome dataset clean for performance analytics.
  IF NEW.is_demo IS TRUE THEN RETURN NEW; END IF;
  INSERT INTO public.signal_outcomes (
    signal_id, ticker, direction, confidence, tier, score_components,
    entry_price, entry_at, status
  ) VALUES (
    NEW.id, NEW.ticker, NEW.direction::text, NEW.confidence, NEW.tier,
    COALESCE(NEW.score_components, '{}'::jsonb),
    NEW.price, NEW.created_at, 'pending'
  )
  ON CONFLICT (signal_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_seed_signal_outcome
  AFTER INSERT ON public.signals
  FOR EACH ROW EXECUTE FUNCTION public.seed_signal_outcome();

-- Backfill: seed outcomes for existing non-demo signals (idempotent via PK conflict).
INSERT INTO public.signal_outcomes (
  signal_id, ticker, direction, confidence, tier, score_components,
  entry_price, entry_at, status
)
SELECT id, ticker, direction::text, confidence, tier,
       COALESCE(score_components, '{}'::jsonb), price, created_at, 'pending'
FROM public.signals
WHERE is_demo = false
ON CONFLICT (signal_id) DO NOTHING;
