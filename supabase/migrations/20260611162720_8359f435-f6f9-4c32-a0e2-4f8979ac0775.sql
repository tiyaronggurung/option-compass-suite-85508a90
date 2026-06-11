CREATE TABLE public.trade_entry_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id uuid REFERENCES public.signals(id) ON DELETE SET NULL,
  ticker text,
  action text NOT NULL CHECK (action IN ('enter','hold','reject','system')),
  hard_trigger text,
  reason_string text,
  llm_decision text,
  llm_confidence numeric,
  llm_latency_ms integer,
  macro_score numeric,
  signal_confidence numeric,
  fallback_count integer,
  dry_run boolean NOT NULL DEFAULT true,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.trade_entry_decisions TO authenticated;
GRANT ALL ON public.trade_entry_decisions TO service_role;

ALTER TABLE public.trade_entry_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own entry decisions"
  ON public.trade_entry_decisions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins read all entry decisions"
  ON public.trade_entry_decisions
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_trade_entry_decisions_user_created
  ON public.trade_entry_decisions (user_id, created_at DESC);
CREATE INDEX idx_trade_entry_decisions_signal
  ON public.trade_entry_decisions (signal_id);
CREATE INDEX idx_trade_entry_decisions_action_created
  ON public.trade_entry_decisions (action, created_at DESC);
CREATE INDEX idx_trade_entry_decisions_hard_trigger
  ON public.trade_entry_decisions (hard_trigger)
  WHERE hard_trigger IS NOT NULL;