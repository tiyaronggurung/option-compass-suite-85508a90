// Insider Intelligence sync — Phase 1.
// - Pulls per-ticker insider transactions from Finviz (when entitled).
// - SEC Form 4 adapter is a typed stub (architecture only).
// - Writes normalized rows to public.insider_transactions (idempotent upsert).
// - Computes per-ticker public.insider_strength_scores (METADATA ONLY — never
//   read by scoring engine in this phase).
//
// Does NOT touch: scoring math, weights, scanner, tiers, Tradier, UW, paper, live, guest.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FINVIZ_KEY = Deno.env.get("FINVIZ_API_KEY") ?? "";
const INGEST_SECRET = Deno.env.get("SIGNAL_INGEST_SECRET") ?? "";

// ---------- types ----------
type RawTx = {
  ticker: string;
  insider_name: string;
  role: string | null;
  transaction_type: string; // P/S/A/M/G/Other or original label
  filing_date: string | null;
  transaction_date: string;
  shares: number | null;
  price: number | null;
  total_value: number | null;
  direction: "buy" | "sell" | "neutral";
  source: string;
  external_ref: string;
  raw: Record<string, unknown>;
};

type AdapterResult = {
  ok: boolean;
  state: string;
  reason?: string;
  rows: RawTx[];
};

interface InsiderAdapter {
  name: string;
  available: boolean;
  fetchForTicker(ticker: string): Promise<AdapterResult>;
}

// ---------- CSV helpers ----------
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cols = splitCsvLine(l);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return row;
  });
}

function normalizeRole(raw: string): string {
  const r = (raw || "").toLowerCase();
  if (r.includes("chief executive") || r === "ceo" || r.includes(" ceo")) return "CEO";
  if (r.includes("chief financial") || r === "cfo" || r.includes(" cfo")) return "CFO";
  if (r.includes("chief operating") || r === "coo") return "COO";
  if (r.includes("director")) return "Director";
  if (r.includes("officer") || r.includes("president") || r.includes("vp ")) return "Officer";
  if (r.includes("10%") || r.includes("beneficial")) return "10%";
  return raw?.trim() || "Other";
}

