// Shared US equities/options regular-hours gate (Mon–Fri 09:30–16:00 America/New_York).
// Used to block paper-option buys outside RTH so we never simulate fills when
// the option market itself is closed. Holidays are not enumerated here — the
// weekend + clock check covers ~99% of cases and matches what the backend
// mark engine uses.

export type MarketStatus = {
  open: boolean;
  reason: string; // human-readable reason when closed
};

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
  const mins = hour * 60 + minute;
  if (mins < 9 * 60 + 30) {
    return { open: false, reason: "Pre-market — option buys open at 9:30 AM ET." };
  }
  if (mins >= 16 * 60) {
    return { open: false, reason: "After-hours — option market is closed. Buys resume at 9:30 AM ET next trading day." };
  }
  return { open: true, reason: "" };
}

export function isUsMarketOpen(d: Date = new Date()): boolean {
  return getUsMarketStatus(d).open;
}
