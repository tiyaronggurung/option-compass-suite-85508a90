CREATE TABLE public.execution_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  execution_mode text NOT NULL DEFAULT 'approval' CHECK (execution_mode IN ('auto','approval')),
  trading_mode text NOT NULL DEFAULT 'paper' CHECK (trading_mode IN ('paper','live')),
  robinhood_email text,
  robinhood_password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.execution_settings TO authenticated;
GRANT ALL ON public.execution_settings TO service_role;

ALTER TABLE public.execution_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own row select" ON public.execution_settings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own row insert" ON public.execution_settings
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own row update" ON public.execution_settings
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own row delete" ON public.execution_settings
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER execution_settings_set_updated_at
  BEFORE UPDATE ON public.execution_settings
  FOR EACH ROW EXECUTE FUNCTION public.paper_accounts_set_updated_at();