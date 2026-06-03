
-- Enums
CREATE TYPE public.signal_direction AS ENUM ('CALL', 'PUT');
CREATE TYPE public.risk_level AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE public.signal_status AS ENUM ('LIVE', 'EXPIRED', 'TRIGGERED');
CREATE TYPE public.trade_status AS ENUM ('OPEN', 'WIN', 'LOSS', 'CLOSED');

-- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- watchlist_items
CREATE TABLE public.watchlist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  min_confidence INT NOT NULL DEFAULT 70,
  enable_0dte BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, ticker)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.watchlist_items TO authenticated;
GRANT ALL ON public.watchlist_items TO service_role;
ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "watchlist_select_own" ON public.watchlist_items FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "watchlist_insert_own" ON public.watchlist_items FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "watchlist_update_own" ON public.watchlist_items FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "watchlist_delete_own" ON public.watchlist_items FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- signals (shared, all authenticated users read; only service_role writes)
CREATE TABLE public.signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  direction public.signal_direction NOT NULL,
  confidence INT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  risk_level public.risk_level NOT NULL DEFAULT 'MEDIUM',
  price NUMERIC(12,4),
  contract_symbol TEXT,
  dte INT,
  expiry DATE,
  strike NUMERIC(12,4),
  premium NUMERIC(12,4),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  flow_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  technical_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  catalyst_summary TEXT,
  macro_score NUMERIC(5,2),
  status public.signal_status NOT NULL DEFAULT 'LIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.signals TO authenticated;
GRANT ALL ON public.signals TO service_role;
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signals_select_all_auth" ON public.signals FOR SELECT TO authenticated USING (true);
-- (no insert/update/delete policies for authenticated; service_role bypasses RLS)
CREATE INDEX signals_created_at_idx ON public.signals (created_at DESC);
CREATE INDEX signals_ticker_idx ON public.signals (ticker);

-- paper_trades
CREATE TABLE public.paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES public.signals(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  direction public.signal_direction NOT NULL,
  contract_idea TEXT,
  entry_price NUMERIC(12,4),
  stop_idea NUMERIC(12,4),
  target_idea NUMERIC(12,4),
  risk_amount NUMERIC(12,2),
  current_pl NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_gain NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_drawdown NUMERIC(12,2) NOT NULL DEFAULT 0,
  status public.trade_status NOT NULL DEFAULT 'OPEN',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_trades TO authenticated;
GRANT ALL ON public.paper_trades TO service_role;
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trades_select_own" ON public.paper_trades FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "trades_insert_own" ON public.paper_trades FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "trades_update_own" ON public.paper_trades FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "trades_delete_own" ON public.paper_trades FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Trigger: auto-create profile + default watchlist on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Seed some demo signals so the dashboard isn't empty
INSERT INTO public.signals (ticker, direction, confidence, risk_level, price, contract_symbol, dte, strike, premium, reasons, catalyst_summary, status) VALUES
('NVDA','CALL',88,'MEDIUM',1180.20,'NVDA 1200C',5,1200,18.40,'["Unusual call sweep at ask","RSI breakout above 65","Gamma squeeze setup"]','AI demand commentary ahead of GTC','LIVE'),
('TSLA','PUT',72,'HIGH',242.10,'TSLA 235P',2,235,4.20,'["Heavy put flow >$2M premium","Loss of 20EMA on 15m","Weak delivery whispers"]','Delivery numbers Friday','LIVE'),
('AMD','CALL',81,'MEDIUM',162.80,'AMD 165C',7,165,3.10,'["Repeated 165C sweeps","Holding VWAP all day","Sector rotation into semis"]','MI300 ramp updates','LIVE'),
('AAPL','CALL',65,'LOW',221.40,'AAPL 225C',14,225,2.80,'["Steady call accumulation","Above 50DMA","No catalyst risk this week"]',NULL,'LIVE'),
('SPY','PUT',77,'MEDIUM',598.30,'SPY 595P',0,595,1.10,'["0DTE put wall building at 595","VIX intraday divergence","Failed reclaim of overnight high"]','FOMC minutes 2pm ET','LIVE'),
('QQQ','CALL',69,'LOW',512.60,'QQQ 515C',1,515,2.40,'["Tech bid into close","Bullish gamma above 510","Breadth improving"]',NULL,'LIVE'),
('META','CALL',84,'MEDIUM',612.10,'META 620C',9,620,9.80,'["Block call buys $5M+","AI capex tailwind","Above all key MAs"]','Reels monetization update','LIVE');
