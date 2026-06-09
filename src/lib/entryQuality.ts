// Entry Quality Score — pure helper for UI badges in the Buy Option dialog.
// Returns 0–100 score + color band so users can instantly see which strike
// gives the best win-rate setup without touching any existing selection logic.
//
// Factors (same rules discussed with the user):
//   • Delta 0.30–0.45 is the sweet spot (35–45% chance ITM)
//   • Premium $0.80–$3.50 per share ($80–$350/contract)
//   • DTE 5–21 days
//   • Spread < 8% of mid (tight = cheaper exit)
//   • Liquidity: OI > 500, Volume > 100

export type EntryQualityInput = {
  delta: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  expiry: string; // YYYY-MM-DD
};

export type EntryQualityResult = {
  score: number; // 0–100
  band: "poor" | "fair" | "good" | "excellent";
  factors: {
    delta: number;
    premium: number;
    spread: number;
    liquidity: number;
    dte: number;
  };
};

function triangular(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return 0;
  const center = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  const d = Math.abs(value - center);
  if (d >= half) return 0;
  return 1 - d / half;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function daysToExpiry(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return 0;
  const target = Date.UTC(y, m - 1, d);
  const now = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Math.max(0, Math.round((target - now) / 86_400_000));
}

export function computeEntryQuality(input: EntryQualityInput): EntryQualityResult {
  const mid =
    input.bid != null && input.ask != null && input.bid > 0 && input.ask > 0
      ? (input.bid + input.ask) / 2
      : Number(input.ask ?? input.last ?? input.bid ?? 0);

  const dte = daysToExpiry(input.expiry);

  // Delta fit: sweet spot 0.30–0.45, acceptable window 0.20–0.60
  const absDelta = input.delta == null ? null : Math.abs(input.delta);
  const deltaFit = absDelta == null ? 0 : triangular(absDelta, 0.20, 0.60);

  // Premium fit: sweet spot $0.80–$3.50 per share, window $0.40–$5.00
  const premiumFit = mid > 0 ? triangular(mid, 0.40, 5.00) : 0;

  // Spread quality: ideal < 5%, worsens up to 15%
  let spreadQuality = 0;
  if (input.bid != null && input.ask != null && input.bid > 0 && input.ask > 0) {
    const sp = ((input.ask - input.bid) / mid) * 100;
    spreadQuality = clamp01(1 - Math.max(0, sp - 5) / 10); // 5%→1.0, 15%→0.0
  }

  // Liquidity: OI > 500 and volume > 100 is ideal
  const oi = input.open_interest ?? 0;
  const vol = input.volume ?? 0;
  const oiScore = clamp01(Math.log10(Math.max(1, oi)) / Math.log10(5000));
  const volScore = clamp01(Math.log10(Math.max(1, vol)) / Math.log10(5000));
  const liquidity = (oiScore + volScore) / 2;

  // DTE fit: 5–21 days sweet spot, 2–30 acceptable
  const dteFit = triangular(dte, 2, 30);

  const score01 =
    0.30 * deltaFit +
    0.20 * premiumFit +
    0.20 * spreadQuality +
    0.20 * liquidity +
    0.10 * dteFit;

  const score = Math.round(score01 * 100);

  let band: EntryQualityResult["band"] = "poor";
  if (score >= 80) band = "excellent";
  else if (score >= 60) band = "good";
  else if (score >= 40) band = "fair";

  return {
    score,
    band,
    factors: {
      delta: Math.round(deltaFit * 100),
      premium: Math.round(premiumFit * 100),
      spread: Math.round(spreadQuality * 100),
      liquidity: Math.round(liquidity * 100),
      dte: Math.round(dteFit * 100),
    },
  };
}
