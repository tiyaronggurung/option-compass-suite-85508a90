// POST /functions/v1/ingest-signal
// Webhook endpoint for the future Python trading engine to push new signals.
// Auth: requires `x-ingest-secret` header matching SIGNAL_INGEST_SECRET (set in project secrets).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SignalSchema = z.object({
  ticker: z.string().min(1).max(10),
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number().int().min(0).max(100),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const secret = Deno.env.get("SIGNAL_INGEST_SECRET");
  if (secret) {
    const provided = req.headers.get("x-ingest-secret");
    if (provided !== secret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const parsed = SignalSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Validation failed", details: parsed.error.flatten() }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await supabase
    .from("signals")
    .insert({ ...parsed.data, ticker: parsed.data.ticker.toUpperCase() })
    .select()
    .single();

  if (error) {
    console.error("ingest-signal insert error", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, signal: data }), {
    status: 201,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
