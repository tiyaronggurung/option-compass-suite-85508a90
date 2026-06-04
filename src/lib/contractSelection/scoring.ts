// Contract Selection Engine — pure scoring (v1.1).
// No I/O. Imported by the select-contract edge function AND any UI preview.
//
// v1.1 changes:
//   • Hard rejects kept for: bad quote, expired/short DTE, wrong delta side, missing delta,
//     no premium, premium > affordability cap, OI below band floor, extreme spread (>25%),
//     spread above band cap.
//   • Volume is NO LONGER a hard reject. Low volume becomes a scoring penalty.
//     If OI >= 2× band minimum, low volume is tolerated. Otherwise it still penalizes.
//   • Rejection reasons are categorized for analytics (REJECTION_CATEGORIES).
//   • rankCandidates returns rejection counts AND the best-effort top candidate
//     among rejected ones (above EXTREME thresholds), for the engine to surface
//     when nothing passes.

import {
  BAND_PREFS,
  BEST_EFFORT_MIN_SCORE,
  EXTREME_SPREAD_PCT,
  MAX_PREMIUM_DOLLARS,
  MIN_DTE_FLOOR,
  type BandPrefs,
  type RiskProfile,
} from "./bands";

export type Candidate = {
  contract_symbol?: string | null;
  strike: number;
  expiry: string;            // YYYY-MM-DD
  dte: number;
  delta: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv?: number | null;
  bid: number | null;
  ask: number | null;
  mid?: number | null;
  premium: number | null;    // per share
  volume?: number | null;
  open_interest?: number | null;
};

export type RejectionCategory =
  | "quote"
  | "dte"
  | "delta"
  | "spread"
  | "liquidity"
  | "affordability"
  | "data";

export type ScoredCandidate = Candidate & {
  spread_pct: number | null;
  contract_score: number;        // 0..100
  liquidity_score: number;       // 0..100
  rationale: string;
  rationale_factors: Record<string, number>;
  rejected_reason: string | null;
  rejected_category: RejectionCategory | null;
};

