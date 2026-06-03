-- Cooldown setting on alert_settings
ALTER TABLE public.alert_settings
  ADD COLUMN IF NOT EXISTS cooldown_minutes INTEGER NOT NULL DEFAULT 15
  CHECK (cooldown_minutes IN (0, 5, 15, 30, 60));

-- Signal actions (dismissals; approvals are tracked via paper_trades)
CREATE TYPE public.signal_action AS ENUM ('approved', 'dismissed');

CREATE TABLE public.signal_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id UUID NOT NULL REFERENCES public.signals(id) ON DELETE CASCADE,
  action public.signal_action NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, signal_id, action)
);

GRANT SELECT, INSERT, DELETE ON public.signal_actions TO authenticated;
GRANT ALL ON public.signal_actions TO service_role;

ALTER TABLE public.signal_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY signal_actions_select_own_or_admin
  ON public.signal_actions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY signal_actions_insert_own
  ON public.signal_actions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY signal_actions_delete_own
  ON public.signal_actions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX signal_actions_signal_idx ON public.signal_actions (signal_id);
CREATE INDEX signal_actions_user_idx ON public.signal_actions (user_id, created_at DESC);