function classifyTransaction(raw: string): { code: string; direction: "buy" | "sell" | "neutral" } {
  const t = (raw || "").toLowerCase();
  if (t.includes("buy") || t.includes("purchase") || t.startsWith("p")) return { code: "P-Purchase", direction: "buy" };
  if (t.includes("sale") || t.includes("sell") || t.startsWith("s")) return { code: "S-Sale", direction: "sell" };
  if (t.includes("option exercise") || t.includes("exercise")) return { code: "M-OptionExercise", direction: "neutral" };
  if (t.includes("grant") || t.includes("award")) return { code: "A-Grant", direction: "neutral" };
  if (t.includes("gift")) return { code: "G-Gift", direction: "neutral" };
  return { code: raw?.trim() || "Other", direction: "neutral" };
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[$,]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

async function sha(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ---------- Adapter: Finviz ----------
const finvizAdapter: InsiderAdapter = {
  name: "finviz",
  available: !!FINVIZ_KEY,
  async fetchForTicker(ticker: string): Promise<AdapterResult> {
    if (!FINVIZ_KEY) return { ok: false, state: "missing_key", reason: "FINVIZ_API_KEY missing", rows: [] };
    const url = `https://elite.finviz.com/insidertrading.ashx?tc=7&v=2&t=${ticker}&auth=${FINVIZ_KEY}`;
    try {
      const res = await fetch(url, { redirect: "follow" });
      const finalUrl = res.url || "";
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!res.ok) return { ok: false, state: "http_error", reason: `HTTP ${res.status}`, rows: [] };
      const text = await res.text();
      if (finalUrl.includes("finviz.com/elite") || finalUrl.includes("utm_campaign=")) {
        return { ok: false, state: "not_entitled", reason: "redirected to Elite upsell", rows: [] };
      }
      const head = text.slice(0, 200).toLowerCase();
      if (ct.includes("text/html") || head.includes("<!doctype") || head.includes("<html")) {
        return { ok: false, state: "html_response", reason: "HTML instead of CSV", rows: [] };
      }
      if (!text || text.length < 8) return { ok: false, state: "empty", reason: "empty body", rows: [] };

      const parsed = parseCsv(text);
      const rows: RawTx[] = [];
      for (const r of parsed) {
        const insider = r["Insider Trading"] ?? r["Owner"] ?? r["Insider"] ?? "";
        if (!insider) continue;
        const role = r["Relationship"] ?? r["Title"] ?? "";
        const txRaw = r["Transaction"] ?? r["Type"] ?? "";
        const cls = classifyTransaction(txRaw);
        const txDate = isoDate(r["Date"] ?? r["Transaction Date"] ?? "");
        if (!txDate) continue;
        const filingDate = isoDate(r["SEC Form 4"] ?? r["Filing Date"] ?? "");
        const shares = num(r["#Shares"] ?? r["Shares"]);
        const price = num(r["Cost"] ?? r["Price"]);
        const value = num(r["Value ($)"] ?? r["Value"]);
        const ref = await sha(`finviz|${ticker}|${insider}|${txDate}|${cls.code}|${shares ?? ""}`);
        rows.push({
          ticker,
          insider_name: insider.slice(0, 200),
          role: normalizeRole(role),
          transaction_type: cls.code,
          filing_date: filingDate,
          transaction_date: txDate,
          shares,
          price,
          total_value: value,
          direction: cls.direction,
          source: "finviz",
          external_ref: ref,
          raw: r,
        });
      }
      return { ok: true, state: "ok", rows };
    } catch (e) {
      return { ok: false, state: "fetch_error", reason: (e as Error).message.slice(0, 120), rows: [] };
    }
  },
};

// ---------- Adapter: SEC EDGAR Form 4 ----------
// Primary insider source. Canonical, free, structured XML.
// Polite: User-Agent header + small inter-request sleeps; sequential only.
const SEC_UA = "TradingFlow Insider Research insider-sync@tradingflow.app";
const SEC_LOOKBACK_DAYS = 90;
const SEC_MAX_FILINGS_PER_TICKER = 25;
const SEC_REQUEST_GAP_MS = 130; // ~7-8 req/s, well under SEC 10 req/s limit

let CIK_MAP: Map<string, string> | null = null;
let CIK_MAP_FETCHED_AT = 0;
const CIK_MAP_TTL_MS = 6 * 60 * 60 * 1000;

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function secFetch(url: string, attempt = 1): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA, "Accept": "*/*" } });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(400 * attempt);
    return secFetch(url, attempt + 1);
  }
  return res;
}

async function loadCikMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (CIK_MAP && now - CIK_MAP_FETCHED_AT < CIK_MAP_TTL_MS) return CIK_MAP;
  const res = await secFetch("https://www.sec.gov/files/company_tickers.json");
  if (!res.ok) throw new Error(`company_tickers.json HTTP ${res.status}`);
  const json = await res.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
  const map = new Map<string, string>();
  for (const v of Object.values(json)) {
    if (v?.ticker && v?.cik_str != null) {
      map.set(String(v.ticker).toUpperCase(), String(v.cik_str).padStart(10, "0"));
    }
  }
  CIK_MAP = map; CIK_MAP_FETCHED_AT = now;
  return map;
}

function classifySecCode(code: string, acquiredDisposed: string): { code: string; direction: "buy" | "sell" | "neutral" } {
  const c = (code || "").toUpperCase().trim();
  if (c === "P") return { code: "P-Purchase", direction: "buy" };
  if (c === "S") return { code: "S-Sale", direction: "sell" };
  if (c === "A") return { code: "A-Grant", direction: "neutral" };
  if (c === "M") return { code: "M-OptionExercise", direction: "neutral" };
  if (c === "G") return { code: "G-Gift", direction: "neutral" };
  if (c === "F") return { code: "F-TaxWithhold", direction: "neutral" };
  if (c === "D") return { code: "D-Disposition", direction: acquiredDisposed === "A" ? "buy" : "sell" };
  if (c === "X") return { code: "X-OptionExercise", direction: "neutral" };
  if (c === "C") return { code: "C-Conversion", direction: "neutral" };
  if (c === "J") return { code: "J-Other", direction: "neutral" };
  return { code: c ? `${c}-Other` : "Other", direction: "neutral" };
}

