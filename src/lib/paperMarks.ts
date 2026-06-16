import { supabase } from "@/integrations/supabase/client";

export async function invokeUpdatePaperMarks(body: Record<string, unknown> = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    // No active session — silently no-op (don't force sign-out, avoids loops on unauth pages).
    return { data: null, error: new Error("Not authenticated") };
  }
  const res = await supabase.functions.invoke("update-paper-marks", { body });
  // Background refresh — never surface auth/transient errors as runtime errors.
  // 401/403 commonly happen during logout races or stale tokens.
  const status = (res.error as any)?.context?.status;
  const msg = String(res.error?.message ?? "");
  if (res.error && (status === 401 || status === 403 || /401|403|Unauthorized|non-2xx/i.test(msg))) {
    return { data: null, error: null };
  }
  return res;
}
