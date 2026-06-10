import { useEffect, useMemo, useState } from "react";
import { Activity, TrendingUp, TrendingDown, Target, X } from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar } from "@/components/Disclaimer";
import { fmtPL, type PaperTrade, type Signal } from "@/lib/signalHelpers";
import { deriveTags, ALL_TAGS, type TagId } from "@/lib/signalTags";
import { cn } from "@/lib/utils";
import { HighlightsRow, TradeHistoryTable, NotTakenSignalHistory } from "@/components/PerformanceInsights";
import { Leaderboard } from "@/components/Leaderboard";


const BULL = "hsl(145 75% 48%)";
const BEAR = "hsl(358 78% 58%)";
const PRIMARY = "hsl(195 100% 55%)";
const MUTED = "hsl(218 12% 60%)";

export default function Performance() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<PaperTrade[] | null>(null);
  const [signals, setSignals] = useState<Record<string, Signal>>({});

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const load = async () => {
      const { data: t } = await supabase
        .from("paper_trades").select("*").eq("user_id", user.id);
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

      if (cancelled) return;
      const map: Record<string, Signal> = {};
      cleanSignals.forEach((x) => { map[x.id] = x; });
      setSignals(map);
      setTrades(cleanTrades);
    };

    void load();

    // Live refresh: subscribe to this user's paper_trades changes (marks, closes, new trades).
    const channel = supabase
      .channel(`perf-trades-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "paper_trades", filter: `user_id=eq.${user.id}` },
        () => { void load(); },
      )
      .subscribe();

    // Safety net: poll every 30s in case realtime drops.
    const poll = setInterval(() => { void load(); }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [user]);

  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [tickerFilter, setTickerFilter] = useState<string>("__all__");

  const availableTickers = useMemo(() => {
    const set = new Set<string>();
    (trades ?? []).forEach((t) => set.add(t.ticker));
    return Array.from(set).sort();
  }, [trades]);

  const filteredTrades = useMemo(() => {
    if (!trades) return null;
    const fromMs = fromDate ? new Date(fromDate + "T00:00:00").getTime() : null;
    const toMs = toDate ? new Date(toDate + "T23:59:59").getTime() : null;
    return trades.filter((t) => {
      if (tickerFilter !== "__all__" && t.ticker !== tickerFilter) return false;
      const ref = new Date(t.closed_at ?? t.opened_at).getTime();
      if (fromMs != null && ref < fromMs) return false;
      if (toMs != null && ref > toMs) return false;
      return true;
    });
  }, [trades, fromDate, toDate, tickerFilter]);

  const metrics = useMemo(
    () => computeReal(filteredTrades ?? [], signals),
    [filteredTrades, signals],
  );
  const hasAny = (filteredTrades?.length ?? 0) > 0;
  const filtersActive = fromDate !== "" || toDate !== "" || tickerFilter !== "__all__";

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Performance</h1>
          <p className="text-sm text-muted-foreground">
            {hasAny ? "Real paper trades." : "No paper trades yet. Approve a signal to get started."}
          </p>
        </div>
        <Badge className="border-0 bg-emerald-500/15 text-emerald-400">Real paper data</Badge>
      </header>

      <section className="glass-card p-3 grid grid-cols-2 sm:flex sm:flex-wrap sm:items-end gap-2 sm:gap-3">
        <div className="space-y-1 min-w-0">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">From</label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 w-full sm:w-[150px]"
          />
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">To</label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 w-full sm:w-[150px]"
          />
        </div>
        <div className="space-y-1 min-w-0 col-span-2 sm:col-auto">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Ticker</label>
          <Select value={tickerFilter} onValueChange={setTickerFilter}>
            <SelectTrigger className="h-9 w-full sm:w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All tickers</SelectItem>
              {availableTickers.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-1 col-span-2 sm:col-auto justify-center"
            onClick={() => { setFromDate(""); setToDate(""); setTickerFilter("__all__"); }}
          >
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
        <div className="col-span-2 sm:ml-auto text-xs text-muted-foreground text-right">
          {filteredTrades?.length ?? 0} of {trades?.length ?? 0} trades
        </div>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total paper trades" value={metrics.total} icon={Activity} accent="text-primary" />
        <Stat label="Win rate" value={`${metrics.winRate.toFixed(0)}%`} icon={Target} accent="text-bull" />
        <Stat label="Profit factor" value={isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "∞"} icon={TrendingUp} accent="text-info" />
        <Stat label="Avg return / trade" value={`$${fmtPL(metrics.avgReturn)}`} icon={TrendingDown} accent={metrics.avgReturn >= 0 ? "text-bull" : "text-bear"} />
        <Stat label="Max drawdown" value={`$${fmtPL(metrics.maxDD)}`} icon={TrendingDown} accent="text-bear" />
        <Stat label="High-conviction hit rate" value={`${metrics.highConvHit.toFixed(0)}%`} icon={Target} accent="text-primary" />
        <Stat label="Open positions" value={metrics.open} icon={Activity} accent="text-info" />
        <Stat label="Avg MFE / MAE" value={`${metrics.avgMfe.toFixed(2)} / ${metrics.avgMae.toFixed(2)}`} icon={Activity} accent="text-muted-foreground" />
      </section>

      <DisclaimerBar />

      <Leaderboard currentUserId={user?.id} />

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

          <HighlightsRow trades={filteredTrades ?? []} signals={signals} />

          <TradeHistoryTable trades={filteredTrades ?? []} signals={signals} />

          <section className="grid lg:grid-cols-2 gap-4">
            <BreakdownTable title="By tag" rows={metrics.byTag} />
            <BreakdownTable title="By source" rows={metrics.bySource} />
            <BreakdownTable title="By ticker" rows={metrics.byTicker} />
            <BreakdownTable title="By direction" rows={metrics.byDirection} />
            <BreakdownTable title="By risk level" rows={metrics.byRisk} />
            <BreakdownTable title="By confidence bucket" rows={metrics.byConfidence} />
          </section>

          {user && (
            <NotTakenSignalHistory
              userId={user.id}
              fromDate={fromDate || null}
              toDate={toDate || null}
              ticker={tickerFilter === "__all__" ? null : tickerFilter}
            />
          )}
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
                {r.avgPl >= 0 ? "+" : ""}{r.avgPl.toFixed(2)}
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
    if (!s) return "unknown";
    if ((s as any).confirmed_by_both) return "Confirmed by both";
    const src = String(s.source ?? "").toLowerCase();
    if (src.includes("unusual") && src.includes("whales")) return "Unusual Whales";
    if (src.includes("alpaca")) return "Alpaca";
    return s.source ?? "unknown";
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

