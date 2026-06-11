// POST /functions/v1/auto-entry-engine
// Whitelist-only auto-entry for paper option trades. For each user with rules
// enabled, looks at fresh signals on whitelisted tickers, applies filters,
// and auto-buys the contract that the signal already carries (strike/expiry/
// premium). Mirrors the manual Buy dialog's paper_trades insert shape.
//
// Defaults: every user starts disabled with dry_run=true. Engine only ACTS
// when user flips both enabled=true AND dry_run=false.
//
// Idempotency: UNIQUE(user_id, signal_id) on auto_entry_log prevents the
// same signal from ever being acted on twice for the same user.
//
// Safety: market-hours, risk_settings (kill switch, max open, daily loss),
// daily caps, cooldowns, open-position de-dup.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TIER_RANK: Record<string, number> = { ELITE: 3, GOLD: 2, SILVER: 1 };

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

  async function logRun(status: string, extra: Record<string, unknown> = {}) {
    try {
      await admin.from("mark_engine_runs").insert({
        status: `auto_entry:${status}`,
        updated_count: Number(extra.fired ?? 0),
        skipped_count: Number(extra.skipped ?? 0),
        missing_prices: [],
        error: extra.error as string | null ?? null,
        trigger,
        duration_ms: Date.now() - t0,
      });
    } catch (e) { console.error("log insert failed", e); }
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
      if (!roleRow) return json({ error: "admin only" }, 403);
    }

    if (trigger === "cron" && !isUsMarketOpenNow()) {
      await logRun("outside_hours");
      return json({ ok: true, status: "outside_hours" });
    }

    const { data: rulesRows, error: rErr } = await admin
      .from("auto_entry_rules").select("*").eq("enabled", true);
    if (rErr) {
      await logRun("error", { error: rErr.message });
      return json({ error: rErr.message }, 500);
    }
    if (!rulesRows || rulesRows.length === 0) {
      await logRun("no_rules");
      return json({ ok: true, status: "no_rules" });
    }

    let scanned = 0, fired = 0, dryRun = 0, skipped = 0;

    // ── Cycle-level macro snapshot (once, used by macro_headwind hard override) ──
    const { data: macroSnap } = await admin
      .from("macro_regime_snapshots")
      .select("captured_at, macro_tailwind_score")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    let macroScore: number | null = null;
    let macroStale = true;
    let macroAgeMin: number | null = null;
    if (macroSnap?.captured_at) {
      macroAgeMin = (Date.now() - new Date(macroSnap.captured_at).getTime()) / 60_000;
      macroStale = macroAgeMin > 30;
      if (!macroStale) macroScore = numOrNull(macroSnap.macro_tailwind_score);
    }
    if (macroStale) {
      // One system row per cycle — paper trail, NOT per-signal.
      await admin.from("trade_entry_decisions").insert({
        user_id: null, signal_id: null, ticker: null,
        action: "system", hard_trigger: "macro_stale",
        reason_string: "Macro snapshot stale or missing; headwind check skipped this cycle.",
        macro_score: null, signal_confidence: null, fallback_count: null,
        dry_run: false,
        context: { snapshot_age_min: macroAgeMin, has_snapshot: !!macroSnap },
      });
    }


    for (const rules of rulesRows) {
      const userId = rules.user_id as string;

      // Whitelist
      const { data: wl } = await admin
        .from("auto_entry_whitelist").select("ticker").eq("user_id", userId);
      const whitelist = new Set((wl ?? []).map((r: any) => String(r.ticker).toUpperCase()));
      if (whitelist.size === 0) continue;

      // Risk settings
      const { data: rs } = await admin
        .from("risk_settings").select("*").eq("user_id", userId).maybeSingle();
      if (rs?.kill_switch) continue;

      // Time-of-day window
      if (!withinTimeWindow(rules.start_time_et, rules.end_time_et)) continue;

      // Current open trades
      const { data: openTrades } = await admin
        .from("paper_trades").select("id, ticker").eq("user_id", userId).eq("status", "OPEN");
      const openCount = openTrades?.length ?? 0;
      const openTickers = new Set((openTrades ?? []).map((t: any) => String(t.ticker).toUpperCase()));
      if (rs?.max_open_trades != null && openCount >= Number(rs.max_open_trades)) continue;

      // Today's realized P/L + cash
      const todayStartUtc = startOfNyDayUtc();
      const { data: closedToday } = await admin
        .from("paper_trades").select("realized_pl, closed_at, total_cost, opened_at")
        .eq("user_id", userId).neq("status", "OPEN").gte("closed_at", todayStartUtc);
      const todayLoss = (closedToday ?? []).reduce((s: number, t: any) => s + Math.min(0, Number(t.realized_pl ?? 0)), 0);
      if (rs?.daily_loss_cap != null && Math.abs(todayLoss) >= Number(rs.daily_loss_cap)) continue;

      // Daily trade-count + spend caps (use today's auto_entry_log fires + manual opens)
      const { data: firesToday } = await admin
        .from("auto_entry_log").select("status, paper_trade_id, created_at")
        .eq("user_id", userId).eq("status", "fired").gte("created_at", todayStartUtc);
      const firesCount = firesToday?.length ?? 0;
      const tradeIdsToday = (firesToday ?? []).map((r: any) => r.paper_trade_id).filter(Boolean);
      let spendToday = 0;
      if (tradeIdsToday.length > 0) {
        const { data: spendRows } = await admin
          .from("paper_trades").select("total_cost").in("id", tradeIdsToday);
        spendToday = (spendRows ?? []).reduce((s: number, r: any) => s + Number(r.total_cost ?? 0), 0);
      }
      if (firesCount >= Number(rules.max_trades_per_day ?? 5)) continue;
      if (spendToday >= Number(rules.daily_spend_cap_usd ?? 0)) continue;

      // Paper cash balance
      const { data: acct } = await admin
        .from("paper_accounts").select("cash_balance").eq("user_id", userId).maybeSingle();
      const cash = Number(acct?.cash_balance ?? 0);
      if (!Number.isFinite(cash) || cash <= 0) continue;

      // Already-acted signal ids
      const { data: priorLog } = await admin
        .from("auto_entry_log").select("signal_id").eq("user_id", userId);
      const priorIds = new Set((priorLog ?? []).map((r: any) => r.signal_id).filter(Boolean));

      // Candidate signals: fresh, not hidden, not demo, ticker in whitelist
      const ageMin = Number(rules.max_signal_age_minutes ?? 5);
      const sinceIso = new Date(Date.now() - ageMin * 60_000).toISOString();
      const { data: sigs } = await admin
        .from("signals").select("*")
        .gte("created_at", sinceIso)
        .eq("is_demo", false)
        .neq("hidden", true)
        .in("ticker", Array.from(whitelist));
      if (!sigs || sigs.length === 0) continue;

      // Loss streak (any closed loss today on the ticker — manual or auto, cause-agnostic)
      const { data: closedTodayDetail } = await admin
        .from("paper_trades").select("ticker, realized_pl")
        .eq("user_id", userId).neq("status", "OPEN").gte("closed_at", todayStartUtc);
      const lossCountByTicker = new Map<string, number>();
      for (const t of closedTodayDetail ?? []) {
        if (Number((t as any).realized_pl ?? 0) < 0) {
          const k = String((t as any).ticker ?? "").toUpperCase();
          if (k) lossCountByTicker.set(k, (lossCountByTicker.get(k) ?? 0) + 1);
        }
      }

      // Earnings today for candidate tickers (NY date)
      const todayNy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
      const candidateTickers = Array.from(new Set(sigs.map((x: any) => String(x.ticker))));
      const { data: erRows } = await admin
        .from("earnings_events").select("ticker, report_date")
        .in("ticker", candidateTickers).eq("report_date", todayNy);
      const earningsToday = new Set((erRows ?? []).map((r: any) => String(r.ticker).toUpperCase()));

      const logDecision = async (
        signal: any,
        action: "enter" | "hold" | "reject",
        hard_trigger: string | null,
        reason: string,
        context: Record<string, unknown> = {},
      ) => {
        try {
          await admin.from("trade_entry_decisions").insert({
            user_id: userId,
            signal_id: signal?.id ?? null,
            ticker: signal?.ticker ?? null,
            action,
            hard_trigger,
            reason_string: reason,
            macro_score: macroScore,
            signal_confidence: signal ? Number(signal.confidence ?? 0) : null,
            fallback_count: signal ? Number((signal as any).fallback_count ?? 0) : null,
            dry_run: !!rules.dry_run,
            context,
          });
        } catch (e) {
          console.error("trade_entry_decisions insert failed", e);
        }
      };



      for (const s of sigs) {
        scanned++;
        if (priorIds.has(s.id)) continue; // idempotency

        const ticker = String(s.ticker).toUpperCase();
        const skip = (reason: string) => {
          skipped++;
          admin.from("auto_entry_log").insert({
            user_id: userId, signal_id: s.id, ticker, status: "skipped",
            skip_reason: reason, rule_snapshot: rules,
          }).then(() => {}, () => {});
        };

        // ── Hard overrides (deterministic vetoes — checked BEFORE soft filters) ──
        // Order: cheapest checks first. Each writes a trade_entry_decisions reject row.
        const fallbackCount = Number((s as any).fallback_count ?? 0);

        // 1) Earnings same day → IV crush window
        if (earningsToday.has(ticker)) {
          await logDecision(s, "reject", "earnings_same_day",
            `Earnings report today on ${ticker} — IV crush window.`);
          skip("hard:earnings_same_day"); continue;
        }

        // 2) Spread emergency (>35% of mid) → unfillable / toxic
        const bidQ = numOrNull((s as any).bid);
        const askQ = numOrNull((s as any).ask);
        if (bidQ != null && askQ != null && bidQ > 0 && askQ > 0) {
          const midQ = (bidQ + askQ) / 2;
          const spreadPct = (askQ - bidQ) / midQ;
          if (spreadPct > 0.12) {
            await logDecision(s, "reject", "spread_emergency",
              `Bid/ask spread ${(spreadPct * 100).toFixed(0)}% of mid.`, { spread_pct: spreadPct });
            skip(`hard:spread_emergency:${spreadPct.toFixed(2)}`); continue;
          }
        }

        // 3) Signal degraded (3+ fallbacks) → don't fire real cash on filler
        if (fallbackCount >= 3) {
          await logDecision(s, "reject", "fallback_count_high",
            `Signal degraded (fallback_count=${fallbackCount}).`, { fallback_count: fallbackCount });
          skip(`hard:fallback_count:${fallbackCount}`); continue;
        }

        // 4) Loss streak on this ticker today (any source, manual or auto)
        const lossesToday = lossCountByTicker.get(ticker) ?? 0;
        if (lossesToday >= 2) {
          await logDecision(s, "reject", "loss_streak",
            `${lossesToday} closed losses on ${ticker} today.`, { losses_today: lossesToday });
          skip(`hard:loss_streak:${lossesToday}`); continue;
        }

        // 5) Macro headwind (only when snapshot is fresh; stale → skip check, not veto)
        if (!macroStale && macroScore != null) {
          const dirU = String(s.direction ?? "").toUpperCase();
          const isCall = !dirU.includes("PUT");
          if ((isCall && macroScore < 35) || (!isCall && macroScore > 65)) {
            await logDecision(s, "reject", "macro_headwind",
              `Macro tailwind ${macroScore.toFixed(2)} opposes ${isCall ? "CALL" : "PUT"}.`,
              { macro_score: macroScore, direction: dirU });
            skip(`hard:macro_headwind:${macroScore.toFixed(2)}`); continue;
          }
        }


        // Filters
        if (rules.min_tier && (TIER_RANK[String(s.tier ?? "").toUpperCase()] ?? 0)
            < (TIER_RANK[String(rules.min_tier).toUpperCase()] ?? 0)) { skip("tier_below_min"); continue; }
        if (rules.min_confidence != null && Number(s.confidence ?? 0) < Number(rules.min_confidence)) { skip("confidence_below_min"); continue; }
        if (Array.isArray(rules.allowed_directions) && rules.allowed_directions.length > 0
            && !rules.allowed_directions.map((d: string) => d.toUpperCase()).includes(String(s.direction ?? "").toUpperCase())) {
          skip("direction_not_allowed"); continue;
        }
        if (rules.block_if_open_on_ticker && openTickers.has(ticker)) { skip("open_on_ticker"); continue; }

        // Cooldown
        const cdMs = Number(rules.cooldown_minutes ?? 30) * 60_000;
        if (cdMs > 0) {
          const cutoff = new Date(Date.now() - cdMs).toISOString();
          const { data: recent } = await admin.from("paper_trades")
            .select("opened_at").eq("user_id", userId).eq("ticker", ticker)
            .gte("opened_at", cutoff).limit(1);
          if (recent && recent.length > 0) { skip("cooldown"); continue; }
        }

        // Resolve contract from signal fields
        const strike = numOrNull(s.strike);
        const expiry = s.expiry ? String(s.expiry) : null;
        const premium = numOrNull(s.premium);
        const optType = String(s.direction ?? "").toUpperCase().includes("PUT") ? "PUT" : "CALL";
        if (strike == null || !expiry || premium == null || premium <= 0) {
          skip("contract_unavailable"); continue;
        }
        if (rules.max_premium_usd != null && premium > Number(rules.max_premium_usd)) { skip("premium_above_max"); continue; }

        // Size: risk cap = min(rule.max_risk_usd, risk_settings.max_risk_per_trade, daily_spend_cap_usd - spendToday)
        const maxRisk = Math.min(
          rules.max_risk_usd != null ? Number(rules.max_risk_usd) : Infinity,
          rs?.max_risk_per_trade != null ? Number(rs.max_risk_per_trade) : Infinity,
          Number(rules.daily_spend_cap_usd ?? Infinity) - spendToday,
          cash - 1, // never use full cash
        );
        if (!Number.isFinite(maxRisk) || maxRisk <= 0) { skip("no_risk_budget"); continue; }
        const multiplier = 100;
        const perContract = premium * multiplier;
        const qty = Math.max(0, Math.floor(maxRisk / perContract));
        if (qty < 1) { skip("size_below_one_contract"); continue; }
        const totalCost = perContract * qty;

        // DRY RUN: log only
        if (rules.dry_run) {
          dryRun++;
          await admin.from("auto_entry_log").insert({
            user_id: userId, signal_id: s.id, ticker, status: "dry_run",
            skip_reason: null, rule_snapshot: { ...rules, planned_qty: qty, planned_cost: totalCost, premium },
          });
          await logDecision(s, "enter", null, "Dry-run: all hard overrides passed; would fire.",
            { planned_qty: qty, planned_cost: totalCost, premium });
          continue;
        }

        // ── Pre-trade sanity layer (Option A) ──
        // Re-validate signal right before committing real paper cash.
        // Blocks stale, withdrawn, or wildly-moved fills. ~1 extra round-trip.
        const { data: fresh, error: freshErr } = await admin
          .from("signals").select("*").eq("id", s.id).maybeSingle();
        if (freshErr || !fresh) { skip("sanity_signal_missing"); continue; }
        if (fresh.hidden === true) { skip("sanity_signal_hidden"); continue; }
        // Age recheck (signal could have aged past window during loop)
        const ageMs = Date.now() - new Date(fresh.created_at).getTime();
        if (ageMs > ageMin * 60_000) { skip("sanity_signal_stale"); continue; }
        // Premium drift: if signal carries a live mid/current price, ensure we
        // aren't sizing against a price that already moved >15% against us.
        const liveMid = numOrNull((fresh as any).current_premium)
          ?? numOrNull((fresh as any).mid)
          ?? numOrNull((fresh as any).last_price);
        if (liveMid != null && liveMid > 0 && premium > 0) {
          const drift = Math.abs(liveMid - premium) / premium;
          if (drift > 0.15) { skip(`sanity_premium_drift:${drift.toFixed(2)}`); continue; }
        }
        // Bid/ask spread sanity: skip if spread > 25% of mid (illiquid).
        const bid = numOrNull((fresh as any).bid);
        const ask = numOrNull((fresh as any).ask);
        if (bid != null && ask != null && bid > 0 && ask > 0) {
          const mid = (bid + ask) / 2;
          const spreadPct = (ask - bid) / mid;
          if (spreadPct > 0.25) { skip(`sanity_spread_wide:${spreadPct.toFixed(2)}`); continue; }
        }

        // LIVE: insert paper_trade then log
        const openedAt = new Date().toISOString();
        const confidenceSnapshot = Number(s.confidence ?? 0);
        const { data: inserted, error: insErr } = await admin.from("paper_trades").insert({
          user_id: userId,
          signal_id: s.id,
          ticker: s.ticker,
          direction: s.direction,
          contract_idea: s.contract_symbol,
          entry_price: premium,
          stop_idea: premium * 0.6,
          target_idea: premium * 1.8,
          risk_amount: totalCost,
          paper_test_class: paperTestClassFor(confidenceSnapshot),
          confidence_at_approval: confidenceSnapshot,
          is_option: true,
          option_type: optType,
          strike,
          expiry,
          contracts: qty,
          multiplier,
          entry_premium: premium,
          total_cost: totalCost,
          mid: premium,
          current_premium: premium,
          current_value: totalCost,
          unrealized_pl: 0,
          unrealized_pl_pct: 0,
          current_pl: 0,
          current_pl_pct: 0,
          last_mark_price: premium,
          last_mark_at: openedAt,
          status: "OPEN",
        }).select("id").single();

        if (insErr || !inserted) {
          console.error("auto-entry insert failed", s.id, insErr);
          skip(`insert_failed:${insErr?.message ?? "unknown"}`);
          continue;
        }

        fired++;
        spendToday += totalCost;
        openTickers.add(ticker);
        await admin.from("auto_entry_log").insert({
          user_id: userId, signal_id: s.id, ticker, status: "fired",
          paper_trade_id: inserted.id,
          rule_snapshot: { ...rules, qty, total_cost: totalCost, premium },
        });
        await logDecision(s, "enter", null, "All hard overrides passed; signal fired.",
          { qty, total_cost: totalCost, premium, paper_trade_id: inserted.id });


        if (firesCount + fired >= Number(rules.max_trades_per_day ?? 5)) break;
        if (spendToday >= Number(rules.daily_spend_cap_usd ?? Infinity)) break;
      }
    }

    await logRun("ok", { fired, skipped, dryRun });
    return json({ ok: true, scanned, fired, dry_run: dryRun, skipped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("auto-entry-engine exception", e);
    await logRun("error", { error: msg });
    return json({ error: msg }, 500);
  }
});

