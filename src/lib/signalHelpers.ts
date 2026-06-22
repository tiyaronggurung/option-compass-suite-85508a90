import type { Database } from "@/integrations/supabase/types";

export type Signal = Database["public"]["Tables"]["signals"]["Row"];
export type PaperTrade = Database["public"]["Tables"]["paper_trades"]["Row"];
export type WatchlistItem = Database["public"]["Tables"]["watchlist_items"]["Row"];

export const fmtPrice = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtPL = (n: number | null | undefined) => {
  if (n == null) return "—";
  const s = (n >= 0 ? "+" : "") + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s;
};

export const timeAgo = (iso: string) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

export const fmtSignalTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
};