function secRoleFrom(rel: { isDirector: boolean; isOfficer: boolean; isTenPercent: boolean; isOther: boolean; officerTitle: string }): string {
  const title = (rel.officerTitle || "").trim();
  if (rel.isOfficer && title) {
    const norm = normalizeRole(title);
    if (norm && norm !== "Other") return norm;
    return "Officer";
  }
  if (rel.isOfficer) return "Officer";
  if (rel.isDirector) return "Director";
  if (rel.isTenPercent) return "10%";
  if (rel.isOther) return "Other";
  return "Other";
}

// Extract first match of <tag>...<value>X</value>...</tag> or <tag>X</tag>.
function xmlInner(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return null;
  const inner = m[1];
  const v = inner.match(/<value>([\s\S]*?)<\/value>/);
  return (v ? v[1] : inner).trim();
}
function xmlFlag(xml: string, tag: string): boolean {
  const v = xmlInner(xml, tag);
  return v === "1" || v?.toLowerCase() === "true";
}
function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

type ParsedFiling = {
  rows: RawTx[];
  filing_date: string | null;
  accession: string;
};

async function parseForm4Xml(xml: string, ticker: string, accession: string, filingDate: string | null): Promise<RawTx[]> {
  const ownerBlock = blocks(xml, "reportingOwner")[0] ?? "";
  const ownerName = xmlInner(ownerBlock, "rptOwnerName") ?? "Unknown";
  const rel = {
    isDirector: xmlFlag(ownerBlock, "isDirector"),
    isOfficer: xmlFlag(ownerBlock, "isOfficer"),
    isTenPercent: xmlFlag(ownerBlock, "isTenPercentOwner"),
    isOther: xmlFlag(ownerBlock, "isOther"),
    officerTitle: xmlInner(ownerBlock, "officerTitle") ?? "",
  };
  const role = secRoleFrom(rel);

  const rows: RawTx[] = [];
  const txTags = ["nonDerivativeTransaction", "derivativeTransaction"];
  for (const tag of txTags) {
    for (const tx of blocks(xml, tag)) {
      const txDate = xmlInner(tx, "transactionDate");
      if (!txDate) continue;
      const codingBlock = blocks(tx, "transactionCoding")[0] ?? "";
      const code = xmlInner(codingBlock, "transactionCode") ?? "";
      const amounts = blocks(tx, "transactionAmounts")[0] ?? "";
      const sharesStr = xmlInner(amounts, "transactionShares") ?? "";
      const priceStr = xmlInner(amounts, "transactionPricePerShare") ?? "";
      const adCode = xmlInner(amounts, "transactionAcquiredDisposedCode") ?? "";
      const cls = classifySecCode(code, adCode);
      const shares = num(sharesStr);
      const price = num(priceStr);
      const totalValue = (shares != null && price != null) ? Math.round(shares * price * 100) / 100 : null;
      const ref = await sha(`sec|${accession}|${ticker}|${ownerName}|${txDate}|${cls.code}|${sharesStr}|${priceStr}|${tag}`);
      rows.push({
        ticker,
        insider_name: ownerName.slice(0, 200),
        role,
        transaction_type: cls.code,
        filing_date: filingDate,
        transaction_date: txDate.slice(0, 10),
        shares,
        price,
        total_value: totalValue,
        direction: cls.direction,
        source: "sec_form4",
        external_ref: ref,
        raw: { accession, securityKind: tag, code, ad: adCode, officerTitle: rel.officerTitle },
      });
    }
  }
  return rows;
}

