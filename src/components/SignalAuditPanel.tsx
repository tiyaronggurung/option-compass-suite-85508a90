import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import type { Signal } from "@/lib/signalHelpers";

interface Row {
  signal: Signal;
  approvals: number;
  dismissals: number;
}

export function SignalAuditPanel() {
  const { isAdmin, loading } = useIsAdmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;

    const load = async () => {
      const { data: signals } = await supabase
        .from("signals")
        .select("*")
        .eq("is_demo", false)
        .order("created_at", { ascending: false })
        .limit(50);
      const list = (signals ?? []) as Signal[];
      const ids = list.map((s) => s.id);
      if (ids.length === 0) {
        if (!cancelled) { setRows([]); setLastRefresh(new Date()); }
        return;
      }

      const [{ data: approvals }, { data: dismissals }] = await Promise.all([
        supabase.from("paper_trades").select("signal_id").in("signal_id", ids),
        supabase.from("signal_actions").select("signal_id, action").in("signal_id", ids).eq("action", "dismissed"),
      ]);

      const aCount = new Map<string, number>();
      for (const r of approvals ?? []) {
        if (!r.signal_id) continue;
        aCount.set(r.signal_id, (aCount.get(r.signal_id) ?? 0) + 1);
      }
      const dCount = new Map<string, number>();
      for (const r of dismissals ?? []) {
        dCount.set(r.signal_id, (dCount.get(r.signal_id) ?? 0) + 1);
      }

      if (cancelled) return;
      setRows(list.map((s) => ({
        signal: s,
        approvals: aCount.get(s.id) ?? 0,
        dismissals: dCount.get(s.id) ?? 0,
      })));
      setLastRefresh(new Date());
    };

    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isAdmin]);

  if (loading) return <Skeleton className="h-40" />;
  if (!isAdmin) return null;

  return (
    <section className="glass-card p-5 space-y-3">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-primary" />
          Live signal audit
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground ml-1">admin</span>
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Last 50 live (non-demo) signals with approve/reject ratios to help tune the engine. Auto-refreshes every 30s.
          {lastRefresh && <span className="ml-1 opacity-70">· Updated {lastRefresh.toLocaleTimeString()}</span>}
        </p>
      </div>

      {rows === null ? <Skeleton className="h-40" /> :
       rows.length === 0 ? <div className="text-xs text-muted-foreground py-6 text-center">No live signals yet.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1.5 pr-3 font-normal">Time</th>
                <th className="py-1.5 pr-3 font-normal">Ticker</th>
                <th className="py-1.5 pr-3 font-normal">Dir</th>
                <th className="py-1.5 pr-3 font-normal">Conf</th>
                <th className="py-1.5 pr-3 font-normal">Source</th>
                <th className="py-1.5 pr-3 font-normal text-right">Reasons</th>
                <th className="py-1.5 pr-3 font-normal text-right">✓</th>
                <th className="py-1.5 pr-3 font-normal text-right">✕</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ signal: s, approvals, dismissals }) => (
                <tr key={s.id} className="border-t border-border/50">
                  <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                    {new Date(s.created_at).toLocaleTimeString()}
                  </td>
                  <td className="py-1.5 pr-3 ticker-mono">{s.ticker}</td>
                  <td className="py-1.5 pr-3">
                    <Badge variant="outline" className={`border-0 text-[10px] ${s.direction === "CALL" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}>
                      {s.direction}
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-3 ticker-mono">{s.confidence}</td>
                  <td className="py-1.5 pr-3 truncate max-w-[160px]" title={s.source ?? ""}>{s.source ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-right">{Array.isArray(s.reasons) ? s.reasons.length : 0}</td>
                  <td className="py-1.5 pr-3 text-right text-bull">{approvals}</td>
                  <td className="py-1.5 pr-3 text-right text-bear">{dismissals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
       )}
    </section>
  );
}
