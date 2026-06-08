// Lightweight health check for Finviz API key. Updates provider_configs row.
import { createClient } from "npm:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const key = Deno.env.get("FINVIZ_API_KEY") ?? "";
  const t0 = Date.now();
  let status: "ok" | "error" | "unknown" = "unknown";
  let err: string | null = null;
  if (!key) err = "FINVIZ_API_KEY not set";
  else {
    try {
      const res = await fetch(`https://elite.finviz.com/quote_export.ashx?t=SPY&auth=${key}`);
      const txt = await res.text();
      status = res.ok && txt.length > 50 ? "ok" : "error";
      if (status === "error") err = `HTTP ${res.status}`;
    } catch (e) { status = "error"; err = (e as Error).message; }
  }
  await admin.from("provider_configs").update({
    last_status: status, last_error: err, last_sync_at: new Date().toISOString(),
    latency_ms: Date.now() - t0,
  }).eq("provider", "finviz");
  return new Response(JSON.stringify({ ok: status === "ok", status, error: err }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
