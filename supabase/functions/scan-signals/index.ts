// Backend signal scanner — Alpaca bars → modular weighted scoring → inserts into public.signals.
// No live orders, paper/signal generation only. Triggered by pg_cron (service role) or
// by an admin "Run Scan Now" button. Market-hours gated in America/New_York.
import { createClient } from "npm:@supabase/supabase-js@2";
import { pickBestContract } from "../_shared/pickContract.ts";
import { getEarningsCatalyst, type CatalystResult } from "../_shared/earningsCatalyst.ts";
import { buildConfirmations } from "../_shared/confirmations.ts";
import { scoreInstitutional, tierFor as tierForScore } from "../_shared/scoring.ts";
import { scoreOptionsFlowUnusualWhales, UW_CONFIGURED, type UWFlowScore } from "../_shared/unusual-whales.ts";
import {
  evaluateLifecycle,
  appendHistory,
  type LifecycleSignal,
  type FlowSnapshot,
  type TechnicalSnapshot,
} from "../_shared/lifecycle.ts";
import { runConfirmationSweep } from "../_shared/crossSourceMatch.ts";

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

// Tier ordering for max/min-tier-seen watermarks (analytics only).
const TIER_RANK: Record<string, number> = {
  rejected: 0, developing: 1, near_watchlist: 2, watchlist: 3, strong: 4, elite: 5,
};
function higherTier(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return (TIER_RANK[b] ?? -1) > (TIER_RANK[a] ?? -1) ? b : a;
}
function lowerTier(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return (TIER_RANK[b] ?? 99) < (TIER_RANK[a] ?? 99) ? b : a;
}

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

// ---------- Options Flow (UW) — wired into pre-score gate ----------
// Async per-ticker fetch. Degrades to neutral (0) on any error/missing key,
// so it never blocks scoring. Pure additive wiring; weight unchanged at 0.05.
async function scoreOptionsLive(
  ticker: string,
  direction: "CALL" | "PUT",
): Promise<ComponentResult> {
  if (!UW_CONFIGURED) {
    return { score: 0, reason: "options flow: UW key missing", metrics: {} };
  }
  try {
    const uw: UWFlowScore = await scoreOptionsFlowUnusualWhales(ticker, direction);
    // UW returns 0..100 (50 = neutral, already direction-aware: high = aligned with direction).
    // Map to -1..+1 for the pre-score bucket.
    const score = clamp((uw.score - 50) / 50);
    if (uw.state !== "active") {
      return { score: 0, reason: `options flow: ${uw.state}`, metrics: { uw_score: uw.score } };
    }
    return {
      score,
      reason: uw.human_reason || `UW flow ${uw.score}`,
      metrics: {
        uw_score: uw.score,
        net_premium_bias: uw.net_premium_bias,
        call_put_bias: uw.call_put_bias,
        sweeps: uw.sweep_count,
        blocks: uw.block_count,
        bullish_premium: uw.bullish_premium,
        bearish_premium: uw.bearish_premium,
      },
    };
  } catch (_e) {
    return { score: 0, reason: "options flow: error", metrics: {} };
  }
}

// ---------- Macro Regime — wired into pre-score gate ----------
// Fetched ONCE per scan run, then evaluated per-direction.
type MacroContext = {
  regime: string;
  spy_trend: number;
  qqq_trend: number;
  vix_level: number;
  fetched: boolean;
};

async function fetchMacroContext(): Promise<MacroContext> {
  try {
    const { data } = await admin
      .from("market_regime")
      .select("regime, spy_trend, qqq_trend, vix_level")
      .eq("id", "global")
      .maybeSingle();
    if (!data) {
      return { regime: "sideways", spy_trend: 0, qqq_trend: 0, vix_level: 0, fetched: false };
    }
    return {
      regime: String(data.regime ?? "sideways"),
      spy_trend: Number(data.spy_trend ?? 0),
      qqq_trend: Number(data.qqq_trend ?? 0),
      vix_level: Number(data.vix_level ?? 0),
      fetched: true,
    };
  } catch {
    return { regime: "sideways", spy_trend: 0, qqq_trend: 0, vix_level: 0, fetched: false };
  }
}

