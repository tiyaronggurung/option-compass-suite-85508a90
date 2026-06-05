// Collapsible status timeline for a paper trade.
// Pulls lifecycle events from trade_alerts (linked by paper_trade_id) plus
// the paper_trades opened/closed timestamps. Pure read-only presentation.
//
// Does not mutate anything. Safe to drop anywhere a trade row is shown.

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { timeAgo, type PaperTrade } from "@/lib/signalHelpers";

type AlertRow = {
  alert_status: string;
  triggered_at: string | null;
  entered_at: string | null;
  hit_t1_at: string | null;
  hit_t2_at: string | null;
  hit_t3_at: string | null;
  stopped_at: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
  last_contract_mid: number | null;
};

type Event = {
  key: string;
  label: string;
  at: string;
  tone: "neutral" | "good" | "bad" | "warn";
};

function fmtAbs(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function buildEvents(trade: PaperTrade, alert: AlertRow | null): Event[] {
  const ev: Event[] = [];
  const push = (key: string, label: string, at: string | null | undefined, tone: Event["tone"]) => {
    if (at) ev.push({ key, label, at, tone });
  };

  push("opened", "Opened", trade.opened_at, "neutral");
  if (alert) {
    push("triggered", "Triggered", alert.triggered_at, "neutral");
    push("entered", "Entered", alert.entered_at, "neutral");
    push("t1", "Hit Target 1", alert.hit_t1_at, "good");
    push("t2", "Hit Target 2", alert.hit_t2_at, "good");
    push("t3", "Hit Target 3", alert.hit_t3_at, "good");
    push("stopped", "Stop hit", alert.stopped_at, "bad");
    push("cancelled", "Cancelled", alert.cancelled_at, "warn");
    if (alert.alert_status === "expired") {
      // expires_at is the plan window end, not when it fired, but it's the
      // best signal we have for the "Expired" tick.
      push("expired", "Expired", alert.expires_at, "warn");
    }
  }
  push(
    "closed",
    trade.status === "WIN" ? "Closed · Win"
      : trade.status === "LOSS" ? "Closed · Loss"
      : trade.status === "OPEN" ? "" : "Closed",
    (trade as any).closed_at ?? null,
    trade.status === "WIN" ? "good" : trade.status === "LOSS" ? "bad" : "neutral",
  );

  // Sort by timestamp ascending, drop empty labels (open trades w/o close).
  return ev
    .filter((e) => e.label)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

const TONE: Record<Event["tone"], string> = {
  neutral: "bg-muted-foreground/60",
  good: "bg-bull",
  bad: "bg-bear",
  warn: "bg-warn",
};

export function TradeTimelinePanel({ trade }: { trade: PaperTrade }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [alert, setAlert] = useState<AlertRow | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from("trade_alerts")
        .select("alert_status,triggered_at,entered_at,hit_t1_at,hit_t2_at,hit_t3_at,stopped_at,cancelled_at,expires_at,last_contract_mid")
        .eq("paper_trade_id", trade.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setAlert((data ?? null) as AlertRow | null);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open, loaded, trade.id]);

  const events = buildEvents(trade, alert);

  return (
    <div className="border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="uppercase tracking-wider">
          Timeline {loaded && <span className="opacity-60">· {events.length}</span>}
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2">
          {!loaded && <div className="text-[11px] text-muted-foreground">Loading…</div>}
          {loaded && events.length === 0 && (
            <div className="text-[11px] text-muted-foreground">No events yet.</div>
          )}
          {loaded && events.length > 0 && (
            <ol className="relative ml-1.5 border-l border-border/60 pl-3 space-y-2.5">
              {events.map((e) => (
                <li key={e.key} className="relative">
                  <span
                    className={cn(
                      "absolute -left-[15px] top-1 h-2 w-2 rounded-full ring-2 ring-background",
                      TONE[e.tone],
                    )}
                  />
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] font-medium text-foreground">{e.label}</span>
                    <span
                      className="text-[10px] text-muted-foreground ticker-mono"
                      title={fmtAbs(e.at)}
                    >
                      {timeAgo(e.at)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
