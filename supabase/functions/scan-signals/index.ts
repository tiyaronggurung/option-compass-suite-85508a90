// Backend signal scanner — Alpaca bars → modular weighted scoring → inserts into public.signals.
// No live orders, paper/signal generation only. Triggered by pg_cron (service role) or
// by an admin "Run Scan Now" button. Market-hours gated in America/New_York.
import { createClient } from "npm:@supabase/supabase-js@2";
import { pickBestContract } from "../_shared/pickContract.ts";
import { getEarningsCatalyst, type CatalystResult } from "../_shared/earningsCatalyst.ts";

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
function macdHist(closes: number[]): number {
  if (closes.length < 35) return 0;
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine: number[] = e12.map((v, i) => v - e26[i]);
  const signal = ema(macdLine.slice(-20), 9);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSig = signal[signal.length - 1];
  return lastMacd - lastSig;
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
function clamp(v: number, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

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

// ---------- Scoring components (each -1..+1) ----------
type ComponentName = "trend" | "momentum" | "levels" | "volume" | "options" | "macro";
type ComponentResult = { score: number; reason: string; metrics: Record<string, number> };
type AllComponents = Record<ComponentName, ComponentResult>;

// Weights sum to 1.0
const WEIGHTS: Record<ComponentName, number> = {
  trend: 0.30,
  momentum: 0.25,
  levels: 0.20,
  volume: 0.15,
  options: 0.05,
  macro: 0.05,
};

function scoreTrend(closes: number[]): ComponentResult {
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const e9 = ema9[ema9.length - 1];
  const e21 = ema21[ema21.length - 1];
  const e9p = ema9[ema9.length - 2];
  const e21p = ema21[ema21.length - 2];
  const gapPct = (e9 - e21) / e21;            // signed
  const base = clamp(gapPct * 50);              // 2% gap → 1.0
  const bullCross = e9p <= e21p && e9 > e21;
  const bearCross = e9p >= e21p && e9 < e21;
  let score = base;
  if (bullCross) score = clamp(score + 0.4);
  if (bearCross) score = clamp(score - 0.4);
  const reason = bullCross ? "EMA9/EMA21 bullish cross"
    : bearCross ? "EMA9/EMA21 bearish cross"
    : e9 > e21 ? "EMA9 above EMA21" : "EMA9 below EMA21";
  return {
    score,
    reason,
    metrics: { ema9: +e9.toFixed(2), ema21: +e21.toFixed(2), gap_pct: +(gapPct * 100).toFixed(2) },
  };
}

function scoreMomentum(closes: number[]): ComponentResult {
  const r = rsi(closes, 14);
  const mh = macdHist(closes);
  const lastClose = closes[closes.length - 1] || 1;
  const rsiScore = clamp((r - 50) / 25);        // RSI 75/25 → ±1
  const macdScore = clamp((mh / lastClose) * 200); // 0.5% hist → 1.0
  const score = clamp(rsiScore * 0.6 + macdScore * 0.4);
  const parts: string[] = [];
  if (Math.abs(rsiScore) >= 0.2) parts.push(`RSI ${r.toFixed(0)}`);
  if (Math.abs(macdScore) >= 0.2) parts.push(`MACD ${mh >= 0 ? "+" : ""}${mh.toFixed(2)}`);
  return {
    score,
    reason: parts.length ? parts.join(" · ") : `RSI ${r.toFixed(0)}`,
    metrics: { rsi: +r.toFixed(2), macd_hist: +mh.toFixed(4) },
  };
}

function scoreLevels(bars: Bar[]): ComponentResult {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const todayBars = bars.filter((b) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(b.t));
    return d === etDate;
  });
  const vw = todayBars.length >= 3 ? vwap(todayBars) : vwap(bars.slice(-20));
  const distPct = (last.c - vw) / vw;
  const base = clamp(distPct * 80);              // 1.25% above vwap → 1.0
  const reclaim = prev.c < vw && last.c > vw;
  const breakdown = prev.c > vw && last.c < vw;
  let score = base;
  if (reclaim) score = clamp(score + 0.4);
  if (breakdown) score = clamp(score - 0.4);
  const reason = reclaim ? "VWAP reclaim"
    : breakdown ? "VWAP breakdown"
    : last.c > vw ? "Above VWAP" : "Below VWAP";
  return {
    score,
    reason,
    metrics: { vwap: +vw.toFixed(2), dist_pct: +(distPct * 100).toFixed(2) },
  };
}

