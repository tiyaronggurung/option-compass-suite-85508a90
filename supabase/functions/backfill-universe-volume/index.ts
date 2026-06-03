// Backfill avg_volume + last_price for tradable_universe using Alpaca daily bars.
// Admin-only (JWT) or service-role (cron). Processes in parallel batches of 20.
// Stops at ~48s elapsed and returns next_offset so the caller can resume.
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
// Market data lives on data.alpaca.markets regardless of paper/live trading base.
const ALPACA_DATA_BASE = "https://data.alpaca.markets";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const BATCH_SIZE = 20;
const MAX_RUNTIME_MS = 48_000; // stop before 60s edge timeout
const BARS_LOOKBACK_DAYS = 35; // ~20 trading days + buffer for weekends/holidays

type Auth = { ok: true; trigger: string } | { ok: false; status: number; msg: string };
async function authorize(req: Request): Promise<Auth> {
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

type BarsResp = {
  bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
};

async function fetchTickerStats(ticker: string): Promise<
  { ticker: string; avg_volume: number | null; last_price: number | null } | null
> {
  const end = new Date();
  const start = new Date(Date.now() - BARS_LOOKBACK_DAYS * 86_400_000);
  const params = new URLSearchParams({
    timeframe: "1Day",
    start: start.toISOString(),
    end: end.toISOString(),
    limit: "30",
    adjustment: "raw",
    feed: "iex",
  });
  const url = `${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(ticker)}/bars?${params}`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
  });
  if (!res.ok) throw new Error(`bars ${res.status}`);
  const body = (await res.json()) as BarsResp;
  const bars = body.bars ?? [];
  if (bars.length === 0) return { ticker, avg_volume: null, last_price: null };
  const recent = bars.slice(-20);
  const avg = Math.round(recent.reduce((s, b) => s + (b.v ?? 0), 0) / recent.length);
  const last = bars[bars.length - 1].c ?? null;
  return { ticker, avg_volume: avg, last_price: last };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorize(req);
  if (!auth.ok) return json({ error: auth.msg }, auth.status);

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    return json({ error: "Alpaca credentials missing" }, 500);
  }

  // Parse query params
  const url = new URL(req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "1000", 10) || 1000));

  const t0 = Date.now();

  // Pull candidates from tradable_universe (ordered for deterministic pagination)
  const { data: rows, error: selErr } = await admin
    .from("tradable_universe")
    .select("ticker")
    .eq("active", true)
    .eq("optionable", true)
    .order("ticker", { ascending: true })
    .range(offset, offset + limit - 1);

  if (selErr) return json({ error: `select: ${selErr.message}` }, 500);

  const tickers = (rows ?? []).map((r) => r.ticker as string);
  if (tickers.length === 0) {
    return json({ processed: 0, updated: 0, failed: 0, next_offset: offset, done: true });
  }

  let processed = 0;
  let updated = 0;
  let failed = 0;
  let i = 0;
  let stopped = false;

  while (i < tickers.length) {
    if (Date.now() - t0 > MAX_RUNTIME_MS) {
      stopped = true;
      break;
    }
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((t) => fetchTickerStats(t)));

    const upserts: Array<{ ticker: string; avg_volume: number | null; last_price: number | null; updated_at: string }> = [];
    for (const r of results) {
      processed++;
      if (r.status === "fulfilled" && r.value) {
        upserts.push({
          ticker: r.value.ticker,
          avg_volume: r.value.avg_volume,
          last_price: r.value.last_price,
          updated_at: new Date().toISOString(),
        });
      } else {
        failed++;
      }
    }

    if (upserts.length > 0) {
      const { error: upErr } = await admin
        .from("tradable_universe")
        .upsert(upserts, { onConflict: "ticker" });
      if (upErr) {
        failed += upserts.length;
      } else {
        updated += upserts.length;
      }
    }

    i += BATCH_SIZE;
  }

  const consumed = Math.min(i, tickers.length);
  const next_offset = offset + consumed;
  // done when we stopped naturally (not by timeout) AND fewer rows returned than requested limit
  const done = !stopped && tickers.length < limit;

  const dur = Date.now() - t0;
  await logProviderHealth("ok", dur);

  return json({
    processed,
    updated,
    failed,
    next_offset,
    done,
    trigger: auth.trigger,
    duration_ms: dur,
    stopped_for_timeout: stopped,
  });
});
