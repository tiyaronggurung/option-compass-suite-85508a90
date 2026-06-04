// POST /functions/v1/select-contract
// Paper-only contract selection engine.
//
// Body: { signal_id?: string, ticker: string, option_type: "CALL"|"PUT", confidence: number, persist?: boolean }
//
// Provider priority: Unusual Whales -> Alpaca options chain -> unavailable.
// Never invents premium, strike, delta, or expiry.
// Inserts a contract_selection_snapshots row when persist=true (default true).
//
// Does NOT place orders. Does NOT touch live trading, scoring, scanner, lifecycle,
// hidden logic, signal generation, or guest flows.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ───────────────── Bands (Hybrid philosophy) — v1.1 relaxed ─────────────────
type RiskProfile = "developing" | "near_watchlist" | "watchlist" | "strong" | "elite";
type BandPrefs = {
  dteMin: number; dteMax: number;
  deltaMin: number; deltaMax: number;
  maxSpreadPct: number; minOI: number; minVolume: number;
};
const BAND_PREFS: Record<RiskProfile, BandPrefs> = {
  developing:     { dteMin: 30, dteMax: 45, deltaMin: 0.65, deltaMax: 0.75, maxSpreadPct: 7,  minOI: 500, minVolume: 25 },
  near_watchlist: { dteMin: 28, dteMax: 45, deltaMin: 0.55, deltaMax: 0.70, maxSpreadPct: 8,  minOI: 400, minVolume: 20 },
  watchlist:      { dteMin: 21, dteMax: 40, deltaMin: 0.50, deltaMax: 0.65, maxSpreadPct: 9,  minOI: 300, minVolume: 15 },
  strong:         { dteMin: 14, dteMax: 35, deltaMin: 0.45, deltaMax: 0.60, maxSpreadPct: 10, minOI: 250, minVolume: 10 },
  elite:          { dteMin: 14, dteMax: 30, deltaMin: 0.40, deltaMax: 0.55, maxSpreadPct: 12, minOI: 200, minVolume: 10 },
};
const MIN_DTE_FLOOR = 6;
const MAX_PREMIUM_DOLLARS = 5000;
const EXTREME_SPREAD_PCT = 25;
const BEST_EFFORT_MIN_SCORE = 35;

function profileForConfidence(c: number): RiskProfile {
  if (c >= 90) return "elite";
  if (c >= 80) return "strong";
  if (c >= 70) return "watchlist";
  if (c >= 65) return "near_watchlist";
  return "developing";
}

// ───────────────── Scoring (pure) ─────────────────
type RejectionCategory = "quote" | "dte" | "delta" | "spread" | "liquidity" | "affordability" | "data";
type Candidate = {
  contract_symbol?: string | null;
  strike: number; expiry: string; dte: number;
  delta: number | null; gamma?: number|null; theta?: number|null; vega?: number|null; iv?: number|null;
  bid: number | null; ask: number | null; mid?: number | null;
  premium: number | null; volume?: number | null; open_interest?: number | null;
};
type ScoredCandidate = Candidate & {
  spread_pct: number | null;
  contract_score: number; liquidity_score: number;
  rationale: string; rationale_factors: Record<string, number>;
  rejected_reason: string | null;
  rejected_category: RejectionCategory | null;
};

