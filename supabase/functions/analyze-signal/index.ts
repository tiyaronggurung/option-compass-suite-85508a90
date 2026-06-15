// POST /functions/v1/analyze-signal
// Generates an AI-written analyst breakdown for one signal and caches it in signal_analyses.
// Uses Lovable AI Gateway (LOVABLE_API_KEY auto-provisioned). Auth required (verify_jwt default).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You are a sober, educational options-flow analyst for an EDUCATIONAL PAPER-TRADING app.
You NEVER give financial advice, never promise profits, and always include risk warnings.
You write concise, plain English. You evaluate setups across desks (Technical, Flow, Catalyst, Macro, Risk).
You also produce a HYPOTHETICAL backtest sample for similar prior setups — clearly label it as illustrative.
Return only the tool call.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Auth gate — prevent unauthenticated AI credit abuse.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { signal_id, force } = await req.json();
    if (!signal_id || typeof signal_id !== "string") {
      return new Response(JSON.stringify({ error: "signal_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (!force) {
      const { data: cached } = await supabase
        .from("signal_analyses").select("*").eq("signal_id", signal_id).maybeSingle();
      if (cached) {
        return new Response(JSON.stringify({ ok: true, cached: true, analysis: cached }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: sig, error: sigErr } = await supabase
      .from("signals").select("*").eq("id", signal_id).single();
    if (sigErr || !sig) {
      return new Response(JSON.stringify({ error: "Signal not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userPrompt = `Analyze this options signal for an educational paper-trading desk.

Ticker: ${sig.ticker}
Direction: ${sig.direction}
Confidence: ${sig.confidence}/100
Risk level: ${sig.risk_level}
Underlying price: ${sig.price ?? "n/a"}
Contract: ${sig.contract_symbol ?? "n/a"}
Strike: ${sig.strike ?? "n/a"}  Premium: ${sig.premium ?? "n/a"}  DTE: ${sig.dte ?? "n/a"}
Reasons given: ${JSON.stringify(sig.reasons)}
Flow metrics: ${JSON.stringify(sig.flow_metrics)}
Technical metrics: ${JSON.stringify(sig.technical_metrics)}
Catalyst: ${sig.catalyst_summary ?? "none provided"}
Macro score: ${sig.macro_score ?? "n/a"}

Write a balanced breakdown. Be honest about uncertainty. Always include risk warnings.
For the historical sample, invent a plausible illustrative backtest (clearly labeled as illustrative).`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: "emit_analysis",
            description: "Return the structured analyst breakdown.",
            parameters: {
              type: "object",
              properties: {
                summary: { type: "string" },
                bull_case: { type: "string" },
                bear_case: { type: "string" },
                why_triggered: { type: "string" },
                flow_interpretation: { type: "string" },
                technical_confirmation: { type: "string" },
                catalyst_context: { type: "string" },
                macro_context: { type: "string" },
                risk_warnings: { type: "string" },
                verdict: { type: "string", enum: ["WAIT", "CHASE", "AVOID"] },
                desks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      desk: { type: "string", enum: ["Technical", "Flow", "Catalyst", "Macro", "Risk"] },
                      stance: { type: "string", enum: ["bullish", "bearish", "neutral"] },
                      conviction: { type: "integer" },
                      note: { type: "string" },
                    },
                    required: ["desk", "stance", "conviction", "note"],
                  },
                },
                historical: {
                  type: "object",
                  properties: {
                    prior_occurrences: { type: "integer" },
                    win_rate_pct: { type: "number" },
                    avg_move_pct: { type: "number" },
                    max_drawdown_pct: { type: "number" },
                    best_dte: { type: "integer" },
                  },
                  required: ["prior_occurrences", "win_rate_pct", "avg_move_pct", "max_drawdown_pct", "best_dte"],
                },
              },
              required: [
                "summary","bull_case","bear_case","why_triggered","flow_interpretation",
                "technical_confirmation","risk_warnings","verdict","desks","historical",
              ],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "emit_analysis" } },
      }),
    });

    if (!aiRes.ok) {
      const txt = await aiRes.text();
      console.error("AI gateway error", aiRes.status, txt);
      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit hit. Try again in a moment." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in workspace settings." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "AI gateway error", detail: txt }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await aiRes.json();
    const args = payload?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) {
      return new Response(JSON.stringify({ error: "No tool call returned", payload }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let parsed: any;
    try { parsed = JSON.parse(args); } catch {
      return new Response(JSON.stringify({ error: "Bad JSON from model" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: saved, error: saveErr } = await supabase
      .from("signal_analyses")
      .upsert({
        signal_id,
        summary: parsed.summary,
        bull_case: parsed.bull_case,
        bear_case: parsed.bear_case,
        why_triggered: parsed.why_triggered,
        flow_interpretation: parsed.flow_interpretation,
        technical_confirmation: parsed.technical_confirmation,
        catalyst_context: parsed.catalyst_context ?? null,
        macro_context: parsed.macro_context ?? null,
        risk_warnings: parsed.risk_warnings,
        verdict: parsed.verdict,
        desks: parsed.desks ?? [],
        historical: parsed.historical ?? {},
        model: "google/gemini-2.5-flash",
      })
      .select()
      .single();

    if (saveErr) {
      console.error("save error", saveErr);
      return new Response(JSON.stringify({ error: saveErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, cached: false, analysis: saved }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("analyze-signal exception", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
