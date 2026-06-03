// Backend signal scanner — Alpaca bars → simple TA rules → inserts into public.signals.
// No live orders, paper/signal generation only. Triggered by pg_cron (service role) or
// by an admin "Run Scan Now" button. Market-hours gated in America/New_York.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_TICKERS = ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "AAPL", "META", "MSFT"];
const ALPACA_DATA_BASE = "https://data.alpaca.markets";
const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
const ALPACA_SECRET = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };

// ---------- Market hours (America/New_York) ----------
function isMarketOpenET(now = new Date()): { open: boolean; reason: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (weekday === "Sat" || weekday === "Sun") return { open: false, reason: "weekend" };
  const mins = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (mins < open || mins >= close) return { open: false, reason: "outside_hours" };
  return { open: true, reason: "ok" };
}

// ---------- Indicators ----------
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(v);
    prev = v;
  }
  return out;
}
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}
function vwap(bars: Bar[]): number {
  let pv = 0, vv = 0;
  for (const b of bars) {
    const typ = (b.h + b.l + b.c) / 3;
    pv += typ * b.v;
    vv += b.v;
  }
  return vv === 0 ? bars[bars.length - 1].c : pv / vv;
}

// ---------- Alpaca ----------
async function fetchBars(symbol: string): Promise<Bar[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeframe: "5Min",
    start: start.toISOString(),
    end: end.toISOString(),
    limit: "1000",
    adjustment: "raw",
    feed: "iex",
  });
  const url = `${ALPACA_DATA_BASE}/v2/stocks/${symbol}/bars?${params}`;
  const res = await fetch(url, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Alpaca ${symbol} ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.bars ?? []) as Bar[];
}

// ---------- Rules ----------
type SignalDraft = {
  ticker: string;
  direction: "CALL" | "PUT";
  price: number;
  confidence: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  reasons: string[];
  technical_metrics: Record<string, number>;
};

function evaluate(symbol: string, bars: Bar[]): SignalDraft | null {
  if (bars.length < 30) return null;
  const closes = bars.map((b) => b.c);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsiNow = rsi(closes, 14);
  const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const todayBars = bars.filter((b) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(b.t));
    return d === etDate;
  });
  const vw = todayBars.length >= 3 ? vwap(todayBars) : vwap(bars.slice(-20));
  const avgVol20 = bars.slice(-21, -1).reduce((a, b) => a + b.v, 0) / 20;
  const volSpike = avgVol20 > 0 ? last.v / avgVol20 : 1;

  const e9 = ema9[ema9.length - 1];
  const e21 = ema21[ema21.length - 1];
  const e9p = ema9[ema9.length - 2];
  const e21p = ema21[ema21.length - 2];

  const bullCross = e9p <= e21p && e9 > e21;
  const bearCross = e9p >= e21p && e9 < e21;
  const vwapReclaim = prev.c < vw && last.c > vw;
  const vwapBreakdown = prev.c > vw && last.c < vw;

  const reasons: string[] = [];
  let dir: "CALL" | "PUT" | null = null;
  let score = 0;

  if (e9 > e21) { score += 15; reasons.push("EMA9 above EMA21"); }
  if (bullCross) { score += 20; reasons.push("EMA9/EMA21 bullish cross"); dir = "CALL"; }
  if (rsiNow > 55 && rsiNow < 75) { score += 15; reasons.push(`RSI momentum ${rsiNow.toFixed(0)}`); if (!dir) dir = "CALL"; }
  if (vwapReclaim) { score += 20; reasons.push("VWAP reclaim"); if (!dir) dir = "CALL"; }

  let bearScore = 0;
  const bearReasons: string[] = [];
  if (e9 < e21) { bearScore += 15; bearReasons.push("EMA9 below EMA21"); }
  if (bearCross) { bearScore += 20; bearReasons.push("EMA9/EMA21 bearish cross"); }
  if (rsiNow < 45 && rsiNow > 25) { bearScore += 15; bearReasons.push(`RSI weakness ${rsiNow.toFixed(0)}`); }
  if (vwapBreakdown) { bearScore += 20; bearReasons.push("VWAP breakdown"); }

  if (bearScore > score) {
    dir = "PUT";
    score = bearScore;
    reasons.length = 0;
    reasons.push(...bearReasons);
  }

  if (volSpike >= 1.5) { score += 15; reasons.push(`Volume ${volSpike.toFixed(1)}× avg`); }

  // No directional bias at all — not a candidate
  if (!dir) return null;

  const confidence = Math.min(95, Math.round(score));
  const risk_level: "LOW" | "MEDIUM" | "HIGH" =
    confidence >= 80 ? "LOW" : confidence >= 65 ? "MEDIUM" : "HIGH";

  return {
    ticker: symbol,
    direction: dir,
    price: last.c,
    confidence,
    risk_level,
    reasons,
    technical_metrics: {
      rsi: Number(rsiNow.toFixed(2)),
      ema9: Number(e9.toFixed(2)),
      ema21: Number(e21.toFixed(2)),
      vwap: Number(vw.toFixed(2)),
      volume_spike: Number(volSpike.toFixed(2)),
    },
  };
}

const PROFILE_THRESHOLDS: Record<string, number> = {
  conservative: 60,
  balanced: 50,
  active_mvp: 40,
};

