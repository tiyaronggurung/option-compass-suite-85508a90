import { useEffect, useMemo, useState } from "react";
import { Activity, DollarSign, Flame, Radio, Tag as TagIcon, TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SignalCard } from "@/components/SignalCard";
import { SignalDetailDialog } from "@/components/SignalDetailDialog";
import { DisclaimerBar } from "@/components/Disclaimer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { fmtPL, type PaperTrade, type Signal } from "@/lib/signalHelpers";
import { ALL_TAGS, deriveTags, type TagId } from "@/lib/signalTags";
import { cn } from "@/lib/utils";

type Filter = "all" | "bullish" | "bearish" | "high" | "low" | "0dte" | "watch";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bullish", label: "Bullish" },
  { id: "bearish", label: "Bearish" },
  { id: "high", label: "High conviction" },
  { id: "low", label: "Low risk" },
  { id: "0dte", label: "0DTE" },
  { id: "watch", label: "Watchlist only" },
];

type SourceMode = "both" | "live" | "demo";
const SOURCE_FILTERS: { id: SourceMode; label: string }[] = [
  { id: "both", label: "All sources" },
  { id: "live", label: "Live market data" },
  { id: "demo", label: "Demo only" },
];

function marketStatus() {
  const now = new Date();
  const day = now.getUTCDay();
  const minutesUTC = now.getUTCHours() * 60 + now.getUTCMinutes();
  // NYSE: 14:30–21:00 UTC (approx, ignoring DST nuance)
  const open = day >= 1 && day <= 5 && minutesUTC >= 14 * 60 + 30 && minutesUTC < 21 * 60;
  return open ? "Open" : "Closed";
}

export default function Dashboard() {
  const { user } = useAuth();
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [watch, setWatch] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [sourceMode, setSourceMode] = useState<SourceMode>("both");
  const [tagFilter, setTagFilter] = useState<TagId | null>(null);
  const [detailSignal, setDetailSignal] = useState<Signal | null>(null);
  const watchSet = useMemo(() => new Set(watch), [watch]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const [{ data: s }, { data: t }, { data: w }, { data: settings }] = await Promise.all([
        supabase.from("signals").select("*").eq("hidden", false).order("created_at", { ascending: false }).limit(100),
        supabase.from("paper_trades").select("*").eq("user_id", user!.id),
        supabase.from("watchlist_items").select("ticker").eq("user_id", user!.id),
        supabase.from("app_settings").select("signal_mode").eq("id", "global").maybeSingle(),
      ]);
      if (cancel) return;
      setSignals(s ?? []);
      setTrades(t ?? []);
      setWatch((w ?? []).map((x: any) => x.ticker));
      if (settings?.signal_mode) setSourceMode(settings.signal_mode as SourceMode);
    })();

    const channel = supabase
      .channel("signals-stream")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "signals" }, (payload) => {
        const ns = payload.new as Signal;
        if (ns.hidden) return;
        setSignals((prev) => (prev ? [ns, ...prev] : [ns]));
        toast.success(`New ${ns.direction} signal on ${ns.ticker}`);
      })
      .subscribe();
    return () => { cancel = true; supabase.removeChannel(channel); };
  }, [user]);

  const filtered = useMemo(() => {
    if (!signals) return [];
    return signals.filter((s) => {
      if (sourceMode === "live" && s.is_demo) return false;
      if (sourceMode === "demo" && !s.is_demo) return false;
      if (filter === "bullish" && s.direction !== "CALL") return false;
      if (filter === "bearish" && s.direction !== "PUT") return false;
      if (filter === "high" && s.confidence < 80) return false;
      if (filter === "low" && s.risk_level !== "LOW") return false;
      if (filter === "0dte" && s.dte !== 0) return false;
      if (filter === "watch" && !watchSet.has(s.ticker)) return false;
      if (tagFilter) {
        const tags = deriveTags(s, watchSet);
        if (!tags.includes(tagFilter)) return false;
      }
      return true;
    });
  }, [signals, filter, sourceMode, tagFilter, watchSet]);

  const totalLive = signals?.filter((s) => s.status === "LIVE").length ?? 0;
  const highConv = signals?.filter((s) => s.confidence >= 80 && s.status === "LIVE").length ?? 0;
  const openTrades = trades.filter((t) => t.status === "OPEN");
  const dailyPL = trades
    .filter((t) => new Date(t.opened_at).toDateString() === new Date().toDateString())
    .reduce((a, t) => a + Number(t.current_pl ?? 0), 0);

  async function approve(s: Signal) {
    const { error } = await supabase.from("paper_trades").insert({
      user_id: user!.id,
      signal_id: s.id,
      ticker: s.ticker,
      direction: s.direction,
      contract_idea: s.contract_symbol,
      entry_price: s.premium ?? s.price,
      stop_idea: s.premium ? Number(s.premium) * 0.6 : null,
      target_idea: s.premium ? Number(s.premium) * 1.8 : null,
      risk_amount: 100,
    });
    if (error) return toast.error(error.message);
    toast.success(`Paper trade opened on ${s.ticker}`);
    const { data } = await supabase.from("paper_trades").select("*").eq("user_id", user!.id);
    setTrades(data ?? []);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Live signals</h1>
            <p className="text-sm text-muted-foreground">Educational paper-trading desk. Approve trades manually.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="pulse-dot" />
            Market <span className="text-foreground font-medium">{marketStatus()}</span>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={Radio} label="Live signals" value={String(totalLive)} accent="text-primary" />
        <Stat icon={Flame} label="High conviction" value={String(highConv)} accent="text-bull" />
        <Stat icon={Activity} label="Open paper trades" value={String(openTrades.length)} accent="text-info" />
        <Stat icon={DollarSign} label="Daily P/L (paper)" value={`$${fmtPL(dailyPL)}`} accent={dailyPL >= 0 ? "text-bull" : "text-bear"} />
      </section>

      <DisclaimerBar />

      <section className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {SOURCE_FILTERS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={sourceMode === f.id ? "secondary" : "outline"}
              className={cn(sourceMode === f.id ? "" : "bg-transparent")}
              onClick={() => setSourceMode(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={filter === f.id ? "default" : "outline"}
              className={cn(filter === f.id ? "" : "bg-transparent")}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {!signals
          ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-lg" />)
          : filtered.length === 0
          ? <EmptyState />
          : filtered.map((s) => <SignalCard key={s.id} signal={s} onApprove={approve} onReject={() => toast("Signal rejected")} />)}
      </section>
    </div>
  );
}

function Stat({ icon: Icon, label, value, accent }: { icon: any; label: string; value: string; accent: string }) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn("h-4 w-4", accent)} /> {label}
      </div>
      <div className={cn("mt-2 text-2xl font-semibold ticker-mono", accent)}>{value}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="col-span-full glass-card p-10 text-center">
      <TrendingUp className="h-8 w-8 mx-auto text-muted-foreground" />
      <div className="mt-3 font-medium">No signals match this filter</div>
      <div className="text-sm text-muted-foreground">Try another filter, or wait for the next alert.</div>
    </div>
  );
}
