// Provider debug probe — admin-only diagnostics endpoint.
// Probes a named provider/endpoint and returns classified response metadata.
// Does NOT mutate scoring, does NOT touch Tradier or Unusual Whales.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FINVIZ_KEY = Deno.env.get("FINVIZ_API_KEY") ?? "";
const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const APIFY_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? "";
const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";

function classify(text: string, contentType: string, finalUrl: string) {
  const head = text.slice(0, 200).toLowerCase();
  if (finalUrl.includes("utm_campaign=") || finalUrl.includes("finviz.com/elite")) {
    return { kind: "not_entitled", message: "Redirected to Elite upsell page" };
  }
  if (contentType.includes("text/html") || head.includes("<!doctype") || head.includes("<html")) {
    if (head.includes("login") || head.includes("sign in")) {
      return { kind: "auth_failed", message: "Login page returned — token rejected" };
    }
    return { kind: "html_response", message: "HTML returned instead of expected CSV/JSON" };
  }
  if (!text || text.length < 8) return { kind: "empty", message: "Empty response body" };
  return { kind: "ok", message: "Valid response" };
}

async function probeUrl(url: string, headers: Record<string, string> = {}) {
  const start = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const cls = classify(text, ct.toLowerCase(), res.url ?? "");
    return {
      ok: res.ok && cls.kind === "ok",
      status: res.status,
      content_type: ct,
      final_url: res.url,
      classified: cls,
      bytes: text.length,
      preview: text.slice(0, 400),
      ms: Date.now() - start,
    };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message.slice(0, 200),
      ms: Date.now() - start,
    };
  }
}

async function isAdmin(authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return false;
  const { data } = await supabase
    .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Admin gate
  if (!(await isAdmin(req.headers.get("Authorization")))) {
    return new Response(JSON.stringify({ error: "admin required" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { provider?: string; ticker?: string } = {};
  try { body = await req.json(); } catch {}
  const provider = (body.provider ?? "all").toLowerCase();
  const ticker = (body.ticker ?? "NVDA").toUpperCase();

  const results: Record<string, unknown> = {};

  const probes: Record<string, () => Promise<unknown>> = {
    finviz_main: async () => {
      if (!FINVIZ_KEY) return { skipped: true, reason: "FINVIZ_API_KEY not configured" };
      return probeUrl(`https://elite.finviz.com/export.ashx?v=152&t=${ticker}&auth=${FINVIZ_KEY}`);
    },
    finviz_news: async () => {
      if (!FINVIZ_KEY) return { skipped: true, reason: "FINVIZ_API_KEY not configured" };
      return probeUrl(`https://elite.finviz.com/news_export.ashx?v=3&t=${ticker}&auth=${FINVIZ_KEY}`);
    },
    finviz_insider: async () => {
      if (!FINVIZ_KEY) return { skipped: true, reason: "FINVIZ_API_KEY not configured" };
      return probeUrl(`https://elite.finviz.com/insidertrading.ashx?tc=7&v=2&t=${ticker}&auth=${FINVIZ_KEY}`);
    },
    finviz_sectors: async () => {
      if (!FINVIZ_KEY) return { skipped: true, reason: "FINVIZ_API_KEY not configured" };
      return probeUrl(`https://elite.finviz.com/groups_export.ashx?g=sector&v=140&auth=${FINVIZ_KEY}`);
    },
    finnhub: async () => {
      if (!FINNHUB_KEY) return { skipped: true, reason: "FINNHUB_API_KEY not configured" };
      return probeUrl(`https://finnhub.io/api/v1/news-sentiment?symbol=${ticker}&token=${FINNHUB_KEY}`);
    },
    apify: async () => {
      if (!APIFY_TOKEN) return { skipped: true, reason: "APIFY_API_TOKEN not configured" };
      return probeUrl(`https://api.apify.com/v2/key-value-stores/x_sentiment/records/${ticker}?token=${APIFY_TOKEN}`);
    },
    alpaca: async () => {
      if (!ALPACA_KEY || !ALPACA_SECRET) return { skipped: true, reason: "Alpaca credentials not configured" };
      return probeUrl(`https://data.alpaca.markets/v2/stocks/${ticker}/bars/latest`, {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
      });
    },
  };

  const keys = provider === "all" ? Object.keys(probes) : [provider];
  for (const k of keys) {
    if (!probes[k]) { results[k] = { error: "unknown provider" }; continue; }
    results[k] = await probes[k]();
  }

  return new Response(JSON.stringify({ ticker, results, ts: new Date().toISOString() }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
