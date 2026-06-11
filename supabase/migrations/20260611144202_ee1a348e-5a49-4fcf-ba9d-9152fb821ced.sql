
CREATE TABLE public.auto_exit_rules (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  stop_loss_pct NUMERIC,
  take_profit_pct NUMERIC,
  trailing_stop_pct NUMERIC,
  time_exit_et TIME,
  theta_burn_pct NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.auto_exit_rules TO authenticated;
GRANT ALL ON public.auto_exit_rules TO service_role;

ALTER TABLE public.auto_exit_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auto_exit_rules_select_own" ON public.auto_exit_rules
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "auto_exit_rules_insert_own" ON public.auto_exit_rules
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "auto_exit_rules_update_own" ON public.auto_exit_rules
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "auto_exit_rules_delete_own" ON public.auto_exit_rules
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.auto_exit_rules_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER auto_exit_rules_updated_at
  BEFORE UPDATE ON public.auto_exit_rules
  FOR EACH ROW EXECUTE FUNCTION public.auto_exit_rules_set_updated_at();

ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS auto_exit_armed_rule TEXT,
  ADD COLUMN IF NOT EXISTS auto_exit_closed_by TEXT,
  ADD COLUMN IF NOT EXISTS auto_exit_peak_premium NUMERIC;