function scoreVolume(bars: Bar[], trendSign: number): ComponentResult {
  const last = bars[bars.length - 1];
  const avgVol20 = bars.slice(-21, -1).reduce((a, b) => a + b.v, 0) / 20;
  const spike = avgVol20 > 0 ? last.v / avgVol20 : 1;
  // Magnitude from spike, direction follows trend (volume confirms current move)
  const mag = clamp((spike - 1) / 1.5);          // 2.5x avg → 1.0
  const dir = trendSign >= 0 ? 1 : -1;
  const score = clamp(mag * dir);
  return {
    score,
    reason: spike >= 1.2 ? `Volume ${spike.toFixed(1)}× avg` : `Volume ${spike.toFixed(1)}× (light)`,
    metrics: { volume_spike: +spike.toFixed(2) },
  };
}

function scoreOptions(): ComponentResult {
  return { score: 0, reason: "options flow: n/a", metrics: {} };
}
function scoreMacro(): ComponentResult {
  return { score: 0, reason: "macro regime: n/a", metrics: {} };
}

// ---------- Blend ----------
type Draft = {
  ticker: string;
  direction: "CALL" | "PUT";
  price: number;
  confidence: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  reasons: string[];
  technical_metrics: Record<string, unknown>;
  components: AllComponents;
};

