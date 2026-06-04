REVOKE EXECUTE ON FUNCTION public.seed_signal_outcome() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_signal_outcome() TO service_role;