function triangular(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi <= lo) return 0;
  const center = (lo + hi) / 2, half = (hi - lo) / 2;
  const d = Math.abs(value - center);
  return d >= half ? 0 : 1 - d / half;
}
function clamp01(n: number) { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function round3(n: number) { return Math.round(n * 1000) / 1000; }

function spreadPct(bid: number|null, ask: number|null, mid: number|null): number | null {
  if (bid == null || ask == null || bid <= 0 || ask <= 0 || ask < bid) return null;
  const m = mid ?? (bid + ask) / 2;
  return m <= 0 ? null : ((ask - bid) / m) * 100;
}

function scoreCandidate(c: Candidate, profile: RiskProfile): ScoredCandidate {
  const p = BAND_PREFS[profile];
  const sp = spreadPct(c.bid, c.ask, c.mid ?? null);
  const baseRej = (reason: string, category: RejectionCategory): ScoredCandidate => ({
    ...c, spread_pct: sp, contract_score: 0, liquidity_score: 0,
    rationale: `Rejected: ${reason}`, rationale_factors: {},
    rejected_reason: reason, rejected_category: category,
  });
  if (c.dte < MIN_DTE_FLOOR) return baseRej(`too short DTE (< ${MIN_DTE_FLOOR})`, "dte");
  if (c.bid == null || c.ask == null || c.bid <= 0 || c.ask <= 0) return baseRej("no two-sided quote", "quote");
  if (sp == null) return baseRej("invalid spread", "quote");
  if (sp > EXTREME_SPREAD_PCT) return baseRej(`extreme spread (${sp.toFixed(1)}% > ${EXTREME_SPREAD_PCT}%)`, "spread");
  if (sp > p.maxSpreadPct) return baseRej(`spread too wide (${sp.toFixed(1)}% > ${p.maxSpreadPct}%)`, "spread");
  if ((c.open_interest ?? 0) < p.minOI) return baseRej(`OI below band min (${c.open_interest ?? 0} < ${p.minOI})`, "liquidity");
  if (c.premium == null || c.premium <= 0) return baseRej("no premium", "data");
  if (c.premium * 100 > MAX_PREMIUM_DOLLARS) return baseRej(`premium above $${MAX_PREMIUM_DOLLARS} affordability cap`, "affordability");
  const absDelta = c.delta == null ? null : Math.abs(c.delta);
  if (absDelta == null) return baseRej("missing delta", "data");

  // v1.1: volume is a SOFT floor. Only reject when vol < floor AND OI does not compensate.
  const vol = c.volume ?? 0;
  const oi = c.open_interest ?? 0;
  const volBelowFloor = vol < p.minVolume;
  const oiCompensates = oi >= p.minOI * 2;
  if (volBelowFloor && !oiCompensates) {
    return baseRej(`volume below band min (${vol} < ${p.minVolume}) and OI insufficient to compensate`, "liquidity");
  }

  const dteFit = triangular(c.dte, p.dteMin, p.dteMax);
  const deltaFit = triangular(absDelta, p.deltaMin, p.deltaMax);
  const oiScore = clamp01(Math.log10(Math.max(1, oi)) / Math.log10(Math.max(10, p.minOI * 20)));
  const volScore = clamp01(Math.log10(Math.max(1, vol)) / Math.log10(Math.max(10, p.minVolume * 20)));
  const volEffective = volBelowFloor ? volScore * 0.7 : volScore;
  const liquidity = (oiScore + volEffective) / 2;
  const spreadQuality = clamp01(1 - sp / p.maxSpreadPct);
  const affordability = clamp01(1 - Math.max(0, c.premium * 100 - 1000) / (MAX_PREMIUM_DOLLARS - 1000));
  const ivNorm = c.iv == null ? null : (c.iv > 5 ? c.iv / 100 : c.iv);
  const ivPenalty = ivNorm == null ? 0.5 : clamp01(1 - Math.max(0, ivNorm - 0.8) * 2);

  const factors = {
    dte_fit: round3(dteFit), delta_fit: round3(deltaFit),
    liquidity: round3(liquidity), spread_quality: round3(spreadQuality),
    affordability: round3(affordability), iv_sanity: round3(ivPenalty),
  };
  const score01 = 0.25*dteFit + 0.25*deltaFit + 0.20*liquidity + 0.15*spreadQuality + 0.10*affordability + 0.05*ivPenalty;
  const reasons: string[] = [];
  if (dteFit > 0.7) reasons.push("DTE in sweet spot"); else if (dteFit > 0.3) reasons.push("DTE acceptable");
  if (deltaFit > 0.7) reasons.push(`Δ ${absDelta.toFixed(2)} balanced for band`); else if (deltaFit > 0.3) reasons.push(`Δ ${absDelta.toFixed(2)} acceptable`);
  if (spreadQuality > 0.7) reasons.push(`tight spread ${sp!.toFixed(1)}%`);
  if (liquidity > 0.6) reasons.push("healthy liquidity");
  if (affordability > 0.7) reasons.push("affordable premium");
  if (volBelowFloor && oiCompensates) reasons.push("low volume offset by strong OI");

  return {
    ...c, spread_pct: sp,
    contract_score: Math.round(score01 * 100),
    liquidity_score: Math.round(liquidity * 100),
    rationale: reasons.length ? reasons.join(", ") : "Meets band guards",
    rationale_factors: factors,
    rejected_reason: null,
    rejected_category: null,
  };
}

// Best-effort rescore: skips soft caps (band spread, liquidity), keeps hard safety checks.
function scoreForBestEffort(c: Candidate, profile: RiskProfile): ScoredCandidate | null {
  const p = BAND_PREFS[profile];
  const sp = spreadPct(c.bid, c.ask, c.mid ?? null);
  if (c.dte < MIN_DTE_FLOOR) return null;
  if (c.bid == null || c.ask == null || c.bid <= 0 || c.ask <= 0) return null;
  if (sp == null || sp > EXTREME_SPREAD_PCT) return null;
  if (c.premium == null || c.premium <= 0) return null;
  if (c.premium * 100 > MAX_PREMIUM_DOLLARS) return null;
  const absDelta = c.delta == null ? null : Math.abs(c.delta);
  if (absDelta == null) return null;
  const dteFit = triangular(c.dte, p.dteMin, p.dteMax);
  const deltaFit = triangular(absDelta, p.deltaMin, p.deltaMax);
  if (deltaFit <= 0 && dteFit <= 0) return null;

  const oi = c.open_interest ?? 0;
  const vol = c.volume ?? 0;
  const oiScore = clamp01(Math.log10(Math.max(1, oi)) / Math.log10(Math.max(10, p.minOI * 20)));
  const volScore = clamp01(Math.log10(Math.max(1, vol)) / Math.log10(Math.max(10, p.minVolume * 20)));
  const liquidity = (oiScore + volScore) / 2;
  const spreadDen = Math.max(p.maxSpreadPct, sp);
  const spreadQuality = clamp01(1 - sp / spreadDen);
  const affordability = clamp01(1 - Math.max(0, c.premium * 100 - 1000) / (MAX_PREMIUM_DOLLARS - 1000));
  const ivNorm = c.iv == null ? null : (c.iv > 5 ? c.iv / 100 : c.iv);
  const ivPenalty = ivNorm == null ? 0.5 : clamp01(1 - Math.max(0, ivNorm - 0.8) * 2);

  const factors = {
    dte_fit: round3(dteFit), delta_fit: round3(deltaFit),
    liquidity: round3(liquidity), spread_quality: round3(spreadQuality),
    affordability: round3(affordability), iv_sanity: round3(ivPenalty),
  };
  const score01 = 0.25*dteFit + 0.25*deltaFit + 0.20*liquidity + 0.15*spreadQuality + 0.10*affordability + 0.05*ivPenalty;
  return {
    ...c, spread_pct: sp,
    contract_score: Math.round(score01 * 100),
    liquidity_score: Math.round(liquidity * 100),
    rationale: `Best-effort pick — below preferred band (spread ${sp.toFixed(1)}%, OI ${oi}, vol ${vol})`,
    rationale_factors: factors,
    rejected_reason: null,
    rejected_category: null,
  };
}

function sortBest(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.contract_score !== a.contract_score) return b.contract_score - a.contract_score;
  if ((b.open_interest ?? 0) !== (a.open_interest ?? 0)) return (b.open_interest ?? 0) - (a.open_interest ?? 0);
  return (a.spread_pct ?? 1e9) - (b.spread_pct ?? 1e9);
}