// Mirror src/lib/approveSignal.ts:paperTestClassFor (kept local to avoid client deps)
function paperTestClassFor(conf: number): string {
  if (conf >= 85) return "high_confidence";
  if (conf >= 70) return "mid_confidence";
  return "low_confidence";
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function nyParts(d: Date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit",
    year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    weekday: get("weekday"),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    y: get("year"), m: get("month"), d: get("day"),
  };
}
function isUsMarketOpenNow(d: Date = new Date()): boolean {
  const p = nyParts(d);
  if (["Sat", "Sun"].includes(p.weekday)) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
function withinTimeWindow(start: string | null, end: string | null): boolean {
  if (!start && !end) return true;
  const p = nyParts();
  const now = p.hour * 60 + p.minute;
  const toMin = (t: string) => {
    const [h, m] = String(t).split(":").map((x) => parseInt(x, 10));
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const s = start ? toMin(start) : 0;
  const e = end ? toMin(end) : 24 * 60;
  return now >= s && now < e;
}
function startOfNyDayUtc(): string {
  const p = nyParts();
  // ET ~UTC-4/5; close enough using local 00:00 ET → convert by formatting a midnight string.
  // Build "YYYY-MM-DD 00:00 America/New_York" then parse via Date by offset trick.
  const iso = `${p.y}-${p.m}-${p.d}T00:00:00`;
  // Date.parse treats no-Z as local; we want NY. Subtract from a probe to find NY offset.
  const probe = new Date();
  const localStr = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).format(probe);
  const m = /GMT([+-]\d{1,2})/.exec(localStr);
  const offsetHours = m ? parseInt(m[1], 10) : -5;
  const sign = offsetHours >= 0 ? "+" : "-";
  const hh = String(Math.abs(offsetHours)).padStart(2, "0");
  return new Date(`${iso}${sign}${hh}:00`).toISOString();
}
