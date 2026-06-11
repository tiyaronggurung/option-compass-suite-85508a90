import { supabase } from "@/integrations/supabase/client";

export async function invokeUpdatePaperMarks(body: Record<string, unknown> = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    // No active session — silently no-op (don't force sign-out, avoids loops on unauth pages).
    return { data: null, error: new Error("Not authenticated") };
  }
  const res = await supabase.functions.invoke("update-paper-marks", { body });
  // Server-side 401 (e.g. expired token that still looked valid client-side): sign out cleanly.
  const msg = String(res.error?.message ?? "");
  if (res.error && /401|Unauthorized/i.test(msg)) {
    await supabase.auth.signOut();
    return { data: null, error: new Error("Session expired. Please sign in again.") };
  }
  return res;
}
