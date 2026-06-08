// POST /functions/v1/dispatch-alert
//
// Sends a rich notification when a trade alert transitions between states.
// Reads alert_settings for the alert's user and dispatches to enabled
// channels (email log, telegram, discord webhook). SMS is intentionally
// stubbed — no SMS provider is wired.
//
// Body: { alert_id: string, status: string, from?: string }
//
// Paper-only. Does NOT place any orders. Does NOT touch scoring, scanner,
// lifecycle, hidden logic, signal generation, or guest flows.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireAdmin } from "../_shared/requireAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole);

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const alertId = String(body.alert_id ?? "").trim();
  const status = String(body.status ?? "").trim();
  const fromStatus = body.from ? String(body.from) : null;
  if (!alertId || !status) return json({ ok: false, error: "missing alert_id or status" }, 400);

  const { data: alert, error: aErr } = await admin
    .from("trade_alerts")
    .select("*")
    .eq("id", alertId)
    .maybeSingle();
  if (aErr || !alert) return json({ ok: false, error: aErr?.message ?? "alert_not_found" }, 404);

  // Idempotency: don't re-send the same status notification.
  if (alert.last_notified_status === status) {
    return json({ ok: true, skipped: "already_notified", status });
  }

  const { data: settings } = await admin
    .from("alert_settings")
    .select("*")
    .eq("user_id", alert.user_id)
    .maybeSingle();

  const enabledChannels: string[] = [];
  if (settings?.telegram_enabled && settings.telegram_chat_id) enabledChannels.push("telegram");
  if (settings?.discord_enabled && settings.discord_webhook_url) enabledChannels.push("discord");
  if (settings?.email_enabled && settings.notify_email) enabledChannels.push("email");
  if (settings?.browser_push_enabled) enabledChannels.push("browser_push");

  const payload = buildPayload(alert, status, fromStatus);
  const results: Record<string, string> = {};

  await Promise.allSettled(
    enabledChannels.map(async (channel) => {
      try {
        if (channel === "telegram") {
          // Telegram dispatch is not wired yet — log the payload for now.
          console.log("[dispatch-alert] telegram payload", { chat_id: settings.telegram_chat_id, text: payload.text });
          results.telegram = "logged";
        } else if (channel === "discord" && settings?.discord_webhook_url) {
          const r = await fetch(settings.discord_webhook_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: payload.text }),
          });
          results.discord = r.ok ? "sent" : `error_${r.status}`;
          await r.text();
        } else if (channel === "email") {
          // Email dispatch requires Resend (not wired). Log payload.
          console.log("[dispatch-alert] email payload", { to: settings.notify_email, subject: payload.subject, text: payload.text });
          results.email = "logged";
        } else if (channel === "browser_push") {
          results.browser_push = "client_side";
        }
      } catch (e) {
        console.warn("[dispatch-alert] channel failed", channel, e);
        results[channel] = "error";
      }
    }),
  );

  // Mark as notified.
  await admin
    .from("trade_alerts")
    .update({ last_notified_status: status })
    .eq("id", alertId);

  return json({ ok: true, alert_id: alertId, status, channels: results, payload });
});

function buildPayload(a: any, status: string, fromStatus: string | null) {
  const side = String(a.option_side ?? "").toUpperCase();
  const strike = a.strike != null ? `$${Number(a.strike).toFixed(2).replace(/\.00$/, "")}` : "";
  const expiry = a.expiry ?? "";
  const head = `${a.ticker} ${strike}${side} ${expiry}`.trim();
  const verb = STATUS_VERB[status] ?? status.toUpperCase();
  const trigger = a.underlying_trigger_price != null
    ? `Trigger was ${a.ticker} ${a.trigger_direction === "above" ? "above" : "below"} $${Number(a.underlying_trigger_price).toFixed(2)}.`
    : "";
  const zone = a.entry_contract_price_min != null && a.entry_contract_price_max != null
    ? `Entry zone $${Number(a.entry_contract_price_min).toFixed(2)}–$${Number(a.entry_contract_price_max).toFixed(2)}.`
    : "";
  const stop = a.stop_loss_contract_price != null ? `Stop $${Number(a.stop_loss_contract_price).toFixed(2)}.` : "";
  const targets = [a.target_1_contract_price, a.target_2_contract_price, a.target_3_contract_price]
    .filter((x): x is number => x != null)
    .map((x) => `$${Number(x).toFixed(2)}`).join(" / ");
  const targetsLine = targets ? `Targets ${targets}.` : "";
  const conf = a.confidence_score != null ? `Confidence ${a.confidence_score}%.` : "";
  const text = [
    `${head} ${verb}.`,
    zone, stop, targetsLine, trigger, conf,
    a.trade_rationale ? `Why: ${a.trade_rationale}` : "",
    "(Paper trade — simulation only, no real money executed.)",
  ].filter(Boolean).join(" ");
  const subject = `${head} ${verb}`;
  return { subject, text, from_status: fromStatus, status };
}

const STATUS_VERB: Record<string, string> = {
  triggered: "TRIGGERED — watch for entry",
  entered: "ENTERED — paper position opened in entry zone",
  hit_t1: "HIT TARGET 1",
  hit_t2: "HIT TARGET 2",
  hit_t3: "HIT TARGET 3",
  stopped: "STOPPED OUT",
  expired: "EXPIRED",
  cancelled: "CANCELLED",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
