// Exit Score engine — pure, client-side, no network calls.
//
// Computes a 0–100 "best exit window" score for an OPEN paper option trade
// (calls AND puts). The score is direction-agnostic because P/L is derived
// from premium change, which is already signed correctly for long calls/puts.
//
// Hard triggers short-circuit to a fixed score+label. Otherwise we sum
// weighted factors (each 0..1). Threshold: >=75 = EXIT NOW, 50-74 = TRIM,
// <50 = HOLD.

export type ExitBand = "HOLD" | "TRIM" | "EXIT";

export type ExitFactor = {
  key: string;
  label: string;
  weight: number;     // 0..100 contribution cap
  value: number;      // 0..1 raw activation
  contribution: number; // weight * value
};

export type ExitScore = {
  score: number;        // 0..100
  band: ExitBand;
  headline: string;     // one-liner reason for toast/badge tooltip
  hardTrigger: boolean; // true when a hard rule fired
  factors: ExitFactor[];
};

export type ExitInputs = {
  optionType: "CALL" | "PUT";
  entryPremium: number;
  currentPremium: number | null;
  peakPremium: number | null;       // trailing high since entry
  recentMarks: number[];            // last N marks oldest->newest
  plPct: number | null;             // P/L as % of total cost
  dte: number | null;               // days to expiry
  theta: number | null;             // per-day, negative for longs
  alertStatus?: string | null;      // from trade_alerts.alert_status
};

function clamp01(x: number) {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function bandFor(score: number): ExitBand {
  if (score >= 75) return "EXIT";
  if (score >= 50) return "TRIM";
  return "HOLD";
}

// Momentum: is the last 3-mark slope rolling over?
function momentumRolling(marks: number[]): boolean {
  if (marks.length < 3) return false;
  const a = marks[marks.length - 3];
  const b = marks[marks.length - 2];
  const c = marks[marks.length - 1];
  return c < b && b <= a;
}

export function computeExitScore(inp: ExitInputs): ExitScore {
  const factors: ExitFactor[] = [];

  // ---- Hard triggers ----------------------------------------------------
  // Lock the win: >=+100% AND momentum rolling
  if (inp.plPct != null && inp.plPct >= 100 && momentumRolling(inp.recentMarks)) {
    return {
      score: 90,
      band: "EXIT",
      headline: "Lock the win — momentum rolling at +100%+",
      hardTrigger: true,
      factors,
    };
  }
  // Stop zone: -50% or worse on premium
  if (inp.plPct != null && inp.plPct <= -50) {
    return {
      score: 80,
      band: "EXIT",
      headline: "Stop zone — premium down 50%+",
      hardTrigger: true,
      factors,
    };
  }
  // Decay risk: 2 DTE or less
  if (inp.dte != null && inp.dte <= 2) {
    return {
      score: 75,
      band: "EXIT",
      headline: `Decay risk — ${inp.dte}d to expiry`,
      hardTrigger: true,
      factors,
    };
  }

  // ---- Scored factors (weights sum to 100) ------------------------------

  // 1. Drawdown from trailing peak (only meaningful when in profit)
  //    25% pullback => full activation. Below 5% => 0.
  let drawdownVal = 0;
  if (inp.peakPremium != null && inp.currentPremium != null && inp.peakPremium > 0
      && inp.currentPremium < inp.peakPremium && (inp.plPct ?? 0) > 0) {
    const dd = (inp.peakPremium - inp.currentPremium) / inp.peakPremium;
    drawdownVal = clamp01((dd - 0.05) / 0.20); // 5%->0, 25%->1
  }
  factors.push({
    key: "drawdown",
    label: "Pullback from peak",
    weight: 30,
    value: drawdownVal,
    contribution: 30 * drawdownVal,
  });

  // 2. Plan target hit (T2 or T3 from trade_alerts.alert_status)
  let targetVal = 0;
  if (inp.alertStatus === "hit_t3") targetVal = 1;
  else if (inp.alertStatus === "hit_t2") targetVal = 0.85;
  else if (inp.alertStatus === "hit_t1") targetVal = 0.4;
  factors.push({
    key: "target",
    label: "Plan target captured",
    weight: 25,
    value: targetVal,
    contribution: 25 * targetVal,
  });

  // 3. Momentum rolling while in profit
  const momoVal = momentumRolling(inp.recentMarks) && (inp.plPct ?? 0) > 20 ? 1 : 0;
  factors.push({
    key: "momentum",
    label: "Momentum rolling over",
    weight: 15,
    value: momoVal,
    contribution: 15 * momoVal,
  });

  // 4. DTE pressure (5d->0.5, 3d->1, 7d->0.1, >=10d->0)
  let dteVal = 0;
  if (inp.dte != null) dteVal = clamp01((10 - inp.dte) / 7);
  factors.push({
    key: "dte",
    label: "Days-to-expiry pressure",
    weight: 15,
    value: dteVal,
    contribution: 15 * dteVal,
  });

  // 5. Theta burn pressure — theta as % of current premium per day
  //    1%/day -> 0, 5%/day -> 1
  let thetaVal = 0;
  if (inp.theta != null && inp.currentPremium != null && inp.currentPremium > 0) {
    const burnPct = Math.abs(inp.theta) / inp.currentPremium;
    thetaVal = clamp01((burnPct - 0.01) / 0.04);
  }
  factors.push({
    key: "theta",
    label: "Theta burn vs premium",
    weight: 15,
    value: thetaVal,
    contribution: 15 * thetaVal,
  });

  const score = Math.round(factors.reduce((s, f) => s + f.contribution, 0));
  const band = bandFor(score);

  // Build headline from top contributor
  const top = [...factors].sort((a, b) => b.contribution - a.contribution)[0];
  const headline =
    band === "EXIT"
      ? `Best exit window — ${top?.label?.toLowerCase() ?? "multiple factors"}`
      : band === "TRIM"
        ? `Consider trimming — ${top?.label?.toLowerCase() ?? "mixed signals"}`
        : "Hold — no exit pressure";

  return { score, band, headline, hardTrigger: false, factors };
}

// Helpers ---------------------------------------------------------------
export function dteFromExpiry(expiry: string | null | undefined): number | null {
  if (!expiry) return null;
  const [y, m, d] = expiry.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  const exp = new Date(Date.UTC(y, m - 1, d, 21, 0, 0)); // ~ market close UTC
  const ms = exp.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function bandColor(band: ExitBand): { text: string; bg: string; border: string } {
  switch (band) {
    case "EXIT": return { text: "text-bear", bg: "bg-bear/15", border: "border-bear/40" };
    case "TRIM": return { text: "text-warn", bg: "bg-warn/15", border: "border-warn/40" };
    default:     return { text: "text-muted-foreground", bg: "bg-muted/30", border: "border-border" };
  }
}
