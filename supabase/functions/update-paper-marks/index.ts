// POST /functions/v1/update-paper-marks
// Updates marks for open paper option trades.
//
// Quote source priority (per approved plan):
//   1. Tradier        (if TRADIER_API_KEY secret exists)
//   2. Unusual Whales (option contract endpoint)
//   3. Alpaca         (option snapshot)
//   4. unavailable    — pricing skipped, no P/L written, never faked.
//
// Computes Robinhood-style option P/L:
//   total_cost      = entry_premium × 100 × contracts
//   current_value   = current_premium × 100 × contracts
//   unrealized_pl   = current_value − total_cost
//   unrealized_pl%  = unrealized_pl / total_cost × 100
//   day_pl          = (current_premium − day_open_premium) × 100 × contracts
//
// Auth: admin user OR service-role (scheduled). Never places orders. Never auto-closes.
// Market-hours gated to America/New_York, Mon-Fri, 09:30-16:00 for cron triggers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RunStatus = "ok" | "outside_hours" | "disabled" | "error" | "no_open_trades";

type OptionQuote = {
  premium: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  open_interest: number | null;
  option_volume: number | null;
  source: "tradier" | "unusual_whales" | "alpaca" | "unavailable";
};

const EMPTY_QUOTE: OptionQuote = {
  premium: null, bid: null, ask: null, mid: null, iv: null,
  delta: null, gamma: null, theta: null, vega: null,
  open_interest: null, option_volume: null, source: "unavailable",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const isServiceRole = bearer && bearer === serviceRole;
  let trigger: "cron" | "manual" = isServiceRole ? "cron" : "manual";
  try {
    const body = req.headers.get("content-length") && Number(req.headers.get("content-length")) > 0
      ? await req.json().catch(() => ({})) : {};
    if (body && typeof body.trigger === "string") trigger = body.trigger === "cron" ? "cron" : "manual";
  } catch { /* ignore */ }

  async function logRun(
    status: RunStatus,
    extra: { updated_count?: number; skipped_count?: number; missing_prices?: string[]; error?: string | null } = {},
  ) {
    try {
      await admin.from("mark_engine_runs").insert({
        status,
        updated_count: extra.updated_count ?? 0,
        skipped_count: extra.skipped_count ?? 0,
        missing_prices: extra.missing_prices ?? [],
        error: extra.error ?? null,
        trigger,
        duration_ms: Date.now() - t0,
      });
    } catch (e) {
      console.error("mark_engine_runs insert failed", e);
    }
  }

  try {
    if (!isServiceRole && trigger !== "cron") {
      if (!authHeader) return json({ error: "Unauthorized" }, 401);
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data: ud } = await userClient.auth.getUser();
      const user = ud?.user;
      if (!user) return json({ error: "Unauthorized" }, 401);
      const { data: roleRow } = await admin
        .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
      if (!roleRow) return json({ error: "Admin only" }, 403);
    }

    const { data: cfg } = await admin
      .from("mark_engine_config").select("enabled").eq("id", "global").maybeSingle();
    if (cfg && cfg.enabled === false) {
      await logRun("disabled");
      return json({ ok: true, status: "disabled" });
    }

    if (trigger === "cron" && !isUsMarketOpenNow()) {
      await logRun("outside_hours");
      return json({ ok: true, status: "outside_hours" });
    }

    const { data: open, error: oErr } = await admin
      .from("paper_trades").select("*").eq("status", "OPEN");
    if (oErr) {
      await logRun("error", { error: oErr.message });
      return json({ error: oErr.message }, 500);
    }
    if (!open || open.length === 0) {
      await logRun("no_open_trades");
      return json({ ok: true, status: "no_open_trades", updated: 0, skipped: 0 });
    }

    const now = new Date().toISOString();
    const todayNY = nyDateString();
    let updated = 0;
    let skipped = 0;
    const unavailable: string[] = [];

    for (const trade of open) {
      // Only handle option trades here; non-option rows (none today) get skipped.
      if (trade.is_option === false) { skipped++; continue; }

      const occ = resolveOccSymbol(trade);
      if (!occ) {
        unavailable.push(`${trade.ticker} (no contract symbol)`);
        await admin.from("paper_trades").update({
          quote_source: "unavailable",
          quote_updated_at: now,
        }).eq("id", trade.id);
        skipped++;
        continue;
      }

      const quote = await fetchOptionQuote(occ, trade.ticker);
      if (quote.source === "unavailable" || quote.premium == null || !Number.isFinite(quote.premium)) {
        unavailable.push(`${trade.ticker} ${occ}`);
        await admin.from("paper_trades").update({
          quote_source: "unavailable",
          quote_updated_at: now,
        }).eq("id", trade.id);
        skipped++;
        continue;
      }

      const contracts = Math.max(1, Number(trade.contracts ?? 1));
      const multiplier = Number(trade.multiplier ?? 100);
      const entryPremium = Number(trade.entry_premium ?? trade.entry_price ?? 0);
      if (!entryPremium || !Number.isFinite(entryPremium)) {
        skipped++;
        continue;
      }

      const currentPremium = Number(quote.premium);
      const totalCost = entryPremium * multiplier * contracts;
      const currentValue = currentPremium * multiplier * contracts;
      const unrealizedPl = currentValue - totalCost;
      const unrealizedPlPct = totalCost > 0 ? (unrealizedPl / totalCost) * 100 : 0;

      // Day P/L: snapshot day_open_premium on first mark of the NY trading day.
      const sameDay = trade.day_open_date === todayNY && trade.day_open_premium != null;
      const dayOpenPremium = sameDay ? Number(trade.day_open_premium) : currentPremium;
      const dayPl = (currentPremium - dayOpenPremium) * multiplier * contracts;
      const dayPlPct = dayOpenPremium > 0 ? ((currentPremium - dayOpenPremium) / dayOpenPremium) * 100 : 0;

      // MFE/MAE based on unrealized P/L $.
      const prevMfe = trade.mfe == null ? -Infinity : Number(trade.mfe);
      const prevMae = trade.mae == null ?  Infinity : Number(trade.mae);
      const mfe = Math.max(prevMfe, unrealizedPl);
      const mae = Math.min(prevMae, unrealizedPl);

      const patch: Record<string, unknown> = {
        current_premium: round2(currentPremium),
        current_value: round2(currentValue),
        unrealized_pl: round2(unrealizedPl),
        unrealized_pl_pct: round2(unrealizedPlPct),
        day_pl: round2(dayPl),
        day_pl_pct: round2(dayPlPct),
        bid: quote.bid != null ? round2(quote.bid) : null,
        ask: quote.ask != null ? round2(quote.ask) : null,
        mid: quote.mid != null ? round2(quote.mid) : null,
        iv: quote.iv,
        delta: quote.delta,
        gamma: quote.gamma,
        theta: quote.theta,
        vega: quote.vega,
        open_interest: quote.open_interest,
        option_volume: quote.option_volume,
        quote_source: quote.source,
        quote_updated_at: now,
        // Mirror to legacy fields so existing UI/analytics keep working.
        current_pl: round2(unrealizedPl),
        current_pl_pct: round2(unrealizedPlPct),
        last_mark_price: round2(currentPremium),
        last_mark_at: now,
        mark_source: quote.source,
        mfe: round2(mfe),
        mae: round2(mae),
        max_gain: round2(Math.abs(mfe > 0 ? mfe : 0)),
        max_drawdown: round2(Math.abs(mae < 0 ? mae : 0)),
      };
      if (!sameDay) {
        patch.day_open_premium = round2(currentPremium);
        patch.day_open_date = todayNY;
        patch.day_pl = 0;
        patch.day_pl_pct = 0;
      }

      const { error: uErr } = await admin.from("paper_trades").update(patch).eq("id", trade.id);
      if (uErr) { console.error("update failed", trade.id, uErr); skipped++; continue; }
      updated++;
    }

    await logRun("ok", { updated_count: updated, skipped_count: skipped, missing_prices: unavailable });
    return json({ ok: true, status: "ok", updated, skipped, unavailable });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("update-paper-marks exception", e);
    await logRun("error", { error: msg });
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function nyDateString(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d); // YYYY-MM-DD
}