function rankCandidates(cands: Candidate[], profile: RiskProfile) {
  const all = cands.map(c => scoreCandidate(c, profile));
  const scored = all.filter(s => s.rejected_reason == null);
  const rejected = all.filter(s => s.rejected_reason != null);
  const rejectionCounts: Record<RejectionCategory, number> = {
    quote: 0, dte: 0, delta: 0, spread: 0, liquidity: 0, affordability: 0, data: 0,
  };
  for (const r of rejected) if (r.rejected_category) rejectionCounts[r.rejected_category]++;
  scored.sort(sortBest);

  let bestEffort: ScoredCandidate | null = null;
  if (scored.length === 0) {
    const beCands = rejected
      .filter(r => r.rejected_category === "spread" || r.rejected_category === "liquidity")
      .map(r => scoreForBestEffort(r, profile))
      .filter((s): s is ScoredCandidate => s != null && s.contract_score >= BEST_EFFORT_MIN_SCORE);
    beCands.sort(sortBest);
    bestEffort = beCands[0] ?? null;
  }
  return { scored, best: scored[0] ?? null, rejected, rejectionCounts, bestEffort };
}

// ───────────────── Provider fetchers ─────────────────
const num = (x: unknown): number | null => { if (x == null) return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
const numInt = (x: unknown): number | null => { const n = num(x); return n == null ? null : Math.round(n); };

function daysBetween(today: Date, iso: string): number {
  const [y,m,d] = iso.split("-").map(Number);
  if (!y || !m || !d) return -1;
  const target = Date.UTC(y, m-1, d);
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - base) / 86_400_000);
}

