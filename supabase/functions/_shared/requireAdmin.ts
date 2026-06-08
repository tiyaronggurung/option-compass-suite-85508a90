// Shared admin-or-cron authorization helper for edge functions.
// Accepts: (a) service-role token (cron / pg_net) OR (b) authenticated admin user JWT.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export type AuthResult =
  | { ok: true; trigger: "cron" | "manual"; userId?: string }
  | { ok: false; status: number; msg: string };

export async function requireAdmin(req: Request): Promise<AuthResult> {
  const authz = req.headers.get("Authorization") ?? "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) return { ok: false, status: 401, msg: "unauthorized" };

  // Cron / service-role path
  if (token === SERVICE_KEY) return { ok: true, trigger: "cron" };

  // User path: must be admin
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authz } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return { ok: false, status: 401, msg: "unauthorized" };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: role } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!role) return { ok: false, status: 403, msg: "admin only" };

  return { ok: true, trigger: "manual", userId: user.id };
}
