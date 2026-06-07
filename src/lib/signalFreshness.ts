import type { Signal } from "@/lib/signalHelpers";

export type Freshness = "fresh" | "aging" | "expired";

/** TTL window (ms) inferred from DTE when expires_at is missing. */
function fallbackTtlMs(s: Signal): number {
  const d = s.dte;
  if (d === 0) return 30 * 60 * 1000;
  if (d != null && d >= 1 && d <= 7) return 60 * 60 * 1000;
  if (d != null && d >= 8 && d <= 30) return 4 * 60 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

export function getExpiryMs(s: Signal): number {
  if ((s as any).expires_at) return new Date((s as any).expires_at as string).getTime();
  return new Date(s.created_at).getTime() + fallbackTtlMs(s);
}

export function getFreshness(s: Signal, now = Date.now()): Freshness {
  const expiry = getExpiryMs(s);
  if (now >= expiry) return "expired";
  const total = expiry - new Date(s.created_at).getTime();
  const remaining = expiry - now;
  return remaining / total > 0.5 ? "fresh" : "aging";
}

export function isExpired(s: Signal, now = Date.now()): boolean {
  return now >= getExpiryMs(s);
}

/** Human-readable countdown until expiry, e.g. "1h 30m", "12m", "45s", or "Expired". */
export function getCountdownLabel(s: Signal, now = Date.now()): string {
  const expiry = getExpiryMs(s);
  const remaining = expiry - now;
  if (remaining <= 0) return "Expired";
  const totalSec = Math.floor(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
