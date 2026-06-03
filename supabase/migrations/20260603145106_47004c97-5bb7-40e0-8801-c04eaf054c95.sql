-- 1. Roles
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_roles_select_own
  ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 2. has_role helper (security definer to avoid RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- 3. Provider configs
CREATE TYPE public.provider_id AS ENUM ('alpaca','tradier','polygon','unusual_whales','news');
CREATE TYPE public.provider_mode AS ENUM ('live','simulated');
CREATE TYPE public.provider_status AS ENUM ('ok','error','unknown');

CREATE TABLE public.provider_configs (
  provider public.provider_id PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode public.provider_mode NOT NULL DEFAULT 'simulated',
  last_sync_at TIMESTAMPTZ,
  last_status public.provider_status NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  latency_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.provider_configs TO authenticated;
GRANT ALL ON public.provider_configs TO service_role;

ALTER TABLE public.provider_configs ENABLE ROW LEVEL SECURITY;

-- Any authed user can view status (safe, no secrets)
CREATE POLICY provider_configs_select_auth
  ON public.provider_configs FOR SELECT TO authenticated
  USING (true);

-- Only admins can update via direct SQL (edge functions use service role anyway)
CREATE POLICY provider_configs_update_admin
  ON public.provider_configs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Seed providers
INSERT INTO public.provider_configs (provider) VALUES
  ('alpaca'), ('tradier'), ('polygon'), ('unusual_whales'), ('news')
ON CONFLICT (provider) DO NOTHING;

-- 4. Update handle_new_user: first user => admin, rest => user
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t TEXT;
  is_first BOOLEAN;
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

  -- Role assignment: first user becomes admin
  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin') INTO is_first;
  IF is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin')
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure trigger exists (idempotent)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 5. Backfill: if there are already users but no admin, promote the oldest one
DO $$
DECLARE
  oldest_uid UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin') THEN
    SELECT id INTO oldest_uid FROM auth.users ORDER BY created_at ASC LIMIT 1;
    IF oldest_uid IS NOT NULL THEN
      INSERT INTO public.user_roles (user_id, role) VALUES (oldest_uid, 'admin')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- Give 'user' role to any existing users that have no role yet
  INSERT INTO public.user_roles (user_id, role)
  SELECT u.id, 'user'::public.app_role
  FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id);
END $$;