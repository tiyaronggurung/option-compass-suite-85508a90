// POST /functions/v1/review-trade
// Generates an AI post-trade review for a closed paper trade and caches it in trade_reviews.
// Uses Lovable AI Gateway (LOVABLE_API_KEY auto-provisioned).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You are a sober, educational post-trade reviewer for a PAPER-TRADING app.
You NEVER give financial advice and you always frame results as educational lessons.
You write concise, plain English. You judge: entry quality, risk/reward quality,
timing, signal strength, and lessons learned. Be honest and specific. Return only the tool call.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { trade_id, force } = await req.json();
    if (!trade_id || typeof trade_id !== "string") {
      return new Response(JSON.stringify({ error: "trade_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceRole);

    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: trade, error: tErr } = await admin
      .from("paper_trades").select("*").eq("id", trade_id).single();
    if (tErr || !trade) {
      return new Response(JSON.stringify({ error: "Trade not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (trade.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (trade.status === "OPEN") {
      return new Response(JSON.stringify({ error: "Trade is still open" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!force) {
      const { data: cached } = await admin
        .from("trade_reviews").select("*").eq("trade_id", trade_id).maybeSingle();
      if (cached) {
        return new Response(JSON.stringify({ ok: true, cached: true, review: cached }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    let signal: any = null;
    if (trade.signal_id) {
      const { data } = await admin.from("signals").select("*").eq("id", trade.signal_id).maybeSingle();
      signal = data;
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userPrompt = `Review this closed PAPER trade. Educational only.

TRADE
  Ticker: ${trade.ticker}
  Direction: ${trade.direction}
  Contract: ${trade.contract_idea ?? "n/a"}
  Entry price: ${trade.entry_price ?? "n/a"}
  Exit price: ${trade.exit_price ?? "n/a"}
  Stop idea: ${trade.stop_idea ?? "n/a"}
  Target idea: ${trade.target_idea ?? "n/a"}
  Status: ${trade.status}
  Exit reason: ${trade.exit_reason ?? "n/a"}
  Realized P/L $: ${trade.current_pl}
  Realized P/L %: ${trade.realized_pl_pct ?? "n/a"}
  MFE: ${trade.mfe ?? "n/a"}  MAE: ${trade.mae ?? "n/a"}
  Opened: ${trade.opened_at}   Closed: ${trade.closed_at ?? "n/a"}

SIGNAL
${signal ? `  Confidence: ${signal.confidence}/100
  Risk: ${signal.risk_level}
  DTE: ${signal.dte ?? "n/a"}
  Source: ${signal.source ?? "n/a"}
  Reasons: ${JSON.stringify(signal.reasons)}
  Flow: ${JSON.stringify(signal.flow_metrics)}
  Technicals: ${JSON.stringify(signal.technical_metrics)}` : "  (no linked signal)"}

Judge entry quality, risk/reward quality, timing, signal strength, and write 1-2 lessons.`;

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
            name: "emit_review",
            description: "Return the structured post-trade review.",
            parameters: {
              type: "object",
              properties: {
                summary: { type: "string" },
                entry_quality: { type: "string" },
                rr_quality: { type: "string" },
                timing: { type: "string" },
                signal_strength: { type: "string" },
                lessons: { type: "string" },
              },
              required: ["summary","entry_quality","rr_quality","timing","signal_strength","lessons"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "emit_review" } },
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
      return new Response(JSON.stringify({ error: "No tool call returned" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let parsed: any;
    try { parsed = JSON.parse(args); } catch {
      return new Response(JSON.stringify({ error: "Bad JSON from model" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: saved, error: saveErr } = await admin
      .from("trade_reviews")
      .upsert({
        trade_id,
        user_id: user.id,
        summary: parsed.summary,
        entry_quality: parsed.entry_quality,
        rr_quality: parsed.rr_quality,
        timing: parsed.timing,
        signal_strength: parsed.signal_strength,
        lessons: parsed.lessons,
        model: "google/gemini-2.5-flash",
      }, { onConflict: "trade_id" })
      .select()
      .single();

    if (saveErr) {
      console.error("save error", saveErr);
      return new Response(JSON.stringify({ error: saveErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, cached: false, review: saved }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("review-trade exception", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
