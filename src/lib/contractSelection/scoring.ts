// Contract Selection Engine — pure scoring.
// No I/O. Imported by the select-contract edge function AND any UI preview.

import {
  BAND_PREFS,
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

export type ScoredCandidate = Candidate & {
  spread_pct: number | null;
  contract_score: number;        // 0..100
  liquidity_score: number;       // 0..100
  rationale: string;
  rationale_factors: Record<string, number>;
  rejected_reason: string | null;
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

  // Hard rejects
  if (c.dte < MIN_DTE_FLOOR) {
    return reject(c, sp, "too short DTE (< 6)");
  }
  if (c.bid == null || c.ask == null || c.bid <= 0 || c.ask <= 0) {
    return reject(c, sp, "no two-sided quote");
  }
  if (sp == null || sp > p.maxSpreadPct) {
    return reject(c, sp, `spread too wide (${sp == null ? "n/a" : sp.toFixed(1) + "%"} > ${p.maxSpreadPct}%)`);
  }
  if ((c.open_interest ?? 0) < p.minOI) {
    return reject(c, sp, `OI below band min (${c.open_interest ?? 0} < ${p.minOI})`);
  }
  if ((c.volume ?? 0) < p.minVolume) {
    return reject(c, sp, `volume below band min (${c.volume ?? 0} < ${p.minVolume})`);
  }
  if (c.premium == null || c.premium <= 0) {
    return reject(c, sp, "no premium");
  }
  if (c.premium * 100 > MAX_PREMIUM_DOLLARS) {
    return reject(c, sp, `premium above $${MAX_PREMIUM_DOLLARS} affordability cap`);
  }
  const absDelta = c.delta == null ? null : Math.abs(c.delta);
  if (absDelta == null) {
    return reject(c, sp, "missing delta");
  }

  // Soft factors (0..1)
  const dteFit = triangular(c.dte, p.dteMin, p.dteMax);
  const deltaFit = triangular(absDelta, p.deltaMin, p.deltaMax);

  const oiScore = clamp01(Math.log10(Math.max(1, c.open_interest ?? 0)) / Math.log10(Math.max(10, p.minOI * 20)));
  const volScore = clamp01(Math.log10(Math.max(1, c.volume ?? 0)) / Math.log10(Math.max(10, p.minVolume * 20)));
  const liquidity = (oiScore + volScore) / 2;

  const spreadQuality = clamp01(1 - sp / p.maxSpreadPct);
  const affordability = clamp01(1 - Math.max(0, c.premium * 100 - 1000) / (MAX_PREMIUM_DOLLARS - 1000));

  // IV sanity: 0..1, penalize >80% IV when we have nothing better to compare against.
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

  const rationale = reasons.length ? reasons.join(", ") : "Meets band guards";

  return {
    ...c,
    spread_pct: sp,
    contract_score: score,
    liquidity_score: liqScore,
    rationale,
    rationale_factors: factors,
    rejected_reason: null,
  };
}

function reject(c: Candidate, sp: number | null, reason: string): ScoredCandidate {
  return {
    ...c,
    spread_pct: sp,
    contract_score: 0,
    liquidity_score: 0,
    rationale: `Rejected: ${reason}`,
    rationale_factors: {},
    rejected_reason: reason,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function rankCandidates(cands: Candidate[], profile: RiskProfile): {
  scored: ScoredCandidate[];
  best: ScoredCandidate | null;
} {
  const scored = cands
    .map((c) => scoreCandidate(c, profile))
    .filter((s) => s.rejected_reason == null);

  scored.sort((a, b) => {
    if (b.contract_score !== a.contract_score) return b.contract_score - a.contract_score;
    const aoi = a.open_interest ?? 0;
    const boi = b.open_interest ?? 0;
    if (boi !== aoi) return boi - aoi;
    const asp = a.spread_pct ?? 1e9;
    const bsp = b.spread_pct ?? 1e9;
    return asp - bsp;
  });

  return { scored, best: scored[0] ?? null };
}

export function daysBetween(from: Date, isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return -1;
  const target = Date.UTC(y, m - 1, d);
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((target - base) / 86_400_000);
}
