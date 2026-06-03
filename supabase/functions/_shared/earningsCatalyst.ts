// Earnings catalyst lookup. Read-only, runs against the cached earnings_events table.
// If table empty / Alpha Vantage not configured, returns null and scanner continues
// without any catalyst adjustment.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type CatalystResult = {
  tag: "Earnings Tomorrow" | "Earnings Soon" | "Post Earnings Drift";
  summary: string;
  /** Small positive bump to confidence (0..100). */
  confidenceBoost: number;
  /** If true, force risk level to at least HIGH (IV crush window). */
  forceHighRisk: boolean;
  daysToReport: number;        // negative = past
  reportDate: string;
};

/** Pick the catalyst window for a ticker, if any, given today's date. */
export async function getEarningsCatalyst(
  admin: SupabaseClient,
  ticker: string,
  now = new Date(),
): Promise<CatalystResult | null> {
  // Look at events in a [-7d, +30d] window
  const past = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const future = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("earnings_events")
    .select("report_date")
    .eq("ticker", ticker)
    .gte("report_date", past)
    .lte("report_date", future)
    .order("report_date", { ascending: true });
  if (error || !data || data.length === 0) return null;

  const today = startOfDay(now);
  let chosen: { report_date: string; days: number } | null = null;

  // Prefer nearest upcoming (incl. today); else most recent past within 3d
  for (const row of data) {
    const reportDay = startOfDay(new Date(row.report_date + "T00:00:00Z"));
    const days = Math.round((reportDay.getTime() - today.getTime()) / 86400000);
    if (days >= 0) { chosen = { report_date: row.report_date, days }; break; }
  }
  if (!chosen) {
    // Most recent past within 3 days
    for (let i = data.length - 1; i >= 0; i--) {
      const reportDay = startOfDay(new Date(data[i].report_date + "T00:00:00Z"));
      const days = Math.round((reportDay.getTime() - today.getTime()) / 86400000);
      if (days < 0 && days >= -3) { chosen = { report_date: data[i].report_date, days }; break; }
    }
  }
  if (!chosen) return null;

  const d = chosen.days;
  if (d <= 1 && d >= 0) {
    return {
      tag: "Earnings Tomorrow",
      summary: d === 0
        ? `Earnings report today (${chosen.report_date}). Earnings can increase volatility and option IV crush risk.`
        : `Earnings report tomorrow (${chosen.report_date}). Earnings can increase volatility and option IV crush risk.`,
      confidenceBoost: 0,
      forceHighRisk: true,
      daysToReport: d,
      reportDate: chosen.report_date,
    };
  }
  if (d >= 2 && d <= 7) {
    return {
      tag: "Earnings Soon",
      summary: `Earnings in ${d} days (${chosen.report_date}). Catalyst window — IV may expand into report.`,
      confidenceBoost: 3,
      forceHighRisk: false,
      daysToReport: d,
      reportDate: chosen.report_date,
    };
  }
  if (d < 0 && d >= -3) {
    const dayN = Math.abs(d);
    return {
      tag: "Post Earnings Drift",
      summary: `Post-earnings day ${dayN} (reported ${chosen.report_date}). PEAD window — trend follow-through possible.`,
      confidenceBoost: 2,
      forceHighRisk: false,
      daysToReport: d,
      reportDate: chosen.report_date,
    };
  }
  return null;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