const secForm4Adapter: InsiderAdapter = {
  name: "sec_form4",
  available: true,
  async fetchForTicker(ticker: string): Promise<AdapterResult> {
    try {
      const map = await loadCikMap();
      const cik = map.get(ticker.toUpperCase());
      if (!cik) return { ok: false, state: "no_cik", reason: `no CIK for ${ticker}`, rows: [] };

      const cutoff = Date.now() - SEC_LOOKBACK_DAYS * 86400000;
      const feedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=${SEC_MAX_FILINGS_PER_TICKER}&output=atom`;
      await sleep(SEC_REQUEST_GAP_MS);
      const feedRes = await secFetch(feedUrl);
      if (!feedRes.ok) return { ok: false, state: "feed_error", reason: `feed HTTP ${feedRes.status}`, rows: [] };
      const feed = await feedRes.text();

      const entries: Array<{ accession: string; filingDate: string | null }> = [];
      for (const entry of blocks(feed, "entry")) {
        const accession = xmlInner(entry, "accession-number");
        const filingDate = xmlInner(entry, "filing-date");
        const formType = xmlInner(entry, "filing-type");
        if (!accession || formType !== "4") continue;
        if (filingDate) {
          const ts = Date.parse(filingDate);
          if (Number.isFinite(ts) && ts < cutoff) continue;
        }
        entries.push({ accession, filingDate });
      }
      if (entries.length === 0) return { ok: true, state: "no_recent_filings", rows: [] };

      const allRows: RawTx[] = [];
      for (const e of entries) {
        const accNoDash = e.accession.replace(/-/g, "");
        const idxUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDash}/index.json`;
        await sleep(SEC_REQUEST_GAP_MS);
        const idxRes = await secFetch(idxUrl);
        if (!idxRes.ok) continue;
        const idx = await idxRes.json() as { directory?: { item?: Array<{ name: string }> } };
        const items = idx?.directory?.item ?? [];
        // Prefer the structured form4 xml; skip the index/footer xml.
        const xmlFile = items.find((i) => /form4.*\.xml$/i.test(i.name))
          ?? items.find((i) => /primary_doc\.xml$/i.test(i.name))
          ?? items.find((i) => /\.xml$/i.test(i.name) && !/index|footer|filer/i.test(i.name));
        if (!xmlFile) continue;
        const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDash}/${xmlFile.name}`;
        await sleep(SEC_REQUEST_GAP_MS);
        const xmlRes = await secFetch(xmlUrl);
        if (!xmlRes.ok) continue;
        const xml = await xmlRes.text();
        if (!xml.includes("<ownershipDocument") && !xml.includes("ownershipDocument")) continue;
        try {
          const rows = await parseForm4Xml(xml, ticker.toUpperCase(), e.accession, e.filingDate);
          allRows.push(...rows);
        } catch (_) { /* skip malformed filing */ }
      }

      return { ok: true, state: "ok", rows: allRows };
    } catch (e) {
      return { ok: false, state: "fetch_error", reason: (e as Error).message.slice(0, 160), rows: [] };
    }
  },
};

// Order matters: SEC first (canonical), Finviz second (degraded — usually html_response).
const ADAPTERS: InsiderAdapter[] = [secForm4Adapter, finvizAdapter];

// ---------- Strength score ----------
type StrengthOut = {
  score: number;
  label: string;
  signals: Array<{ kind: string; weight: number; detail: string }>;
  buy_count_30d: number;
  sell_count_30d: number;
  buy_count_90d: number;
  sell_count_90d: number;
  total_buy_value_90d: number;
};

function labelFor(score: number): string {
  if (score >= 80) return "strong_buy";
  if (score >= 65) return "buy";
  if (score >= 45) return "neutral";
  if (score >= 30) return "sell";
  return "strong_sell";
}

function computeStrength(rows: RawTx[]): StrengthOut {
  const now = Date.now();
  const day = 86400000;
  const w90 = rows.filter((r) => now - Date.parse(r.transaction_date) <= 90 * day);
  const w30 = rows.filter((r) => now - Date.parse(r.transaction_date) <= 30 * day);

  const buys90 = w90.filter((r) => r.direction === "buy");
  const sells90 = w90.filter((r) => r.direction === "sell");
  const buys30 = w30.filter((r) => r.direction === "buy");
  const sells30 = w30.filter((r) => r.direction === "sell");
  const exercises = w90.filter((r) => r.transaction_type === "M-OptionExercise");
  const grants = w90.filter((r) => r.transaction_type === "A-Grant");

  const totalBuyValue90 = buys90.reduce((s, r) => s + (r.total_value ?? 0), 0);
  const uniqueBuyers = new Set(buys30.map((r) => r.insider_name.toLowerCase())).size;

  let score = 50;
  const signals: Array<{ kind: string; weight: number; detail: string }> = [];

  // Strong signals (additive)
  for (const role of ["CEO", "CFO"] as const) {
    const buys = buys90.filter((r) => r.role === role);
    if (buys.length > 0) {
      const w = role === "CEO" ? 25 : 20;
      score += w;
      signals.push({ kind: `${role.toLowerCase()}_buy`, weight: w, detail: `${buys.length} ${role} buy(s) in 90d` });
    }
  }
  const directorBuys = buys90.filter((r) => r.role === "Director");
  if (directorBuys.length > 0) {
    score += 12;
    signals.push({ kind: "director_buy", weight: 12, detail: `${directorBuys.length} director buy(s) in 90d` });
  }
  if (uniqueBuyers >= 3) {
    score += 10;
    signals.push({ kind: "multiple_insiders", weight: 10, detail: `${uniqueBuyers} unique buyers in 30d` });
  }
  if (buys30.length >= 3) {
    score += 15;
    signals.push({ kind: "cluster_30d", weight: 15, detail: `${buys30.length} buys in 30d` });
  }
  if (totalBuyValue90 > 500_000) {
    score += 10;
    signals.push({ kind: "large_dollar", weight: 10, detail: `$${Math.round(totalBuyValue90).toLocaleString()} bought in 90d` });
  }

  // Weak/negative signals
  if (sells90.length > buys90.length && sells90.length >= 3) {
    score -= 10;
    signals.push({ kind: "net_selling", weight: -10, detail: `${sells90.length} sells vs ${buys90.length} buys in 90d` });
  }
  if (exercises.length > 0 && exercises.length >= buys90.length) {
    score -= 10;
    signals.push({ kind: "option_exercise_dominant", weight: -10, detail: `${exercises.length} option exercises` });
  }
  if (grants.length > 0 && grants.length >= buys90.length && buys90.length === 0) {
    score -= 5;
    signals.push({ kind: "grants_dominant", weight: -5, detail: `${grants.length} grants, no purchases` });
  }
  if (buys90.length > 0 && totalBuyValue90 > 0 && totalBuyValue90 < 25_000) {
    score -= 5;
    signals.push({ kind: "only_small_buys", weight: -5, detail: `Buys total $${Math.round(totalBuyValue90).toLocaleString()}` });
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    label: labelFor(score),
    signals,
    buy_count_30d: buys30.length,
    sell_count_30d: sells30.length,
    buy_count_90d: buys90.length,
    sell_count_90d: sells90.length,
    total_buy_value_90d: totalBuyValue90,
  };
}

// ---------- Auth ----------
async function isAdmin(authHeader: string | null, admin: SupabaseClient): Promise<boolean> {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return false;
  const { data } = await admin
    .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
  return !!data;
}

// ---------- Universe selection ----------
async function resolveTickers(admin: SupabaseClient, override?: string[]): Promise<string[]> {
  if (override && override.length > 0) return override.map((t) => t.toUpperCase().trim()).filter(Boolean).slice(0, 50);
  // Default: distinct watchlist tickers across all users (capped).
  const { data } = await admin
    .from("watchlist_items").select("ticker").limit(500);
  const set = new Set<string>();
  for (const r of (data ?? [])) {
    if (r.ticker) set.add(String(r.ticker).toUpperCase());
  }
  return Array.from(set).slice(0, 50);
}

// ---------- Main ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Auth: admin user OR cron with shared secret
  const authHeader = req.headers.get("Authorization");
  const cronSecret = req.headers.get("x-ingest-secret");
  const authedAdmin = await isAdmin(authHeader, admin);
  const authedCron = !!INGEST_SECRET && cronSecret === INGEST_SECRET;
  if (!authedAdmin && !authedCron) {
    return new Response(JSON.stringify({ error: "admin or ingest secret required" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { tickers?: string[] } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const tickers = await resolveTickers(admin, body.tickers);
  if (tickers.length === 0) {
    return new Response(JSON.stringify({ ok: true, note: "no tickers", per_ticker: {} }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const perTicker: Record<string, { adapters: Record<string, { state: string; rows: number; reason?: string }>; strength?: StrengthOut; error?: string }> = {};
  let totalInserted = 0;
  let totalStrength = 0;

  // Sequential per ticker to be polite to Finviz; small N.
  for (const ticker of tickers) {
    perTicker[ticker] = { adapters: {} };
    const collected: RawTx[] = [];
    for (const adapter of ADAPTERS) {
      if (!adapter.available) {
        perTicker[ticker].adapters[adapter.name] = { state: "unavailable", rows: 0, reason: "adapter disabled" };
        continue;
      }
      const r = await adapter.fetchForTicker(ticker);
      perTicker[ticker].adapters[adapter.name] = { state: r.state, rows: r.rows.length, reason: r.reason };
      if (r.ok) collected.push(...r.rows);
    }

    if (collected.length > 0) {
      // Upsert by external_ref (per-source unique). Use the dedupe unique index as fallback.
      const payload = collected.map((r) => ({
        ticker: r.ticker,
        insider_name: r.insider_name,
        role: r.role,
        transaction_type: r.transaction_type,
        filing_date: r.filing_date,
        transaction_date: r.transaction_date,
        shares: r.shares,
        price: r.price,
        total_value: r.total_value,
        direction: r.direction,
        source: r.source,
        external_ref: r.external_ref,
        raw: r.raw,
      }));
      // Idempotent: ignore conflicts on the dedupe unique index.
      const { error, count } = await admin
        .from("insider_transactions")
        .upsert(payload, { onConflict: "ticker,insider_name,transaction_date,transaction_type,shares,source", ignoreDuplicates: true, count: "exact" });
      if (error) {
        perTicker[ticker].error = error.message.slice(0, 200);
      } else if (typeof count === "number") {
        totalInserted += count;
      }
    }

    // Strength score: read last 90d (covers prior history + new inserts).
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const { data: txRows } = await admin
      .from("insider_transactions")
      .select("ticker, insider_name, role, transaction_type, transaction_date, shares, price, total_value, direction, source")
      .eq("ticker", ticker)
      .gte("transaction_date", since);
    const normalized: RawTx[] = (txRows ?? []).map((r: any) => ({ ...r, filing_date: null, external_ref: "", raw: {} }));
    const strength = computeStrength(normalized);
    const { error: sErr } = await admin.from("insider_strength_scores").upsert({
      ticker,
      score: strength.score,
      label: strength.label,
      signals: strength.signals,
      window_days: 90,
      buy_count_30d: strength.buy_count_30d,
      sell_count_30d: strength.sell_count_30d,
      buy_count_90d: strength.buy_count_90d,
      sell_count_90d: strength.sell_count_90d,
      total_buy_value_90d: strength.total_buy_value_90d,
      as_of: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (sErr) perTicker[ticker].error = (perTicker[ticker].error ?? "") + " | strength: " + sErr.message.slice(0, 120);
    else { perTicker[ticker].strength = strength; totalStrength++; }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      note: "Phase 1 insider sync — metadata only, scoring engine untouched.",
      tickers_processed: tickers.length,
      rows_inserted_estimate: totalInserted,
      strength_scored: totalStrength,
      per_ticker: perTicker,
    }, null, 2),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
