import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";
const ALPACA_DATA_BASE = "https://data.alpaca.markets";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(url, service);
    const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!roleRow) return json({ error: "admin only" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "fetch";

    if (action === "test") {
      if (!ALPACA_KEY || !ALPACA_SECRET) {
        return json({ ok: false, configured: false, error: "Alpaca credentials not configured" });
      }
      const res = await fetch(`${ALPACA_DATA_BASE}/v1beta1/options/snapshots/SPY?limit=1`, {
        headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
      });
      const ok = res.ok;
      const txt = ok ? "" : await res.text();
      return json({ ok, configured: true, status: res.status, error: ok ? null : txt.slice(0, 300) });
    }

    const underlying = String(body.ticker ?? "").toUpperCase().trim();
    const expiry = String(body.expiry ?? "").trim(); // YYYY-MM-DD
    if (!underlying) return json({ error: "ticker required" }, 400);
    if (!ALPACA_KEY || !ALPACA_SECRET) return json({ error: "Alpaca not configured" }, 500);

    const params = new URLSearchParams({ limit: "1000" });
    if (expiry) {
      params.set("expiration_date_gte", expiry);
      params.set("expiration_date_lte", expiry);
    }

    const apiUrl = `${ALPACA_DATA_BASE}/v1beta1/options/snapshots/${underlying}?${params}`;
    const res = await fetch(apiUrl, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
    });

    if (!res.ok) {
      const txt = await res.text();
      return json({ error: `Alpaca ${res.status}: ${txt.slice(0, 300)}` }, 502);
    }

    const data = await res.json();
    const snapshots = data.snapshots ?? {};
    const rows: any[] = [];
    const now = new Date().toISOString();

    for (const [symbol, snap] of Object.entries<any>(snapshots)) {
      // OCC symbol: e.g. AAPL250620C00150000
      const parsed = parseOcc(symbol);
      if (!parsed) continue;
      const q = snap.latestQuote ?? {};
      const t = snap.latestTrade ?? {};
      const g = snap.greeks ?? {};
      rows.push({
        symbol,
        underlying: parsed.underlying,
        expiry: parsed.expiry,
        strike: parsed.strike,
        type: parsed.type,
        bid: q.bp ?? null,
        ask: q.ap ?? null,
        last: t.p ?? null,
        volume: snap.dailyBar?.v ?? null,
        open_interest: snap.openInterest ?? null,
        delta: g.delta ?? null,
        gamma: g.gamma ?? null,
        theta: g.theta ?? null,
        vega: g.vega ?? null,
        iv: snap.impliedVolatility ?? null,
        updated_at: now,
      });
    }

    if (rows.length > 0) {
      // Upsert in chunks
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const { error } = await admin
          .from("options_contracts")
          .upsert(rows.slice(i, i + chunk), { onConflict: "underlying,expiry,strike,type" });
        if (error) return json({ error: error.message }, 500);
      }
    }

    return json({ ok: true, count: rows.length, underlying, expiry: expiry || null });
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

function parseOcc(sym: string): { underlying: string; expiry: string; strike: number; type: "call" | "put" } | null {
  const m = sym.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, underlying, yy, mm, dd, cp, strikeRaw] = m;
  return {
    underlying,
    expiry: `20${yy}-${mm}-${dd}`,
    strike: parseInt(strikeRaw, 10) / 1000,
    type: cp === "C" ? "call" : "put",
  };
}
