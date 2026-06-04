// Score debug — admin-only validation endpoint.
// Runs scoreInstitutional() directly for one ticker/direction with no
// scanner gate, no DB writes, no alerts, no paper trades.
import { createClient } from "npm:@supabase/supabase-js@2";
import { scoreInstitutional, tierFor, finvizSnapshotChecked, WEIGHTS } from "../_shared/scoring.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function isAdmin(authHeader: string | null, admin: ReturnType<typeof createClient>): Promise<boolean> {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return false;
  const { data } = await admin
    .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
  return !!data;
}

// Hidden-flag logic preserved from production: tier === "elite" surfaces, anything
// else is "hidden" from the public surface. This endpoint only REPORTS that flag,
// it does not write or alter scanner gating.
function hiddenFor(tier: string): boolean {
  return tier !== "elite";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (!(await isAdmin(req.headers.get("Authorization"), admin))) {
    return new Response(JSON.stringify({ error: "admin required" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { ticker?: string; direction?: string; baseTrendScore?: number } = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const ticker = (body.ticker ?? "NVDA").toUpperCase().trim();
  const direction = (body.direction ?? "CALL").toUpperCase() === "PUT" ? "PUT" : "CALL";
  const baseTrendScore = typeof body.baseTrendScore === "number" ? body.baseTrendScore : 0;

  try {
    // Re-fetch raw Finviz snapshot for visibility (scoreInstitutional fetches its own
    // internally — this second call is read-only and only used to surface raw fields).
    const fvRaw = await finvizSnapshotChecked(ticker);

    const result = await scoreInstitutional(admin, { ticker, direction, baseTrendScore });
    const tier = tierFor(result.final);

    const finviz_used = fvRaw.state === "ok";
    const finvizComponents = ["options_flow", "technical", "volatility"] as const;
    const finviz_powering = Object.fromEntries(
      finvizComponents.map((k) => [
        k,
        finviz_used && result.components[k].configured && result.components[k].source.toLowerCase().includes("finviz")
          ? "real_finviz"
          : "neutral_fallback",
      ]),
    );

    return new Response(
      JSON.stringify({
        debug: true,
        note: "validation-only — no signals inserted, no alerts, no paper trades, scanner gate untouched",
        ticker,
        direction,
        baseTrendScore,
        final_confidence: result.final,
        base_confidence: result.base,
        tier,
        hidden: hiddenFor(tier),
        regime: result.regime,
        regime_adjust: result.regime_adjust,
        weights: WEIGHTS,
        components: result.components,
        provider_status: result.provider_status,
        reasons: result.reasons,
        sources_used: result.sources_used,
        finviz: {
          state: fvRaw.state,
          reason: fvRaw.reason,
          detail: fvRaw.detail,
          real_or_fallback: finviz_used ? "real" : "fallback",
          powering: finviz_powering,
          raw_fields: fvRaw.row ?? null,
        },
      }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
