import { useEffect, useMemo, useState } from "react";
import { Activity, TrendingUp, TrendingDown, Target } from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar } from "@/components/Disclaimer";
import { fmtPL, type PaperTrade, type Signal } from "@/lib/signalHelpers";
import { deriveTags, ALL_TAGS, type TagId } from "@/lib/signalTags";
import { cn } from "@/lib/utils";

const BULL = "hsl(145 75% 48%)";
const BEAR = "hsl(358 78% 58%)";
const PRIMARY = "hsl(195 100% 55%)";
const MUTED = "hsl(218 12% 60%)";

export default function Performance() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<PaperTrade[] | null>(null);
  const [signals, setSignals] = useState<Record<string, Signal>>({});

  useEffect(() => {
    (async () => {
      const { data: t } = await supabase
        .from("paper_trades").select("*").eq("user_id", user!.id);
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

      const map: Record<string, Signal> = {};
      cleanSignals.forEach((x) => { map[x.id] = x; });
      setSignals(map);
      setTrades(cleanTrades);
    })();
  }, [user]);

  const closed = useMemo(() => (trades ?? []).filter((t) => t.status !== "OPEN"), [trades]);
  const hasReal = closed.length >= 3;
  const metrics = useMemo(
    () => hasReal ? computeReal(trades ?? [], signals) : demoMetrics(trades?.length ?? 0),
    [trades, signals, hasReal],
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Performance</h1>
          <p className="text-sm text-muted-foreground">
            {hasReal
              ? "Real closed paper trades."
              : "Demo data shown until you've closed at least 3 paper trades."}
          </p>
        </div>
        <Badge className={cn("border-0", hasReal ? "bg-emerald-500/15 text-emerald-400" : "bg-warn/15 text-warn")}>
          {hasReal ? "Real paper data" : "Simulated · paper trading only"}
        </Badge>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total paper trades" value={metrics.total} icon={Activity} accent="text-primary" />
        <Stat label="Win rate" value={`${metrics.winRate.toFixed(0)}%`} icon={Target} accent="text-bull" />
        <Stat label="Profit factor" value={isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "∞"} icon={TrendingUp} accent="text-info" />
        <Stat label="Avg return / trade" value={`$${fmtPL(metrics.avgReturn)}`} icon={TrendingDown} accent={metrics.avgReturn >= 0 ? "text-bull" : "text-bear"} />
        <Stat label="Max drawdown" value={`$${fmtPL(metrics.maxDD)}`} icon={TrendingDown} accent="text-bear" />
        <Stat label="High-conviction hit rate" value={`${metrics.highConvHit.toFixed(0)}%`} icon={Target} accent="text-primary" />
        <Stat label="Open positions" value={metrics.open} icon={Activity} accent="text-info" />
        <Stat label="Avg MFE / MAE" value={`${metrics.avgMfe.toFixed(0)} / ${metrics.avgMae.toFixed(0)}`} icon={Activity} accent="text-muted-foreground" />
      </section>

      <DisclaimerBar />

      {!trades ? <Skeleton className="h-72" /> : (
        <>
          <section className="grid lg:grid-cols-2 gap-4">
            <Card title="Equity curve (paper)">
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={metrics.equityCurve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" stroke={MUTED} fontSize={11} />
                  <YAxis stroke={MUTED} fontSize={11} />
                  <Tooltip content={<ChartTip />} />
                  <Area type="monotone" dataKey="equity" stroke={PRIMARY} strokeWidth={2} fill="url(#eq)" />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Daily P/L">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={metrics.dailyPL} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" stroke={MUTED} fontSize={11} />
                  <YAxis stroke={MUTED} fontSize={11} />
                  <Tooltip content={<ChartTip />} />
                  <Bar dataKey="pl" radius={[3, 3, 0, 0]}>
                    {metrics.dailyPL.map((d, i) => (
                      <Cell key={i} fill={d.pl >= 0 ? BULL : BEAR} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </section>

          <section className="grid lg:grid-cols-2 gap-4">
            <BreakdownTable title="By tag" rows={metrics.byTag} />
            <BreakdownTable title="By source" rows={metrics.bySource} />
            <BreakdownTable title="By ticker" rows={metrics.byTicker} />
            <BreakdownTable title="By direction" rows={metrics.byDirection} />
            <BreakdownTable title="By risk level" rows={metrics.byRisk} />
            <BreakdownTable title="By confidence bucket" rows={metrics.byConfidence} />
          </section>
        </>
      )}
    </div>
  );
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("glass-card p-4", className)}>
      <div className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, icon: Icon, accent }: any) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn("h-4 w-4", accent)} /> {label}
      </div>
      <div className={cn("mt-2 text-2xl font-semibold ticker-mono", accent)}>{value}</div>
    </div>
  );
}

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="ticker-mono mt-1" style={{ color: p.color }}>
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  );
}

