// UW Flow Scanner — parallel signal source alongside Alpaca scanner.
//
// Polls Unusual Whales flow-alerts every tick (5s cron). For each alert that
// meets the floor (sweep|block, BUY-side, total_premium >= $250K) and that we
// haven't already ingested, inserts a row into public.signals with
// source="Unusual Whales Flow" and flow_type=sweep|block. Then runs a single
// cross-source confirmation sweep so any Alpaca rows in the same 2-min window
// get tagged confirmed_by_both.
//
// Does NOT modify the Alpaca scanner, scoring, tiers, contract selection,
// guest flows, or paper trading. Inserts only.

import { createClient } from "npm:@supabase/supabase-js@2";
import { uwFetch } from "../_shared/unusual-whales.ts";
import { runConfirmationSweep } from "../_shared/crossSourceMatch.ts";
import { requireAdmin } from "../_shared/requireAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const MIN_PREMIUM = 250_000;
const LOOKBACK_MS = 5 * 60 * 1000; // ignore alerts older than 5 min
const SOURCE_LABEL = "Unusual Whales Flow";

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n: number): string {
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K`
    : `$${n.toFixed(0)}`;
}

// Confidence from premium + repeat + aggressor strength.
function deriveConfidence(prem: number, askPrem: number, bidPrem: number, sweep: boolean, block: boolean, volOi: number): number {
  let c = 60;
  if (prem >= 5_000_000) c += 20;
  else if (prem >= 2_000_000) c += 14;
  else if (prem >= 1_000_000) c += 9;
  else if (prem >= 500_000) c += 4;
  const total = askPrem + bidPrem;
  if (total > 0) {
    const askRatio = askPrem / total;
    if (askRatio >= 0.9) c += 8;
    else if (askRatio >= 0.75) c += 5;
    else if (askRatio >= 0.6) c += 2;
  }
  if (sweep) c += 4;
  if (block) c += 3;
  if (volOi >= 5) c += 4;
  else if (volOi >= 2) c += 2;
  return Math.max(50, Math.min(99, Math.round(c)));
}

type AlertRow = Record<string, any>;

function normalize(row: AlertRow) {
  const ticker = String(row.ticker ?? row.underlying ?? "").toUpperCase();
  const typeRaw = String(row.type ?? row.option_type ?? "").toLowerCase();
  const isCall = typeRaw === "call" || typeRaw === "c";
  const isPut = typeRaw === "put" || typeRaw === "p";
  const totalPrem = num(row.total_premium ?? row.premium);
  const askPrem = num(row.total_ask_side_prem ?? row.ask_side_premium);
  const bidPrem = num(row.total_bid_side_prem ?? row.bid_side_premium);
  const isSweep = !!(row.has_sweep ?? row.is_sweep ?? row.sweep);
  const isBlock = !!(row.has_floor ?? row.is_block ?? row.block);
  const volOi = num(row.volume_oi_ratio);
  const strike = row.strike ?? row.strike_price ?? null;
  const expiry = row.expiry ?? row.expiration ?? null;
  const createdAt = row.created_at ?? row.executed_at ?? row.alert_at ?? row.start_time ?? null;
  const id = row.id ?? row.alert_id ?? row.tracking_id ?? null;
  const underlyingPrice = num(row.underlying_price ?? row.spot ?? row.last_price);
  return {
    ticker,
    direction: (isCall ? "CALL" : isPut ? "PUT" : null) as "CALL" | "PUT" | null,
    totalPrem, askPrem, bidPrem,
    isSweep, isBlock, volOi,
    strike, expiry, createdAt, id,
    underlyingPrice,
    flow_type: (isSweep ? "sweep" : isBlock ? "block" : null) as "sweep" | "block" | null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const result = {
    polled: 0,
    eligible: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    errors: [] as string[],
    pairs_made: 0,
    state: "unknown" as string,
  };

  // Pull recent flow alerts (latest first). Limit 200; we filter aggressively.
  const r = await uwFetch(`/option-trades/flow-alerts?limit=200`);
  result.state = r.state;
  if (r.state !== "active") {
    return new Response(JSON.stringify({ ...result, note: r.error ?? r.state }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  }

  const rows: AlertRow[] = Array.isArray(r.data?.data) ? r.data.data
    : Array.isArray(r.data) ? r.data
    : Array.isArray(r.data?.flow_alerts) ? r.data.flow_alerts : [];
  result.polled = rows.length;

  const cutoff = Date.now() - LOOKBACK_MS;

  // Pre-fetch existing external_ids for dedupe.
  const incoming = rows.map(normalize).filter((n) => {
    if (!n.ticker || !n.direction) return false;
    if (!n.flow_type) return false; // sweeps + blocks only
    if (n.totalPrem < MIN_PREMIUM) return false;
    if (n.askPrem <= n.bidPrem) return false; // BUY-side only
    if (n.createdAt) {
      const ts = new Date(n.createdAt).getTime();
      if (Number.isFinite(ts) && ts < cutoff) return false;
    }
    return true;
  });
  result.eligible = incoming.length;
  if (incoming.length === 0) {
    // Still run a confirmation sweep so any prior UW rows can pair with new Alpaca rows.
    const sweep = await runConfirmationSweep(admin, { windowMinutes: 2 });
    result.pairs_made = sweep.pairs_made;
    return new Response(JSON.stringify({ ...result, ms: Date.now() - startedAt }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  }

  for (const n of incoming) {
    try {
      // Dedupe via external_id (uuid). Hash the provider id to a stable uuid if it isn't already.
      const externalId = n.id ? deterministicUuid(`uw:${n.id}`) : deterministicUuid(`uw:${n.ticker}:${n.direction}:${n.strike}:${n.expiry}:${n.totalPrem}:${n.createdAt}`);

      const existing = await admin.from("signals").select("id").eq("external_id", externalId).maybeSingle();
      if (existing.data) { result.duplicates++; continue; }

      const confidence = deriveConfidence(n.totalPrem, n.askPrem, n.bidPrem, n.isSweep, n.isBlock, n.volOi);
      const reason = `⚡ UW ${n.flow_type} ${n.direction} · ${fmtUsd(n.totalPrem)} premium · ${fmtUsd(n.askPrem)} ask vs ${fmtUsd(n.bidPrem)} bid${n.volOi > 0 ? ` · vol/OI ${n.volOi.toFixed(1)}x` : ""}`;

      const ins = await admin.from("signals").insert({
        ticker: n.ticker,
        direction: n.direction,
        price: n.underlyingPrice || null,
        confidence,
        risk_level: n.flow_type === "sweep" ? "HIGH" : "MEDIUM",
        reasons: [reason],
        flow_metrics: {
          total_premium: n.totalPrem,
          ask_side_premium: n.askPrem,
          bid_side_premium: n.bidPrem,
          volume_oi_ratio: n.volOi,
          is_sweep: n.isSweep,
          is_block: n.isBlock,
        },
        technical_metrics: {},
        status: "LIVE",
        is_demo: false,
        hidden: false,
        source: SOURCE_LABEL,
        external_id: externalId,
        expires_at: null,
        catalyst_summary: null,
        source_confirmations: {},
        confirmation_score: null,
        confirmation_label: null,
        tier: confidence >= 80 ? "strong" : confidence >= 70 ? "watchlist" : "developing",
        score_components: {},
        lifecycle_state: "fresh",
        lifecycle_reason: "created",
        lifecycle_updated_at: new Date().toISOString(),
        confidence_at_birth: confidence,
        flow_at_birth: {
          total_premium: n.totalPrem,
          ask_side_premium: n.askPrem,
          bid_side_premium: n.bidPrem,
          flow_type: n.flow_type,
        },
        technical_at_birth: {},
        lifecycle_history: [{ state: "fresh", reason: "created", at: new Date().toISOString(), confidence }],
        max_confidence_seen: confidence,
        min_confidence_seen: confidence,
        max_tier_seen: null,
        min_tier_seen: null,
        flow_type: n.flow_type,
        raw_provider_payload: { source: "unusual_whales", normalized: n },
        contract_symbol: null,
        strike: n.strike ?? null,
        expiry: n.expiry ?? null,
        // IMPORTANT: do NOT store total notional flow here. signals.premium is a
        // per-share contract price used by approveSignal as the entry premium
        // fallback. Storing total flow ($) caused 100%-loss paper trades.
        // Leave null so the contract picker must resolve a real mid before approval.
        premium: null,
      });
      if (ins.error) {
        if ((ins.error as any).code === "23505") { result.duplicates++; continue; }
        result.errors.push(ins.error.message);
        result.skipped++;
        continue;
      }
      result.inserted++;
    } catch (e) {
      result.errors.push((e as Error).message.slice(0, 200));
      result.skipped++;
    }
  }

  const sweep = await runConfirmationSweep(admin, { windowMinutes: 2 });
  result.pairs_made = sweep.pairs_made;

  return new Response(JSON.stringify({ ...result, ms: Date.now() - startedAt }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status: 200,
  });
});

// Tiny deterministic UUID v5-ish (not strict v5 but stable & well-formed).
function deterministicUuid(input: string): string {
  // FNV-1a 64-bit-ish + spread into a uuid string.
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  const a = h1.toString(16).padStart(8, "0");
  const b = (h2 & 0xffff).toString(16).padStart(4, "0");
  const c = ((h2 >>> 16) & 0x0fff | 0x5000).toString(16).padStart(4, "0"); // version "5"
  const d = ((h1 & 0x3fff) | 0x8000).toString(16).padStart(4, "0"); // variant
  const e = (Math.imul(h1, h2) >>> 0).toString(16).padStart(8, "0") + (h2 & 0xffff).toString(16).padStart(4, "0");
  return `${a}-${b}-${c}-${d}-${e.slice(0, 12)}`;
}