function scoreMacroLive(
  macro: MacroContext,
  direction: "CALL" | "PUT",
): ComponentResult {
  if (!macro.fetched) {
    return { score: 0, reason: "macro regime: n/a", metrics: {} };
  }
  // Blend SPY + QQQ trend (percent). ±5% trend → ±1.0 raw.
  const trendAvg = (macro.spy_trend + macro.qqq_trend) / 2;
  let bias = clamp(trendAvg / 5);

  // Regime modifiers
  const reg = macro.regime.toLowerCase();
  if (reg.includes("bullish")) bias = clamp(bias + 0.2);
  else if (reg.includes("bearish")) bias = clamp(bias - 0.2);
  if (reg.includes("high_vol")) bias *= 0.5;       // damp in high-vol regimes
  if (reg.includes("sideways")) bias *= 0.6;        // damp in sideways

  // Direction alignment: CALL benefits from bullish bias, PUT from bearish.
  const score = clamp(direction === "CALL" ? bias : -bias);

  return {
    score,
    reason: `Macro ${macro.regime} · SPY ${macro.spy_trend.toFixed(2)}% · QQQ ${macro.qqq_trend.toFixed(2)}% · VIX ${macro.vix_level.toFixed(1)}`,
    metrics: {
      regime_bias: +bias.toFixed(3),
      spy_trend: macro.spy_trend,
      qqq_trend: macro.qqq_trend,
      vix_level: macro.vix_level,
    },
  };
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

async function evaluate(symbol: string, bars: Bar[], macroCtx: MacroContext): Promise<Draft | null> {
  if (bars.length < 35) return null;
  const closes = bars.map((b) => b.c);
  const last = bars[bars.length - 1];

  // Phase 1: technical buckets (sync, no external IO)
  const trend = scoreTrend(closes);
  const momentum = scoreMomentum(closes);
  const levels = scoreLevels(bars);
  const volume = scoreVolume(bars, trend.score);

  // Provisional direction from technical-only blend (sum of weights = 0.90).
  // We need a direction up-front because options flow is direction-aware.
  const techBlended =
    trend.score * WEIGHTS.trend +
    momentum.score * WEIGHTS.momentum +
    levels.score * WEIGHTS.levels +
    volume.score * WEIGHTS.volume;
  const provisionalDirection: "CALL" | "PUT" = techBlended >= 0 ? "CALL" : "PUT";

  // Phase 2: direction-aware async buckets (options flow + macro).
  const [options, macro] = await Promise.all([
    scoreOptionsLive(symbol, provisionalDirection),
    Promise.resolve(scoreMacroLive(macroCtx, provisionalDirection)),
  ]);

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
  for (const k of ["trend", "momentum", "levels", "volume", "options", "macro"] as ComponentName[]) {
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
        options: { score: +options.score.toFixed(3), reason: options.reason, ...options.metrics },
        macro: { score: +macro.score.toFixed(3), reason: macro.reason, ...macro.metrics },
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
  testing: 25,
};

type UniverseMode = "base_8" | "watchlist_earnings" | "top_100" | "top_250" | "top_500";

async function loadScannerSettings(): Promise<{ profile: string; threshold: number; debug_mode: boolean; universe_mode: UniverseMode }> {
  const { data } = await admin.from("scanner_settings").select("profile, debug_mode, universe_mode").eq("id", "global").maybeSingle();
  const profile = (data?.profile as string) ?? "balanced";
  const debug_mode = !!data?.debug_mode;
  const universe_mode = ((data as any)?.universe_mode as UniverseMode) ?? "base_8";
  const threshold = PROFILE_THRESHOLDS[profile] ?? 50;
  return { profile, threshold, debug_mode, universe_mode };
}

// ---------- Universe resolution ----------
// Returns the tickers to scan plus diagnostics for signal_scan_runs.
// Does NOT touch scoring logic.
async function resolveUniverse(mode: UniverseMode): Promise<{
  tickers: string[];
  universe_count: number;
  watchlist_count: number;
  earnings_count: number;
  skipped_due_to_cap: number;
}> {
  if (mode === "base_8") {
    return {
      tickers: DEFAULT_TICKERS,
      universe_count: DEFAULT_TICKERS.length,
      watchlist_count: 0,
      earnings_count: 0,
      skipped_due_to_cap: 0,
    };
  }

  if (mode === "watchlist_earnings") {
    const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const [wlRes, earnRes] = await Promise.all([
      admin.from("watchlist_items").select("ticker"),
      admin.from("earnings_events").select("ticker").gte("report_date", today).lte("report_date", horizon),
    ]);
    const wl = new Set((wlRes.data ?? []).map((r: any) => r.ticker as string));
    const earn = new Set((earnRes.data ?? []).map((r: any) => r.ticker as string));
    const merged = new Set<string>([...wl, ...earn]);
    return {
      tickers: [...merged],
      universe_count: merged.size,
      watchlist_count: wl.size,
      earnings_count: earn.size,
      skipped_due_to_cap: 0,
    };
  }

  // top_100 / top_250 / top_500 — pull from tradable_universe with ranking
  const cap = mode === "top_100" ? 100 : mode === "top_250" ? 250 : 500;
  const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [uniRes, wlRes, earnRes] = await Promise.all([
    admin
      .from("tradable_universe")
      .select("ticker, avg_volume, market_cap, last_price")
      .eq("optionable", true)
      .eq("active", true)
      .eq("tradable", true)
      .order("avg_volume", { ascending: false, nullsFirst: false })
      .limit(2000),
    admin.from("watchlist_items").select("ticker"),
    admin.from("earnings_events").select("ticker, report_date").gte("report_date", today).lte("report_date", horizon),
  ]);

  const universe = uniRes.data ?? [];
  const wl = new Set((wlRes.data ?? []).map((r: any) => r.ticker as string));
  const earningsByTicker = new Map<string, string>();
  for (const e of (earnRes.data ?? [])) {
    earningsByTicker.set((e as any).ticker, (e as any).report_date);
  }

  // Filter price>$5 OR price unknown (heuristic mode — no price yet) AND avg_volume>500k OR unknown
  const eligible = universe.filter((r: any) => {
    const price = r.last_price;
    const vol = r.avg_volume;
    if (price !== null && price !== undefined && Number(price) <= 5) return false;
    if (vol !== null && vol !== undefined && Number(vol) < 500_000) return false;
    return true;
  });

  // Rank: earnings ≤7d > earnings ≤14d > avg_volume > watchlist > market_cap
  const now = Date.now();
  const ranked = eligible
    .map((r: any) => {
      const t = r.ticker as string;
      const earn = earningsByTicker.get(t);
      let earnScore = 0;
      if (earn) {
        const days = Math.floor((new Date(earn).getTime() - now) / 86400000);
        if (days <= 7) earnScore = 3;
        else if (days <= 14) earnScore = 2;
      }
      const wlScore = wl.has(t) ? 1 : 0;
      const vol = Number(r.avg_volume ?? 0);
      const mcap = Number(r.market_cap ?? 0);
      return { ticker: t, earnScore, wlScore, vol, mcap };
    })
    .sort((a, b) => {
      if (b.earnScore !== a.earnScore) return b.earnScore - a.earnScore;
      if (b.vol !== a.vol) return b.vol - a.vol;
      if (b.wlScore !== a.wlScore) return b.wlScore - a.wlScore;
      return b.mcap - a.mcap;
    });

  const picked = ranked.slice(0, cap);
  const pickedSet = new Set(picked.map((p) => p.ticker));
  const earnings_count = picked.filter((p) => earningsByTicker.has(p.ticker)).length;
  const watchlist_count = picked.filter((p) => wl.has(p.ticker)).length;

  return {
    tickers: picked.map((p) => p.ticker),
    universe_count: eligible.length,
    watchlist_count,
    earnings_count,
    skipped_due_to_cap: Math.max(0, eligible.length - picked.length),
  };
}

// ---------- Overlap lock (prevents two scans running at once) ----------
const SCAN_LOCK_ID = "scan-signals";
const SCAN_LOCK_TTL_MS = 5 * 60 * 1000; // 5 min safety release

async function acquireScanLock(trigger: string): Promise<boolean> {
  // Try insert — if conflict, check age and steal if stale
  const { error } = await admin.from("scan_locks").insert({
    id: SCAN_LOCK_ID,
    locked_at: new Date().toISOString(),
    locked_by: trigger,
  });
  if (!error) return true;
  // Existing lock — check staleness
  const { data } = await admin.from("scan_locks").select("locked_at").eq("id", SCAN_LOCK_ID).maybeSingle();
  if (!data) return false;
  const age = Date.now() - new Date((data as any).locked_at).getTime();
  if (age > SCAN_LOCK_TTL_MS) {
    await admin.from("scan_locks").update({
      locked_at: new Date().toISOString(),
      locked_by: trigger,
    }).eq("id", SCAN_LOCK_ID);
    return true;
  }
  return false;
}

async function releaseScanLock(): Promise<void> {
  await admin.from("scan_locks").delete().eq("id", SCAN_LOCK_ID);
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
  const settings = await loadScannerSettings();

  // Resolve universe based on configured mode
  const universe = await resolveUniverse(settings.universe_mode);
  const tickers = universe.tickers;

  // Market-hours gate (bypassable by admin force run)
  const market = isMarketOpenET();
  if (!market.open && !force) {
    await admin.from("signal_scan_runs").insert({
      status: market.reason, trigger: auth.trigger, tickers_scanned: tickers,
      signals_created: 0, skipped_count: tickers.length, duration_ms: Date.now() - t0,
      profile: settings.profile, threshold: settings.threshold,
      universe_mode: settings.universe_mode,
      universe_count: universe.universe_count,
      watchlist_count: universe.watchlist_count,
      earnings_count: universe.earnings_count,
      skipped_due_to_cap: universe.skipped_due_to_cap,
    });
    return json({ ok: true, status: market.reason, signals_created: 0 });
  }

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    await admin.from("signal_scan_runs").insert({
      status: "error", trigger: auth.trigger, tickers_scanned: tickers,
      error: "Alpaca credentials missing", duration_ms: Date.now() - t0,
      profile: settings.profile, threshold: settings.threshold,
      universe_mode: settings.universe_mode,
      universe_count: universe.universe_count,
    });
    return json({ error: "Alpaca not configured" }, 500);
  }

  if (tickers.length === 0) {
    await admin.from("signal_scan_runs").insert({
      status: "empty_universe", trigger: auth.trigger, tickers_scanned: [],
      signals_created: 0, skipped_count: 0, duration_ms: Date.now() - t0,
      profile: settings.profile, threshold: settings.threshold,
      universe_mode: settings.universe_mode,
      universe_count: universe.universe_count,
      watchlist_count: universe.watchlist_count,
      earnings_count: universe.earnings_count,
      skipped_due_to_cap: universe.skipped_due_to_cap,
    });
    return json({ ok: true, status: "empty_universe", signals_created: 0 });
  }

  // Overlap lock — prevent two scans running at once
  const gotLock = await acquireScanLock(auth.trigger);
  if (!gotLock) {
    return json({ ok: false, status: "scan_in_progress", signals_created: 0 }, 200);
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

  // Lifecycle: capture fresh per-(ticker,direction) scoring this scan, used
  // after the per-ticker loop to re-evaluate state of existing non-terminal signals.
  type ScoringSnapshot = { confidence: number; flow: FlowSnapshot; technical: TechnicalSnapshot };
  const scoringByKey = new Map<string, ScoringSnapshot>();
  const keyOf = (t: string, d: string) => `${t.toUpperCase()}|${d}`;

  // Macro context fetched ONCE per scan run (global, not per-ticker).
  const macroCtx = await fetchMacroContext();

  // Per-ticker processor — identical scoring/picker/insert logic, extracted for parallel execution.
  async function processTicker(sym: string): Promise<void> {
    try {
      const bars = await fetchBars(sym);
      const draft = await evaluate(sym, bars, macroCtx);
      if (!draft) { skipped++; return; }

      candidates++;
      scores.push(draft.confidence);
      for (const k of Object.keys(compSums) as ComponentName[]) {
        compSums[k] += draft.components[k].score;
      }

      const oldPreScore = draft.confidence; // diagnostic only — no longer the gate

      // A2: Institutional scoring is now the publish gate.
      // Full 5-component engine (UW flow + Finviz + macro regime + sentiment + insiders).
      // Missing keys → component returns neutral 50 and does not block.
      let institutional: Awaited<ReturnType<typeof scoreInstitutional>> | null = null;
      let institutionalConfidence = 0;
      let institutionalTier: string = "rejected";
      const institutionalReasons: string[] = [];
      try {
        institutional = await scoreInstitutional(admin, {
          ticker: draft.ticker,
          direction: draft.direction,
          baseTrendScore: draft.components.trend.score,
        });
        institutionalConfidence = institutional.final;
        institutionalTier = tierForScore(institutionalConfidence);
        institutionalReasons.push(...institutional.reasons);
        // Lifecycle: record fresh scoring snapshot for this (ticker, direction).
        scoringByKey.set(keyOf(draft.ticker, draft.direction), {
          confidence: institutionalConfidence,
          flow: (institutional.components.options_flow?.details ?? {}) as FlowSnapshot,
          technical: {
            score: institutional.components.technical?.score ?? null,
            ...(institutional.components.technical?.details ?? {}),
          } as TechnicalSnapshot,
        });
      } catch (e) {
        errors.push(`${sym} institutional: ${(e as Error).message}`);
        // Hard fail → skip this candidate; do not fall back to old pre-score.
        skipped++;
        skippedList.push({
          ticker: draft.ticker,
          direction: draft.direction,
          score: oldPreScore,
          reasons: [
            `old_pre_score=${oldPreScore}`,
            `institutional=error`,
            `skip_reason=institutional_failed`,
            ...draft.reasons,
          ],
        });
        return;
      }

      // "Would have" diagnostic: institutional just under threshold
      if (settings.threshold >= 50 &&
          institutionalConfidence >= settings.threshold - 10 &&
          institutionalConfidence < settings.threshold) {
        wouldHave++;
      }

      // Publish gate uses institutional confidence (was old pre-score)
      if (institutionalConfidence < settings.threshold) {
        skipped++;
        skippedList.push({
          ticker: draft.ticker,
          direction: draft.direction,
          score: institutionalConfidence,
          reasons: [
            `old_pre_score=${oldPreScore}`,
            `institutional_confidence=${institutionalConfidence}`,
            `institutional_tier=${institutionalTier}`,
            `skip_reason=below_institutional_threshold`,
            ...institutionalReasons.slice(0, 4),
          ],
        });
        return;
      }

      const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
      const dedupeRaw = `${sym}|${draft.direction}|${bucket}`;
      const externalId = await sha1Uuid(dedupeRaw);

      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      let catalyst: CatalystResult | null = null;
      let finalConfidence = draft.confidence;
      let finalRisk: "LOW" | "MEDIUM" | "HIGH" = draft.risk_level;
      let catalystSummary: string | null = null;
      try {
        catalyst = await getEarningsCatalyst(admin, draft.ticker);
        if (catalyst) {
          finalConfidence = Math.min(100, draft.confidence + catalyst.confidenceBoost);
          if (catalyst.forceHighRisk) finalRisk = "HIGH";
          catalystSummary = catalyst.summary;
        }
      } catch (e) {
        errors.push(`${sym} catalyst: ${(e as Error).message}`);
      }

      let contractFields: Record<string, unknown> = {};
      let contractMeta: Record<string, unknown> | null = null;
      const reasonsWithContract = [...draft.reasons];
      if (catalyst) reasonsWithContract.push(catalyst.summary);
      if (ALPACA_KEY && ALPACA_SECRET) {
        try {
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

      // Multi-source confirmation — purely additive metadata, NEVER alters confidence/threshold.
      let confirmations: Awaited<ReturnType<typeof buildConfirmations>> | null = null;
      try {
        const blendedScore = typeof (draft.technical_metrics as any)?.score === "number"
          ? (draft.technical_metrics as any).score : 0;
        confirmations = await buildConfirmations(admin, {
          ticker: draft.ticker,
          direction: draft.direction,
          blendedScore,
          confidence: finalConfidence,
        });
      } catch (e) {
        errors.push(`${sym} confirmations: ${(e as Error).message}`);
      }

      // Institutional was already computed BEFORE the gate (A2).
      // Reuse those values here for the insert — do not score twice.
      const finalScore = institutionalConfidence;
      const tier = institutionalTier;

      const allReasons = Array.from(new Set([...reasonsWithContract, ...institutionalReasons]));
      const hideForRejected = tier === "rejected";

      const { error } = await admin.from("signals").insert({
        ticker: draft.ticker,
        direction: draft.direction,
        price: draft.price,
        confidence: finalScore,
        risk_level: finalRisk,
        reasons: allReasons,
        technical_metrics: techMetrics,
        flow_metrics: {},
        status: "LIVE",
        is_demo: false,
        hidden: hideForRejected,
        source: "Alpaca Backend Scanner v2",
        external_id: externalId,
        expires_at: expiresAt,
        catalyst_summary: catalystSummary,
        source_confirmations: confirmations?.matrix ?? {},
        confirmation_score: confirmations?.score ?? null,
        confirmation_label: confirmations?.label ?? null,
        tier,
        score_components: institutional ? {
          final: institutional.final,
          base: institutional.base,
          regime: institutional.regime,
          regime_adjust: institutional.regime_adjust,
          components: institutional.components,
          sources_used: institutional.sources_used,
          provider_status: institutional.provider_status,
          reasons: institutional.reasons,
        } : {},
        // Lifecycle: birth snapshot + initial state.
        lifecycle_state: "fresh",
        lifecycle_reason: "created",
        lifecycle_updated_at: new Date().toISOString(),
        confidence_at_birth: finalScore,
        flow_at_birth: institutional?.components.options_flow?.details ?? {},
        technical_at_birth: institutional ? {
          score: institutional.components.technical?.score ?? null,
          ...(institutional.components.technical?.details ?? {}),
        } : {},
        lifecycle_history: [{
          state: "fresh",
          reason: "created",
          at: new Date().toISOString(),
          confidence: finalScore,
        }],
        // Confidence drift watermarks (analytics only).
        max_confidence_seen: finalScore,
        min_confidence_seen: finalScore,
        max_tier_seen: tier,
        min_tier_seen: tier,
        ...contractFields,
      });
      if (error) {
        if ((error as any).code === "23505") { skipped++; return; }
        errors.push(`${sym}: ${error.message}`);
        skipped++;
        return;
      }
      created++;
    } catch (e) {
      errors.push(`${sym}: ${(e as Error).message}`);
      skipped++;
    }
  }


  // Parallel batches of 20
  const BATCH_SIZE = 20;
  try {
    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((sym) => processTicker(sym)));
    }
  } finally {
    await releaseScanLock();
  }

  // Cross-source confirmation sweep — tags Alpaca + UW rows agreeing within 2 min.
  // Safe: read-only failure path, idempotent, never throws.
  try { await runConfirmationSweep(admin, { windowMinutes: 2 }); } catch { /* swallow */ }

  // ---------- Lifecycle pass ----------
  // Re-evaluate every non-terminal signal using either the fresh scoring
  // captured this scan or a time-only check when fresh data isn't available.
  // Never deletes; only updates lifecycle_state/reason/history.
  const lifecycleTransitions: Record<string, number> = {
    fresh: 0, active: 0, weakening: 0, expired: 0, invalidated: 0,
  };
  try {
    const { data: livingSignals } = await admin
      .from("signals")
      .select("id, ticker, direction, confidence, confidence_at_birth, created_at, lifecycle_state, lifecycle_history, flow_at_birth, technical_at_birth, max_confidence_seen, min_confidence_seen, max_tier_seen, min_tier_seen, tier")
      .in("lifecycle_state", ["fresh", "active", "weakening"])
      .eq("is_demo", false)
      .limit(2000);

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    for (const row of (livingSignals ?? []) as any[]) {
      const snap = scoringByKey.get(keyOf(row.ticker, row.direction));
      const liveConf = snap?.confidence ?? row.confidence;
      const liveTier = snap?.confidence != null ? tierForScore(snap.confidence) : row.tier;

      // Watermark update (analytics only; runs every scan regardless of lifecycle transition).
      const newMaxConf = Math.max(row.max_confidence_seen ?? liveConf, liveConf);
      const newMinConf = Math.min(row.min_confidence_seen ?? liveConf, liveConf);
      const newMaxTier = higherTier(row.max_tier_seen, liveTier);
      const newMinTier = lowerTier(row.min_tier_seen, liveTier);
      const watermarkPatch: Record<string, unknown> = {};
      if (newMaxConf !== row.max_confidence_seen) watermarkPatch.max_confidence_seen = newMaxConf;
      if (newMinConf !== row.min_confidence_seen) watermarkPatch.min_confidence_seen = newMinConf;
      if (newMaxTier !== row.max_tier_seen) watermarkPatch.max_tier_seen = newMaxTier;
      if (newMinTier !== row.min_tier_seen) watermarkPatch.min_tier_seen = newMinTier;

      const decision = evaluateLifecycle(row as LifecycleSignal, {
        currentConfidence: liveConf,
        currentFlow: snap?.flow ?? null,
        currentTechnical: snap?.technical ?? null,
        nowMs,
      });

      if (decision.transitioned) {
        lifecycleTransitions[decision.state] = (lifecycleTransitions[decision.state] ?? 0) + 1;
        const history = appendHistory(row.lifecycle_history, {
          state: decision.state,
          reason: decision.reason,
          at: nowIso,
          confidence: liveConf,
        });
        const { error: lcErr } = await admin
          .from("signals")
          .update({
            lifecycle_state: decision.state,
            lifecycle_reason: decision.reason,
            lifecycle_updated_at: nowIso,
            lifecycle_history: history,
            ...watermarkPatch,
          })
          .eq("id", row.id);
        if (lcErr) errors.push(`lifecycle ${row.ticker}: ${lcErr.message}`);
      } else if (Object.keys(watermarkPatch).length > 0) {
        const { error: wmErr } = await admin
          .from("signals")
          .update(watermarkPatch)
          .eq("id", row.id);
        if (wmErr) errors.push(`watermark ${row.ticker}: ${wmErr.message}`);
      }
    }
  } catch (e) {
    errors.push(`lifecycle pass: ${(e as Error).message}`);
  }


  const topSkipped = settings.debug_mode
    ? skippedList.sort((a, b) => b.score - a.score).slice(0, 3)
    : [];

  const avgScore = scores.length
    ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
    : null;

  const avgComponents: Record<string, unknown> & { candidate_count: number } = {
    trend: null, momentum: null, levels: null, volume: null, options: null, macro: null,
    candidate_count: candidates,
    lifecycle: lifecycleTransitions,
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
    universe_mode: settings.universe_mode,
    universe_count: universe.universe_count,
    watchlist_count: universe.watchlist_count,
    earnings_count: universe.earnings_count,
    skipped_due_to_cap: universe.skipped_due_to_cap,
  });

  return json({
    ok: true, status, signals_created: created, skipped,
    would_have_created: wouldHave, candidates_scanned: candidates,
    avg_score: avgScore, avg_components: avgComponents,
    profile: settings.profile, threshold: settings.threshold,
    universe_mode: settings.universe_mode,
    universe_count: universe.universe_count,
    watchlist_count: universe.watchlist_count,
    earnings_count: universe.earnings_count,
    skipped_due_to_cap: universe.skipped_due_to_cap,
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
