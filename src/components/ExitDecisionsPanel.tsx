import { useEffect, useState } from "react";
import { ScrollText, RefreshCw, AlertTriangle, Clock, ShieldAlert, Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";

type Row = {
  id: string;
  decided_at: string;
  action: string;            // exit_now | dry_run | hold | macro_stale
  hard_trigger: string | null;
  reason_string: string;
  executed: boolean;
  macro_score: number | null;
  trade_id: string | null;
  context: any;
};

type TradeMini = { id: string; ticker: string; option_type: string | null; strike: number | null };

export default function ExitDecisionsPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [trades, setTrades] = useState<Record<string, TradeMini>>({});
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    const { data } = await (supabase as any)
      .from("trade_exit_decisions")
      .select("id, decided_at, action, hard_trigger, reason_string, executed, macro_score, trade_id, context")
      .order("decided_at", { ascending: false })
      .limit(20);
    const list = (data ?? []) as Row[];
    setRows(list);

    // Bulk-fetch trade tickers for the trade-linked rows
    const tradeIds = Array.from(new Set(list.map(r => r.trade_id).filter(Boolean))) as string[];
    if (tradeIds.length > 0) {
      const { data: tr } = await (supabase as any)
        .from("paper_trades")
        .select("id, ticker, option_type, strike")
        .in("id", tradeIds);
      const map: Record<string, TradeMini> = {};
      for (const t of (tr ?? []) as TradeMini[]) map[t.id] = t;
      setTrades(map);
    }
    setRefreshing(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <section className="glass-card p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-primary" /> Exit decisions
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Last 20 auto-exit evaluations including holds and macro-stale cycles. The engine
            writes here every time it looks at a trade.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {rows === null ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          No decisions logged yet. Enable auto-exit and wait for the engine to evaluate trades.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map(r => <DecisionRow key={r.id} row={r} trade={r.trade_id ? trades[r.trade_id] : undefined} />)}
        </ul>
      )}
    </section>
  );
}

function DecisionRow({ row, trade }: { row: Row; trade?: TradeMini }) {
  const v = visuals(row);
  const when = (() => {
    try { return formatDistanceToNow(new Date(row.decided_at), { addSuffix: true }); }
    catch { return row.decided_at; }
  })();

  return (
    <li className={`rounded-md border ${v.border} ${v.bg} px-3 py-2.5`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <v.Icon className={`h-4 w-4 mt-0.5 shrink-0 ${v.icon}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-semibold uppercase tracking-wide ${v.label}`}>{v.title}</span>
              {trade && (
                <span className="text-xs ticker-mono text-muted-foreground">
                  {trade.ticker} {trade.strike}{trade.option_type === "CALL" ? "C" : trade.option_type === "PUT" ? "P" : ""}
                </span>
              )}
              {row.executed && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-bear bg-bear/10 px-1.5 py-0.5 rounded">
                  Closed
                </span>
              )}
            </div>
            <p className="text-xs text-foreground/80 mt-0.5 leading-snug">{row.reason_string}</p>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground whitespace-nowrap mt-0.5">{when}</span>
      </div>
    </li>
  );
}

function visuals(r: Row) {
  // System: macro_stale — amber, visually distinct from hold
  if (r.action === "macro_stale") {
    return {
      Icon: AlertTriangle,
      title: "Macro stale",
      icon: "text-amber-500",
      label: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-500/5",
      border: "border-amber-500/30",
    };
  }
  // Hard-trigger exits — bear (red)
  if (r.hard_trigger) {
    const title =
      r.hard_trigger === "macro_override" ? "Macro override" :
      r.hard_trigger === "earnings_risk" ? "Earnings risk" :
      r.hard_trigger === "spread_emergency" ? "Spread emergency" :
      r.hard_trigger;
    return {
      Icon: ShieldAlert,
      title,
      icon: "text-bear",
      label: "text-bear",
      bg: "bg-bear/5",
      border: "border-bear/40",
    };
  }
  // Manual-rule exits (stop / take / trailing / time / theta)
  if (r.action === "exit_now") {
    return {
      Icon: Activity,
      title: "Exit fired",
      icon: "text-bear",
      label: "text-bear",
      bg: "bg-bear/5",
      border: "border-bear/30",
    };
  }
  // Dry-run — warn (yellow-ish but distinct from stale)
  if (r.action === "dry_run") {
    return {
      Icon: Activity,
      title: "Dry-run",
      icon: "text-warn",
      label: "text-warn",
      bg: "bg-warn/5",
      border: "border-warn/30",
    };
  }
  // Default: hold — muted gray
  return {
    Icon: Clock,
    title: "Hold",
    icon: "text-muted-foreground",
    label: "text-muted-foreground",
    bg: "bg-muted/20",
    border: "border-border",
  };
}
