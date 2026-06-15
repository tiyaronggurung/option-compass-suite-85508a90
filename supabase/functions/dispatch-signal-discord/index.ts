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
  tech_adjusted_confidence: number | null;
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

const effConf = (s: { confidence: number; tech_adjusted_confidence: number | null }) =>
  Math.round(s.tech_adjusted_confidence ?? s.confidence);

function buildEmbed(s: SignalRow) {
  const dir = (s.direction ?? "").toUpperCase();
  const isCall = dir === "CALL";
  const arrow = isCall ? "▲" : "▼";
  const sideEmoji = isCall ? "🟢" : "🔴";
  const score = effConf(s);

  let tierLabel: string;
  let color: number;
  if (score >= 85) {
    tierLabel = "🔥 ELITE";
    color = isCall ? 0x16a34a : 0xdc2626;
  } else if (score >= 70) {
    tierLabel = "⭐ TOP";
    color = isCall ? 0x22c55e : 0xef4444;
  } else {
    tierLabel = "🌱 DEVELOPING";
    color = isCall ? 0x4ade80 : 0xf87171;
  }

  const risk = s.risk_level ?? "—";
  const signalUrl = `${APP_BASE}/app?signal=${s.id}`;

  const headerBits = [tierLabel, `${risk} risk`];
  if (s.dte != null) headerBits.push(`${s.dte} DTE`);
  const description =
    `**${headerBits.join("  •  ")}**\n` +
    `[Open in Xalgoflow →](${signalUrl})`;

  const fields: { name: string; value: string; inline?: boolean }[] = [];

  if (s.contract_symbol) {
    fields.push({
      name: "Contract",
      value: `\`\`\`${s.contract_symbol}\`\`\``,
      inline: false,
    });
  }

  if (s.strike != null || s.expiry || s.dte != null) {
    fields.push({ name: "Strike", value: s.strike != null ? `$${Number(s.strike).toFixed(2)}` : "—", inline: true });
    fields.push({ name: "Expiry", value: s.expiry ?? "—", inline: true });
    fields.push({ name: "DTE", value: s.dte != null ? `${s.dte}d` : "—", inline: true });
  }

  if (s.premium != null || s.price != null || s.source) {
    fields.push({ name: "Premium", value: s.premium != null ? `$${Number(s.premium).toFixed(2)}` : "—", inline: true });
    fields.push({ name: "Underlying", value: s.price != null ? `$${Number(s.price).toFixed(2)}` : "—", inline: true });
    fields.push({ name: "Source", value: s.source ?? "—", inline: true });
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
    fields.push({
      name: "Catalyst",
      value: `> ${s.catalyst_summary.slice(0, 480).replace(/\n+/g, "\n> ")}`,
      inline: false,
    });
  }

  const ticker = s.ticker.toUpperCase();
  const thumbUrl = `https://financialmodelingprep.com/image-stock/${ticker}.png`;

  return {
    username: "Xalgoflow AI",
    embeds: [{
      author: { name: `Xalgoflow AI${s.source ? ` · ${s.source}` : ""}` },
      title: `${sideEmoji} ${ticker} · ${dir} ${arrow} ${effConf(s)}/100`,
      url: signalUrl,
      description,
      color,
      thumbnail: { url: thumbUrl },
      fields,
      timestamp: s.created_at,
      footer: { text: "Xalgoflow • paper trading signal • not financial advice" },
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

  // Parse body up-front so we can branch auth: sweep mode is callable by cron
  // (anon/internal) since it only re-posts already-stored DB signals; single
  // and test modes still require admin.
  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const sweep = body.sweep === true;

  if (!sweep) {
    const auth = await requireAdmin(req);
    if (!auth.ok) return json(auth.status, { error: auth.msg });
  }

  const webhook = Deno.env.get("DISCORD_SIGNALS_WEBHOOK_URL");
  if (!webhook) return json(500, { error: "missing_webhook", message: "DISCORD_SIGNALS_WEBHOOK_URL not set" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const signalId = typeof body.signal_id === "string" ? body.signal_id : null;
  const isTest = body.test === true;

  // ---- Single signal mode ----
  if (signalId) {
    const { data, error } = await admin
      .from("signals")
      .select("id, ticker, direction, confidence, tech_adjusted_confidence, risk_level, price, contract_symbol, strike, expiry, dte, premium, reasons, catalyst_summary, source, created_at, is_demo, discord_dispatched_at")
      .eq("id", signalId)
      .maybeSingle();
    if (error) return json(500, { error: "db_error", message: error.message });
    if (!data) return json(404, { error: "not_found" });

    if (!isTest) {
      if (data.discord_dispatched_at) return json(200, { ok: true, skipped: "already_dispatched" });
      if (effConf(data as SignalRow) < MIN_CONF) return json(200, { ok: true, skipped: "below_min_confidence" });
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
      .select("id, ticker, direction, confidence, tech_adjusted_confidence, risk_level, price, contract_symbol, strike, expiry, dte, premium, reasons, catalyst_summary, source, created_at, is_demo, discord_dispatched_at")
      .gte("created_at", since)
      .or(`confidence.gte.${MIN_CONF},tech_adjusted_confidence.gte.${MIN_CONF}`)
      .is("discord_dispatched_at", null)
      .eq("is_demo", false)
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) return json(500, { error: "db_error", message: error.message });

    // Final gate: effective confidence must meet MIN_CONF (mirror dashboard cards).
    const rows = ((data ?? []) as SignalRow[]).filter((s) => effConf(s) >= MIN_CONF);

    let sent = 0;
    for (const s of rows) {
      const ok = await postOne(webhook, s);
      if (ok) {
        sent++;
        await admin.from("signals").update({ discord_dispatched_at: new Date().toISOString() }).eq("id", s.id);
        await new Promise((r) => setTimeout(r, 350)); // gentle on Discord rate limits
      }
    }
    return json(200, { ok: true, mode: "sweep", scanned: rows.length, sent });
  }

  return json(400, { error: "bad_request", message: "Provide signal_id or sweep:true" });
});