type BRow = { label: string; n: number; winRate: number; avgPl: number };

function BreakdownTable({ title, rows }: { title: string; rows: BRow[] }) {
  return (
    <div className="glass-card p-0 overflow-hidden">
      <div className="px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
        {title}
      </div>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="text-left px-4 py-1.5 font-medium">Label</th>
            <th className="text-right px-4 py-1.5 font-medium">n</th>
            <th className="text-right px-4 py-1.5 font-medium">Win %</th>
            <th className="text-right px-4 py-1.5 font-medium">Avg P/L</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-4 py-3 text-center text-muted-foreground">No data</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border/60 last:border-0">
              <td className="px-4 py-1.5 truncate max-w-[160px]" title={r.label}>{r.label}</td>
              <td className="px-4 py-1.5 text-right ticker-mono">{r.n}</td>
              <td className={cn("px-4 py-1.5 text-right ticker-mono", r.winRate >= 50 ? "text-bull" : "text-bear")}>
                {r.winRate.toFixed(0)}%
              </td>
              <td className={cn("px-4 py-1.5 text-right ticker-mono", r.avgPl >= 0 ? "text-bull" : "text-bear")}>
                {r.avgPl >= 0 ? "+" : ""}{r.avgPl.toFixed(0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rowFor(label: string, ts: PaperTrade[]): BRow {
  const wins = ts.filter((t) => t.status === "WIN").length;
  const losses = ts.filter((t) => t.status === "LOSS").length;
  const closed = wins + losses;
  const avgPl = ts.length ? ts.reduce((a, t) => a + Number(t.current_pl ?? 0), 0) / ts.length : 0;
  return { label, n: ts.length, winRate: closed ? (wins / closed) * 100 : 0, avgPl };
}

function bucketBy<K extends string | number>(ts: PaperTrade[], key: (t: PaperTrade) => K | undefined): BRow[] {
  const buckets = new Map<string, PaperTrade[]>();
  for (const t of ts) {
    const k = key(t);
    if (k == null) continue;
    const ks = String(k);
    if (!buckets.has(ks)) buckets.set(ks, []);
    buckets.get(ks)!.push(t);
  }
  return Array.from(buckets.entries())
    .map(([label, list]) => rowFor(label, list))
    .sort((a, b) => b.n - a.n);
}

function computeReal(trades: PaperTrade[], signals: Record<string, Signal>) {
  const closed = trades.filter((t) => t.status !== "OPEN");
  const wins = closed.filter((t) => t.status === "WIN");
  const losses = closed.filter((t) => t.status === "LOSS");
  const grossWin = wins.reduce((a, t) => a + Number(t.current_pl), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + Number(t.current_pl), 0));

  const sorted = [...closed].sort(
    (a, b) => new Date(a.closed_at ?? a.opened_at).getTime() - new Date(b.closed_at ?? b.opened_at).getTime(),
  );
  let eq = 0; let peak = 0; let maxDD = 0;
  const equityCurve = sorted.map((t, i) => {
    eq += Number(t.current_pl);
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq - peak);
    return { label: `#${i + 1}`, equity: Number(eq.toFixed(2)) };
  });

  const dailyMap = new Map<string, number>();
  sorted.forEach((t) => {
    const k = new Date(t.closed_at ?? t.opened_at).toISOString().slice(5, 10);
    dailyMap.set(k, (dailyMap.get(k) ?? 0) + Number(t.current_pl));
  });
  const dailyPL = Array.from(dailyMap.entries()).map(([label, pl]) => ({ label, pl: Number(pl.toFixed(2)) }));

  const byTicker = bucketBy(closed, (t) => t.ticker);
  const byDirection = bucketBy(closed, (t) => t.direction);

  const byRisk = bucketBy(closed, (t) => {
    const s = t.signal_id ? signals[t.signal_id] : undefined;
    return s?.risk_level;
  });
  const bySource = bucketBy(closed, (t) => {
    const s = t.signal_id ? signals[t.signal_id] : undefined;
    return s?.source ?? "unknown";
  });
  const byConfidence = bucketBy(closed, (t) => {
    const s = t.signal_id ? signals[t.signal_id] : undefined;
    if (!s) return undefined;
    const c = s.confidence;
    if (c < 60) return "50–59";
    if (c < 70) return "60–69";
    if (c < 80) return "70–79";
    if (c < 90) return "80–89";
    return "90+";
  });

  // By tag — a trade can appear in multiple tag buckets.
  const tagBuckets = new Map<TagId, PaperTrade[]>();
  for (const t of closed) {
    const s = t.signal_id ? signals[t.signal_id] : undefined;
    if (!s) continue;
    for (const tag of deriveTags(s, new Set())) {
      if (!tagBuckets.has(tag)) tagBuckets.set(tag, []);
      tagBuckets.get(tag)!.push(t);
    }
  }
  for (const tag of ALL_TAGS) if (!tagBuckets.has(tag)) tagBuckets.set(tag, []);
  const byTag = Array.from(tagBuckets.entries())
    .map(([label, list]) => rowFor(label, list))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);

  // High-conviction hit rate (confidence >= 80)
  const highConv = closed.filter((t) => {
    const s = t.signal_id ? signals[t.signal_id] : undefined;
    return s && s.confidence >= 80;
  });
  const highConvWins = highConv.filter((t) => t.status === "WIN").length;

  const avgMfe = closed.length ? closed.reduce((a, t) => a + Number(t.mfe ?? 0), 0) / closed.length : 0;
  const avgMae = closed.length ? closed.reduce((a, t) => a + Number(t.mae ?? 0), 0) / closed.length : 0;

  return {
    total: trades.length,
    open: trades.filter((t) => t.status === "OPEN").length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgReturn: closed.length ? closed.reduce((a, t) => a + Number(t.current_pl), 0) / closed.length : 0,
    maxDD,
    highConvHit: highConv.length ? (highConvWins / highConv.length) * 100 : 0,
    avgMfe, avgMae,
    equityCurve, dailyPL,
    byTicker, byDirection, byRisk, bySource, byConfidence, byTag,
  };
}

function demoMetrics(total: number) {
  let eq = 0;
  const equityCurve = Array.from({ length: 20 }, (_, i) => {
    eq += (Math.sin(i / 2) * 80) + (Math.random() * 40 - 10) + 25;
    return { label: `#${i + 1}`, equity: Number(eq.toFixed(2)) };
  });
  const dailyPL = ["06-01","06-02","06-03","06-04","06-05","06-06","06-07","06-08","06-09","06-10"].map((d) => ({
    label: d, pl: Number(((Math.random() - 0.4) * 220).toFixed(2)),
  }));
  return {
    total: total || 47,
    open: 3,
    winRate: 62,
    profitFactor: 1.84,
    avgReturn: 28.4,
    maxDD: -210.5,
    highConvHit: 71,
    avgMfe: 84, avgMae: -42,
    equityCurve, dailyPL,
    byTicker: [
      { label: "NVDA", n: 12, winRate: 67, avgPl: 34 },
      { label: "META", n: 9, winRate: 55, avgPl: 21 },
      { label: "AMD", n: 7, winRate: 57, avgPl: 18 },
    ] as BRow[],
    byDirection: [
      { label: "CALL", n: 28, winRate: 61, avgPl: 32 },
      { label: "PUT", n: 19, winRate: 58, avgPl: 22 },
    ] as BRow[],
    byRisk: [
      { label: "LOW", n: 14, winRate: 71, avgPl: 24 },
      { label: "MEDIUM", n: 22, winRate: 59, avgPl: 28 },
      { label: "HIGH", n: 11, winRate: 45, avgPl: 18 },
    ] as BRow[],
    bySource: [
      { label: "Alpaca Signal Engine v1", n: 18, winRate: 64, avgPl: 31 },
      { label: "Demo seed", n: 29, winRate: 58, avgPl: 24 },
    ] as BRow[],
    byConfidence: [
      { label: "50–59", n: 4, winRate: 25, avgPl: -12 },
      { label: "60–69", n: 9, winRate: 44, avgPl: 8 },
      { label: "70–79", n: 14, winRate: 57, avgPl: 22 },
      { label: "80–89", n: 11, winRate: 73, avgPl: 41 },
      { label: "90+",   n: 5, winRate: 80, avgPl: 58 },
    ] as BRow[],
    byTag: [
      { label: "VWAP Reclaim", n: 12, winRate: 67, avgPl: 34 },
      { label: "Volume Spike", n: 9, winRate: 56, avgPl: 21 },
      { label: "RSI Momentum", n: 8, winRate: 50, avgPl: 12 },
    ] as BRow[],
  };
}
