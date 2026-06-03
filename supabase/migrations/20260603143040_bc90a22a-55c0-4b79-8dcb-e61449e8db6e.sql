
-- alert_settings (one row per user)
CREATE TABLE public.alert_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  browser_push_enabled BOOLEAN NOT NULL DEFAULT false,
  email_enabled BOOLEAN NOT NULL DEFAULT false,
  telegram_enabled BOOLEAN NOT NULL DEFAULT false,
  discord_enabled BOOLEAN NOT NULL DEFAULT false,
  sms_enabled BOOLEAN NOT NULL DEFAULT false,
  telegram_chat_id TEXT,
  discord_webhook_url TEXT,
  sms_phone TEXT,
  notify_email TEXT,
  min_confidence INT NOT NULL DEFAULT 70 CHECK (min_confidence BETWEEN 0 AND 100),
  max_risk_level TEXT NOT NULL DEFAULT 'HIGH' CHECK (max_risk_level IN ('LOW','MEDIUM','HIGH')),
  watchlist_only BOOLEAN NOT NULL DEFAULT false,
  include_0dte BOOLEAN NOT NULL DEFAULT true,
  bullish_only BOOLEAN NOT NULL DEFAULT false,
  bearish_only BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_settings TO authenticated;
GRANT ALL ON public.alert_settings TO service_role;
ALTER TABLE public.alert_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alert_settings_select_own" ON public.alert_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "alert_settings_insert_own" ON public.alert_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "alert_settings_update_own" ON public.alert_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- risk_settings (one row per user)
CREATE TABLE public.risk_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  max_risk_per_trade NUMERIC(12,2) NOT NULL DEFAULT 100,
  daily_loss_cap NUMERIC(12,2) NOT NULL DEFAULT 500,
  max_open_trades INT NOT NULL DEFAULT 5,
  kill_switch BOOLEAN NOT NULL DEFAULT false,
  require_manual_approval BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.risk_settings TO authenticated;
GRANT ALL ON public.risk_settings TO service_role;
ALTER TABLE public.risk_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "risk_settings_select_own" ON public.risk_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "risk_settings_insert_own" ON public.risk_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "risk_settings_update_own" ON public.risk_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- signal_analyses (cached AI output, one row per signal)
CREATE TABLE public.signal_analyses (
  signal_id UUID PRIMARY KEY REFERENCES public.signals(id) ON DELETE CASCADE,
  summary TEXT,
  bull_case TEXT,
  bear_case TEXT,
  why_triggered TEXT,
  flow_interpretation TEXT,
  technical_confirmation TEXT,
  catalyst_context TEXT,
  macro_context TEXT,
  risk_warnings TEXT,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('WAIT','CHASE','AVOID')),
  desks JSONB NOT NULL DEFAULT '[]'::jsonb,
  historical JSONB NOT NULL DEFAULT '{}'::jsonb,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.signal_analyses TO authenticated;
GRANT ALL ON public.signal_analyses TO service_role;
ALTER TABLE public.signal_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "analyses_select_all_auth" ON public.signal_analyses FOR SELECT TO authenticated USING (true);

-- Extend new-user trigger to seed alert + risk defaults
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t TEXT;
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(NEW.email, '@', 1)));

  FOREACH t IN ARRAY ARRAY['SPY','QQQ','NVDA','TSLA','AMD','AAPL','META','MSFT'] LOOP
    INSERT INTO public.watchlist_items (user_id, ticker) VALUES (NEW.id, t)
    ON CONFLICT (user_id, ticker) DO NOTHING;
  END LOOP;

  INSERT INTO public.alert_settings (user_id, notify_email) VALUES (NEW.id, NEW.email)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.risk_settings (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Backfill for existing users
INSERT INTO public.alert_settings (user_id, notify_email)
SELECT u.id, u.email FROM auth.users u
LEFT JOIN public.alert_settings a ON a.user_id = u.id
WHERE a.user_id IS NULL;

INSERT INTO public.risk_settings (user_id)
SELECT u.id FROM auth.users u
LEFT JOIN public.risk_settings r ON r.user_id = u.id
WHERE r.user_id IS NULL;
