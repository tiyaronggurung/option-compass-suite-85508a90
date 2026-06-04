// Finviz Elite "extras" endpoints — sub-signals folded into existing scoring components.
// Weights remain 30/25/20/15/10. Each fetch degrades cleanly to null on auth/HTML/empty.
// Reserved providers (Tradier, Unusual Whales) are NOT touched here.

const FINVIZ_KEY = Deno.env.get("FINVIZ_API_KEY") ?? "";

export type FinvizExtraState =
  | "ok"
  | "missing_key"
  | "auth_failed"
  | "not_entitled"
  | "html_response"
  | "empty"
  | "http_error"
  | "fetch_error";

export type FinvizExtraResult<T> = {
  data: T | null;
  state: FinvizExtraState;
  reason?: string;
};

// ---- Internal: classified CSV/JSON fetch with HTML/upsell guard ----
async function finvizFetch(url: string): Promise<{ text: string; state: FinvizExtraState; reason?: string }> {
  if (!FINVIZ_KEY) return { text: "", state: "missing_key", reason: "finviz_key_not_configured" };
  try {
    const res = await fetch(url, { redirect: "follow" });
    const finalUrl = res.url || "";
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) return { text: "", state: "http_error", reason: `HTTP ${res.status}` };
    const text = await res.text();
    if (!text || text.length < 8) return { text: "", state: "empty", reason: "empty body" };
    if (finalUrl.includes("utm_campaign=") || finalUrl.includes("finviz.com/elite")) {
      return { text: "", state: "not_entitled", reason: "redirected to Elite upsell" };
    }
    const head = text.slice(0, 200).toLowerCase();
    if (ct.includes("text/html") || head.includes("<!doctype") || head.includes("<html")) {
      if (head.includes("login") || head.includes("sign in")) {
        return { text: "", state: "auth_failed", reason: "login page returned" };
      }
      return { text: "", state: "html_response", reason: "HTML instead of CSV" };
    }
    return { text, state: "ok" };
  } catch (e) {
    return { text: "", state: "fetch_error", reason: (e as Error).message.slice(0, 100) };
  }
}

// ---- Tiny CSV parser (no deps) ----
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const split = (line: string): string[] => {
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
  };
  const headers = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cols = split(l);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return row;
  });
}

// =============================================================
// 1) Insider Trading — last 30d, per ticker
//    Endpoint: insidertrading.ashx?tc=7&v=2&t=TICKER&auth=KEY
// =============================================================
export type InsiderSummary = {
  buys: number;
  sells: number;
  net_value_usd: number;    // signed: buys - sells
  buy_sell_ratio: number;   // 0..1 share of buys vs total transactions
  rows: number;
};

export async function fetchInsiderSummary(ticker: string): Promise<FinvizExtraResult<InsiderSummary>> {
  const url = `https://elite.finviz.com/insidertrading.ashx?tc=7&v=2&t=${ticker}&auth=${FINVIZ_KEY}`;
  const r = await finvizFetch(url);
  if (r.state !== "ok") return { data: null, state: r.state, reason: r.reason };
  const rows = parseCsv(r.text);
  if (rows.length === 0) {
    return { data: { buys: 0, sells: 0, net_value_usd: 0, buy_sell_ratio: 0.5, rows: 0 }, state: "ok" };
  }
  let buys = 0, sells = 0, netVal = 0;
  for (const row of rows) {
    const tx = (row["Transaction"] ?? row["Type"] ?? "").toLowerCase();
    const valStr = (row["Value ($)"] ?? row["Value"] ?? "0").replace(/[$,]/g, "");
    const val = Number(valStr) || 0;
    if (tx.includes("buy")) { buys++; netVal += val; }
    else if (tx.includes("sale") || tx.includes("sell")) { sells++; netVal -= val; }
  }
  const total = buys + sells;
  const ratio = total > 0 ? buys / total : 0.5;
  return {
    data: { buys, sells, net_value_usd: netVal, buy_sell_ratio: ratio, rows: rows.length },
    state: "ok",
  };
}

// =============================================================
// 2) News Export — per ticker (CSV)
//    Endpoint: news_export.ashx?v=3&t=TICKER&auth=KEY
// =============================================================
export type FinvizNewsSummary = {
  count_24h: number;
  count_7d: number;
  headlines: string[];   // up to 10 recent titles, used for dedupe vs Finnhub
};

