// POST /functions/v1/refresh-signal-quotes
// Lightweight 30s refresher for LIVE/developing signals.
// Pulls UW option-chain (one call per ticker+expiry) and updates
// signal `premium` (contract mid) for currently-active signal cards.
// Does NOT re-score, does NOT re-rank, does NOT touch paper_trades.
// Market-hours gated for cron triggers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { bumpBudget } from "../_shared/budget.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole);

  const authHeader = req.headers.get("Authorization") ?? "";
  const isServiceRole = authHeader.replace(/^Bearer\s+/i, "") === serviceRole;
  let trigger: "cron" | "manual" = isServiceRole ? "cron" : "manual";
  try {
    const body = req.headers.get("content-length") && Number(req.headers.get("content-length")) > 0
      ? await req.json().catch(() => ({})) : {};
    if (body && typeof body.trigger === "string") trigger = body.trigger === "cron" ? "cron" : "manual";
  } catch { /* ignore */ }

  try {
    if (trigger === "cron" && !isUsMarketOpenNow()) {
      return json({ ok: true, status: "outside_hours", duration_ms: Date.now() - t0 });
    }

    // Pull active developing signals (LIVE status, not expired, with contract info).
    const { data: signals, error: sErr } = await admin
      .from("signals")
      .select("id, ticker, expiry, contract_symbol, strike, direction, premium, price")
      .eq("status", "LIVE")
      .eq("hidden", false)
      .eq("is_demo", false)
      .not("contract_symbol", "is", null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("created_at", { ascending: false })
      .limit(200);

    if (sErr) return json({ error: sErr.message }, 500);
    if (!signals || signals.length === 0) {
      return json({ ok: true, status: "no_active_signals", duration_ms: Date.now() - t0 });
    }

    // Group by (ticker, expiry) so we make one UW chain call per group.
    const groups = new Map<string, { ticker: string; expiry: string; signals: typeof signals }>();
    for (const s of signals) {
      if (!s.ticker || !s.expiry) continue;
      const key = `${String(s.ticker).toUpperCase()}|${s.expiry}`;
      const g = groups.get(key);
      if (g) g.signals.push(s);
      else groups.set(key, { ticker: String(s.ticker).toUpperCase(), expiry: String(s.expiry), signals: [s] });
    }

    const uwKey = Deno.env.get("UNUSUAL_WHALES_API_KEY");
    if (!uwKey) return json({ ok: false, status: "no_uw_key" }, 200);

    let updated = 0;
    let skipped = 0;
    let underlying_updates = 0;

    await Promise.all(Array.from(groups.values()).map(async (group) => {
      // Budget guard — one call per group.
      const budget = await bumpBudget(admin, "unusual_whales", 1);
      if (!budget.allowed) { skipped += group.signals.length; return; }

      const url = `https://api.unusualwhales.com/api/stock/${encodeURIComponent(group.ticker)}/option-contracts?expiry=${group.expiry}&limit=500`;
      let rows: any[] = [];
      let underlyingPrice: number | null = null;
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${uwKey}`, Accept: "application/json" } });
        if (!res.ok) { skipped += group.signals.length; return; }
        const j = await res.json().catch(() => null) as any;
        rows = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
        // UW often surfaces underlying spot on each row — sample the first one.
        const first = rows[0];
        if (first) underlyingPrice = num(first.underlying_price ?? first.stock_price ?? first.spot_price);
      } catch {
        skipped += group.signals.length;
        return;
      }

      const bySym = new Map<string, any>();
      for (const r of rows) {
        const sym = String(r.option_symbol ?? "").trim().toUpperCase();
        if (sym) bySym.set(sym, r);
      }

      for (const s of group.signals) {
        const occ = String(s.contract_symbol ?? "").trim().toUpperCase();
        const row = bySym.get(occ);
        if (!row) { skipped++; continue; }
        const bid = num(row.nbbo_bid ?? row.bid);
        const ask = num(row.nbbo_ask ?? row.ask);
        const lastPx = num(row.last_price ?? row.last ?? row.mark);
        const mid = bid != null && ask != null ? (bid + ask) / 2 : num(row.mid);
        const premium = mid ?? lastPx ?? bid ?? ask;
        if (premium == null || !Number.isFinite(premium)) { skipped++; continue; }

        const patch: Record<string, unknown> = { premium: round2(premium) };
        if (underlyingPrice != null && Number.isFinite(underlyingPrice)) {
          patch.price = round2(underlyingPrice);
        }
        const { error: uErr } = await admin.from("signals").update(patch).eq("id", s.id);
        if (uErr) { skipped++; continue; }
        updated++;
        if (patch.price != null) underlying_updates++;
      }
    }));

    return json({
      ok: true,
      status: "ok",
      groups: groups.size,
      signals_seen: signals.length,
      updated,
      skipped,
      underlying_updates,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("refresh-signal-quotes exception", e);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function num(x: unknown): number | null {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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
