// POST /functions/v1/auto-exit-engine
// Evaluates user-defined auto-exit rules against OPEN paper option trades and
// closes them when a rule fires. Opt-in per user; defaults are disabled.
//
// Auth: service-role (cron) OR admin user (manual). The engine never closes a
// trade owned by another user without their `auto_exit_rules.enabled = true`.
//
// Market-hours gated (Mon-Fri 09:30-16:00 America/New_York) when triggered by cron.
// Honors `risk_settings.kill_switch` per user.
// Dry-run mode: logs intended actions to mark_engine_runs without modifying trades.
//
// Rules evaluated in priority order (first match wins):
//   1. stop_loss_pct   - close when unrealized_pl_pct <= threshold
//   2. take_profit_pct - close when unrealized_pl_pct >= threshold
//   3. trailing_stop_pct - close when peak-pullback >= threshold (in profit only)
//   4. time_exit_et    - close at ET time (DTE <= 0 only)
//   5. theta_burn_pct  - close when |theta|/current_premium >= threshold/day

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FiredRule = "stop_loss" | "take_profit" | "trailing_stop" | "time_exit" | "theta_burn";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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
    status: "ok" | "outside_hours" | "no_rules" | "error",
    extra: { updated_count?: number; skipped_count?: number; missing_prices?: string[]; error?: string | null } = {},
  ) {
    try {
      await admin.from("mark_engine_runs").insert({
        status: `auto_exit:${status}`,
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
    // Manual path requires admin user.
    if (!isServiceRole && trigger !== "cron") {
      if (!authHeader) return json({ error: "Unauthorized" }, 401);
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data: ud } = await userClient.auth.getUser();
      const user = ud?.user;
      if (!user) return json({ error: "Unauthorized" }, 401);
      const { data: roleRow } = await admin
        .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
      if (!roleRow) return json({ error: "admin only" }, 403);
    }

    if (trigger === "cron" && !isUsMarketOpenNow()) {
      await logRun("outside_hours");
      return json({ ok: true, status: "outside_hours" });
    }

    // Load enabled rules
    const { data: rulesRows, error: rErr } = await admin
      .from("auto_exit_rules")
      .select("*")
      .eq("enabled", true);
    if (rErr) {
      await logRun("error", { error: rErr.message });
      return json({ error: rErr.message }, 500);
    }
    if (!rulesRows || rulesRows.length === 0) {
      await logRun("no_rules");
      return json({ ok: true, status: "no_rules" });
    }

    let closed = 0;
    let scanned = 0;
    const actions: Array<{ trade_id: string; rule: FiredRule; dry_run: boolean }> = [];

    for (const rules of rulesRows) {
      const userId = rules.user_id as string;

      // Honor kill switch
      const { data: rs } = await admin.from("risk_settings").select("kill_switch").eq("user_id", userId).maybeSingle();
      if (rs?.kill_switch) continue;

      const { data: open } = await admin
        .from("paper_trades")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "OPEN");
      if (!open || open.length === 0) continue;

      for (const trade of open) {
        scanned++;
        if (trade.is_option === false) continue;

        const currentPremium = numOrNull(trade.current_premium);
        const entryPremium = numOrNull(trade.entry_premium ?? trade.entry_price);
        if (currentPremium == null || entryPremium == null || entryPremium <= 0) continue;

        // Update trailing peak
        const prevPeak = numOrNull(trade.auto_exit_peak_premium);
        const newPeak = prevPeak == null ? currentPremium : Math.max(prevPeak, currentPremium);
        if (prevPeak == null || newPeak > prevPeak) {
          await admin.from("paper_trades")
            .update({ auto_exit_peak_premium: newPeak })
            .eq("id", trade.id);
        }

        const plPct = numOrNull(trade.unrealized_pl_pct ?? trade.current_pl_pct) ?? 0;
        const dte = dteFromExpiry(trade.expiry);
        const theta = numOrNull(trade.theta);

        const fired = evaluateRules({
          rules,
          plPct,
          currentPremium,
          peakPremium: newPeak,
          dte,
          theta,
        });

        // Show armed badge: pick the closest rule to firing (priority order, just label whichever is configured first)
        const armed = pickArmedRuleLabel(rules);
        if (armed && trade.auto_exit_armed_rule !== armed) {
          await admin.from("paper_trades")
            .update({ auto_exit_armed_rule: armed })
            .eq("id", trade.id);
        }

        if (!fired) continue;

        actions.push({ trade_id: trade.id, rule: fired, dry_run: !!rules.dry_run });

        if (rules.dry_run) {
          console.log("auto-exit DRY-RUN", { user: userId, trade: trade.id, rule: fired, plPct });
          continue;
        }

        // Close: mirrors manual-close pattern in src/pages/Trades.tsx
        const multiplier = Number(trade.multiplier ?? 100);
        const contracts = Math.max(1, Number(trade.contracts ?? 1));
        const exitPremium = currentPremium;
        const totalCost = entryPremium * multiplier * contracts;
        const realizedPl = (exitPremium - entryPremium) * multiplier * contracts;
        const realizedPlPct = totalCost > 0 ? (realizedPl / totalCost) * 100 : 0;
        const status = realizedPl > 0 ? "WIN" : realizedPl < 0 ? "LOSS" : "CLOSED";
        const exitReason = fired === "stop_loss" ? "stop_hit"
          : fired === "take_profit" ? "target_hit"
          : "manual";

        // Idempotent: only update if still OPEN
        const { error: uErr, data: updated } = await admin
          .from("paper_trades")
          .update({
            status,
            exit_premium: round4(exitPremium),
            exit_price: round4(exitPremium),
            realized_pl: round2(realizedPl),
            realized_pl_dollars: round2(realizedPl),
            realized_pl_pct: round2(realizedPlPct),
            current_pl: round2(realizedPl),
            current_pl_pct: round2(realizedPlPct),
            current_premium: round4(exitPremium),
            current_value: round2(exitPremium * multiplier * contracts),
            unrealized_pl: round2(realizedPl),
            unrealized_pl_pct: round2(realizedPlPct),
            exit_reason: exitReason,
            closed_at: new Date().toISOString(),
            auto_exit_closed_by: fired,
          })
          .eq("id", trade.id)
          .eq("status", "OPEN")
          .select("id");
        if (uErr) {
          console.error("auto-exit close failed", trade.id, uErr);
          continue;
        }
        if (updated && updated.length > 0) closed++;
      }
    }

    await logRun("ok", { updated_count: closed, skipped_count: scanned - closed });
    return json({ ok: true, status: "ok", scanned, closed, actions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("auto-exit-engine exception", e);
    await logRun("error", { error: msg });
    return json({ error: msg }, 500);
  }
});

function evaluateRules(args: {
  rules: any;
  plPct: number;
  currentPremium: number;
  peakPremium: number;
  dte: number | null;
  theta: number | null;
}): FiredRule | null {
  const { rules, plPct, currentPremium, peakPremium, dte, theta } = args;

  if (rules.stop_loss_pct != null && plPct <= Number(rules.stop_loss_pct)) return "stop_loss";
  if (rules.take_profit_pct != null && plPct >= Number(rules.take_profit_pct)) return "take_profit";

  if (rules.trailing_stop_pct != null && peakPremium > 0 && plPct > 0) {
    const pullback = ((peakPremium - currentPremium) / peakPremium) * 100;
    if (pullback >= Number(rules.trailing_stop_pct)) return "trailing_stop";
  }

  if (rules.time_exit_et && dte != null && dte <= 0) {
    const nowMin = nyMinutesNow();
    const [hh, mm] = String(rules.time_exit_et).split(":").map((x: string) => parseInt(x, 10));
    if (Number.isFinite(hh) && Number.isFinite(mm)) {
      if (nowMin >= hh * 60 + mm) return "time_exit";
    }
  }

  if (rules.theta_burn_pct != null && theta != null && currentPremium > 0) {
    const burn = Math.abs(theta) / currentPremium;
    if (burn >= Number(rules.theta_burn_pct)) return "theta_burn";
  }

  return null;
}

function pickArmedRuleLabel(rules: any): string | null {
  if (rules.stop_loss_pct != null) return "stop_loss";
  if (rules.take_profit_pct != null) return "take_profit";
  if (rules.trailing_stop_pct != null) return "trailing_stop";
  if (rules.time_exit_et) return "time_exit";
  if (rules.theta_burn_pct != null) return "theta_burn";
  return null;
}

function dteFromExpiry(expiry: string | null | undefined): number | null {
  if (!expiry) return null;
  const [y, m, d] = String(expiry).split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  const exp = new Date(Date.UTC(y, m - 1, d, 21, 0, 0));
  const ms = exp.getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n: number) { return Math.round(n * 100) / 100; }
function round4(n: number) { return Math.round(n * 10000) / 10000; }
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function nyMinutesNow(d: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
}
function isUsMarketOpenNow(d: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  if (["Sat", "Sun"].includes(weekday)) return false;
  const mins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
