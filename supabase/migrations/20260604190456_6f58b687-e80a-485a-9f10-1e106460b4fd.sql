ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS paper_test_class text,
  ADD COLUMN IF NOT EXISTS confidence_at_approval integer;