async function loadScannerSettings(): Promise<{ profile: string; threshold: number; debug_mode: boolean }> {
  const { data } = await admin.from("scanner_settings").select("profile, debug_mode").eq("id", "global").maybeSingle();
  const profile = (data?.profile as string) ?? "balanced";
  const debug_mode = !!data?.debug_mode;
  const threshold = PROFILE_THRESHOLDS[profile] ?? 50;
  return { profile, threshold, debug_mode };
}

// ---------- Auth ----------
async function authorize(req: Request): Promise<{ ok: true; trigger: string } | { ok: false; status: number; msg: string }> {
  const authz = req.headers.get("Authorization") ?? "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";

  // Cron path: service-role token in Authorization
  if (token && token === SERVICE_KEY) return { ok: true, trigger: "cron" };

  // User path: must be admin
  if (!token) return { ok: false, status: 401, msg: "unauthorized" };
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authz } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return { ok: false, status: 401, msg: "unauthorized" };
  const { data: role } = await admin
    .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
  if (!role) return { ok: false, status: 403, msg: "admin only" };
  return { ok: true, trigger: "manual" };
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorize(req);
  if (!auth.ok) return json({ error: auth.msg }, auth.status);

  // Optional force flag — honored ONLY for manual (admin) trigger, never for cron
  let force = false;
  try {
    const body = await req.json().catch(() => null);
    if (body && typeof body === "object" && (body as any).force === true) force = true;
  } catch { /* ignore */ }
  if (auth.trigger !== "manual") force = false;

  const t0 = Date.now();
  const tickers = DEFAULT_TICKERS;
  const settings = await loadScannerSettings();

  // Market-hours gate (bypassable by admin force run)
  const market = isMarketOpenET();
  if (!market.open && !force) {
    await admin.from("signal_scan_runs").insert({
      status: market.reason, trigger: auth.trigger, tickers_scanned: tickers,
      signals_created: 0, skipped_count: tickers.length, duration_ms: Date.now() - t0,
      profile: settings.profile, threshold: settings.threshold,
    });
    return json({ ok: true, status: market.reason, signals_created: 0 });
  }

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    await admin.from("signal_scan_runs").insert({
      status: "error", trigger: auth.trigger, tickers_scanned: tickers,
      error: "Alpaca credentials missing", duration_ms: Date.now() - t0,
      profile: settings.profile, threshold: settings.threshold,
    });
    return json({ error: "Alpaca not configured" }, 500);
  }

  let created = 0;
  let skipped = 0;
  let wouldHave = 0;
  let candidates = 0;
  const scores: number[] = [];
  const skippedList: Array<{ ticker: string; direction: string; score: number; reasons: string[] }> = [];
  const errors: string[] = [];

  for (const sym of tickers) {
    try {
      const bars = await fetchBars(sym);
      const draft = evaluate(sym, bars);
      if (!draft) { skipped++; continue; }

      candidates++;
      scores.push(draft.confidence);

      // Would-have-created: only when threshold >= 50, count [threshold-10, threshold-1]
      if (settings.threshold >= 50 &&
          draft.confidence >= settings.threshold - 10 &&
          draft.confidence < settings.threshold) {
        wouldHave++;
      }

      if (draft.confidence < settings.threshold) {
        skipped++;
        skippedList.push({
          ticker: draft.ticker,
          direction: draft.direction,
          score: draft.confidence,
          reasons: draft.reasons,
        });
        continue;
      }

      const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
      const dedupeRaw = `${sym}|${draft.direction}|${bucket}`;
      const externalId = await sha1Uuid(dedupeRaw);

      // TTL: stock-bar scanner has no DTE, default to 2h
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const { error } = await admin.from("signals").insert({
        ticker: draft.ticker,
        direction: draft.direction,
        price: draft.price,
        confidence: draft.confidence,
        risk_level: draft.risk_level,
        reasons: draft.reasons,
        technical_metrics: draft.technical_metrics,
        flow_metrics: {},
        status: "LIVE",
        is_demo: false,
        hidden: false,
        source: "Alpaca Backend Scanner v1",
        external_id: externalId,
        expires_at: expiresAt,
      });
      if (error) {
        if ((error as any).code === "23505") { skipped++; continue; }
        errors.push(`${sym}: ${error.message}`);
        skipped++;
        continue;
      }
      created++;
    } catch (e) {
      errors.push(`${sym}: ${(e as Error).message}`);
      skipped++;
    }
  }

  // Top 3 skipped by score (only persisted when debug_mode is on)
  const topSkipped = settings.debug_mode
    ? skippedList.sort((a, b) => b.score - a.score).slice(0, 3)
    : [];

  const avgScore = scores.length
    ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
    : null;

  const status = errors.length === 0 ? "ok" : created > 0 ? "partial" : "error";
  await admin.from("signal_scan_runs").insert({
    status, trigger: auth.trigger, tickers_scanned: tickers,
    signals_created: created, skipped_count: skipped,
    would_have_created: wouldHave,
    candidates_scanned: candidates,
    avg_score: avgScore,
    skipped_candidates: topSkipped,
    profile: settings.profile,
    threshold: settings.threshold,
    error: errors.length ? errors.join("; ").slice(0, 1000) : null,
    duration_ms: Date.now() - t0,
  });

  return json({
    ok: true, status, signals_created: created, skipped,
    would_have_created: wouldHave, candidates_scanned: candidates,
    avg_score: avgScore, profile: settings.profile, threshold: settings.threshold,
    errors,
  });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Deterministic UUID from a string (sha1, formatted as UUID layout).
async function sha1Uuid(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  const hex = Array.from(hash.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
