REVOKE EXECUTE ON FUNCTION public.bump_provider_budget(text, int, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bump_provider_budget(text, int, int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bump_provider_budget(text, int, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_provider_budget(text, int, int) TO service_role;