function buildOcc(ticker: string, expiry: string, optionType: string, strike: number): string {
  const yymmdd = expiry.replace(/-/g, "").slice(2);
  const cp = optionType === "CALL" ? "C" : "P";
  const strikeInt = Math.round(strike * 1000).toString().padStart(8, "0");
  return `${ticker}${yymmdd}${cp}${strikeInt}`;
}

// Standard normal CDF (Abramowitz & Stegun 26.2.17, ε < 7.5e-8).
function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}
// Black-Scholes delta estimate. r=0.04 default, q=0. ivPct can be decimal (0.25) or percent (25).
function estimateDelta(optionType: "CALL"|"PUT", spot: number, strike: number, dte: number, iv: number | null): number | null {
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(strike) || strike <= 0 || dte < 0) return null;
  const ivDec = iv == null ? 0.25 : (iv > 5 ? iv / 100 : iv); // assume 25% if missing
  if (!Number.isFinite(ivDec) || ivDec <= 0) return null;
  const T = Math.max(1, dte) / 365;
  const r = 0.04;
  const d1 = (Math.log(spot / strike) + (r + (ivDec * ivDec) / 2) * T) / (ivDec * Math.sqrt(T));
  const callDelta = normCdf(d1);
  return optionType === "CALL" ? callDelta : callDelta - 1;
}

// Pulls last_price for the ticker so we can estimate delta when providers don't return greeks.
async function fetchSpot(admin: any, ticker: string): Promise<number | null> {
  const { data } = await admin.from("tradable_universe").select("last_price").eq("ticker", ticker).maybeSingle();
  const lp = data?.last_price;
  return lp != null && Number.isFinite(Number(lp)) ? Number(lp) : null;
}

