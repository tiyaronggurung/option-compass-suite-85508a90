import { useEffect, useMemo, useState } from "react";
import { Brain } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import type { PaperTrade, Signal } from "@/lib/signalHelpers";
import { deriveTags, ALL_TAGS, type TagId } from "@/lib/signalTags";
import { cn } from "@/lib/utils";

type Row = { label: string; trades: number; wins: number; losses: number; winRate: number; avgPl: number };

export default function SignalLearningPanel() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [trades, setTrades] = useState<PaperTrade[] | null>(null);
  const [signals, setSignals] = useState<Record<string, Signal>>({});

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      const { data: t } = await supabase
        .from("paper_trades").select("*").neq("status", "OPEN")
        .order("opened_at", { ascending: false }).limit(500);
      const ids = (t ?? []).map((x) => x.signal_id).filter(Boolean) as string[];
      const { data: s } = ids.length
        ? await supabase.from("signals").select("*").in("id", ids)
        : { data: [] as Signal[] };

      // Exclude demo / test signals from analytics to prevent data contamination.
      const excludedIds = new Set<string>();
      for (const sig of (s ?? []) as Signal[]) {
        if (sig.is_demo || (sig.source && String(sig.source).includes("TEST_ONLY_OPTION_PL_VALIDATION"))) {
          excludedIds.add(sig.id);
        }
      }
      const cleanSignals = ((s ?? []) as Signal[]).filter((sig) => !excludedIds.has(sig.id));
      const cleanTrades = (t ?? []).filter((trade) => !trade.signal_id || !excludedIds.has(trade.signal_id));

      const m: Record<string, Signal> = {};
      cleanSignals.forEach((x) => { m[x.id] = x; });
      setSignals(m);
      setTrades(cleanTrades);
    })();
  }, [isAdmin]);

  const rows = useMemo(() => {
    if (!trades) return { byTag: [], bySource: [], byRisk: [] };
    return {
      byTag: groupByTag(trades, signals),
      bySource: group(trades, signals, (s) => s?.source ?? "unknown"),
      byRisk: group(trades, signals, (s) => s?.risk_level ?? "MEDIUM"),
    };
  }, [trades, signals]);

  if (adminLoading) return <Skeleton className="h-32" />;
  if (!isAdmin) return null;

  return (
    <div className="glass-card p-5 space-y-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          <div>
            <h2 className="font-semibold">Signal learning</h2>
            <p className="text-xs text-muted-foreground">Win rate and avg P/L of closed paper trades — by feature.</p>
          </div>
        </div>
        <Badge variant="outline" className="border-border text-muted-foreground">Admin</Badge>
      </header>

      {!trades ? (
        <Skeleton className="h-24" />
      ) : trades.length === 0 ? (
        <div className="text-sm text-muted-foreground">No closed paper trades yet.</div>
      ) : (
        <div className="grid md:grid-cols-3 gap-4">
          <LearningTable title="By tag" rows={rows.byTag} />
          <LearningTable title="By source" rows={rows.bySource} />
          <LearningTable title="By risk level" rows={rows.byRisk} />
        </div>
      )}
    </div>
  );
}

function LearningTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground bg-card-elevated/40">
        {title}
      </div>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="text-left px-3 py-1.5 font-medium">Label</th>
            <th className="text-right px-3 py-1.5 font-medium">n</th>
            <th className="text-right px-3 py-1.5 font-medium">Win %</th>
            <th className="text-right px-3 py-1.5 font-medium">Avg P/L</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-3 text-center text-muted-foreground">No data</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border/60 last:border-0">
              <td className="px-3 py-1.5 truncate max-w-[140px]" title={r.label}>{r.label}</td>
              <td className="px-3 py-1.5 text-right ticker-mono">{r.trades}</td>
              <td className={cn("px-3 py-1.5 text-right ticker-mono", r.winRate >= 50 ? "text-bull" : "text-bear")}>
                {r.winRate.toFixed(0)}%
              </td>
              <td className={cn("px-3 py-1.5 text-right ticker-mono", r.avgPl >= 0 ? "text-bull" : "text-bear")}>
                {r.avgPl >= 0 ? "+" : ""}{r.avgPl.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function group(trades: PaperTrade[], signals: Record<string, Signal>, key: (s: Signal | undefined) => string): Row[] {
  const buckets = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const s = t.signal_id ? signals[t.signal_id] : undefined;
    const k = key(s);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(t);
  }
  return Array.from(buckets.entries())
    .map(([label, ts]) => rowFor(label, ts))
    .sort((a, b) => b.trades - a.trades);
}

function groupByTag(trades: PaperTrade[], signals: Record<string, Signal>): Row[] {
  const buckets = new Map<TagId, PaperTrade[]>();
  for (const t of trades) {
    const s = t.signal_id ? signals[t.signal_id] : undefined;
    if (!s) continue;
    const tags = deriveTags(s, new Set());
    for (const tag of tags) {
      if (!buckets.has(tag)) buckets.set(tag, []);
      buckets.get(tag)!.push(t);
    }
  }
  // Ensure all tags appear (even empty)
  for (const tag of ALL_TAGS) if (!buckets.has(tag)) buckets.set(tag, []);
  return Array.from(buckets.entries())
    .map(([label, ts]) => rowFor(label, ts))
    .filter((r) => r.trades > 0)
    .sort((a, b) => b.trades - a.trades);
}

function rowFor(label: string, ts: PaperTrade[]): Row {
  const wins = ts.filter((t) => t.status === "WIN").length;
  const losses = ts.filter((t) => t.status === "LOSS").length;
  const closed = wins + losses;
  const avgPl = ts.length ? ts.reduce((a, t) => a + Number(t.current_pl ?? 0), 0) / ts.length : 0;
  return {
    label,
    trades: ts.length,
    wins,
    losses,
    winRate: closed ? (wins / closed) * 100 : 0,
    avgPl,
  };
}
