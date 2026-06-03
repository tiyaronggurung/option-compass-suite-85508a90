// Admin-only: refresh option chain for a signal's underlying (if stale) and
// pick the best ~0.35-delta contract, then update the signal row.
import { createClient } from "npm:@supabase/supabase-js@2";
import { pickBestContract } from "../_shared/pickContract.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authz = req.headers.get("Authorization") ?? "";
    if (!authz) return json({ error: "unauthorized" }, 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authz } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: role } = await admin
      .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!role) return json({ error: "admin only" }, 403);

    const body = await req.json().catch(() => ({}));
    const signalId = String(body.signal_id ?? "");
    if (!signalId) return json({ error: "signal_id required" }, 400);

    const { data: sig, error: sigErr } = await admin
      .from("signals").select("*").eq("id", signalId).maybeSingle();
    if (sigErr || !sig) return json({ error: "signal not found" }, 404);

    if (!ALPACA_KEY || !ALPACA_SECRET) {
      return json({ error: "Options provider not configured" }, 400);
    }

    // Check freshness of cached chain
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("options_contracts")
      .select("symbol", { count: "exact", head: true })
      .eq("underlying", sig.ticker)
      .gt("updated_at", cutoff);

    let refreshed = false;
    if (!count || count < 10) {
      // Invoke fetch-options-chain directly via service role
      const r = await fetch(`${SUPABASE_URL}/functions/v1/fetch-options-chain`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          "apikey": SERVICE_KEY,
        },
        body: JSON.stringify({ ticker: sig.ticker }),
      });
      refreshed = r.ok;
    }

    const picked = await pickBestContract(admin, sig.ticker, sig.direction as "CALL" | "PUT");
    if (!picked) {
      return json({ ok: true, refreshed, picked: null, reason: "No contract match yet." });
    }

    const tm = (sig.technical_metrics as Record<string, unknown>) ?? {};
    const newTm = {
      ...tm,
      contract: {
        delta: picked.contract.delta,
        iv: picked.contract.iv,
        bid: picked.contract.bid,
        ask: picked.contract.ask,
        mid: picked.mid,
        dte: picked.dte,
        spread_pct: picked.spread_pct,
        liquidity_score: picked.liquidity_score,
        reason: picked.reason,
      },
    };

    const { error: updErr } = await admin
      .from("signals")
      .update({
        contract_symbol: picked.contract.symbol,
        expiry: picked.contract.expiry,
        strike: picked.contract.strike,
        premium: picked.mid,
        dte: picked.dte,
        technical_metrics: newTm,
      })
      .eq("id", signalId);

    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, refreshed, picked });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
