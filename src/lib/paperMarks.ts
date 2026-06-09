import { supabase } from "@/integrations/supabase/client";

export async function invokeUpdatePaperMarks(body: Record<string, unknown> = {}) {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    await supabase.auth.signOut();
    return { data: null, error: new Error("Session expired. Please sign in again.") };
  }
  return supabase.functions.invoke("update-paper-marks", { body });
}
