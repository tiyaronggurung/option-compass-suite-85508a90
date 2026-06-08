// Fetch option chain via Tradier (migrated from Alpaca) and upsert into options_contracts.
// Same I/O contract as before — callers (scan-signals, pick-contract, refresh_scanner) unchanged.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TRADIER_KEY = Deno.env.get("TRADIER_API_KEY") ?? "";
const TRADIER_BASE = "https://api.tradier.com/v1";

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
      if (!TRADIER_KEY) return json({ ok: false, configured: false, error: "Tradier credentials not configured" });
      const res = await fetch(`${TRADIER_BASE}/markets/quotes?symbols=SPY`, {
        headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" },
      });
      const ok = res.ok;
      const txt = ok ? "" : await res.text();
      return json({ ok, configured: true, status: res.status, error: ok ? null : txt.slice(0, 300) });
    }

    if (!TRADIER_KEY) return json({ error: "Tradier not configured" }, 500);

    // Default 14–30 DTE focused window: today+10 .. today+45
    const today = new Date();
    const defaultStart = isoDate(addDays(today, 10));
    const defaultEnd   = isoDate(addDays(today, 45));

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
    const expiry = String(body.expiry ?? "").trim();
    const startExpiry = String(body.start_expiry ?? "").trim();
    const endExpiry   = String(body.end_expiry ?? "").trim();
    if (!underlying) return json({ error: "ticker required" }, 400);
    if (!/^[A-Z.]{1,6}$/.test(underlying)) {
      return json({ error: `Invalid ticker symbol "${underlying}". Use a symbol like NVDA, not a company name.` }, 400);
    }

    let startE = "";
    let endE = "";
    if (expiry) { startE = expiry; endE = expiry; }
    else if (startExpiry || endExpiry) { startE = startExpiry || defaultStart; endE = endExpiry || defaultEnd; }
    else { startE = defaultStart; endE = defaultEnd; }

    try {
      const count = await fetchAndCache(admin, underlying, startE, endE);
      return json({ ok: true, count, underlying, start_expiry: startE, end_expiry: endE });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const status = msg.startsWith("TRADIER_400:") ? 400 : 502;
      return json({ error: msg }, status);
    }
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});

async function tradier(path: string, params: Record<string, string>, timeoutMs = 10_000): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TRADIER_BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (res.status === 400) throw new Error(`TRADIER_400: ${t.slice(0, 200)}`);
      throw new Error(`Tradier ${path} ${res.status}: ${t.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function fetchAndCache(admin: any, underlying: string, startE: string, endE: string): Promise<number> {
  // 1) List expirations and filter to the requested window.
  const expJson = await tradier("/markets/options/expirations", { symbol: underlying, includeAllRoots: "true", strikes: "false" });
  const rawExp = expJson?.expirations?.date;
  const allExp: string[] = Array.isArray(rawExp) ? rawExp : rawExp ? [rawExp] : [];
  const windowExp = allExp.filter((e) => typeof e === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= startE && e <= endE);
  if (windowExp.length === 0) return 0;

  // 2) Pull each expiration's chain (with Greeks) and collect rows.
  const now = new Date().toISOString();
  const rows: any[] = [];
  for (const exp of windowExp) {
    let chainJson: any;
    try {
      chainJson = await tradier("/markets/options/chains", { symbol: underlying, expiration: exp, greeks: "true" }, 12_000);
    } catch (e) {
      // Skip a bad expiration but keep going so partial cache is still useful.
      console.warn("tradier chain failed", underlying, exp, (e as Error).message);
      continue;
    }
    const raw = chainJson?.options?.option;
    const arr: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const c of arr) {
      const symbol = String(c.symbol ?? "");
      if (!symbol) continue;
      const g = c.greeks ?? {};
      rows.push({
        symbol,
        underlying: String(c.underlying ?? underlying),
        expiry: String(c.expiration_date ?? exp),
        strike: numOrNull(c.strike) ?? 0,
        type: String(c.option_type ?? "").toLowerCase() === "put" ? "put" : "call",
        bid: numOrNull(c.bid),
        ask: numOrNull(c.ask),
        last: numOrNull(c.last),
        volume: numOrNull(c.volume),
        open_interest: numOrNull(c.open_interest),
        delta: numOrNull(g.delta),
        gamma: numOrNull(g.gamma),
        theta: numOrNull(g.theta),
        vega: numOrNull(g.vega),
        iv: numOrNull(g.mid_iv ?? g.smv_vol ?? g.ask_iv ?? g.bid_iv),
        updated_at: now,
      });
    }
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

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x;
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
