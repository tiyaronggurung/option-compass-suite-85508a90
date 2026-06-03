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
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const admin = createClient(url, service);

    // Service-role bearer (internal calls, e.g. scan-signals) bypasses user check.
    if (token !== service) {
      const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
      if (!roleRow) return json({ error: "admin only" }, 403);
    }

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

    if (!ALPACA_KEY || !ALPACA_SECRET) return json({ error: "Alpaca not configured" }, 500);

    // Default 14–30 DTE focused window: today+10 .. today+45
    const today = new Date();
    const defaultStart = isoDate(addDays(today, 10));
    const defaultEnd   = isoDate(addDays(today, 45));

    // Bulk refresh for scanner tickers
    if (action === "refresh_scanner") {
      const tickers: string[] = Array.isArray(body.tickers) && body.tickers.length
        ? body.tickers.map((s: any) => String(s).toUpperCase())
        : ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "AAPL", "META", "MSFT"];
      const startE = String(body.start_expiry ?? defaultStart);
      const endE   = String(body.end_expiry   ?? defaultEnd);
      const results: Array<{ ticker: string; ok: boolean; count: number; error?: string }> = [];
      for (const t of tickers) {
        try {
          const n = await fetchAndCache(admin, t, startE, endE);
          results.push({ ticker: t, ok: true, count: n });
        } catch (e: any) {
          results.push({ ticker: t, ok: false, count: 0, error: e?.message ?? String(e) });
        }
      }
      return json({ ok: true, start_expiry: startE, end_expiry: endE, results });
    }

    const underlying = String(body.ticker ?? "").toUpperCase().trim();
    const expiry = String(body.expiry ?? "").trim(); // single YYYY-MM-DD (optional)
    const startExpiry = String(body.start_expiry ?? "").trim();
    const endExpiry   = String(body.end_expiry ?? "").trim();
    if (!underlying) return json({ error: "ticker required" }, 400);
    if (!/^[A-Z.]{1,6}$/.test(underlying)) {
      return json({ error: `Invalid ticker symbol "${underlying}". Use a symbol like NVDA, not a company name.` }, 400);
    }

    // Resolve window:
    //  - explicit single expiry → use it
    //  - explicit window → use it
    //  - neither → default 10..45 day window (so we don't waste the 1000-row limit on 0DTE chains)
    let startE = "";
    let endE = "";
    if (expiry) {
      startE = expiry;
      endE = expiry;
    } else if (startExpiry || endExpiry) {
      startE = startExpiry || defaultStart;
      endE = endExpiry || defaultEnd;
    } else {
      startE = defaultStart;
      endE = defaultEnd;
    }

    try {
      const count = await fetchAndCache(admin, underlying, startE, endE);
      return json({ ok: true, count, underlying, start_expiry: startE, end_expiry: endE });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const status = msg.startsWith("ALPACA_400:") ? 400 : 502;
      return json({ error: msg }, status);
    }

  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});

async function fetchAndCache(admin: any, underlying: string, startE: string, endE: string): Promise<number> {
  const params = new URLSearchParams({ limit: "1000" });
  if (startE) params.set("expiration_date_gte", startE);
  if (endE)   params.set("expiration_date_lte", endE);
  const apiUrl = `${ALPACA_DATA_BASE}/v1beta1/options/snapshots/${underlying}?${params}`;
  const res = await fetch(apiUrl, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 400) throw new Error(`ALPACA_400: ${txt.slice(0, 200)}`);
    throw new Error(`Alpaca ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const snapshots = data.snapshots ?? {};
  const rows: any[] = [];
  const now = new Date().toISOString();
  for (const [symbol, snap] of Object.entries<any>(snapshots)) {
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
    const chunk = 500;
    for (let i = 0; i < rows.length; i += chunk) {
      const { error } = await admin
        .from("options_contracts")
        .upsert(rows.slice(i, i + chunk), { onConflict: "underlying,expiry,strike,type" });
      if (error) throw new Error(error.message);
    }
  }
  return rows.length;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

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
