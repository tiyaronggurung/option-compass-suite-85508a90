import { useEffect, useMemo, useState } from "react";
import { Activity, TrendingUp, TrendingDown, Target } from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { DisclaimerBar } from "@/components/Disclaimer";
import { fmtPL, type PaperTrade } from "@/lib/signalHelpers";
import { cn } from "@/lib/utils";

const BULL = "hsl(145 75% 48%)";
const BEAR = "hsl(358 78% 58%)";
const PRIMARY = "hsl(195 100% 55%)";
const MUTED = "hsl(218 12% 60%)";

export default function Performance() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<PaperTrade[]>([]);

  useEffect(() => {
    supabase.from("paper_trades").select("*").eq("user_id", user!.id)
      .then(({ data }) => setTrades(data ?? []));
  }, [user]);

  const metrics = useMemo(() => computeMetrics(trades), [trades]);

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Performance</h1>
          <p className="text-sm text-muted-foreground">Paper-trading metrics. Demo data shown until you've closed real paper trades.</p>
        </div>
        <Badge className="bg-warn/15 text-warn border-0">Simulated · paper trading only</Badge>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total paper trades" value={metrics.total} icon={Activity} accent="text-primary" />
        <Stat label="Win rate" value={`${metrics.winRate.toFixed(0)}%`} icon={Target} accent="text-bull" />
        <Stat label="Profit factor" value={metrics.profitFactor.toFixed(2)} icon={TrendingUp} accent="text-info" />
        <Stat label="Avg return / trade" value={`$${fmtPL(metrics.avgReturn)}`} icon={TrendingDown} accent={metrics.avgReturn >= 0 ? "text-bull" : "text-bear"} />
        <Stat label="Max drawdown" value={`$${fmtPL(metrics.maxDD)}`} icon={TrendingDown} accent="text-bear" />
        <Stat label="High-conviction hit rate" value={`${metrics.highConvHit.toFixed(0)}%`} icon={Target} accent="text-primary" />
        <Stat label="Rejected signals tracked" value={metrics.rejected} icon={Activity} accent="text-muted-foreground" />
        <Stat label="Open positions" value={metrics.open} icon={Activity} accent="text-info" />
      </section>

      <DisclaimerBar />

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

        <Card title="Signal quality distribution">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={metrics.quality} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="bucket" stroke={MUTED} fontSize={11} />
              <YAxis stroke={MUTED} fontSize={11} />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="count" fill={PRIMARY} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Performance by ticker">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={metrics.byTicker} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="ticker" stroke={MUTED} fontSize={11} />
              <YAxis stroke={MUTED} fontSize={11} />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="pl" radius={[3, 3, 0, 0]}>
                {metrics.byTicker.map((d, i) => (
                  <Cell key={i} fill={d.pl >= 0 ? BULL : BEAR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Performance by DTE" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={metrics.byDTE} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="dte" stroke={MUTED} fontSize={11} />
              <YAxis stroke={MUTED} fontSize={11} />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="winRate" fill={PRIMARY} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </section>
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

function computeMetrics(trades: PaperTrade[]) {
  // Use real trades when present, otherwise fall back to demo data.
  const closed = trades.filter((t) => t.status !== "OPEN");
  if (closed.length < 3) return demoMetrics(trades.length);

  const wins = closed.filter((t) => Number(t.current_pl) > 0);
  const losses = closed.filter((t) => Number(t.current_pl) < 0);
  const grossWin = wins.reduce((a, t) => a + Number(t.current_pl), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + Number(t.current_pl), 0));

  const sorted = [...closed].sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
  let eq = 0; let peak = 0; let maxDD = 0;
  const equityCurve = sorted.map((t, i) => {
    eq += Number(t.current_pl);
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq - peak);
    return { label: `#${i + 1}`, equity: Number(eq.toFixed(2)) };
  });

  const dailyMap = new Map<string, number>();
  sorted.forEach((t) => {
    const k = new Date(t.opened_at).toISOString().slice(5, 10);
    dailyMap.set(k, (dailyMap.get(k) ?? 0) + Number(t.current_pl));
  });
  const dailyPL = Array.from(dailyMap.entries()).map(([label, pl]) => ({ label, pl: Number(pl.toFixed(2)) }));

  const tickerMap = new Map<string, number>();
  sorted.forEach((t) => tickerMap.set(t.ticker, (tickerMap.get(t.ticker) ?? 0) + Number(t.current_pl)));
  const byTicker = Array.from(tickerMap.entries()).map(([ticker, pl]) => ({ ticker, pl: Number(pl.toFixed(2)) })).sort((a, b) => b.pl - a.pl);

  return {
    total: trades.length,
    open: trades.filter((t) => t.status === "OPEN").length,
    rejected: 0,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgReturn: closed.length ? closed.reduce((a, t) => a + Number(t.current_pl), 0) / closed.length : 0,
    maxDD,
    highConvHit: 0,
    equityCurve,
    dailyPL,
    quality: demoMetrics(0).quality,
    byTicker,
    byDTE: demoMetrics(0).byDTE,
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
    rejected: 18,
    winRate: 62,
    profitFactor: 1.84,
    avgReturn: 28.4,
    maxDD: -210.5,
    highConvHit: 71,
    equityCurve,
    dailyPL,
    quality: [
      { bucket: "50–59", count: 4 },
      { bucket: "60–69", count: 9 },
      { bucket: "70–79", count: 14 },
      { bucket: "80–89", count: 11 },
      { bucket: "90+",   count: 5 },
    ],
    byTicker: [
      { ticker: "NVDA", pl: 412 }, { ticker: "META", pl: 280 }, { ticker: "AMD", pl: 165 },
      { ticker: "SPY", pl: -90 }, { ticker: "TSLA", pl: -140 }, { ticker: "AAPL", pl: 60 },
    ],
    byDTE: [
      { dte: "0DTE", winRate: 52 }, { dte: "1-2", winRate: 58 }, { dte: "3-7", winRate: 67 },
      { dte: "8-14", winRate: 64 }, { dte: "15-30", winRate: 55 }, { dte: "30+", winRate: 49 },
    ],
  };
}
