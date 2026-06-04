// Outcome tracker — Phase 2.
// Pulls pending/partial signal_outcomes and fills price_*d / return_*d / win_*d
// using Alpaca daily bars. Marks 'final' once price_30d is populated.
//
// Read-only against signals. Does NOT touch scoring, scanner, tiers, Tradier, UW,
// paper, live, or guest paths.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";
const INGEST_SECRET = Deno.env.get("SIGNAL_INGEST_SECRET") ?? "";
const ALPACA_BASE = "https://data.alpaca.markets";

const WINDOWS: Array<{ days: number; key: "1d" | "3d" | "5d" | "10d" | "30d" }> = [
  { days: 1, key: "1d" },
  { days: 3, key: "3d" },
  { days: 5, key: "5d" },
  { days: 10, key: "10d" },
  { days: 30, key: "30d" },
];
const MAX_RUNTIME_MS = 50_000;
const BATCH_SIZE = 100;

async function isAdmin(authHeader: string | null, admin: SupabaseClient): Promise<boolean> {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return false;
  const { data } = await admin
    .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
  return !!data;
}

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };

// Fetch enough daily bars to cover the largest window (30d trading ≈ 45 calendar days + buffer).
async function fetchBars(ticker: string, from: Date): Promise<Bar[]> {
  if (!ALPACA_KEY || !ALPACA_SECRET) return [];
  const start = new Date(from.getTime() - 2 * 86400000); // small lookback for entry-day price
  const end = new Date(Math.min(Date.now(), from.getTime() + 50 * 86400000));
  const params = new URLSearchParams({
    timeframe: "1Day",
    start: start.toISOString(),
    end: end.toISOString(),
    limit: "80",
    adjustment: "raw",
    feed: "iex",
  });
  const url = `${ALPACA_BASE}/v2/stocks/${encodeURIComponent(ticker)}/bars?${params}`;
  try {
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
    });
    if (!res.ok) { await res.text(); return []; }
    const j = await res.json();
    return Array.isArray(j?.bars) ? j.bars : [];
  } catch { return []; }
}

// Find the close on/after entry+N calendar days. Returns null if no bar yet.
function closeAfterDays(bars: Bar[], entry: Date, addDays: number): number | null {
  if (bars.length === 0) return null;
  const target = entry.getTime() + addDays * 86400000;
  let chosen: Bar | null = null;
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (Number.isNaN(t)) continue;
    if (t >= target) { chosen = b; break; }
  }
  if (!chosen) {
    // Window not closed yet
    const last = bars[bars.length - 1];
    const lastT = Date.parse(last.t);
    if (Number.isNaN(lastT) || lastT < target) return null;
    chosen = last;
  }
  return chosen.c ?? null;
}

// Entry price: use stored entry_price if present, otherwise nearest close on/after entry_at.
function resolveEntryPrice(stored: number | null, bars: Bar[], entry: Date): number | null {
  if (stored && stored > 0) return stored;
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (!Number.isNaN(t) && t >= entry.getTime() - 86400000) return b.c ?? null;
  }
  return null;
}

type OutcomeRow = {
  signal_id: string;
  ticker: string;
  direction: string;
  entry_price: number | null;
  entry_at: string;
  status: string;
  price_1d: number | null; price_3d: number | null; price_5d: number | null;
  price_10d: number | null; price_30d: number | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Auth: admin user, cron with shared secret, OR service-role bearer.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const cronSecret = req.headers.get("x-ingest-secret");
  const authedService = token && token === SERVICE_KEY;
  const authedCron = !!INGEST_SECRET && cronSecret === INGEST_SECRET;
  const authedAdmin = !authedService && !authedCron && await isAdmin(authHeader, admin);
  if (!authedAdmin && !authedCron && !authedService) {
    return new Response(JSON.stringify({ error: "admin or ingest secret required" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const started = Date.now();
  const { data: pending, error } = await admin
    .from("signal_outcomes")
    .select("signal_id, ticker, direction, entry_price, entry_at, status, price_1d, price_3d, price_5d, price_10d, price_30d")
    .in("status", ["pending", "partial"])
    .order("entry_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rows = (pending ?? []) as OutcomeRow[];
  let updated = 0;
  let finalized = 0;
  let errored = 0;
  const perTicker: Record<string, { processed: number; bars: number | null }> = {};

  // Group by ticker to reuse bar fetches per ticker (still per-signal entry timing).
  // Simple approach: fetch per row but cache by ticker+entry-week to avoid duplicate calls.
  const barCache = new Map<string, Bar[]>();

  for (const row of rows) {
    if (Date.now() - started > MAX_RUNTIME_MS) break;
    const entry = new Date(row.entry_at);
    const cacheKey = `${row.ticker}|${entry.toISOString().slice(0, 10)}`;
    let bars = barCache.get(cacheKey);
    if (!bars) {
      bars = await fetchBars(row.ticker, entry);
      barCache.set(cacheKey, bars);
    }
    perTicker[row.ticker] ??= { processed: 0, bars: bars.length };
    perTicker[row.ticker].processed++;

    const entryPrice = resolveEntryPrice(row.entry_price, bars, entry);
    if (!entryPrice) {
      // Can't compute anything yet — mark errored only if signal is older than 35 days (data gap).
      const ageDays = (Date.now() - entry.getTime()) / 86400000;
      if (ageDays > 35) {
        await admin.from("signal_outcomes").update({
          status: "errored",
          last_error: "no entry price (Alpaca returned no bars in window)",
          last_updated_at: new Date().toISOString(),
        }).eq("signal_id", row.signal_id);
        errored++;
      }
      continue;
    }

    const sign = row.direction === "PUT" ? -1 : 1; // CALL → up is win; PUT → down is win
    const patch: Record<string, unknown> = {
      entry_price: entryPrice,
      last_updated_at: new Date().toISOString(),
      last_error: null,
    };
    let filledCount = 0;
    let allFilled = true;
    for (const w of WINDOWS) {
      const priceKey = `price_${w.key}` as keyof OutcomeRow;
      const existing = row[priceKey] as number | null;
      if (existing != null) { filledCount++; continue; }
      const close = closeAfterDays(bars, entry, w.days);
      if (close == null) { allFilled = false; continue; }
      const ret = (close - entryPrice) / entryPrice;
      const directional = ret * sign;
      patch[`price_${w.key}`] = close;
      patch[`return_${w.key}`] = directional * 100; // percent, signed by direction
      patch[`win_${w.key}`] = directional > 0;
      filledCount++;
    }

    patch.status = allFilled ? "final" : (filledCount > 0 ? "partial" : "pending");
    if (allFilled) finalized++;

    const { error: uErr } = await admin.from("signal_outcomes").update(patch).eq("signal_id", row.signal_id);
    if (uErr) {
      errored++;
      await admin.from("signal_outcomes").update({
        last_error: uErr.message.slice(0, 200),
        last_updated_at: new Date().toISOString(),
      }).eq("signal_id", row.signal_id);
    } else {
      updated++;
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      note: "Phase 2 outcome tracker — Alpaca daily bars, no scoring touched.",
      scanned: rows.length,
      updated, finalized, errored,
      runtime_ms: Date.now() - started,
      per_ticker_summary: perTicker,
    }, null, 2),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
