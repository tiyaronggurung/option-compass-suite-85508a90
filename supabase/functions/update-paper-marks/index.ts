// POST /functions/v1/update-paper-marks
// Pulls latest Alpaca underlying quotes for open paper trades and updates marks.
// Auth: admin user OR service-role (scheduled). Never places orders. Never auto-closes.
// Market-hours gated to America/New_York, Mon-Fri, 09:30-16:00.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RunStatus = "ok" | "outside_hours" | "disabled" | "error" | "no_open_trades";

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

  // Decide trigger source from caller.
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
    extra: {
      updated_count?: number;
      skipped_count?: number;
      missing_prices?: string[];
      error?: string | null;
    } = {},
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
    // Auth
    if (!isServiceRole) {
      if (!authHeader) {
        return json({ error: "Unauthorized" }, 401);
      }
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: ud } = await userClient.auth.getUser();
      const user = ud?.user;
      if (!user) return json({ error: "Unauthorized" }, 401);
      const { data: roleRow } = await admin
        .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
      if (!roleRow) return json({ error: "Admin only" }, 403);
    }

    // Engine config gate
    const { data: cfg } = await admin
      .from("mark_engine_config").select("enabled").eq("id", "global").maybeSingle();
    if (cfg && cfg.enabled === false) {
      await logRun("disabled");
      return json({ ok: true, status: "disabled" });
    }

    // Market hours gate: America/New_York, Mon-Fri, 09:30-16:00. Cron runs are gated;
    // manual admin runs bypass the gate so admins can refresh anytime.
    if (trigger === "cron" && !isUsMarketOpenNow()) {
      await logRun("outside_hours");
      return json({ ok: true, status: "outside_hours" });
    }

    const alpacaKey = Deno.env.get("ALPACA_API_KEY_ID");
    const alpacaSecret = Deno.env.get("ALPACA_API_SECRET_KEY");
    if (!alpacaKey || !alpacaSecret) {
      await logRun("error", { error: "Alpaca credentials missing" });
      return json({ error: "Alpaca credentials missing" }, 500);
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

    const tickers = Array.from(new Set(open.map((t: any) => t.ticker))).filter(Boolean);
    const symbols = tickers.join(",");

    const url = `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${encodeURIComponent(symbols)}&feed=iex`;
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": alpacaKey,
        "APCA-API-SECRET-KEY": alpacaSecret,
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("alpaca error", res.status, txt);
      await logRun("error", { error: `Alpaca ${res.status}: ${txt.slice(0, 500)}` });
      return json({ error: "Alpaca request failed", status: res.status, detail: txt }, 502);
    }
    const payload = await res.json();
    const priceMap: Record<string, number> = {};
    const tradesObj = payload?.trades ?? {};
    for (const [sym, t] of Object.entries<any>(tradesObj)) {
      if (t && typeof t.p === "number") priceMap[sym.toUpperCase()] = t.p;
    }

    const now = new Date().toISOString();
    let updated = 0;
    let skipped = 0;

    for (const trade of open) {
      const sym = String(trade.ticker).toUpperCase();
      const mark = priceMap[sym];
      const entry = Number(trade.entry_price ?? 0);
      if (!mark || !entry || Number.isNaN(entry)) { skipped++; continue; }

      const dir = trade.direction === "CALL" ? 1 : -1;
      const moveAbs = (mark - entry) * dir;
      const movePct = (moveAbs / entry) * 100;
      const risk = Number(trade.risk_amount ?? 0);
      const currentPl = risk > 0 ? (moveAbs / entry) * risk * 2 : moveAbs;

      const prevMfe = trade.mfe == null ? -Infinity : Number(trade.mfe);
      const prevMae = trade.mae == null ?  Infinity : Number(trade.mae);
      const mfe = Math.max(prevMfe, moveAbs);
      const mae = Math.min(prevMae, moveAbs);

      const { error: uErr } = await admin
        .from("paper_trades").update({
          current_pl: Number(currentPl.toFixed(2)),
          current_pl_pct: Number(movePct.toFixed(2)),
          last_mark_price: mark,
          last_mark_at: now,
          mark_source: "alpaca",
          mfe: Number(mfe.toFixed(2)),
          mae: Number(mae.toFixed(2)),
          max_gain: Math.abs(mfe > 0 ? mfe : 0),
          max_drawdown: Math.abs(mae < 0 ? mae : 0),
        })
        .eq("id", trade.id);
      if (uErr) { console.error("update failed", trade.id, uErr); skipped++; continue; }
      updated++;
    }

    const missing = tickers.filter((s) => !priceMap[s.toUpperCase()]);
    await logRun("ok", { updated_count: updated, skipped_count: skipped, missing_prices: missing });

    return json({
      ok: true,
      status: "ok",
      updated,
      skipped,
      tickers: tickers.length,
      missing_prices: missing,
    });
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

// Returns true if America/New_York wall-clock is Mon-Fri and within [09:30, 16:00).
// Uses Intl to avoid hardcoding DST offsets.
function isUsMarketOpenNow(d: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday"); // Mon, Tue, ...
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  if (["Sat", "Sun"].includes(weekday)) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
