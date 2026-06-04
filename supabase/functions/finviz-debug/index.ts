// Finviz debug probe — inspects exactly what quote_export.ashx returns
// for the configured FINVIZ_API_KEY. Read-only. No scoring side effects.
// Never echoes the API key in logs or response.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const FINVIZ_KEY = Deno.env.get("FINVIZ_API_KEY") ?? "";

function redact(s: string): string {
  if (!FINVIZ_KEY) return s;
  return s.split(FINVIZ_KEY).join("***REDACTED***");
}

function classify(status: number, contentType: string, body: string): {
  kind: string;
  message: string;
} {
  const ct = contentType.toLowerCase();
  const head = body.slice(0, 200).toLowerCase();
  if (status === 401 || status === 403) {
    return { kind: "unauthorized", message: `HTTP ${status} — token rejected or endpoint not on plan` };
  }
  if (status >= 500) {
    return { kind: "server_error", message: `HTTP ${status} — Finviz server error` };
  }
  if (status === 302 || status === 301) {
    return { kind: "redirect", message: "Finviz returned a redirect (likely login)" };
  }
  if (ct.includes("text/html") || head.includes("<!doctype") || head.includes("<html")) {
    if (head.includes("login") || head.includes("sign in")) {
      return { kind: "login_page", message: "Finviz returned the login page — auth token not accepted" };
    }
    return { kind: "html_response", message: "Finviz returned HTML instead of CSV — wrong endpoint or paywall" };
  }
  if (!body || body.trim().length < 20) {
    return { kind: "empty", message: "Empty response body" };
  }
  if (ct.includes("text/csv") || ct.includes("application/octet-stream") || body.includes(",")) {
    const lines = body.trim().split("\n");
    if (lines.length < 2) {
      return { kind: "csv_no_data", message: `CSV header only (${lines.length} line) — no data row` };
    }
    return { kind: "csv_ok", message: `CSV with ${lines.length} lines` };
  }
  return { kind: "unknown", message: `Unrecognized response (content-type: ${contentType || "none"})` };
}

function parseCsv(text: string): Record<string, string> | null {
  try {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const splitCsv = (l: string): string[] => {
      const out: string[] = [];
      let cur = "", inQ = false;
      for (const ch of l) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
        cur += ch;
      }
      out.push(cur);
      return out;
    };
    const headers = splitCsv(lines[0]);
    const values = splitCsv(lines[1]);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] ?? "").trim(); });
    return row;
  } catch { return null; }
}

async function probe(ticker: string, paramName: "auth" | "apikey", followRedirect: boolean) {
  const url = `https://elite.finviz.com/quote_export.ashx?t=${encodeURIComponent(ticker)}&${paramName}=${encodeURIComponent(FINVIZ_KEY)}`;
  const start = Date.now();
  let status = 0, contentType = "", body = "", error: string | null = null;
  let location: string | null = null;
  let finalUrl: string | null = null;
  try {
    const res = await fetch(url, { redirect: followRedirect ? "follow" : "manual" });
    status = res.status;
    contentType = res.headers.get("content-type") ?? "";
    location = res.headers.get("location");
    finalUrl = res.url;
    body = await res.text();
  } catch (e) {
    error = (e as Error).message;
  }
  const cls = classify(status, contentType, body);
  const parsedRow = cls.kind === "csv_ok" ? parseCsv(body) : null;
  const keyFields = parsedRow ? Object.fromEntries(
    ["Ticker", "Price", "Optionable", "Rel Volume", "SMA50", "SMA200", "Perf Week",
     "Volatility", "ATR", "Short Float", "Recom"]
      .map((k) => [k, parsedRow[k] ?? null]),
  ) : null;
  return {
    ticker,
    auth_param: paramName,
    follow_redirect: followRedirect,
    url_template: `https://elite.finviz.com/quote_export.ashx?t=${ticker}&${paramName}=***REDACTED***`,
    final_url: finalUrl ? redact(finalUrl) : null,
    redirect_location: location ? redact(location) : null,
    duration_ms: Date.now() - start,
    http_status: status,
    content_type: contentType,
    classification: cls.kind,
    message: cls.message,
    error: error ? redact(error) : null,
    body_length: body.length,
    body_preview: redact(body.slice(0, 1000)),
    parsed_row_field_count: parsedRow ? Object.keys(parsedRow).length : 0,
    parsed_key_fields: keyFields,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!FINVIZ_KEY) {
    return new Response(JSON.stringify({
      ok: false,
      error: "FINVIZ_API_KEY is not configured",
    }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") ?? "NVDA").toUpperCase().trim();

  // Probe with both auth param names to confirm which one Finviz accepts.
  const [authResult, apikeyResult] = await Promise.all([
    probe(ticker, "auth"),
    probe(ticker, "apikey"),
  ]);

  // Recommendation
  let recommendation = "";
  if (authResult.classification === "csv_ok") {
    recommendation = `Auth param "auth" works. Current scoring code is correct.`;
  } else if (apikeyResult.classification === "csv_ok") {
    recommendation = `Auth param "apikey" works. Update scoring.ts to use apikey=<KEY> instead of auth=<KEY>.`;
  } else if (authResult.classification === "login_page" || apikeyResult.classification === "login_page") {
    recommendation = `Token is being rejected — Finviz returned the login page for both param names. Verify the FINVIZ_API_KEY value (it must be the Elite "Export auth token" from finviz.com/account, not the login password).`;
  } else if (authResult.classification === "html_response" || apikeyResult.classification === "html_response") {
    recommendation = `Finviz returned HTML, suggesting the quote_export.ashx endpoint is not available on the current plan. Confirm Finviz Elite subscription is active and includes data exports.`;
  } else if (authResult.classification === "unauthorized" || apikeyResult.classification === "unauthorized") {
    recommendation = `HTTP 401/403 from Finviz — token invalid or endpoint not entitled.`;
  } else {
    recommendation = `Neither auth nor apikey returned valid CSV. See classifications below.`;
  }

  return new Response(JSON.stringify({
    ok: true,
    ticker,
    key_configured: true,
    key_length: FINVIZ_KEY.length,
    recommendation,
    probes: { auth: authResult, apikey: apikeyResult },
  }, null, 2), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
