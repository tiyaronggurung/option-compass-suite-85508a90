// Provider health check — admin-only. Tests connectivity to each configured provider
// using auth-only/lightweight calls, then updates provider_configs.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type ProviderId = "alpaca" | "tradier" | "polygon" | "unusual_whales" | "news";

interface ProbeResult {
  status: "ok" | "error" | "unknown";
  latency_ms: number | null;
  error: string | null;
  configured: boolean;
}

async function probeAlpaca(): Promise<ProbeResult> {
  const key = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!key || !secret) {
    return { status: "unknown", latency_ms: null, error: null, configured: false };
  }
  // Account endpoint lives on the trading API, not the data API — use it explicitly
  // to avoid 404s when ALPACA_BASE_URL is pointed at data.alpaca.markets or similar.
  const tradingBase = "https://paper-api.alpaca.markets";
  const t0 = Date.now();
  try {
    const res = await fetch(`${tradingBase}/v2/account`, {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
    });
    const latency = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "error", latency_ms: latency, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, configured: true };
    }
    await res.json().catch(() => null);
    return { status: "ok", latency_ms: latency, error: null, configured: true };
  } catch (e) {
    return { status: "error", latency_ms: Date.now() - t0, error: (e as Error).message, configured: true };
  }
}

function notConfigured(envName: string): ProbeResult {
  return {
    status: "unknown",
    latency_ms: null,
    error: null,
    configured: !!Deno.env.get(envName),
  };
}

async function probeUnusualWhales(): Promise<ProbeResult> {
  const key = Deno.env.get("UNUSUAL_WHALES_API_KEY");
  if (!key) return { status: "unknown", latency_ms: null, error: null, configured: false };
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.unusualwhales.com/api/stock/SPY/flow-alerts?limit=1", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    const latency = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "error", latency_ms: latency, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, configured: true };
    }
    await res.json().catch(() => null);
    return { status: "ok", latency_ms: latency, error: null, configured: true };
  } catch (e) {
    return { status: "error", latency_ms: Date.now() - t0, error: (e as Error).message, configured: true };
  }
}

async function probeFinnhubNews(): Promise<ProbeResult> {
  const key = Deno.env.get("FINNHUB_API_KEY");
  if (!key) return { status: "unknown", latency_ms: null, error: null, configured: false };
  const t0 = Date.now();
  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(key)}`);
    const latency = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "error", latency_ms: latency, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, configured: true };
    }
    await res.json().catch(() => null);
    return { status: "ok", latency_ms: latency, error: null, configured: true };
  } catch (e) {
    return { status: "error", latency_ms: Date.now() - t0, error: (e as Error).message, configured: true };
  }
}

async function probe(provider: ProviderId): Promise<ProbeResult> {
  switch (provider) {
    case "alpaca": return await probeAlpaca();
    case "tradier": return notConfigured("TRADIER_API_KEY");
    case "polygon": return notConfigured("POLYGON_API_KEY");
    case "unusual_whales": return await probeUnusualWhales();
    case "news": return await probeFinnhubNews();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: claims, error: claimsErr } = await userClient.auth.getClaims(token);
  if (claimsErr || !claims?.claims) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = claims.claims.sub as string;

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) {
    return new Response(JSON.stringify({ error: "Forbidden: admin only" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const providers: ProviderId[] = ["alpaca", "tradier", "polygon", "unusual_whales", "news"];
  const results = await Promise.all(providers.map(async (p) => {
    const r = await probe(p);
    // Only update sync metadata for providers we actually probed (configured).
    if (r.configured) {
      await admin.from("provider_configs").update({
        last_sync_at: new Date().toISOString(),
        last_status: r.status,
        last_error: r.error,
        latency_ms: r.latency_ms,
        updated_at: new Date().toISOString(),
      }).eq("provider", p);
    }
    return { provider: p, ...r };
  }));

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
