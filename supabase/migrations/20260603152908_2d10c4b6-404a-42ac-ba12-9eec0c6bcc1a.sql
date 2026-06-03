-- Phase 4E: trade outcomes + AI review

-- Close reason enum
DO $$ BEGIN
  CREATE TYPE public.trade_close_reason AS ENUM
    ('target_hit', 'stop_hit', 'manual_close', 'expired', 'invalidated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Extend paper_trades with outcome fields (opened_at/closed_at already exist)
ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS exit_price numeric,
  ADD COLUMN IF NOT EXISTS exit_reason public.trade_close_reason,
  ADD COLUMN IF NOT EXISTS realized_pl_pct numeric,
  ADD COLUMN IF NOT EXISTS mfe numeric,
  ADD COLUMN IF NOT EXISTS mae numeric;

-- trade_reviews: cached AI post-trade reviews
CREATE TABLE IF NOT EXISTS public.trade_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  summary text,
  entry_quality text,
  rr_quality text,
  timing text,
  signal_strength text,
  lessons text,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_reviews TO authenticated;
GRANT ALL ON public.trade_reviews TO service_role;

ALTER TABLE public.trade_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY trade_reviews_select_own_or_admin ON public.trade_reviews
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY trade_reviews_insert_own ON public.trade_reviews
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY trade_reviews_update_own ON public.trade_reviews
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

-- Allow admins to read all paper_trades (for learning dashboard)
CREATE POLICY trades_select_admin ON public.paper_trades
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