function evaluate(symbol: string, bars: Bar[]): Draft | null {
  if (bars.length < 35) return null;
  const closes = bars.map((b) => b.c);
  const last = bars[bars.length - 1];

  const trend = scoreTrend(closes);
  const momentum = scoreMomentum(closes);
  const levels = scoreLevels(bars);
  const volume = scoreVolume(bars, trend.score);
  const options = scoreOptions();
  const macro = scoreMacro();

  const components: AllComponents = { trend, momentum, levels, volume, options, macro };

  let blended = 0;
  for (const k of Object.keys(WEIGHTS) as ComponentName[]) {
    blended += components[k].score * WEIGHTS[k];
  }
  blended = clamp(blended);

  // No directional bias at all
  if (Math.abs(blended) < 0.05) return null;

  const direction: "CALL" | "PUT" = blended > 0 ? "CALL" : "PUT";
  const confidence = Math.max(0, Math.min(100, Math.round(Math.abs(blended) * 100)));
  const risk_level: "LOW" | "MEDIUM" | "HIGH" =
    confidence >= 80 ? "LOW" : confidence >= 65 ? "MEDIUM" : "HIGH";

  // Reasons: pick components whose signed score agrees with direction and is meaningful
  const sign = blended > 0 ? 1 : -1;
  const reasons: string[] = [];
  for (const k of ["trend", "momentum", "levels", "volume"] as ComponentName[]) {
    const c = components[k];
    if (c.score * sign >= 0.15) reasons.push(c.reason);
  }
  if (reasons.length === 0) reasons.push(components.trend.reason);

  return {
    ticker: symbol,
    direction,
    price: last.c,
    confidence,
    risk_level,
    reasons,
    technical_metrics: {
      score: +blended.toFixed(3),
      profile_weights: WEIGHTS,
      components: {
        trend: { score: +trend.score.toFixed(3), reason: trend.reason, ...trend.metrics },
        momentum: { score: +momentum.score.toFixed(3), reason: momentum.reason, ...momentum.metrics },
        levels: { score: +levels.score.toFixed(3), reason: levels.reason, ...levels.metrics },
        volume: { score: +volume.score.toFixed(3), reason: volume.reason, ...volume.metrics },
        options: { score: 0, reason: options.reason },
        macro: { score: 0, reason: macro.reason },
      },
      // Flat fields kept for back-compat with any UI that read them directly
      rsi: momentum.metrics.rsi,
      ema9: trend.metrics.ema9,
      ema21: trend.metrics.ema21,
      vwap: levels.metrics.vwap,
      volume_spike: volume.metrics.volume_spike,
    },
    components,
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
  const compSums: Record<ComponentName, number> = {
    trend: 0, momentum: 0, levels: 0, volume: 0, options: 0, macro: 0,
  };
  const skippedList: Array<{ ticker: string; direction: string; score: number; reasons: string[] }> = [];
  const errors: string[] = [];

  for (const sym of tickers) {
    try {
      const bars = await fetchBars(sym);
      const draft = evaluate(sym, bars);
      if (!draft) { skipped++; continue; }

      candidates++;
      scores.push(draft.confidence);
      // Accumulate signed component scores for averaging
      for (const k of Object.keys(compSums) as ComponentName[]) {
        compSums[k] += draft.components[k].score;
      }

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

      // ---- 0.35-delta contract picker (best-effort) ----
      let contractFields: Record<string, unknown> = {};
      let contractMeta: Record<string, unknown> | null = null;
      const reasonsWithContract = [...draft.reasons];
      if (ALPACA_KEY && ALPACA_SECRET) {
        try {
          // Pre-flight: if cache empty in 14-30 DTE window, best-effort refresh
          const winEnd = new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10);
          const winStart = new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10);
          const { count: cached } = await admin
            .from("options_contracts")
            .select("symbol", { count: "exact", head: true })
            .eq("underlying", draft.ticker)
            .gte("expiry", winStart)
            .lte("expiry", winEnd);
          if (!cached || cached < 5) {
            try {
              await fetch(`${SUPABASE_URL}/functions/v1/fetch-options-chain`, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${SERVICE_KEY}`,
                  "Content-Type": "application/json",
                  "apikey": SERVICE_KEY,
                },
                body: JSON.stringify({ ticker: draft.ticker }),
              });
            } catch { /* best-effort */ }
          }

          const picked = await pickBestContract(admin, draft.ticker, draft.direction);
          if (picked) {
            contractFields = {
              contract_symbol: picked.contract.symbol,
              expiry: picked.contract.expiry,
              strike: picked.contract.strike,
              premium: picked.mid,
              dte: picked.dte,
            };
            contractMeta = {
              delta: picked.contract.delta,
              iv: picked.contract.iv,
              bid: picked.contract.bid,
              ask: picked.contract.ask,
              mid: picked.mid,
              dte: picked.dte,
              spread_pct: picked.spread_pct,
              liquidity_score: picked.liquidity_score,
              reason: picked.reason,
            };
          } else {
            reasonsWithContract.push("No contract match yet.");
          }
        } catch (e) {
          errors.push(`${sym} picker: ${(e as Error).message}`);
        }
      }

      const techMetrics = contractMeta
        ? { ...draft.technical_metrics, contract: contractMeta }
        : draft.technical_metrics;

      const { error } = await admin.from("signals").insert({
        ticker: draft.ticker,
        direction: draft.direction,
        price: draft.price,
        confidence: draft.confidence,
        risk_level: draft.risk_level,
        reasons: reasonsWithContract,
        technical_metrics: techMetrics,
        flow_metrics: {},
        status: "LIVE",
        is_demo: false,
        hidden: false,
        source: "Alpaca Backend Scanner v2",
        external_id: externalId,
        expires_at: expiresAt,
        ...contractFields,
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

  // Average component scores across candidates (signed −1..+1)
  const avgComponents: Record<string, number | null> & { candidate_count: number } = {
    trend: null, momentum: null, levels: null, volume: null, options: null, macro: null,
    candidate_count: candidates,
  };
  if (candidates > 0) {
    for (const k of Object.keys(compSums) as ComponentName[]) {
      avgComponents[k] = Number((compSums[k] / candidates).toFixed(3));
    }
  }

  const status = errors.length === 0 ? "ok" : created > 0 ? "partial" : "error";
  await admin.from("signal_scan_runs").insert({
    status, trigger: auth.trigger, tickers_scanned: tickers,
    signals_created: created, skipped_count: skipped,
    would_have_created: wouldHave,
    candidates_scanned: candidates,
    avg_score: avgScore,
    avg_components: avgComponents,
    skipped_candidates: topSkipped,
    profile: settings.profile,
    threshold: settings.threshold,
    error: errors.length ? errors.join("; ").slice(0, 1000) : null,
    duration_ms: Date.now() - t0,
  });

  return json({
    ok: true, status, signals_created: created, skipped,
    would_have_created: wouldHave, candidates_scanned: candidates,
    avg_score: avgScore, avg_components: avgComponents,
    profile: settings.profile, threshold: settings.threshold,
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
