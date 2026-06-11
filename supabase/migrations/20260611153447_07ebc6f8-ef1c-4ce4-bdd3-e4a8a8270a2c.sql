
ALTER TABLE public.trade_exit_decisions ALTER COLUMN trade_id DROP NOT NULL;
ALTER TABLE public.trade_exit_decisions ALTER COLUMN user_id DROP NOT NULL;

CREATE POLICY "Admins can view system exit decisions"
  ON public.trade_exit_decisions FOR SELECT
  TO authenticated
  USING (user_id IS NULL AND public.has_role(auth.uid(), 'admin'));
