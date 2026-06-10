import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type Trade = {
  id: string;
  status: string;
  closed_at: string | null;
  opened_at: string | null;
  current_pl: number | null;
  ticker: string | null;
};

type Range = "1M" | "3M" | "YTD" | "ALL";

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function dayKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fmtMoney(n: number) {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 2)}`;
}

export default function Calendar() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [range, setRange] = useState<Range>("1M");
  const [cursor, setCursor] = useState<Date>(startOfMonth(new Date()));

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("paper_trades")
        .select("id,status,closed_at,opened_at,current_pl,ticker")
        .eq("user_id", user.id)
        .in("status", ["WIN", "LOSS"])
        .order("closed_at", { ascending: false })
        .limit(2000);
      setTrades((data ?? []) as Trade[]);
    })();
  }, [user]);

  // Aggregate P/L by local-day for closed trades
  const byDay = useMemo(() => {
    const m = new Map<string, { pl: number; count: number; tickers: string[] }>();
    if (!trades) return m;
    for (const t of trades) {
      const when = t.closed_at ?? t.opened_at;
      if (!when) continue;
      const key = dayKey(new Date(when));
      const pl = Number(t.current_pl ?? 0);
      const cur = m.get(key) ?? { pl: 0, count: 0, tickers: [] };
      cur.pl += pl;
      cur.count += 1;
      if (t.ticker && cur.tickers.length < 6 && !cur.tickers.includes(t.ticker)) cur.tickers.push(t.ticker);
      m.set(key, cur);
    }
    return m;
  }, [trades]);

  // Window filter for the summary tiles
  const windowStart = useMemo(() => {
    const now = new Date();
    if (range === "1M") return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    if (range === "3M") return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    if (range === "YTD") return new Date(now.getFullYear(), 0, 1);
    return new Date(2000, 0, 1);
  }, [range]);

  const summary = useMemo(() => {
    let total = 0, winDays = 0, lossDays = 0, flatDays = 0;
    for (const [k, v] of byDay) {
      const d = new Date(k + "T00:00:00");
      if (d < windowStart) continue;
      total += v.pl;
      if (v.pl > 0) winDays++;
      else if (v.pl < 0) lossDays++;
      else flatDays++;
    }
    return { total, winDays, lossDays, flatDays };
  }, [byDay, windowStart]);

  // Build month grid
  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const leadingBlanks = monthStart.getDay(); // 0 = Sun
  const totalCells = Math.ceil((leadingBlanks + monthEnd.getDate()) / 7) * 7;
  const cells: Array<Date | null> = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let d = 1; d <= monthEnd.getDate(); d++) cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
  while (cells.length < totalCells) cells.push(null);

  const monthLabel = cursor.toLocaleString(undefined, { month: "long", year: "numeric" });
  const today = dayKey(new Date());

  const monthTotals = useMemo(() => {
    let pl = 0, days = 0;
    for (const c of cells) {
      if (!c) continue;
      const v = byDay.get(dayKey(c));
      if (!v) continue;
      pl += v.pl;
      days += 1;
    }
    return { pl, days };
  }, [cells, byDay]);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl font-semibold font-display tracking-tight">P/L Calendar</h1>
            <p className="text-xs text-muted-foreground">Realized P/L from closed paper trades, grouped by day.</p>
          </div>
        </div>
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList className="h-8">
            <TabsTrigger value="1M" className="text-xs px-3">1M</TabsTrigger>
            <TabsTrigger value="3M" className="text-xs px-3">3M</TabsTrigger>
            <TabsTrigger value="YTD" className="text-xs px-3">YTD</TabsTrigger>
            <TabsTrigger value="ALL" className="text-xs px-3">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label={`${range} P/L`} value={fmtMoney(summary.total)} positive={summary.total >= 0} />
        <SummaryTile label="Win days" value={String(summary.winDays)} tone="bull" />
        <SummaryTile label="Loss days" value={String(summary.lossDays)} tone="bear" />
        <SummaryTile label="Flat days" value={String(summary.flatDays)} tone="muted" />
      </div>

      {/* Month nav */}
      <div className="glass-card p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-sm font-medium font-display flex items-center gap-3">
            <span>{monthLabel}</span>
            <span className={cn("ticker-mono text-xs", monthTotals.pl >= 0 ? "text-bull" : "text-bear")}>
              {fmtMoney(monthTotals.pl)} · {monthTotals.days}d
            </span>
          </div>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => (
            <div key={d} className="px-2 py-1">{d}</div>
          ))}
        </div>

        {trades === null ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {cells.map((c, i) => {
              if (!c) return <div key={i} className="aspect-square rounded-sm bg-muted/10" />;
              const key = dayKey(c);
              const entry = byDay.get(key);
              const isToday = key === today;
              const pos = entry && entry.pl > 0;
              const neg = entry && entry.pl < 0;
              return (
                <div
                  key={i}
                  title={entry ? `${entry.count} trade${entry.count > 1 ? "s" : ""} · ${entry.tickers.join(", ")}` : undefined}
                  className={cn(
                    "aspect-square rounded-sm border p-1.5 flex flex-col justify-between transition-colors",
                    "border-border/60",
                    pos && "bg-bull/15 border-bull/40 hover:bg-bull/25",
                    neg && "bg-bear/15 border-bear/40 hover:bg-bear/25",
                    !entry && "bg-card-elevated/30",
                    isToday && "ring-1 ring-primary",
                  )}
                >
                  <div className="flex items-start justify-between">
                    <span className={cn("text-[11px] ticker-mono", isToday ? "text-primary font-semibold" : "text-foreground/80")}>
                      {c.getDate()}
                    </span>
                    {entry && (
                      <span className="text-[9px] text-muted-foreground">{entry.count}</span>
                    )}
                  </div>
                  {entry && (
                    <div className={cn("ticker-mono text-[10.5px] md:text-xs font-semibold leading-tight", pos ? "text-bull" : neg ? "text-bear" : "text-muted-foreground")}>
                      {fmtMoney(entry.pl)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, positive, tone }: { label: string; value: string; positive?: boolean; tone?: "bull" | "bear" | "muted" }) {
  const color =
    tone === "bull" ? "text-bull" :
    tone === "bear" ? "text-bear" :
    tone === "muted" ? "text-muted-foreground" :
    positive ? "text-bull" : "text-bear";
  return (
    <div className="glass-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold ticker-mono mt-1", color)}>{value}</div>
    </div>
  );
}
