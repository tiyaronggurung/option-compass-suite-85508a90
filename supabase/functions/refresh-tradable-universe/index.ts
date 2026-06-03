// Refresh public.tradable_universe from Alpaca Assets API.
// Admin-only (via JWT) or service-role (via cron). Heuristic-only enrichment for now:
// optionable = true for major US options exchanges (NYSE/NASDAQ/ARCA/BATS) when active+tradable.
// avg_volume / market_cap / last_price left NULL — future backfill job will populate.
import { createClient } from "npm:@supabase/supabase-js@2";

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
const ALPACA_BASE = Deno.env.get("ALPACA_BASE_URL") ?? "https://paper-api.alpaca.markets";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

// Major US options exchanges — heuristic for optionable flag
const OPTIONABLE_EXCHANGES = new Set(["NYSE", "NASDAQ", "ARCA", "BATS", "AMEX", "NYSEARCA", "NYSEAMERICAN"]);

type AlpacaAsset = {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  easy_to_borrow: boolean;
  fractionable: boolean;
  attributes?: string[];
};

async function authorize(req: Request): Promise<{ ok: true; trigger: string } | { ok: false; status: number; msg: string }> {
  const authz = req.headers.get("Authorization") ?? "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (token && token === SERVICE_KEY) return { ok: true, trigger: "cron" };
  if (!token) return { ok: false, status: 401, msg: "unauthorized" };
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authz } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return { ok: false, status: 401, msg: "unauthorized" };
  const { data: role } = await admin
    .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
  if (!role) return { ok: false, status: 403, msg: "admin only" };
  return { ok: true, trigger: "manual" };
}

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function logProviderHealth(status: "ok" | "error", latencyMs: number, err?: string) {
  await admin.from("provider_configs").upsert({
    provider: "alpaca",
    last_status: status,
    last_sync_at: new Date().toISOString(),
    last_error: err ?? null,
    latency_ms: latencyMs,
    updated_at: new Date().toISOString(),
  }, { onConflict: "provider" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorize(req);
  if (!auth.ok) return json({ error: auth.msg }, auth.status);

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    return json({ error: "Alpaca credentials missing" }, 500);
  }

  const t0 = Date.now();
  try {
    const url = `${ALPACA_BASE}/v2/assets?status=active&asset_class=us_equity`;
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      await logProviderHealth("error", Date.now() - t0, `assets ${res.status}: ${txt.slice(0, 200)}`);
      return json({ error: `Alpaca assets ${res.status}` }, 502);
    }

    const assets: AlpacaAsset[] = await res.json();

    // Filter active + tradable equities
    const filtered = assets.filter(
      (a) => a.status === "active" && a.tradable && a.class === "us_equity",
    );

    // Build upsert rows
    const rows = filtered.map((a) => {
      const ex = (a.exchange || "").toUpperCase();
      const optionable = OPTIONABLE_EXCHANGES.has(ex);
      return {
        ticker: a.symbol,
        company_name: a.name ?? null,
        exchange: a.exchange ?? null,
        asset_class: a.class ?? null,
        optionable,
        active: true,
        tradable: true,
        updated_at: new Date().toISOString(),
      };
    });

    // Batch upsert (Postgres has parameter limits; chunk by 500)
    let upserted = 0;
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await admin
        .from("tradable_universe")
        .upsert(chunk, { onConflict: "ticker" });
      if (error) throw new Error(`upsert chunk ${i}: ${error.message}`);
      upserted += chunk.length;
    }

    const dur = Date.now() - t0;
    await logProviderHealth("ok", dur);

    return json({
      ok: true,
      trigger: auth.trigger,
      total_assets: assets.length,
      filtered,
      upserted,
      optionable_count: rows.filter((r) => r.optionable).length,
      duration_ms: dur,
    });
  } catch (e) {
    const msg = (e as Error).message;
    await logProviderHealth("error", Date.now() - t0, msg);
    return json({ error: msg }, 500);
  }
});
