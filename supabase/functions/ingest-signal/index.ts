// POST /functions/v1/ingest-signal
// Secure webhook for the Xalgoflow Python trading engine.
// Auth: HARD-REQUIRED `x-ingest-secret` header matching SIGNAL_INGEST_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const SignalSchema = z.object({
  signal_id: z.string().uuid().optional(), // external dedup id
  source: z.string().min(1).max(100).optional(),
  is_demo: z.boolean().optional(),
  ticker: z.string().min(1).max(10),
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number().int().min(0).max(100),
  risk_level: z
    .string()
    .transform((s) => s.toUpperCase())
    .pipe(z.enum(["LOW", "MEDIUM", "HIGH"]))
    .default("MEDIUM"),
  price: z.number().nullable().optional(),
  contract_symbol: z.string().max(50).nullable().optional(),
  dte: z.number().int().min(0).max(365).nullable().optional(),
  expiry: z.string().nullable().optional(),
  strike: z.number().nullable().optional(),
  premium: z.number().nullable().optional(),
  reasons: z.array(z.string()).default([]),
  flow_metrics: z.record(z.any()).default({}),
  technical_metrics: z.record(z.any()).default({}),
  catalyst_summary: z.string().max(500).nullable().optional(),
  macro_score: z.number().nullable().optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // 1. Fail closed if secret not configured
  const secret = Deno.env.get("SIGNAL_INGEST_SECRET");
  if (!secret) {
    console.error("[ingest-signal] config_error: SIGNAL_INGEST_SECRET not set");
    return json(500, { error: "config_error", message: "Ingest secret not configured" });
  }

  // 2. Hard-required auth
  const provided = req.headers.get("x-ingest-secret");
  const ua = req.headers.get("user-agent") ?? "unknown";
  const fwd = req.headers.get("x-forwarded-for") ?? "unknown";

  if (!provided) {
    console.warn(`[ingest-signal] auth_fail: missing header ua="${ua}" ip="${fwd}"`);
    return json(401, { error: "unauthorized", message: "Missing x-ingest-secret header" });
  }
  if (provided !== secret) {
    console.warn(`[ingest-signal] auth_fail: bad secret ua="${ua}" ip="${fwd}"`);
    return json(401, { error: "unauthorized", message: "Invalid x-ingest-secret" });
  }

  // 3. Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  // 4. Validate
  const parsed = SignalSchema.safeParse(body);
  if (!parsed.success) {
    return json(400, { error: "validation_failed", details: parsed.error.flatten() });
  }

  const { signal_id, is_demo, source, ...rest } = parsed.data;
  // Default is_demo: explicit > false when source comes from a live engine > true otherwise
  const inferredDemo =
    is_demo !== undefined
      ? is_demo
      : source
        ? !/alpaca|tradier|polygon|unusual.*whales/i.test(source)
        : true;
  const row = {
    ...rest,
    source: source ?? null,
    is_demo: inferredDemo,
    ticker: rest.ticker.toUpperCase(),
    external_id: signal_id ?? null,
  };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 5. Dedup by external_id when provided
  if (signal_id) {
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("external_id", signal_id)
      .maybeSingle();
    if (existing) {
      return json(200, { ok: true, deduped: true, signal_id: existing.id });
    }
  }

  const { data, error } = await supabase
    .from("signals")
    .insert(row)
    .select()
    .single();

  if (error) {
    // Unique violation race -> treat as dedup
    if (error.code === "23505" && signal_id) {
      const { data: existing } = await supabase
        .from("signals")
        .select("id")
        .eq("external_id", signal_id)
        .maybeSingle();
      return json(200, { ok: true, deduped: true, signal_id: existing?.id });
    }
    console.error("[ingest-signal] insert error", error);
    return json(500, { error: "insert_failed", message: error.message });
  }

  console.log(`[ingest-signal] inserted ${data.ticker} ${data.direction} src="${data.source ?? "n/a"}"`);

  // Fire-and-forget Discord dispatch for EVERY signal (incl. demo + low confidence).
  if (Deno.env.get("DISCORD_SIGNALS_WEBHOOK_URL")) {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/dispatch-signal-discord`;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ signal_id: data.id }),
    }).catch((e) => console.warn("[ingest-signal] discord dispatch failed", e));
  }

  return json(201, { ok: true, signal: data });
});
