// Refresh upcoming earnings calendar from Alpha Vantage and cache in public.earnings_events.
// Admin-only. Key stays server-side (ALPHAVANTAGE_API_KEY env). Rate-limit-aware: on hit,
// updates provider_configs to 'error' with a friendly message and returns gracefully — the
// scanner is built to skip catalyst boost when the cache is empty.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AV_KEY = Deno.env.get("ALPHAVANTAGE_API_KEY") ?? "";

const DEFAULT_TICKERS = ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "AAPL", "META", "MSFT"];

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function updateProviderStatus(status: "ok" | "error" | "unknown", error: string | null, latency_ms: number | null) {
  await admin.from("provider_configs").update({
    last_sync_at: new Date().toISOString(),
    last_status: status,
    last_error: error,
    latency_ms,
    updated_at: new Date().toISOString(),
  }).eq("provider", "alpha_vantage");
}

// Alpha Vantage EARNINGS_CALENDAR returns CSV with header:
// symbol,name,reportDate,fiscalDateEnding,estimate,currency
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length !== header.length) continue;
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { row[h] = (cells[idx] ?? "").trim(); });
    out.push(row);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "unauthorized" }, 401);

  // Admin gate
  let isAdmin = token === SERVICE_KEY;
  let userId: string | null = null;
  if (!isAdmin) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    userId = user.id;
    const { data: role } = await admin
      .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!role) return json({ error: "admin only" }, 403);
    isAdmin = true;
  }

  if (!AV_KEY) {
    await updateProviderStatus("error", "Alpha Vantage key not configured", null);
    return json({ error: "Alpha Vantage not configured" }, 500);
  }

  let body: { tickers?: string[] } | null = null;
  try { body = await req.json(); } catch { /* optional */ }
  const tickerFilter = new Set((body?.tickers ?? DEFAULT_TICKERS).map((t) => t.toUpperCase()));

  const t0 = Date.now();
  const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${AV_KEY}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    const err = (e as Error).message;
    await updateProviderStatus("error", `Network: ${err}`.slice(0, 200), Date.now() - t0);
    return json({ error: "Network error contacting Alpha Vantage" }, 502);
  }
  const latency = Date.now() - t0;

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    await updateProviderStatus("error", `HTTP ${res.status}: ${txt.slice(0, 160)}`, latency);
    return json({ error: `Alpha Vantage HTTP ${res.status}` }, 502);
  }

  const text = await res.text();

  // Rate-limit / quota errors are returned with 200 OK and a JSON-ish note.
  const lower = text.trim().toLowerCase();
  if (lower.startsWith("{") && (lower.includes("note") || lower.includes("information") || lower.includes("rate limit"))) {
    await updateProviderStatus("error", "Rate limit reached (free tier 25/day, 5/min)", latency);
    return json({ error: "Alpha Vantage rate limit reached. Scanner will continue without catalyst boost." }, 429);
  }
  if (!text.includes("symbol,name,reportDate")) {
    await updateProviderStatus("error", "Unexpected response format", latency);
    return json({ error: "Unexpected response from Alpha Vantage" }, 502);
  }

  const rows = parseCsv(text);
  const filtered = rows.filter((r) => tickerFilter.has((r.symbol ?? "").toUpperCase()));

  // Upsert
  let upserted = 0;
  const errors: string[] = [];
  for (const r of filtered) {
    const ticker = (r.symbol ?? "").toUpperCase();
    const report_date = r.reportDate;
    if (!ticker || !report_date) continue;
    const fiscal_date_ending = r.fiscalDateEnding || null;
    const estimateRaw = r.estimate?.trim();
    const estimate = estimateRaw && estimateRaw !== "" && estimateRaw !== "None" ? Number(estimateRaw) : null;
    const currency = (r.currency || "USD").toUpperCase();

    const { error } = await admin.from("earnings_events").upsert({
      ticker,
      report_date,
      fiscal_date_ending,
      estimate: estimate != null && !Number.isNaN(estimate) ? estimate : null,
      currency,
      source: "alpha_vantage",
      updated_at: new Date().toISOString(),
    }, { onConflict: "ticker,report_date" });
    if (error) errors.push(`${ticker} ${report_date}: ${error.message}`);
    else upserted++;
  }

  await updateProviderStatus(
    errors.length === 0 ? "ok" : upserted > 0 ? "ok" : "error",
    errors.length ? errors.slice(0, 3).join("; ").slice(0, 300) : null,
    latency,
  );

  return json({
    ok: true,
    tickers: Array.from(tickerFilter),
    received: rows.length,
    matched: filtered.length,
    upserted,
    errors: errors.slice(0, 5),
    latency_ms: latency,
    triggered_by: userId ?? "service",
  });
});
