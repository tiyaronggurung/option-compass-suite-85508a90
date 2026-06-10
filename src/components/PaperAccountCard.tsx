// PaperAccountCard — Webull/Robinhood-style paper balance summary.
// Shows Total Equity, Cash, Open Positions Value, Day P/L, Total P/L, Buying Power.
// Subscribes to realtime changes on paper_accounts + paper_trades for live ticks.
//
// Paper-only. Reads from public.paper_accounts and computes positions value
// from open paper_trades.current_value.

import { useEffect, useState } from "react";
import { DollarSign, TrendingUp, TrendingDown, Wallet, Briefcase, Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";

type PaperAccount = {
  user_id: string;
  starting_balance: number;
  cash_balance: number;
  day_start_equity: number;
  day_start_date: string;
};

type OpenTradeMark = {
  id: string;
  status: string;
  current_value: number | null;
  entry_premium: number | null;
  entry_price: number | null;
  multiplier: number | null;
  contracts: number | null;
  total_cost: number | null;
};

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function PaperAccountCard({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [openTrades, setOpenTrades] = useState<OpenTradeMark[]>([]);
  const [todayRealized, setTodayRealized] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    // Start of NY day in ISO for filtering closed_at
    function startOfNYDayIso() {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date());
      const y = parts.find(p => p.type === "year")!.value;
      const m = parts.find(p => p.type === "month")!.value;
      const d = parts.find(p => p.type === "day")!.value;
      // Treat NY midnight as UTC-4 (DST) — close enough for a daily filter
      return new Date(`${y}-${m}-${d}T00:00:00-04:00`).toISOString();
    }

    async function loadAll() {
      const startIso = startOfNYDayIso();
      const [accRes, tradesRes, closedRes] = await Promise.all([
        (supabase as any).from("paper_accounts").select("*").eq("user_id", user!.id).maybeSingle(),
        supabase.from("paper_trades")
          .select("id,status,current_value,entry_premium,entry_price,multiplier,contracts,total_cost")
          .eq("user_id", user!.id).eq("status", "OPEN"),
        supabase.from("paper_trades")
          .select("current_pl,closed_at,status")
          .eq("user_id", user!.id).neq("status", "OPEN").gte("closed_at", startIso),
      ]);
      if (cancelled) return;
      if (accRes.data) setAccount(accRes.data as PaperAccount);
      else {
        // No row yet — auto-create with defaults
        await (supabase as any).from("paper_accounts").insert({ user_id: user!.id });
        const { data: re } = await (supabase as any).from("paper_accounts").select("*").eq("user_id", user!.id).maybeSingle();
        if (!cancelled && re) setAccount(re as PaperAccount);
      }
      setOpenTrades((tradesRes.data ?? []) as OpenTradeMark[]);
      setTodayRealized(((closedRes.data ?? []) as any[]).reduce((s, t) => s + Number(t.current_pl ?? 0), 0));
      setLoading(false);
    }

    loadAll();

    const accCh = supabase
      .channel(`paper-account-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "paper_accounts", filter: `user_id=eq.${user.id}` },
        (p: any) => { if (p.new) setAccount(p.new as PaperAccount); })
      .subscribe();

    const tradesCh = supabase
      .channel(`paper-trades-balance-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "paper_trades", filter: `user_id=eq.${user.id}` },
        () => { loadAll(); })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(accCh);
      supabase.removeChannel(tradesCh);
    };
  }, [user]);

  if (!user) return null;

  const startingBalance = Number(account?.starting_balance ?? 10000);
  const cash = Number(account?.cash_balance ?? startingBalance);
  const dayStart = Number(account?.day_start_equity ?? startingBalance);

  const openValue = openTrades.reduce((sum, t) => {
    if (t.current_value != null) return sum + Number(t.current_value);
    // fallback to cost basis if no mark yet
    const mult = Number(t.multiplier ?? 100);
    const qty = Number(t.contracts ?? 1);
    const basis = t.total_cost != null
      ? Number(t.total_cost)
      : Number(t.entry_premium ?? t.entry_price ?? 0) * mult * qty;
    return sum + basis;
  }, 0);

  const equity = cash + openValue;
  const totalPL = equity - startingBalance;
  const totalPLPct = startingBalance > 0 ? (totalPL / startingBalance) * 100 : 0;
  const dayPL = equity - dayStart;
  const dayPLPct = dayStart > 0 ? (dayPL / dayStart) * 100 : 0;
  const buyingPower = Math.max(0, cash);

  // Roll over day_start_equity once per NY day so "today" reflects only today's change.
  useEffect(() => {
    if (!user || !account || loading) return;
    const todayNY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (account.day_start_date === todayNY) return;
    (async () => {
      await (supabase as any)
        .from("paper_accounts")
        .update({ day_start_equity: equity, day_start_date: todayNY })
        .eq("user_id", user.id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, account?.day_start_date, loading]);


  return (
    <div className="glass-card border border-border p-4 md:p-5 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Wallet className="h-3 w-3" /> Paper Account
          </div>
          <div className="mt-1 text-2xl md:text-3xl font-semibold ticker-mono">
            {loading ? "—" : fmtMoney(equity)}
          </div>
          <div className={cn("text-xs ticker-mono mt-0.5", dayPL >= 0 ? "text-bull" : "text-bear")}>
            {loading ? "" : <>{dayPL >= 0 ? "+" : ""}{fmtMoney(dayPL)} ({fmtPct(dayPLPct)}) today</>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P/L</div>
          <div className={cn("text-base ticker-mono font-medium", totalPL >= 0 ? "text-bull" : "text-bear")}>
            {loading ? "—" : <>{totalPL >= 0 ? "+" : ""}{fmtMoney(totalPL)}</>}
          </div>
          <div className={cn("text-[11px] ticker-mono", totalPL >= 0 ? "text-bull" : "text-bear")}>
            {loading ? "" : fmtPct(totalPLPct)}
          </div>
        </div>
      </div>

      <div className={cn("grid gap-2", compact ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2 md:grid-cols-4")}>
        <Cell icon={<DollarSign className="h-3 w-3" />} label="Cash" value={fmtMoney(cash)} />
        <Cell icon={<Briefcase className="h-3 w-3" />} label="Open positions" value={fmtMoney(openValue)} />
        <Cell
          icon={dayPL >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          label="Day P/L"
          value={`${dayPL >= 0 ? "+" : ""}${fmtMoney(dayPL)}`}
          accent={dayPL >= 0 ? "text-bull" : "text-bear"}
        />
        <Cell icon={<Activity className="h-3 w-3" />} label="Buying power" value={fmtMoney(buyingPower)} />
      </div>
    </div>
  );
}

function Cell({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card-elevated/30 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        {icon} {label}
      </div>
      <div className={cn("mt-0.5 text-sm ticker-mono font-medium", accent)}>{value}</div>
    </div>
  );
}
