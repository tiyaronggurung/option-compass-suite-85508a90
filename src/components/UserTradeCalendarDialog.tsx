import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Trade = {
  id: string;
  status: string;
  closed_at: string | null;
  opened_at: string | null;
  current_pl: number | null;
  realized_pl: number | null;
  ticker: string | null;
  direction: string | null;
  option_type: string | null;
  strike: number | null;
  expiry: string | null;
  contracts: number | null;
  entry_premium: number | null;
  exit_premium: number | null;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function fmtMoney(n: number) {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 2)}`;
}

export function UserTradeCalendarDialog({
  open, onOpenChange, userId, displayName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId: string | null;
  displayName: string;
}) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [cursor, setCursor] = useState<Date>(startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) return;
    setTrades(null);
    setSelectedDay(null);
    (async () => {
      const { data, error } = await supabase.rpc("get_user_trade_history", { _user_id: userId });
      if (error) {
        console.error("[user-trades] rpc error", error);
        setTrades([]);
        return;
      }
      setTrades((data ?? []) as Trade[]);
    })();
  }, [open, userId]);

  const byDay = useMemo(() => {
    const m = new Map<string, { pl: number; count: number }>();
    if (!trades) return m;
    for (const t of trades) {
      const when = t.closed_at ?? t.opened_at;
      if (!when) continue;
      const k = dayKey(new Date(when));
      const cur = m.get(k) ?? { pl: 0, count: 0 };
      cur.pl += Number(t.realized_pl ?? t.current_pl ?? 0);
      cur.count += 1;
      m.set(k, cur);
    }
    return m;
  }, [trades]);

  const dayTrades = useMemo(() => {
    if (!selectedDay || !trades) return [];
    return trades.filter((t) => {
      const when = t.closed_at ?? t.opened_at;
      return when ? dayKey(new Date(when)) === selectedDay : false;
    });
  }, [selectedDay, trades]);

  const totals = useMemo(() => {
    if (!trades) return { pl: 0, wins: 0, losses: 0 };
    let pl = 0, wins = 0, losses = 0;
    for (const t of trades) {
      const v = Number(t.realized_pl ?? t.current_pl ?? 0);
      pl += v;
      if (t.status === "WIN") wins++;
      else if (t.status === "LOSS") losses++;
    }
    return { pl, wins, losses };
  }, [trades]);

  // Build month grid
  const first = startOfMonth(cursor);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" />
            {displayName}'s trade history
          </DialogTitle>
        </DialogHeader>

        {trades === null ? (
          <Skeleton className="h-80" />
        ) : trades.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">No closed trades yet.</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Stat label="Total P/L" value={fmtMoney(totals.pl)} accent={totals.pl >= 0 ? "text-bull" : "text-bear"} />
              <Stat label="Wins" value={String(totals.wins)} accent="text-bull" />
              <Stat label="Losses" value={String(totals.losses)} accent="text-bear" />
            </div>

            <div className="flex items-center justify-between mt-3">
              <Button variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="text-sm font-semibold">
                {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-7 gap-1 mt-2">
              {WEEKDAYS.map((w) => (
                <div key={w} className="text-[10px] text-center text-muted-foreground uppercase py-1">{w}</div>
              ))}
              {cells.map((d, i) => {
                if (!d) return <div key={i} />;
                const k = dayKey(d);
                const info = byDay.get(k);
                const hasData = !!info;
                const positive = info && info.pl >= 0;
                return (
                  <button
                    key={i}
                    onClick={() => hasData && setSelectedDay(k)}
                    disabled={!hasData}
                    className={cn(
                      "aspect-square rounded border border-border/60 p-1 text-left flex flex-col justify-between transition-colors",
                      hasData
                        ? positive
                          ? "bg-bull/10 border-bull/30 hover:bg-bull/20 cursor-pointer"
                          : "bg-bear/10 border-bear/30 hover:bg-bear/20 cursor-pointer"
                        : "opacity-40",
                      selectedDay === k && "ring-2 ring-primary",
                    )}
                  >
                    <div className="text-[10px] text-muted-foreground">{d.getDate()}</div>
                    {info && (
                      <div className={cn("text-[10px] font-semibold ticker-mono leading-tight", positive ? "text-bull" : "text-bear")}>
                        {fmtMoney(info.pl)}
                        <div className="text-[9px] text-muted-foreground font-normal">{info.count} {info.count === 1 ? "trade" : "trades"}</div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {selectedDay && dayTrades.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="text-xs font-semibold mb-2">Trades on {selectedDay}</div>
                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {dayTrades.map((t) => {
                    const pl = Number(t.realized_pl ?? t.current_pl ?? 0);
                    return (
                      <div key={t.id} className="flex items-center justify-between gap-2 text-xs rounded border border-border/60 px-2 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn(
                            "text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded",
                            t.direction === "CALL" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear",
                          )}>
                            {t.direction}
                          </span>
                          <span className="font-medium">{t.ticker}</span>
                          <span className="text-muted-foreground ticker-mono truncate">
                            {t.strike ? `$${t.strike}` : ""} {t.expiry ?? ""} ×{t.contracts ?? 1}
                          </span>
                        </div>
                        <span className={cn("ticker-mono font-semibold shrink-0", pl >= 0 ? "text-bull" : "text-bear")}>
                          {fmtMoney(pl)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded border border-border px-3 py-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold ticker-mono", accent)}>{value}</div>
    </div>
  );
}
