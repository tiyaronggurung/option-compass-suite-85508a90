// POST /functions/v1/evaluate-trade-alerts
//
// Paper-only Trade Alert Engine evaluator.
// Reads active alerts (watching, triggered, entered) and advances their
// state based on current underlying price and current paper-trade contract
// mark. Persists every transition and fires dispatch-alert for each one.
//
// Does NOT touch live trading, scoring, scanner, lifecycle, hidden logic,
// signal generation, or guest flows.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Alert = {
  id: string;
  user_id: string;
  ticker: string;
  option_side: "call" | "put";
  paper_trade_id: string | null;
  underlying_trigger_price: number | null;
  trigger_direction: "above" | "below" | null;
  entry_contract_price_min: number | null;
  entry_contract_price_max: number | null;
  stop_loss_contract_price: number | null;
  target_1_contract_price: number | null;
  target_2_contract_price: number | null;
  target_3_contract_price: number | null;
  invalidation_underlying_price: number | null;
  alert_status: string;
  expires_at: string | null;
  last_notified_status: string | null;
  entered_at: string | null;
  created_at: string | null;
};

// Grace period after entry during which we ignore stop-loss hits.
// Prevents the first contract mid (which can sit inside a wide bid/ask spread
// right after entry) from triggering an instant fake stop.
const STOP_GRACE_MS = 60_000;

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole);
  const t0 = Date.now();
  const now = new Date();

  // 1. Pull all alerts that can still change state.
  const ACTIVE = ["watching", "triggered", "entered"];
  const { data: alertsRaw, error: aErr } = await admin
    .from("trade_alerts")
    .select("id,user_id,ticker,option_side,paper_trade_id,underlying_trigger_price,trigger_direction,entry_contract_price_min,entry_contract_price_max,stop_loss_contract_price,target_1_contract_price,target_2_contract_price,target_3_contract_price,invalidation_underlying_price,alert_status,expires_at,last_notified_status,entered_at,created_at")
    .in("alert_status", ACTIVE)
    .limit(500);

  if (aErr) {
    return json({ ok: false, error: aErr.message }, 500);
  }
  const alerts = (alertsRaw ?? []) as Alert[];

  // 2. Bulk-load latest underlying prices (tradable_universe is kept fresh by other jobs)
  const tickers = Array.from(new Set(alerts.map(a => a.ticker)));
  const underlyingByTicker: Record<string, number | null> = {};
  if (tickers.length) {
    const { data: tu } = await admin
      .from("tradable_universe")
      .select("ticker,last_price")
      .in("ticker", tickers);
    for (const row of tu ?? []) underlyingByTicker[row.ticker] = n(row.last_price);
  }

  // 3. Bulk-load contract marks via paper_trades (only for alerts that have one)
  const tradeIds = alerts.map(a => a.paper_trade_id).filter((x): x is string => !!x);
  const contractByTrade: Record<string, { mid: number | null; current: number | null }> = {};
  if (tradeIds.length) {
    const { data: pt } = await admin
      .from("paper_trades")
      .select("id,current_premium,mid")
      .in("id", tradeIds);
    for (const row of pt ?? []) {
      contractByTrade[row.id] = { mid: n(row.mid), current: n(row.current_premium) };
    }
  }

  const transitions: Array<{ alertId: string; from: string; to: string }> = [];
  let updated = 0;

  // 4. Evaluate each alert.
  for (const a of alerts) {
    const underlying = underlyingByTicker[a.ticker] ?? null;
    const mark = a.paper_trade_id ? (contractByTrade[a.paper_trade_id] ?? null) : null;
    const contractMid = mark?.current ?? mark?.mid ?? null;

    let next = a.alert_status;
    const patch: Record<string, unknown> = {
      last_evaluated_at: now.toISOString(),
      last_underlying_price: underlying,
      last_contract_mid: contractMid,
    };

    // Expire check first.
    if (a.expires_at && new Date(a.expires_at).getTime() <= now.getTime()) {
      next = "expired";
    } else {
      // watching -> triggered
      if (a.alert_status === "watching" && underlying != null && a.underlying_trigger_price != null && a.trigger_direction) {
        const hit = a.trigger_direction === "above"
          ? underlying >= a.underlying_trigger_price
          : underlying <= a.underlying_trigger_price;
        if (hit) {
          next = "triggered";
          patch.triggered_at = now.toISOString();
        }
      }
      // triggered -> entered (when contract mid enters entry zone)
      if ((next === "triggered" || a.alert_status === "triggered") && contractMid != null
          && a.entry_contract_price_min != null && a.entry_contract_price_max != null) {
        if (contractMid >= a.entry_contract_price_min && contractMid <= a.entry_contract_price_max) {
          next = "entered";
          patch.entered_at = now.toISOString();
        }
      }
      // Active contract-level transitions (entered or beyond)
      if ((["triggered", "entered", "hit_t1", "hit_t2"].includes(next) || ["triggered","entered","hit_t1","hit_t2"].includes(a.alert_status)) && contractMid != null) {
        // Stop loss takes precedence.
        if (a.stop_loss_contract_price != null && contractMid <= a.stop_loss_contract_price) {
          next = "stopped";
          patch.stopped_at = now.toISOString();
        } else {
          // Targets — promote to highest hit.
          if (a.target_3_contract_price != null && contractMid >= a.target_3_contract_price) {
            next = "hit_t3";
            patch.hit_t3_at = patch.hit_t3_at ?? now.toISOString();
          } else if (a.target_2_contract_price != null && contractMid >= a.target_2_contract_price && rank(a.alert_status) < rank("hit_t2")) {
            next = "hit_t2";
            patch.hit_t2_at = now.toISOString();
          } else if (a.target_1_contract_price != null && contractMid >= a.target_1_contract_price && rank(a.alert_status) < rank("hit_t1")) {
            next = "hit_t1";
            patch.hit_t1_at = now.toISOString();
          }
        }
      }
    }

    if (next !== a.alert_status) {
      patch.alert_status = next;
      transitions.push({ alertId: a.id, from: a.alert_status, to: next });
    }

    const { error: upErr } = await admin.from("trade_alerts").update(patch).eq("id", a.id);
    if (upErr) console.warn("[evaluate-trade-alerts] update failed", a.id, upErr.message);
    else updated++;

    // Keep paper_trade in sync: when an alert reaches a terminal state, close
    // the linked open paper trade so the Open section and Active Plans card
    // never diverge. Cash refund is handled by paper_trades_cash_accounting.
    const TERMINAL = new Set(["stopped", "hit_t3", "expired"]);
    if (TERMINAL.has(next) && a.paper_trade_id) {
      const exitPremium = contractMid ?? mark?.current ?? mark?.mid ?? null;
      const status = next === "hit_t3" ? "WIN" : next === "stopped" ? "LOSS" : "CLOSED";
      const exitReason = next === "hit_t3" ? "target_hit" : next === "stopped" ? "stop_hit" : "expired";

      const { data: existing } = await admin
        .from("paper_trades")
        .select("id,status,entry_premium,contracts,multiplier")
        .eq("id", a.paper_trade_id)
        .maybeSingle();
      if (existing && existing.status === "OPEN") {
        const mult = existing.multiplier ?? 100;
        const qty = existing.contracts ?? 1;
        const entry = Number(existing.entry_premium ?? 0);
        const exitP = exitPremium != null ? Number(exitPremium) : null;
        const realizedPlDollars = exitP != null ? (exitP - entry) * mult * qty : null;
        const realizedPlPct = exitP != null && entry > 0 ? ((exitP - entry) / entry) * 100 : null;
        const { error: ptErr } = await admin.from("paper_trades").update({
          status,
          exit_reason: exitReason,
          exit_premium: exitP,
          exit_price: exitP,
          closed_at: now.toISOString(),
          realized_pl: realizedPlDollars,
          realized_pl_dollars: realizedPlDollars,
          realized_pl_pct: realizedPlPct,
        }).eq("id", a.paper_trade_id);
        if (ptErr) console.warn("[evaluate-trade-alerts] paper_trade close failed", a.paper_trade_id, ptErr.message);
      }
    }

  }

  // 5. Fire dispatch-alert for every transition (best-effort, in parallel).
  if (transitions.length) {
    await Promise.allSettled(transitions.map(async (t) => {
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/dispatch-alert`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${serviceRole}`, "Content-Type": "application/json" },
          body: JSON.stringify({ alert_id: t.alertId, status: t.to, from: t.from }),
        });
        await r.text();
      } catch (e) {
        console.warn("[evaluate-trade-alerts] dispatch failed", t.alertId, e);
      }
    }));
  }

  return json({
    ok: true,
    evaluated: alerts.length,
    updated,
    transitions: transitions.length,
    latency_ms: Date.now() - t0,
  });
});

// Status rank — used to avoid downgrading hit_t2 back to hit_t1, etc.
function rank(s: string): number {
  switch (s) {
    case "watching": return 0;
    case "triggered": return 1;
    case "entered": return 2;
    case "hit_t1": return 3;
    case "hit_t2": return 4;
    case "hit_t3": return 5;
    case "stopped": return 90;
    case "expired": return 91;
    case "cancelled": return 92;
    default: return 0;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
