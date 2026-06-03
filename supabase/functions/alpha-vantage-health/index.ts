// Lightweight Alpha Vantage health check. Admin-only. Pings GLOBAL_QUOTE for SPY
// and updates provider_configs row for 'alpha_vantage'. Key stays server-side.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AV_KEY = Deno.env.get("ALPHAVANTAGE_API_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "unauthorized" }, 401);

  if (token !== SERVICE_KEY) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: role } = await admin
      .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!role) return json({ error: "admin only" }, 403);
  }

  const configured = !!AV_KEY;
  if (!configured) {
    await admin.from("provider_configs").update({
      last_sync_at: new Date().toISOString(),
      last_status: "unknown",
      last_error: "Alpha Vantage key not configured",
      latency_ms: null,
      updated_at: new Date().toISOString(),
    }).eq("provider", "alpha_vantage");
    return json({ provider: "alpha_vantage", status: "unknown", configured: false, error: null, latency_ms: null });
  }

  const t0 = Date.now();
  try {
    const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${AV_KEY}`);
    const latency = Date.now() - t0;
    const body = await res.json().catch(() => null);

    let status: "ok" | "error" = "ok";
    let error: string | null = null;
    if (!res.ok) {
      status = "error";
      error = `HTTP ${res.status}`;
    } else if (body && (body.Note || body.Information)) {
      status = "error";
      error = "Rate limit reached (free tier 25/day, 5/min)";
    } else if (!body || !body["Global Quote"]) {
      status = "error";
      error = "Unexpected response";
    }

    await admin.from("provider_configs").update({
      last_sync_at: new Date().toISOString(),
      last_status: status,
      last_error: error,
      latency_ms: latency,
      updated_at: new Date().toISOString(),
    }).eq("provider", "alpha_vantage");

    return json({ provider: "alpha_vantage", status, configured: true, error, latency_ms: latency });
  } catch (e) {
    const latency = Date.now() - t0;
    const error = (e as Error).message;
    await admin.from("provider_configs").update({
      last_sync_at: new Date().toISOString(),
      last_status: "error",
      last_error: error.slice(0, 200),
      latency_ms: latency,
      updated_at: new Date().toISOString(),
    }).eq("provider", "alpha_vantage");
    return json({ provider: "alpha_vantage", status: "error", configured: true, error, latency_ms: latency }, 200);
  }
});
