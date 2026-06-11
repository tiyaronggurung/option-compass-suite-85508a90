
-- 1) auto_entry_rules
CREATE TABLE public.auto_entry_rules (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  min_tier TEXT,
  min_confidence INT,
  allowed_directions TEXT[],
  max_premium_usd NUMERIC,
  max_risk_usd NUMERIC,
  start_time_et TIME,
  end_time_et TIME,
  cooldown_minutes INT NOT NULL DEFAULT 30,
  max_signal_age_minutes INT NOT NULL DEFAULT 5,
  max_trades_per_day INT NOT NULL DEFAULT 5,
  daily_spend_cap_usd NUMERIC NOT NULL DEFAULT 2000,
  block_if_open_on_ticker BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auto_entry_rules TO authenticated;
GRANT ALL ON public.auto_entry_rules TO service_role;
ALTER TABLE public.auto_entry_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "aer_select_own" ON public.auto_entry_rules FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "aer_insert_own" ON public.auto_entry_rules FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "aer_update_own" ON public.auto_entry_rules FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "aer_delete_own" ON public.auto_entry_rules FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.auto_entry_rules_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER auto_entry_rules_updated_at
  BEFORE UPDATE ON public.auto_entry_rules
  FOR EACH ROW EXECUTE FUNCTION public.auto_entry_rules_set_updated_at();

-- 2) auto_entry_whitelist
CREATE TABLE public.auto_entry_whitelist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, ticker)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auto_entry_whitelist TO authenticated;
GRANT ALL ON public.auto_entry_whitelist TO service_role;
ALTER TABLE public.auto_entry_whitelist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "aew_select_own" ON public.auto_entry_whitelist FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "aew_insert_own" ON public.auto_entry_whitelist FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "aew_delete_own" ON public.auto_entry_whitelist FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 3) auto_entry_log
CREATE TABLE public.auto_entry_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES public.signals(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  paper_trade_id UUID REFERENCES public.paper_trades(id) ON DELETE SET NULL,
  rule_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, signal_id)
);
CREATE INDEX auto_entry_log_user_created_idx ON public.auto_entry_log (user_id, created_at DESC);
GRANT SELECT, INSERT, DELETE ON public.auto_entry_log TO authenticated;
GRANT ALL ON public.auto_entry_log TO service_role;
ALTER TABLE public.auto_entry_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ael_select_own" ON public.auto_entry_log FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "ael_delete_own" ON public.auto_entry_log FOR DELETE TO authenticated USING (auth.uid() = user_id);
-- Inserts come from the edge function (service role); no insert policy for users.
