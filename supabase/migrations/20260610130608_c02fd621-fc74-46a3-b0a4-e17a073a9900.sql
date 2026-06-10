
CREATE TABLE public.technical_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX technical_snapshots_ticker_key ON public.technical_snapshots (ticker);
CREATE INDEX technical_snapshots_computed_at_idx ON public.technical_snapshots (computed_at DESC);

GRANT SELECT ON public.technical_snapshots TO authenticated;
GRANT ALL ON public.technical_snapshots TO service_role;

ALTER TABLE public.technical_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read snapshots"
  ON public.technical_snapshots
  FOR SELECT
  TO authenticated
  USING (true);
