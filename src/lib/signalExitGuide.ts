import type { Signal } from "@/lib/signalHelpers";
import { getLifecycleState } from "@/lib/signalLifecycle";
import { daysToExpiry } from "@/lib/blackScholes";
import { analyzeCostEfficiency } from "@/lib/costEfficiency";

export type ExitGuideBand = "HOLD" | "TRIM" | "EXIT";

export type SignalExitGuide = {
  band: ExitGuideBand;
  headline: string;
  reasons: string[];
};

/**
 * Build a simple exit / trim / hold verdict for a signal card.
 * Uses lifecycle state, DTE, and cost-efficiency/theta metrics.
 * Returns null when there is no actionable guidance (i.e. HOLD and no reasons).
 */
export function getSignalExitGuide(signal: Signal): SignalExitGuide | null {
  const reasons: string[] = [];
  let level: 0 | 1 | 2 = 0; // 0 = HOLD, 1 = TRIM, 2 = EXIT

  const lifecycle = getLifecycleState(signal);
  if (lifecycle === "expired") {
    level = 2;
    reasons.push("Signal expired by time");
  } else if (lifecycle === "invalidated") {
    level = 2;
    reasons.push("Signal invalidated — thesis broken");
  } else if (lifecycle === "weakening") {
    level = Math.max(level, 1) as 0 | 1 | 2;
    reasons.push("Signal weakening");
  }

  const dte = signal.dte ?? daysToExpiry(signal.expiry);
  if (dte != null && dte <= 1) {
    level = 2;
    reasons.push(dte === 0 ? "0DTE — expires today" : "1DTE — expires tomorrow");
  } else if (dte != null && dte <= 3) {
    level = Math.max(level, 1) as 0 | 1 | 2;
    reasons.push(`${dte}DTE — theta pressure rising`);
  }


  const strike = signal.strike != null ? Number(signal.strike) : null;
  const premium = signal.premium != null ? Number(signal.premium) : null;
  const spot = Number(signal.price);
  const theta = (signal.technical_metrics as any)?.contract?.theta ?? null;

  if (
    strike != null &&
    premium != null &&
    Number.isFinite(spot) &&
    spot > 0 &&
    Number.isFinite(premium) &&
    premium > 0 &&
    dte != null
  ) {
    const type = signal.direction === "CALL" ? "call" : "put";
    const ce = analyzeCostEfficiency({ premium, strike, spot, dte, theta, type });
    if (ce.verdict === "theta_trap") {
      level = 2;
      reasons.push("Theta trap — daily decay too high");
    } else if (ce.verdict === "marginal") {
      level = Math.max(level, 1);
      reasons.push("Cost efficiency marginal");
    }
  }

  if (reasons.length === 0) return null;

  const band = level === 2 ? "EXIT" : level === 1 ? "TRIM" : "HOLD";
  return { band, headline: reasons[0], reasons };
}

export const EXIT_GUIDE_CLASS: Record<ExitGuideBand, string> = {
  HOLD: "bg-muted/30 text-muted-foreground border-border",
  TRIM: "bg-warn/15 text-warn border-warn/30",
  EXIT: "bg-bear/15 text-bear border-bear/30",
};
