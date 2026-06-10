import { useEffect, useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtPrice } from "@/lib/signalHelpers";

type Trade = {
  id: string;
  status: string;
  closed_at: string | null;
  opened_at: string | null;
  current_pl: number | null;
  ticker: string | null;
  direction: string | null;
  option_type: string | null;
  strike: number | null;
  expiry: string | null;
  contracts: number | null;
  entry_premium: number | null;
  exit_premium: number | null;
  entry_price: number | null;
  exit_price: number | null;
};

type View = "month" | "year";

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function dayKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function fmtAmount(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : 2;
  return `${sign}${abs.toFixed(digits)}`;
}
function fmtMoneyFull(n: number) {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 2)}`;
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export default function Calendar() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [view, setView] = useState<View>("month");
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

  // Aggregate P/L by local-day
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    if (!trades) return m;
    for (const t of trades) {
      const when = t.closed_at ?? t.opened_at;
      if (!when) continue;
      const key = dayKey(new Date(when));
      m.set(key, (m.get(key) ?? 0) + Number(t.current_pl ?? 0));
    }
    return m;
  }, [trades]);

  const byMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const [k, v] of byDay) {
      const mk = k.slice(0, 7);
      m.set(mk, (m.get(mk) ?? 0) + v);
    }
    return m;
  }, [byDay]);

  // Year picker options (current year ± 4)
  const nowYear = new Date().getFullYear();
  const yearOptions = useMemo(() => {
    const start = nowYear - 4;
    return Array.from({ length: 9 }, (_, i) => start + i);
  }, [nowYear]);

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-primary" />
        <h1 className="text-lg sm:text-xl font-semibold font-display tracking-tight">P&amp;L Calendar</h1>
      </header>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList className="h-8">
            <TabsTrigger value="month" className="text-xs px-3">Month</TabsTrigger>
            <TabsTrigger value="year" className="text-xs px-3">Year</TabsTrigger>
          </TabsList>
        </Tabs>

        {view === "month" ? (
          <div className="flex items-center gap-1.5">
            <Select
              value={String(cursor.getMonth())}
              onValueChange={(v) => setCursor(new Date(cursor.getFullYear(), Number(v), 1))}
            >
              <SelectTrigger className="h-8 w-[120px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i)} className="text-xs">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(cursor.getFullYear())}
              onValueChange={(v) => setCursor(new Date(Number(v), cursor.getMonth(), 1))}
            >
              <SelectTrigger className="h-8 w-[88px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <Select
            value={String(cursor.getFullYear())}
            onValueChange={(v) => setCursor(new Date(Number(v), 0, 1))}
          >
            <SelectTrigger className="h-8 w-[100px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {trades === null ? (
        <Skeleton className="h-72 w-full" />
      ) : view === "month" ? (
        <MonthGrid cursor={cursor} byDay={byDay} />
      ) : (
        <YearGrid year={cursor.getFullYear()} byMonth={byMonth} onPickMonth={(m) => { setCursor(new Date(cursor.getFullYear(), m, 1)); setView("month"); }} />
      )}
    </div>
  );
}

function MonthGrid({ cursor, byDay }: { cursor: Date; byDay: Map<string, number> }) {
  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const leadingBlanks = monthStart.getDay();
  const totalCells = Math.ceil((leadingBlanks + monthEnd.getDate()) / 7) * 7;
  const today = dayKey(new Date());

  const cells: Array<Date> = [];
  // leading: previous month days
  for (let i = leadingBlanks - 1; i >= 0; i--) {
    cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), -i));
  }
  for (let d = 1; d <= monthEnd.getDate(); d++) {
    cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
  }
  while (cells.length < totalCells) {
    const last = cells[cells.length - 1];
    cells.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }

  // Month total
  let monthTotal = 0, monthDays = 0;
  for (let d = 1; d <= monthEnd.getDate(); d++) {
    const v = byDay.get(dayKey(new Date(cursor.getFullYear(), cursor.getMonth(), d)));
    if (v !== undefined) { monthTotal += v; monthDays++; }
  }

  return (
    <div className="glass-card p-2 sm:p-4">
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="text-xs text-muted-foreground">
          {monthDays} trading day{monthDays === 1 ? "" : "s"}
        </div>
        <div className={cn("ticker-mono text-sm font-semibold", monthTotal > 0 ? "text-bull" : monthTotal < 0 ? "text-bear" : "text-muted-foreground")}>
          {fmtMoneyFull(monthTotal)}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px sm:gap-1 text-[10px] uppercase tracking-wider text-muted-foreground mb-px sm:mb-1">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) => (
          <div key={d} className="px-1 py-1 text-center sm:text-left">
            <span className="sm:hidden">{["S","M","T","W","T","F","S"][i]}</span>
            <span className="hidden sm:inline">{d}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px bg-border/60 rounded-sm overflow-hidden">
        {cells.map((c, i) => {
          const inMonth = c.getMonth() === cursor.getMonth();
          const key = dayKey(c);
          const pl = byDay.get(key);
          const isToday = key === today;
          const pos = pl !== undefined && pl > 0;
          const neg = pl !== undefined && pl < 0;
          return (
            <div
              key={i}
              className={cn(
                "min-h-[54px] sm:min-h-[78px] p-1 sm:p-1.5 flex flex-col gap-0.5 transition-colors",
                "bg-card",
                pos && "bg-bull/15",
                neg && "bg-bear/15",
                !inMonth && "opacity-50",
                isToday && "ring-1 ring-primary ring-inset",
              )}
            >

              <div className={cn(
                "text-[11px] sm:text-xs ticker-mono leading-none",
                isToday ? "text-primary font-semibold" : inMonth ? "text-foreground/85" : "text-muted-foreground",
              )}>
                {c.getDate()}
              </div>
              <div className={cn(
                "ticker-mono leading-tight mt-auto",
                "text-[10px] sm:text-[12px] font-semibold",
                pos ? "text-bull" : neg ? "text-bear" : "text-muted-foreground/60",
              )}>
                {pl === undefined ? "—" : fmtAmount(pl)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function YearGrid({ year, byMonth, onPickMonth }: { year: number; byMonth: Map<string, number>; onPickMonth: (m: number) => void }) {
  let yearTotal = 0;
  const months = MONTHS.map((name, i) => {
    const v = byMonth.get(`${year}-${String(i + 1).padStart(2, "0")}`);
    if (v !== undefined) yearTotal += v;
    return { name, idx: i, pl: v };
  });
  return (
    <div className="glass-card p-3 sm:p-4">
      <div className="flex items-center justify-between px-1 pb-3">
        <div className="text-xs text-muted-foreground">Year {year}</div>
        <div className={cn("ticker-mono text-sm font-semibold", yearTotal > 0 ? "text-bull" : yearTotal < 0 ? "text-bear" : "text-muted-foreground")}>
          {fmtMoneyFull(yearTotal)}
        </div>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 sm:gap-2">
        {months.map((m) => {
          const pos = m.pl !== undefined && m.pl > 0;
          const neg = m.pl !== undefined && m.pl < 0;
          return (
            <button
              key={m.name}
              onClick={() => onPickMonth(m.idx)}
              className={cn(
                "rounded-sm border p-2 sm:p-3 text-left transition-colors",
                "border-border/40 bg-card-elevated/20 hover:bg-card-elevated/40",
                pos && "bg-bull/15 border-bull/40 hover:bg-bull/25",
                neg && "bg-bear/15 border-bear/40 hover:bg-bear/25",
              )}
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.name.slice(0, 3)}</div>
              <div className={cn(
                "ticker-mono text-sm sm:text-base font-semibold mt-1",
                pos ? "text-bull" : neg ? "text-bear" : "text-muted-foreground/60",
              )}>
                {m.pl === undefined ? "—" : fmtAmount(m.pl)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