function triangular(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return 0;
  const center = (lo + hi) / 2;
  const halfWidth = (hi - lo) / 2;
  const d = Math.abs(value - center);
  if (d >= halfWidth) return 0;
  return 1 - d / halfWidth;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function spreadPct(bid: number | null, ask: number | null, mid: number | null): number | null {
  if (bid == null || ask == null) return null;
  if (bid <= 0 || ask <= 0 || ask < bid) return null;
  const m = mid ?? (bid + ask) / 2;
  if (m <= 0) return null;
  return ((ask - bid) / m) * 100;
}

export function scoreCandidate(c: Candidate, profile: RiskProfile): ScoredCandidate {
  const p: BandPrefs = BAND_PREFS[profile];
  const sp = spreadPct(c.bid, c.ask, c.mid ?? null);
  const factors: Record<string, number> = {};
  const reasons: string[] = [];

  // ── HARD REJECTS ────────────────────────────────────────────────
  if (c.dte < MIN_DTE_FLOOR) return reject(c, sp, `too short DTE (< ${MIN_DTE_FLOOR})`, "dte");
  if (c.bid == null || c.ask == null || c.bid <= 0 || c.ask <= 0) return reject(c, sp, "no two-sided quote", "quote");
  if (sp == null) return reject(c, sp, "invalid spread", "quote");
  if (sp > EXTREME_SPREAD_PCT) return reject(c, sp, `extreme spread (${sp.toFixed(1)}% > ${EXTREME_SPREAD_PCT}%)`, "spread");
  if (sp > p.maxSpreadPct) return reject(c, sp, `spread too wide (${sp.toFixed(1)}% > ${p.maxSpreadPct}%)`, "spread");
  if ((c.open_interest ?? 0) < p.minOI) return reject(c, sp, `OI below band min (${c.open_interest ?? 0} < ${p.minOI})`, "liquidity");
  if (c.premium == null || c.premium <= 0) return reject(c, sp, "no premium", "data");
  if (c.premium * 100 > MAX_PREMIUM_DOLLARS) return reject(c, sp, `premium above $${MAX_PREMIUM_DOLLARS} affordability cap`, "affordability");
  const absDelta = c.delta == null ? null : Math.abs(c.delta);
  if (absDelta == null) return reject(c, sp, "missing delta", "data");

  // Volume floor is SOFT in v1.1 — only reject if BOTH volume < floor AND OI < 2× minOI
  const vol = c.volume ?? 0;
  const oi = c.open_interest ?? 0;
  const volBelowFloor = vol < p.minVolume;
  const oiCompensates = oi >= p.minOI * 2;
  if (volBelowFloor && !oiCompensates) {
    return reject(c, sp, `volume below band min (${vol} < ${p.minVolume}) and OI insufficient to compensate`, "liquidity");
  }

  // ── SOFT FACTORS (0..1) ─────────────────────────────────────────
  const dteFit = triangular(c.dte, p.dteMin, p.dteMax);
  const deltaFit = triangular(absDelta, p.deltaMin, p.deltaMax);

  const oiScore = clamp01(Math.log10(Math.max(1, oi)) / Math.log10(Math.max(10, p.minOI * 20)));
  const volScore = clamp01(Math.log10(Math.max(1, vol)) / Math.log10(Math.max(10, p.minVolume * 20)));
  // If volume is below floor, apply a 30% penalty on its component (keep it as soft signal).
  const volEffective = volBelowFloor ? volScore * 0.7 : volScore;
  const liquidity = (oiScore + volEffective) / 2;

  const spreadQuality = clamp01(1 - sp / p.maxSpreadPct);
  const affordability = clamp01(1 - Math.max(0, c.premium * 100 - 1000) / (MAX_PREMIUM_DOLLARS - 1000));

  const ivPenalty = c.iv == null ? 0.5 : clamp01(1 - Math.max(0, (c.iv > 5 ? c.iv / 100 : c.iv) - 0.8) * 2);

  factors.dte_fit = round3(dteFit);
  factors.delta_fit = round3(deltaFit);
  factors.liquidity = round3(liquidity);
  factors.spread_quality = round3(spreadQuality);
  factors.affordability = round3(affordability);
  factors.iv_sanity = round3(ivPenalty);

  const score01 =
    0.25 * dteFit +
    0.25 * deltaFit +
    0.20 * liquidity +
    0.15 * spreadQuality +
    0.10 * affordability +
    0.05 * ivPenalty;

  const score = Math.round(score01 * 100);
  const liqScore = Math.round(liquidity * 100);

  if (dteFit > 0.7) reasons.push("DTE in sweet spot");
  else if (dteFit > 0.3) reasons.push("DTE acceptable");
  if (deltaFit > 0.7) reasons.push(`Δ ${absDelta.toFixed(2)} balanced for band`);
  else if (deltaFit > 0.3) reasons.push(`Δ ${absDelta.toFixed(2)} acceptable`);
  if (spreadQuality > 0.7) reasons.push(`tight spread ${sp!.toFixed(1)}%`);
  if (liquidity > 0.6) reasons.push("healthy liquidity");
  if (affordability > 0.7) reasons.push("affordable premium");
  if (volBelowFloor && oiCompensates) reasons.push("low volume offset by strong OI");

  const rationale = reasons.length ? reasons.join(", ") : "Meets band guards";

  return {
    ...c,
    spread_pct: sp,
    contract_score: score,
    liquidity_score: liqScore,
    rationale,
    rationale_factors: factors,
    rejected_reason: null,
    rejected_category: null,
  };
}

function reject(c: Candidate, sp: number | null, reason: string, category: RejectionCategory): ScoredCandidate {
  return {
    ...c,
    spread_pct: sp,
    contract_score: 0,
    liquidity_score: 0,
    rationale: `Rejected: ${reason}`,
    rationale_factors: {},
    rejected_reason: reason,
    rejected_category: category,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export type RankResult = {
  scored: ScoredCandidate[];                       // passing, ranked
  best: ScoredCandidate | null;                    // best passing
  rejected: ScoredCandidate[];                     // all rejected
  rejectionCounts: Record<RejectionCategory, number>;
  bestEffort: ScoredCandidate | null;              // best candidate from "tolerable" rejects (spread + liquidity), if score >= threshold
};

// For best-effort, re-score rejected-by-liquidity-or-spread candidates IGNORING those soft guards,
// pick the highest scoring one above BEST_EFFORT_MIN_SCORE. We do NOT relax hard safety rejects
// (quote, delta, dte, affordability, data, extreme spread).
function scoreForBestEffort(c: Candidate, profile: RiskProfile): ScoredCandidate | null {
  const p: BandPrefs = BAND_PREFS[profile];
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
  if (deltaFit <= 0 && dteFit <= 0) return null; // outside both windows → unsafe

  const oi = c.open_interest ?? 0;
  const vol = c.volume ?? 0;
  const oiScore = clamp01(Math.log10(Math.max(1, oi)) / Math.log10(Math.max(10, p.minOI * 20)));
  const volScore = clamp01(Math.log10(Math.max(1, vol)) / Math.log10(Math.max(10, p.minVolume * 20)));
  const liquidity = (oiScore + volScore) / 2;
  // Use band spread as denominator but clamp; below-band spread will score 0 here.
  const spreadDen = Math.max(p.maxSpreadPct, sp);
  const spreadQuality = clamp01(1 - sp / spreadDen);
  const affordability = clamp01(1 - Math.max(0, c.premium * 100 - 1000) / (MAX_PREMIUM_DOLLARS - 1000));
  const ivPenalty = c.iv == null ? 0.5 : clamp01(1 - Math.max(0, (c.iv > 5 ? c.iv / 100 : c.iv) - 0.8) * 2);

  const factors = {
    dte_fit: round3(dteFit),
    delta_fit: round3(deltaFit),
    liquidity: round3(liquidity),
    spread_quality: round3(spreadQuality),
    affordability: round3(affordability),
    iv_sanity: round3(ivPenalty),
  };
  const score01 = 0.25*dteFit + 0.25*deltaFit + 0.20*liquidity + 0.15*spreadQuality + 0.10*affordability + 0.05*ivPenalty;
  return {
    ...c,
    spread_pct: sp,
    contract_score: Math.round(score01 * 100),
    liquidity_score: Math.round(liquidity * 100),
    rationale: `Best-effort pick — below preferred band (spread ${sp.toFixed(1)}%, OI ${oi}, vol ${vol})`,
    rationale_factors: factors,
    rejected_reason: null,
    rejected_category: null,
  };
}

export function rankCandidates(cands: Candidate[], profile: RiskProfile): RankResult {
  const all = cands.map((c) => scoreCandidate(c, profile));
  const scored = all.filter((s) => s.rejected_reason == null);
  const rejected = all.filter((s) => s.rejected_reason != null);

  const rejectionCounts: Record<RejectionCategory, number> = {
    quote: 0, dte: 0, delta: 0, spread: 0, liquidity: 0, affordability: 0, data: 0,
  };
  for (const r of rejected) {
    if (r.rejected_category) rejectionCounts[r.rejected_category]++;
  }

  scored.sort(sortBest);

  // Best-effort: from rejected candidates whose ONLY problems were spread/liquidity,
  // rescore ignoring those caps and surface the top one if it clears the min threshold.
  let bestEffort: ScoredCandidate | null = null;
  if (scored.length === 0) {
    const beCandidates = rejected
      .filter((r) => r.rejected_category === "spread" || r.rejected_category === "liquidity")
      .map((r) => scoreForBestEffort(r, profile))
      .filter((s): s is ScoredCandidate => s != null && s.contract_score >= BEST_EFFORT_MIN_SCORE);
    beCandidates.sort(sortBest);
    bestEffort = beCandidates[0] ?? null;
  }

  return { scored, best: scored[0] ?? null, rejected, rejectionCounts, bestEffort };
}

function sortBest(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.contract_score !== a.contract_score) return b.contract_score - a.contract_score;
  const aoi = a.open_interest ?? 0;
  const boi = b.open_interest ?? 0;
  if (boi !== aoi) return boi - aoi;
  const asp = a.spread_pct ?? 1e9;
  const bsp = b.spread_pct ?? 1e9;
  return asp - bsp;
}

export function daysBetween(from: Date, isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return -1;
  const target = Date.UTC(y, m - 1, d);
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((target - base) / 86_400_000);
}
