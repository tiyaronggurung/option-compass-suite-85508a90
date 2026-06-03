// Pure ranking utility for Top Signals leaderboard.
// No side effects. Does not mutate signals. Does not place orders.

import type { Signal } from "@/lib/signalHelpers";

export type RankBreakdown = {
  confidence: number;   // 0..35
  liquidity: number;    // 0..20
  delta: number;        // 0..15
  spread: number;       // 0..15
  freshness: number;    // 0..10
  riskPenalty: number;  // 0..5 (subtracted)
  total: number;        // 0..100
};

export type ContractMeta = {
  delta?: number | null;
  iv?: number | null;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  dte?: number | null;
  spread_pct?: number | null;
  liquidity_score?: number | null;
} | null | undefined;

export function getContractMeta(s: Signal): ContractMeta {
  const tm = s.technical_metrics as any;
  if (!tm || typeof tm !== "object") return null;
  return (tm.contract ?? null) as ContractMeta;
}

const TARGET_DELTA = 0.35;
const MAX_SPREAD_PCT = 25; // 25% spread = 0 quality
const FRESH_MS = 15 * 60_000;      // <15m = full credit
const STALE_MS = 6 * 60 * 60_000;  // >6h = 0

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function rankSignal(s: Signal, now = Date.now()): RankBreakdown {
  const contract = getContractMeta(s);

  // Confidence: signal.confidence is 0..100, weight 35%
  const confidence = (clamp(Number(s.confidence ?? 0), 0, 100) / 100) * 35;

  // Liquidity: 0..100 from contract, weight 20%
  const liq = contract?.liquidity_score != null ? clamp(Number(contract.liquidity_score), 0, 100) : 0;
  const liquidity = (liq / 100) * 20;

  // Delta match: closer to 0.35 = higher. weight 15%. Missing delta = 0.
  let deltaScore = 0;
  if (contract?.delta != null) {
    const d = Math.abs(Number(contract.delta));
    const diff = Math.abs(d - TARGET_DELTA);
    deltaScore = clamp(1 - diff / TARGET_DELTA, 0, 1) * 15;
  }

  // Spread quality: lower is better. weight 15%. Missing = 0.
  let spreadScore = 0;
  if (contract?.spread_pct != null) {
    const sp = Math.max(0, Number(contract.spread_pct));
    spreadScore = clamp(1 - sp / MAX_SPREAD_PCT, 0, 1) * 15;
  }

  // Freshness: 100% if <15m, linear decay to 0 at 6h. weight 10%.
  const ageMs = Math.max(0, now - new Date(s.created_at).getTime());
  let freshFrac: number;
  if (ageMs <= FRESH_MS) freshFrac = 1;
  else if (ageMs >= STALE_MS) freshFrac = 0;
  else freshFrac = 1 - (ageMs - FRESH_MS) / (STALE_MS - FRESH_MS);
  const freshness = freshFrac * 10;

  // Risk penalty: LOW=0, MEDIUM=2.5, HIGH=5
  const riskPenalty =
    s.risk_level === "HIGH" ? 5 : s.risk_level === "MEDIUM" ? 2.5 : 0;

  const total = clamp(
    confidence + liquidity + deltaScore + spreadScore + freshness - riskPenalty,
    0,
    100,
  );

  return {
    confidence: round(confidence),
    liquidity: round(liquidity),
    delta: round(deltaScore),
    spread: round(spreadScore),
    freshness: round(freshness),
    riskPenalty: round(riskPenalty),
    total: round(total),
  };
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}

export type RankedSignal = { signal: Signal; rank: RankBreakdown };

export function rankSignals(signals: Signal[], now = Date.now()): RankedSignal[] {
  return signals
    .map((s) => ({ signal: s, rank: rankSignal(s, now) }))
    .sort((a, b) => b.rank.total - a.rank.total);
}