// UW: chain by expiry. Endpoint returns flat array of contracts with nbbo bid/ask, OI, volume, IV.
// Greeks are not returned by this endpoint; delta is estimated downstream from spot + strike + DTE + IV.
async function fetchUnusualWhalesChain(ticker: string, optionType: string, profile: RiskProfile): Promise<Candidate[] | null> {
  const key = Deno.env.get("UNUSUAL_WHALES_API_KEY");
  if (!key) return null;
  const p = BAND_PREFS[profile];
  const today = new Date();

  let expiries: string[] = [];
  try {
    const r = await fetch(`https://api.unusualwhales.com/api/stock/${encodeURIComponent(ticker)}/expiry-breakdown`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (r.ok) {
      const j = await r.json().catch(() => null) as any;
      const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      for (const row of arr) {
        const e = row?.expires ?? row?.expiry ?? row?.expiration ?? row?.expires_at;
        if (typeof e === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e)) expiries.push(e);
      }
    }
  } catch (e) { console.warn("uw expiries err", e); }
  if (expiries.length === 0) return null;

  expiries = Array.from(new Set(expiries))
    .filter(e => { const d = daysBetween(today, e); return d >= Math.max(MIN_DTE_FLOOR, p.dteMin - 7) && d <= p.dteMax + 7; })
    .sort();
  if (expiries.length === 0) return null;

  const candidates: Candidate[] = [];
  for (const expiry of expiries.slice(0, 3)) {
    try {
      const r = await fetch(
        `https://api.unusualwhales.com/api/stock/${encodeURIComponent(ticker)}/option-contracts?expiry=${expiry}`,
        { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
      );
      if (!r.ok) continue;
      const j = await r.json().catch(() => null) as any;
      const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      for (const c of arr) {
        const occ = String(c.option_symbol ?? "").trim();
        // OCC encodes side: ...C########  / ...P########
        const m = /^[A-Z]{1,6}\d{6}([CP])(\d{8})$/.exec(occ);
        if (!m) continue;
        const side = m[1] === "C" ? "CALL" : "PUT";
        if (side !== optionType) continue;
        const strike = parseInt(m[2], 10) / 1000;
        const dte = daysBetween(today, expiry);
        const bid = num(c.nbbo_bid ?? c.bid);
        const ask = num(c.nbbo_ask ?? c.ask);
        const last = num(c.last_price ?? c.last);
        const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
        const premium = mid ?? last ?? bid ?? ask;
        candidates.push({
          contract_symbol: occ,
          strike, expiry, dte,
          delta: num(c.delta), gamma: num(c.gamma), theta: num(c.theta), vega: num(c.vega),
          iv: num(c.implied_volatility ?? c.iv),
          bid, ask, mid, premium,
          volume: numInt(c.volume), open_interest: numInt(c.open_interest ?? c.oi),
        });
      }
    } catch (e) { console.warn("uw chain err", expiry, e); }
  }
  return candidates.length ? candidates : null;
}

// Alpaca chain fallback. Uses /v1beta1/options/snapshots/{underlying} with pagination.
async function fetchAlpacaChain(ticker: string, optionType: string, profile: RiskProfile): Promise<Candidate[] | null> {
  const key = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!key || !secret) return null;
  const p = BAND_PREFS[profile];
  const today = new Date();

  const minExp = new Date(today.getTime() + Math.max(MIN_DTE_FLOOR, p.dteMin - 7) * 86_400_000);
  const maxExp = new Date(today.getTime() + (p.dteMax + 7) * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    type: optionType === "CALL" ? "call" : "put",
    expiration_date_gte: iso(minExp),
    expiration_date_lte: iso(maxExp),
    limit: "100",
  });
  const url = `https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(ticker)}?${params.toString()}`;

  let json: any = null;
  try {
    const r = await fetch(url, {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, Accept: "application/json" },
    });
    if (!r.ok) return null;
    json = await r.json().catch(() => null);
  } catch (e) { console.warn("alpaca chain err", e); return null; }

  const snaps: Record<string, any> = json?.snapshots ?? {};
  const out: Candidate[] = [];
  for (const occ of Object.keys(snaps)) {
    const snap = snaps[occ];
    // OCC: TICKERyymmddC/Pstrike(8 digits, padded, 3 implicit decimals)
    const m = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
    if (!m) continue;
    const yy = parseInt(m[2], 10), mm = parseInt(m[3], 10), dd = parseInt(m[4], 10);
    const side = m[5] === "C" ? "CALL" : "PUT";
    if (side !== optionType) continue;
    const strikeInt = parseInt(m[6], 10);
    const strike = strikeInt / 1000;
    const expiry = `20${String(yy).padStart(2,"0")}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
    const dte = daysBetween(today, expiry);
    const bid = num(snap.latestQuote?.bp);
    const ask = num(snap.latestQuote?.ap);
    const last = num(snap.latestTrade?.p);
    const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
    const premium = mid ?? last ?? bid ?? ask;
    out.push({
      contract_symbol: occ,
      strike, expiry, dte,
      delta: num(snap.greeks?.delta), gamma: num(snap.greeks?.gamma),
      theta: num(snap.greeks?.theta), vega: num(snap.greeks?.vega),
      iv: num(snap.impliedVolatility ?? snap.greeks?.iv),
      bid, ask, mid, premium,
      volume: numInt(snap.dailyBar?.v ?? snap.minuteBar?.v),
      open_interest: numInt(snap.openInterest),
    });
  }
  return out.length ? out : null;
}

// ───────────────── Handler ─────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole);

  // Auth — accept either user JWT or service role (for internal callers).
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const isServiceRole = bearer && bearer === serviceRole;
  let userId: string | null = null;
  if (!isServiceRole) {
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: ud, error: uerr } = await userClient.auth.getUser();
    if (uerr || !ud?.user) return json({ error: "Unauthorized" }, 401);
    userId = ud.user.id;
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const ticker = String(body.ticker ?? "").trim().toUpperCase();
  const optionType = String(body.option_type ?? "").trim().toUpperCase();
  const confidence = Number(body.confidence ?? 0);
  const signalId = body.signal_id ? String(body.signal_id) : null;
  const persist = body.persist !== false;

  if (!ticker || (optionType !== "CALL" && optionType !== "PUT") || !Number.isFinite(confidence)) {
    return json({ ok: false, reason: "invalid_request" }, 400);
  }

  const profile = profileForConfidence(confidence);
  const t0 = Date.now();

  // 1. UW
  let candidates: Candidate[] | null = null;
  let source: "unusual_whales" | "alpaca" | "unavailable" = "unavailable";
  try {
    candidates = await fetchUnusualWhalesChain(ticker, optionType, profile);
    if (candidates && candidates.length) source = "unusual_whales";
  } catch (e) { console.warn("uw error", e); }

  // 2. Alpaca fallback
  if (!candidates || candidates.length === 0) {
    try {
      candidates = await fetchAlpacaChain(ticker, optionType, profile);
      if (candidates && candidates.length) source = "alpaca";
    } catch (e) { console.warn("alpaca error", e); }
  }

  if (!candidates || candidates.length === 0) {
    return json({
      ok: false,
      reason: "contract_chain_unavailable",
      contract_source: "unavailable",
      profile,
      latency_ms: Date.now() - t0,
    });
  }

  // Enrich: estimate delta when provider didn't return it (UW/Alpaca chain endpoints often omit greeks).
  const spot = await fetchSpot(admin, ticker);
  if (spot != null) {
    for (const c of candidates) {
      if (c.delta == null) {
        const est = estimateDelta(optionType as "CALL"|"PUT", spot, c.strike, c.dte, c.iv ?? null);
        if (est != null) c.delta = est;
      }
    }
  }



  const { scored, best } = rankCandidates(candidates, profile);
  if (!best) {
    return json({
      ok: false,
      reason: "no_candidate_passed_guards",
      contract_source: source,
      profile,
      candidates_considered: candidates.length,
      latency_ms: Date.now() - t0,
    });
  }

  let snapshotId: string | null = null;
  if (persist) {
    const { data: inserted, error: ierr } = await admin
      .from("contract_selection_snapshots")
      .insert({
        signal_id: signalId,
        user_id: userId,
        underlying: ticker,
        option_type: optionType,
        contract_symbol: best.contract_symbol ?? null,
        strike: best.strike,
        expiry: best.expiry,
        dte: best.dte,
        delta: best.delta,
        gamma: best.gamma ?? null,
        theta: best.theta ?? null,
        vega: best.vega ?? null,
        iv: best.iv ?? null,
        bid: best.bid,
        ask: best.ask,
        mid: best.mid ?? null,
        spread_pct: best.spread_pct,
        volume: best.volume ?? null,
        open_interest: best.open_interest ?? null,
        premium: best.premium,
        contract_score: best.contract_score,
        liquidity_score: best.liquidity_score,
        rationale: best.rationale,
        rationale_factors: best.rationale_factors,
        contract_source: source,
        candidates_considered: candidates.length,
        risk_profile: profile,
      })
      .select("id")
      .single();
    if (ierr) { console.error("snapshot insert failed", ierr); }
    else snapshotId = inserted?.id ?? null;
  }

  return json({
    ok: true,
    snapshot_id: snapshotId,
    contract_source: source,
    profile,
    candidates_considered: candidates.length,
    best,
    alternates: scored.slice(1, 4),
    latency_ms: Date.now() - t0,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