function isUsMarketOpenNow(d: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  if (["Sat", "Sun"].includes(weekday)) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// ---------- OCC option symbol resolution ----------

// Builds an OCC option symbol e.g. NVDA250620C00190000 from trade fields, or
// returns whatever already-formed symbol the trade carries.
function resolveOccSymbol(trade: any): string | null {
  const raw = String(trade.contract_idea ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (/^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(raw)) return raw;

  const ticker = String(trade.ticker ?? "").trim().toUpperCase();
  const strike = trade.strike != null ? Number(trade.strike) : null;
  const expiry = trade.expiry as string | null;
  const optType = String(trade.option_type ?? trade.direction ?? "").trim().toUpperCase();
  if (!ticker || strike == null || !Number.isFinite(strike) || !expiry || !["CALL", "PUT"].includes(optType)) return null;

  const yymmdd = expiry.replace(/-/g, "").slice(2); // YYYY-MM-DD -> YYMMDD
  const cp = optType === "CALL" ? "C" : "P";
  const strikeInt = Math.round(strike * 1000).toString().padStart(8, "0");
  return `${ticker}${yymmdd}${cp}${strikeInt}`;
}

// ---------- Provider fetchers ----------

async function fetchOptionQuote(occ: string, underlying: string): Promise<OptionQuote> {
  // Unusual Whales is the sole real-time source. Tradier/Alpaca have been
  // removed per product decision — UW NBBO snapshot (sub-second) with an
  // intraday-minute fallback covers our needs and avoids "delayed" tags.
  const uw = await fetchUnusualWhalesQuote(occ, underlying).catch((e) => { console.warn("uw err", occ, e); return null; });
  if (uw && uw.premium != null) return uw;
  console.log("quote unavailable", { occ, reason: uw ? "no_premium_in_response" : "uw_returned_null" });
  return EMPTY_QUOTE;
}

async function fetchTradierQuote(occ: string): Promise<OptionQuote | null> {
  const key = Deno.env.get("TRADIER_API_KEY");
  if (!key) return null;
  const base = Deno.env.get("TRADIER_BASE_URL") ?? "https://api.tradier.com/v1";
  const url = `${base}/markets/quotes?symbols=${encodeURIComponent(occ)}&greeks=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null) as any;
  const q = data?.quotes?.quote;
  if (!q) return null;
  const bid = num(q.bid);
  const ask = num(q.ask);
  const last = num(q.last);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const premium = mid ?? last ?? bid ?? ask;
  return {
    premium, bid, ask, mid,
    iv: num(q.greeks?.mid_iv ?? q.greeks?.smv_vol),
    delta: num(q.greeks?.delta),
    gamma: num(q.greeks?.gamma),
    theta: num(q.greeks?.theta),
    vega: num(q.greeks?.vega),
    open_interest: numInt(q.open_interest),
    option_volume: numInt(q.volume),
    source: "tradier",
  };
}

async function fetchUnusualWhalesQuote(occ: string, _underlying: string): Promise<OptionQuote | null> {
  const key = Deno.env.get("UNUSUAL_WHALES_API_KEY");
  if (!key) { console.warn("uw key missing"); return null; }
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };

  // 1) Try the live NBBO snapshot first — freshest tick UW exposes (sub-second).
  try {
    const snapUrl = `https://api.unusualwhales.com/api/option-contract/${encodeURIComponent(occ)}/nbbo`;
    const r = await fetch(snapUrl, { headers });
    if (!r.ok) {
      console.log("uw nbbo non-ok", { occ, status: r.status });
    } else {
      const j = await r.json().catch(() => null) as any;
      const row = Array.isArray(j?.data) ? j.data[j.data.length - 1] : (j?.data ?? null);
      if (!row) {
        console.log("uw nbbo empty", { occ });
      } else {
        const bid = num(row.bid);
        const ask = num(row.ask);
        const lastPx = num(row.last ?? row.price);
        const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
        const premium = mid ?? lastPx ?? bid ?? ask;
        if (premium != null) {
          return {
            premium, bid, ask, mid,
            iv: num(row.iv ?? row.implied_volatility),
            delta: num(row.delta), gamma: num(row.gamma),
            theta: num(row.theta), vega: num(row.vega),
            open_interest: numInt(row.open_interest ?? row.oi),
            option_volume: numInt(row.volume),
            source: "unusual_whales",
          };
        }
        console.log("uw nbbo no premium", { occ, bid, ask, lastPx });
      }
    }
  } catch (e) { console.warn("uw nbbo err", occ, e); }

  // 2) Fallback to intraday minute aggregates — last entry = most recent minute.
  const url = `https://api.unusualwhales.com/api/option-contract/${encodeURIComponent(occ)}/intraday`;
  const res = await fetch(url, { headers });
  if (!res.ok) { console.log("uw intraday non-ok", { occ, status: res.status }); return null; }
  const json = await res.json().catch(() => null) as any;
  const arr: any[] = Array.isArray(json?.data) ? json.data : [];
  const last = arr.length ? arr[arr.length - 1] : null;
  if (!last) { console.log("uw intraday empty", { occ }); return null; }
  const bid = num(last.bid);
  const ask = num(last.ask);
  const lastPx = num(last.last ?? last.price);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const premium = lastPx ?? mid ?? bid ?? ask;
  if (premium == null) { console.log("uw intraday no premium", { occ, bid, ask, lastPx }); return null; }
  return {
    premium, bid, ask, mid,
    iv: num(last.iv ?? last.implied_volatility),
    delta: num(last.delta),
    gamma: num(last.gamma),
    theta: num(last.theta),
    vega: num(last.vega),
    open_interest: numInt(last.open_interest ?? last.oi),
    option_volume: numInt(last.volume),
    source: "unusual_whales",
  };
}

async function fetchAlpacaOptionSnapshot(occ: string): Promise<OptionQuote | null> {
  const key = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!key || !secret) return null;
  const url = `https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(occ)}`;
  const res = await fetch(url, {
    headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null) as any;
  const snap = json?.snapshot ?? json;
  if (!snap) return null;
  const bid = num(snap.latestQuote?.bp);
  const ask = num(snap.latestQuote?.ap);
  const last = num(snap.latestTrade?.p);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const premium = mid ?? last ?? bid ?? ask;
  if (premium == null) return null;
  return {
    premium, bid, ask, mid,
    iv: num(snap.impliedVolatility ?? snap.greeks?.iv),
    delta: num(snap.greeks?.delta),
    gamma: num(snap.greeks?.gamma),
    theta: num(snap.greeks?.theta),
    vega: num(snap.greeks?.vega),
    open_interest: numInt(snap.openInterest),
    option_volume: numInt(snap.dailyBar?.v ?? snap.minuteBar?.v),
    source: "alpaca",
  };
}

function num(x: unknown): number | null {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function numInt(x: unknown): number | null {
  const n = num(x);
  return n == null ? null : Math.round(n);
}
