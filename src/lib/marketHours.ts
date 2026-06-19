// Shared US equities/options regular-hours gate (Mon–Fri 09:30–16:00 America/New_York).
// Used to block paper-option buys outside RTH so we never simulate fills when
// the option market itself is closed. Holidays are not enumerated here — the
// weekend + clock check covers ~99% of cases and matches what the backend
// mark engine uses.

export type MarketStatus = {
  open: boolean;
  reason: string; // human-readable reason when closed
};

// US equity/options full market closures (NYSE/CBOE).
// Keep in sync with the duplicate set in supabase/functions/*/index.ts gates.
export const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  "2025-01-01","2025-01-09","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
  "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
  // 2026
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19",
  "2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  // 2027
  "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31","2027-06-18",
  "2027-07-05","2027-09-06","2027-11-25","2027-12-25",
]);

// Early-close days (NYSE closes at 1:00 PM ET). Options follow the same schedule.
export const US_MARKET_EARLY_CLOSE_DAYS: ReadonlySet<string> = new Set([
  "2025-11-28","2025-12-24",
  "2026-11-27","2026-12-24",
  "2027-11-26","2027-12-24",
]);

function nyDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export function getUsMarketStatus(d: Date = new Date()): MarketStatus {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);

  if (weekday === "Sat" || weekday === "Sun") {
    return { open: false, reason: "Market closed — weekend. Option buys resume Monday 9:30 AM ET." };
  }
  const ymd = nyDateString(d);
  if (US_MARKET_HOLIDAYS.has(ymd)) {
    return { open: false, reason: "Market closed — US holiday. Option buys resume next trading day at 9:30 AM ET." };
  }
  const mins = hour * 60 + minute;
  const earlyClose = US_MARKET_EARLY_CLOSE_DAYS.has(ymd);
  const closeMins = earlyClose ? 13 * 60 : 16 * 60;

  if (mins < 9 * 60 + 30) {
    return { open: false, reason: "Pre-market — option buys open at 9:30 AM ET." };
  }
  if (mins >= closeMins) {
    return {
      open: false,
      reason: earlyClose
        ? "Early close — option market closed at 1:00 PM ET. Buys resume at 9:30 AM ET next trading day."
        : "After-hours — option market is closed. Buys resume at 9:30 AM ET next trading day.",
    };
  }
  return { open: true, reason: "" };
}

export function isUsMarketOpen(d: Date = new Date()): boolean {
  return getUsMarketStatus(d).open;
}
