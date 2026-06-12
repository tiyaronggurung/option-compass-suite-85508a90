// POST /functions/v1/dispatch-signal-discord
//
// Posts Xalgoflow signals to a private Discord channel as rich embeds.
// Modes:
//   { signal_id: "<uuid>" }   -> post a single signal (used by ingest-signal + admin test button)
//   { sweep: true }           -> scan last 30 min for undispatched signals >= MIN_CONF and post them
//   { signal_id, test: true } -> post even if already dispatched (admin test)
//
// De-dupes via signals.discord_dispatched_at.
// Reads DISCORD_SIGNALS_WEBHOOK_URL from secrets.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireAdmin } from "../_shared/requireAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_CONF = 60;
const APP_BASE = "https://xalgoflow.lovable.app";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type SignalRow = {
  id: string;
  ticker: string;
  direction: string;
  confidence: number;
  risk_level: string | null;
  price: number | null;
  contract_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  premium: number | null;
  reasons: string[] | null;
  catalyst_summary: string | null;
  source: string | null;
  created_at: string;
  is_demo: boolean | null;
  discord_dispatched_at: string | null;
};

function buildEmbed(s: SignalRow) {
  const isCall = s.direction?.toUpperCase() === "CALL";
  const color = isCall ? 0x16a34a : 0xdc2626; // green / red
  const arrow = isCall ? "📈" : "📉";
  const tier =
    s.confidence >= 85 ? "🔥 ELITE" :
    s.confidence >= 70 ? "⭐ TOP" :
    "🌱 DEVELOPING";

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Score", value: `**${s.confidence}/100** · ${tier}`, inline: true },
    { name: "Risk", value: s.risk_level ?? "—", inline: true },
    { name: "Direction", value: `${arrow} ${s.direction}`, inline: true },
  ];

  if (s.contract_symbol) {
    fields.push({ name: "Contract", value: `\`${s.contract_symbol}\``, inline: false });
  }
  const parts: string[] = [];
  if (s.strike != null) parts.push(`Strike $${Number(s.strike).toFixed(2)}`);
  if (s.expiry) parts.push(`Exp ${s.expiry}`);
  if (s.dte != null) parts.push(`${s.dte} DTE`);
  if (s.premium != null) parts.push(`Premium $${Number(s.premium).toFixed(2)}`);
  if (parts.length) fields.push({ name: "Details", value: parts.join(" · "), inline: false });

  if (s.price != null) {
    fields.push({ name: "Underlying", value: `$${Number(s.price).toFixed(2)}`, inline: true });
  }
  if (s.source) {
    fields.push({ name: "Source", value: s.source, inline: true });
  }

  const reasons = (s.reasons ?? []).slice(0, 4);
  if (reasons.length) {
    fields.push({
      name: "Why",
      value: reasons.map((r) => `• ${r}`).join("\n").slice(0, 1000),
      inline: false,
    });
  }
  if (s.catalyst_summary) {
    fields.push({ name: "Catalyst", value: s.catalyst_summary.slice(0, 500), inline: false });
  }

  return {
    username: "Xalgoflow AI",
    embeds: [{
      title: `${arrow} ${s.ticker} ${s.direction}`,
      url: `${APP_BASE}/app?signal=${s.id}`,
      description: `New signal detected — [Open in Xalgoflow](${APP_BASE}/app?signal=${s.id})`,
      color,
      fields,
      timestamp: s.created_at,
      footer: { text: "Xalgoflow — paper trading signal · not financial advice" },
    }],
  };
}

async function postOne(webhook: string, s: SignalRow) {
  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildEmbed(s)),
  });
  const text = await r.text();
  if (!r.ok) {
    console.warn("[discord] post failed", r.status, text.slice(0, 200));
  }
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const webhook = Deno.env.get("DISCORD_SIGNALS_WEBHOOK_URL");
  if (!webhook) return json(500, { error: "missing_webhook", message: "DISCORD_SIGNALS_WEBHOOK_URL not set" });

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const signalId = typeof body.signal_id === "string" ? body.signal_id : null;
  const isTest = body.test === true;
  const sweep = body.sweep === true;

  // ---- Single signal mode ----
  if (signalId) {
    const { data, error } = await admin
      .from("signals")
      .select("id, ticker, direction, confidence, risk_level, price, contract_symbol, strike, expiry, dte, premium, reasons, catalyst_summary, source, created_at, is_demo, discord_dispatched_at")
      .eq("id", signalId)
      .maybeSingle();
    if (error) return json(500, { error: "db_error", message: error.message });
    if (!data) return json(404, { error: "not_found" });

    if (!isTest) {
      if (data.is_demo) return json(200, { ok: true, skipped: "demo" });
      if (data.confidence < MIN_CONF) return json(200, { ok: true, skipped: "low_confidence" });
      if (data.discord_dispatched_at) return json(200, { ok: true, skipped: "already_dispatched" });
    }

    const ok = await postOne(webhook, data as SignalRow);
    if (ok && !isTest) {
      await admin.from("signals").update({ discord_dispatched_at: new Date().toISOString() }).eq("id", signalId);
    }
    return json(200, { ok, mode: isTest ? "test" : "single", signal_id: signalId });
  }

  // ---- Sweep mode (cron-friendly) ----
  if (sweep) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data, error } = await admin
      .from("signals")
      .select("id, ticker, direction, confidence, risk_level, price, contract_symbol, strike, expiry, dte, premium, reasons, catalyst_summary, source, created_at, is_demo, discord_dispatched_at")
      .gte("created_at", since)
      .gte("confidence", MIN_CONF)
      .eq("is_demo", false)
      .is("discord_dispatched_at", null)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) return json(500, { error: "db_error", message: error.message });

    let sent = 0;
    for (const s of (data ?? []) as SignalRow[]) {
      const ok = await postOne(webhook, s);
      if (ok) {
        sent++;
        await admin.from("signals").update({ discord_dispatched_at: new Date().toISOString() }).eq("id", s.id);
        await new Promise((r) => setTimeout(r, 350)); // gentle on Discord rate limits
      }
    }
    return json(200, { ok: true, mode: "sweep", scanned: data?.length ?? 0, sent });
  }

  return json(400, { error: "bad_request", message: "Provide signal_id or sweep:true" });
});