export async function fetchFinvizNews(ticker: string): Promise<FinvizExtraResult<FinvizNewsSummary>> {
  const url = `https://elite.finviz.com/news_export.ashx?v=3&t=${ticker}&auth=${FINVIZ_KEY}`;
  const r = await finvizFetch(url);
  if (r.state !== "ok") return { data: null, state: r.state, reason: r.reason };
  const rows = parseCsv(r.text);
  const now = Date.now();
  let c24 = 0, c7 = 0;
  const titles: string[] = [];
  for (const row of rows) {
    const dateStr = row["Date"] ?? row["Datetime"] ?? "";
    const t = Date.parse(dateStr);
    if (!Number.isNaN(t)) {
      const ageH = (now - t) / 3600000;
      if (ageH <= 24) c24++;
      if (ageH <= 168) c7++;
    }
    const title = row["Title"] ?? row["Headline"] ?? "";
    if (title && titles.length < 10) titles.push(title);
  }
  return { data: { count_24h: c24, count_7d: c7, headlines: titles }, state: "ok" };
}

// =============================================================
// 3) Screener Export — bulk fundamentals for multiple tickers
//    Endpoint: export.ashx?v=152&t=NVDA,TSLA,...&auth=KEY
//    Used as a perf cache primer; does NOT change scoring math.
// =============================================================
export type ScreenerRow = Record<string, string>;

export async function fetchScreenerBulk(tickers: string[]): Promise<FinvizExtraResult<Record<string, ScreenerRow>>> {
  if (tickers.length === 0) return { data: {}, state: "ok" };
  const tList = tickers.slice(0, 50).join(",");
  const url = `https://elite.finviz.com/export.ashx?v=152&t=${tList}&auth=${FINVIZ_KEY}`;
  const r = await finvizFetch(url);
  if (r.state !== "ok") return { data: null, state: r.state, reason: r.reason };
  const rows = parseCsv(r.text);
  const byTicker: Record<string, ScreenerRow> = {};
  for (const row of rows) {
    const t = (row["Ticker"] ?? "").toUpperCase();
    if (t) byTicker[t] = row;
  }
  return { data: byTicker, state: "ok" };
}

// =============================================================
// 4) Group/Sector performance — cached 15 min in module scope
//    Endpoint: groups_export.ashx?g=sector&v=140&auth=KEY
// =============================================================
export type SectorPerf = {
  sector: string;
  perf_week_pct: number;
  perf_month_pct: number;
};

let _sectorCache: { at: number; data: Record<string, SectorPerf> } | null = null;
const SECTOR_TTL_MS = 15 * 60 * 1000;

export async function fetchSectorPerformance(): Promise<FinvizExtraResult<Record<string, SectorPerf>>> {
  if (_sectorCache && Date.now() - _sectorCache.at < SECTOR_TTL_MS) {
    return { data: _sectorCache.data, state: "ok" };
  }
  const url = `https://elite.finviz.com/groups_export.ashx?g=sector&v=140&auth=${FINVIZ_KEY}`;
  const r = await finvizFetch(url);
  if (r.state !== "ok") return { data: null, state: r.state, reason: r.reason };
  const rows = parseCsv(r.text);
  const out: Record<string, SectorPerf> = {};
  for (const row of rows) {
    const name = (row["Name"] ?? row["Sector"] ?? "").trim();
    if (!name) continue;
    const wk = parseFloat((row["Perf Week"] ?? "0").replace("%", "")) || 0;
    const mo = parseFloat((row["Perf Month"] ?? "0").replace("%", "")) || 0;
    out[name.toLowerCase()] = { sector: name, perf_week_pct: wk, perf_month_pct: mo };
  }
  _sectorCache = { at: Date.now(), data: out };
  return { data: out, state: "ok" };
}

export type FinvizExtras = {
  insider: FinvizExtraResult<InsiderSummary>;
  news: FinvizExtraResult<FinvizNewsSummary>;
  sectors: FinvizExtraResult<Record<string, SectorPerf>>;
};

export async function fetchFinvizExtrasForTicker(ticker: string): Promise<FinvizExtras> {
  const [insider, news, sectors] = await Promise.all([
    fetchInsiderSummary(ticker),
    fetchFinvizNews(ticker),
    fetchSectorPerformance(),
  ]);
  return { insider, news, sectors };
}
