// POST /functions/v1/update-paper-marks
// Pulls latest Alpaca underlying quotes for all open paper trades and updates marks.
// Auth: admin user OR service-role (for scheduled jobs). Never places orders.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceRole);

    // Auth: allow service-role caller (scheduled), otherwise require admin user.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    const isServiceRole = bearer && bearer === serviceRole;

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

    const alpacaKey = Deno.env.get("ALPACA_API_KEY_ID");
    const alpacaSecret = Deno.env.get("ALPACA_API_SECRET_KEY");
    if (!alpacaKey || !alpacaSecret) {
      return json({ error: "Alpaca credentials missing" }, 500);
    }

    const { data: open, error: oErr } = await admin
      .from("paper_trades").select("*").eq("status", "OPEN");
    if (oErr) return json({ error: oErr.message }, 500);
    if (!open || open.length === 0) {
      return json({ ok: true, updated: 0, tickers: 0, skipped: 0 });
    }

    const tickers = Array.from(new Set(open.map((t: any) => t.ticker))).filter(Boolean);
    const symbols = tickers.join(",");

    // Use Alpaca IEX feed (free tier). Latest trades batch endpoint.
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
      const moveAbs = (mark - entry) * dir;            // signed price move
      const movePct = (moveAbs / entry) * 100;         // %
      const risk = Number(trade.risk_amount ?? 0);
      // Approx position P/L $ using risk_amount as a sizing proxy (× 2 for option leverage).
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

    return json({
      ok: true,
      updated,
      skipped,
      tickers: tickers.length,
      missing_prices: tickers.filter((s) => !priceMap[s.toUpperCase()]),
    });
  } catch (e) {
    console.error("update-paper-marks exception", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
