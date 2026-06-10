import { useEffect, useMemo, useState } from "react";
import { Activity, DollarSign, Flame, Radio, Tag as TagIcon, TrendingDown, TrendingUp, Trophy } from "lucide-react";
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
import { signalOutcome } from "@/lib/signalOutcome";
import { cn } from "@/lib/utils";
import { isExpired } from "@/lib/signalFreshness";
import { getLifecycleState, LIFECYCLE_META, LIFECYCLE_ORDER, type LifecycleState } from "@/lib/signalLifecycle";
import { effectiveRisk, sumTodayRealizedPL, type RiskSettingsLike } from "@/lib/riskGuard";
import { effectiveConfidence } from "@/lib/techAdjust";
import { approveSignalAsPaperTrade } from "@/lib/approveSignal";
import { RiskStatusCard } from "@/components/RiskStatusCard";
import MarketOverviewStrip from "@/components/MarketOverviewStrip";
import { PaperAccountCard } from "@/components/PaperAccountCard";
import ProviderStatusBanner from "@/components/ProviderStatusBanner";
import { TradeAlertCard, type TradeAlert } from "@/components/TradeAlertCard";
import { BuyOptionDialog } from "@/components/BuyOptionDialog";
import { SOURCE_FILTER_OPTIONS, matchesSourceFilter, sortSignalsBySourcePriority, sourcePriority, type SourceFilter } from "@/lib/signalSource";
import { TopSignalRow } from "@/components/TopSignalRow";
import { NotificationsBell } from "@/components/NotificationsBell";
import { rankSignals, rankSignal, type RankBreakdown, getContractMeta } from "@/lib/rankSignals";
import { Link } from "react-router-dom";

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

type SourceMode = "both" | "live";
const SOURCE_FILTERS: { id: SourceMode; label: string }[] = [
  { id: "both", label: "All sources" },
  { id: "live", label: "Live market data" },
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
  const [developing, setDeveloping] = useState<Signal[] | null>(null);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [watch, setWatch] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [sourceMode, setSourceMode] = useState<SourceMode>("both");
  const [tagFilter, setTagFilter] = useState<TagId | null>(null);
  const [detailSignal, setDetailSignal] = useState<Signal | null>(null);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleState | "all">("fresh");
  const [providerFilter, setProviderFilter] = useState<SourceFilter>("all");
  const [alpacaStatus, setAlpacaStatus] = useState<string | null>(null);
  const [risk, setRisk] = useState<RiskSettingsLike>(null);
  const [showDeveloping, setShowDeveloping] = useState(true);
  const [alerts, setAlerts] = useState<TradeAlert[]>([]);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buySignal, setBuySignal] = useState<Signal | null>(null);
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [minDevelopingScore, setMinDevelopingScore] = useState(60);
  const watchSet = useMemo(() => new Set(watch), [watch]);

  const reloadAlerts = async () => {
    if (!user) return;
    const { data } = await (supabase as any)
      .from("trade_alerts")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    setAlerts((data ?? []) as TradeAlert[]);
  };

  useEffect(() => {
    let cancel = false;
    (async () => {
      const [{ data: s }, { data: dev }, { data: t }, { data: w }, { data: settings }, { data: actions }, { data: pc }, { data: rs }, { data: pa }] = await Promise.all([
        supabase.from("signals").select("*").eq("hidden", false).order("created_at", { ascending: false }).limit(100),
        supabase.from("signals").select("*").eq("hidden", true).eq("tier", "rejected").gte("confidence", 60).order("created_at", { ascending: false }).limit(30),
        supabase.from("paper_trades").select("*").eq("user_id", user!.id),
        supabase.from("watchlist_items").select("ticker").eq("user_id", user!.id),
        supabase.from("app_settings").select("signal_mode").eq("id", "global").maybeSingle(),
        supabase.from("signal_actions").select("signal_id").eq("user_id", user!.id).in("action", ["dismissed", "approved"]),
        supabase.from("provider_configs").select("last_status").eq("provider", "alpaca").maybeSingle(),
        supabase.from("risk_settings").select("*").eq("user_id", user!.id).maybeSingle(),
        supabase.from("paper_accounts").select("cash_balance").eq("user_id", user!.id).maybeSingle(),
      ]);
      if (cancel) return;
      setSignals(s ?? []);
      // Merge visible signals with confidence 60-69 into developing list.
      const visibleDeveloping = (s ?? []).filter((x: any) => !x.is_demo && (x.confidence ?? 0) >= 60 && (x.confidence ?? 0) < 70);
      setDeveloping([...(dev ?? []), ...visibleDeveloping]);
      setTrades(t ?? []);
      setWatch((w ?? []).map((x: any) => x.ticker));
      setDismissedIds(new Set((actions ?? []).map((a: any) => a.signal_id)));
      if (settings?.signal_mode && ["both", "live"].includes(settings.signal_mode)) setSourceMode(settings.signal_mode as SourceMode);
      setAlpacaStatus(pc?.last_status ?? null);
      setRisk(rs as RiskSettingsLike);
      setCashBalance(Number((pa as any)?.cash_balance ?? 0));
      reloadAlerts();
    })();

    const channel = supabase
      .channel("signals-stream")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "signals" }, (payload) => {
        const ns = payload.new as Signal;
        const conf = ns.confidence ?? 0;
        if (ns.hidden) {
          if (ns.tier === "rejected" && conf >= 60) {
            setDeveloping((prev) => (prev ? [ns, ...prev] : [ns]));
          }
          return;
        }
        // Visible signals: 70+ go to top grid, 60-69 surface in developing, <60 dropped.
        if (conf < 60) return;
        if (conf < 70) {
          setDeveloping((prev) => (prev ? [ns, ...prev] : [ns]));
          return;
        }
        setSignals((prev) => (prev ? [ns, ...prev] : [ns]));
        toast.success(`New ${ns.direction} signal on ${ns.ticker}`);
      })
      .subscribe();

    const alertsChannel = supabase
      .channel(`trade-alerts-${user!.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trade_alerts", filter: `user_id=eq.${user!.id}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldId = (payload.old as any)?.id;
            if (oldId) setAlerts((prev) => prev.filter((a) => a.id !== oldId));
            return;
          }
          const row = payload.new as TradeAlert;
          setAlerts((prev) => {
            const idx = prev.findIndex((a) => a.id === row.id);
            if (idx === -1) return [row, ...prev].slice(0, 50);
            const prevStatus = prev[idx].alert_status;
            const next = [...prev];
            next[idx] = row;
            if (prevStatus !== row.alert_status) {
              toast.info(`${row.ticker} ${row.option_side?.toUpperCase()} → ${row.alert_status}`);
            }
            return next;
          });
        }
      )
      .subscribe();

    return () => { cancel = true; supabase.removeChannel(channel); supabase.removeChannel(alertsChannel); };
  }, [user]);


  const filtered = useMemo(() => {
    if (!signals) return [];
    const base = signals.filter((s) => {
      if (dismissedIds.has(s.id)) return false;
      if (!s.is_demo && (s.confidence ?? 0) < 70) return false;
      const lc = getLifecycleState(s);
      // Default view hides expired/invalidated unless filter selected explicitly.
      if (lifecycleFilter === "all") {
        if (lc === "expired" || lc === "invalidated") return false;
        if (!includeExpired && isExpired(s)) return false;
      } else if (lc !== lifecycleFilter) {
        return false;
      }
      if (sourceMode === "live" && s.is_demo) return false;
      if (!matchesSourceFilter(s as any, providerFilter)) return false;
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
    const isZeroBid = (s: Signal) => {
      const bid = getContractMeta(s)?.bid;
      if (bid === 0) return true;
      const reasons = Array.isArray(s.reasons) ? (s.reasons as string[]) : [];
      return reasons.some((r) => /\$0\s*bid|ask\s*vs\s*\$0/i.test(String(r)));
    };
    const ordered = base.sort((a, b) => {
      const ra = rankSignal(a).total;
      const rb = rankSignal(b).total;
      return rb - ra;
    });
    return [...ordered].sort((a, b) => Number(isZeroBid(a)) - Number(isZeroBid(b)));
  }, [signals, filter, sourceMode, providerFilter, tagFilter, watchSet, includeExpired, dismissedIds, lifecycleFilter]);

  const totalLive = signals?.filter((s) => s.status === "LIVE").length ?? 0;
  const openTrades = trades.filter((t) => t.status === "OPEN");
  const closedTradeIds = useMemo(() => new Set(trades.filter((t) => t.status !== "OPEN").map((t) => t.id)), [trades]);
  const closedSignalIds = useMemo(() => new Set(trades.filter((t) => t.status !== "OPEN" && (t as any).signal_id).map((t) => (t as any).signal_id as string)), [trades]);
  const activeAlerts = useMemo(() => alerts.filter((a) => !["cancelled"].includes(a.alert_status) && !closedTradeIds.has(a.paper_trade_id ?? "") && !closedSignalIds.has(a.signal_id ?? "")), [alerts, closedTradeIds, closedSignalIds]);
  const todayRealizedPL = useMemo(() => sumTodayRealizedPL(trades as any), [trades]);
  const unrealizedPL = useMemo(
    () => openTrades.reduce((a, t) => a + Number((t as any).unrealized_pl ?? t.current_pl ?? 0), 0),
    [openTrades],
  );
  const tradesOpenedToday = useMemo(
    () => trades.filter((t) => new Date(t.opened_at).toDateString() === new Date().toDateString()).length,
    [trades],
  );
  const dailyPL = todayRealizedPL + unrealizedPL;
  const effective = useMemo(() => effectiveRisk(risk), [risk]);

  const developingGroups = useMemo(() => {
    if (!developing) return [] as { key: string; label: string; items: Signal[] }[];
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60_000;
    const base = developing.filter((s) => {
      const eff = effectiveConfidence(s as any) ?? (s.confidence ?? 0);
      if (eff < Math.max(60, minDevelopingScore)) return false;
      if (eff > 69) return false;
      const t = new Date(s.created_at).getTime();
      if (t < cutoff) return false;
      return true;
    });
    const isZeroBid = (s: Signal) => {
      const bid = getContractMeta(s)?.bid;
      if (bid === 0) return true;
      const reasons = Array.isArray(s.reasons) ? (s.reasons as string[]) : [];
      return reasons.some((r) => /\$0\s*bid|ask\s*vs\s*\$0/i.test(String(r)));
    };
    // De-dupe by id (developing list can include both hidden + visible merges).
    const seen = new Set<string>();
    const unique = base.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    // Group by local date string.
    const groups = new Map<string, Signal[]>();
    for (const s of unique) {
      const d = new Date(s.created_at);
      const key = d.toDateString();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    const todayKey = new Date().toDateString();
    const yKey = new Date(now - 24 * 60 * 60_000).toDateString();
    const fmt = (key: string) => {
      if (key === todayKey) return `Today · ${new Date(key).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      if (key === yKey) return `Yesterday · ${new Date(key).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      return new Date(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    };
    const sortItems = (arr: Signal[]) => {
      const ordered = [...arr].sort((a, b) => rankSignal(b).total - rankSignal(a).total);
      return ordered.sort((a, b) => Number(isZeroBid(a)) - Number(isZeroBid(b)));
    };
    return Array.from(groups.entries())
      .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
      .map(([key, items]) => ({ key, label: fmt(key), items: sortItems(items) }));
  }, [developing, minDevelopingScore]);

  const filteredDeveloping = useMemo(
    () => developingGroups.flatMap((g) => g.items),
    [developingGroups],
  );

  // Top 5 ranked signals for the dashboard hero strip.
  const dashboardTop = useMemo(() => {
    if (!signals) return [];
    const base = signals.filter((s) => !s.hidden && !s.is_demo && s.status === "LIVE" && !isExpired(s));
    const ranked = rankSignals(base);
    const isZeroBid = (s: Signal) => {
      const bid = getContractMeta(s)?.bid;
      if (bid === 0) return true;
      const reasons = Array.isArray(s.reasons) ? (s.reasons as string[]) : [];
      return reasons.some((r) => /\$0\s*bid|ask\s*vs\s*\$0/i.test(String(r)));
    };
    const sorted = [...ranked].sort((a, b) => {
      const za = Number(isZeroBid(a.signal));
      const zb = Number(isZeroBid(b.signal));
      if (za !== zb) return za - zb;
      const pa = sourcePriority(a.signal as any);
      const pb = sourcePriority(b.signal as any);
      if (pa !== pb) return pa - pb;
      return b.rank.total - a.rank.total;
    });
    return sorted.slice(0, 5);
  }, [signals]);

  // Fallback: 1-click approve (used when option chain is unavailable).
  async function fallbackApprove(s: Signal) {
    const res = await approveSignalAsPaperTrade({
      userId: user!.id,
      signal: s,
      risk,
      openTradesCount: openTrades.length,
      todayRealizedPL,
    });
    if (!res.ok) return toast.error((res as { reason: string }).reason);
    toast.success(`Paper trade opened on ${s.ticker}`);
    await supabase.from("signal_actions").insert({
      user_id: user!.id,
      signal_id: s.id,
      action: "approved",
    });
    setDismissedIds((prev) => new Set(prev).add(s.id));
    await refreshAfterTrade();
  }

  async function refreshAfterTrade() {
    const [{ data: t }, { data: pa }] = await Promise.all([
      supabase.from("paper_trades").select("*").eq("user_id", user!.id),
      supabase.from("paper_accounts").select("cash_balance").eq("user_id", user!.id).maybeSingle(),
    ]);
    setTrades(t ?? []);
    setCashBalance(Number((pa as any)?.cash_balance ?? 0));
    reloadAlerts();
  }

  // New primary action: open the Robinhood-style Buy Option modal.
  function approve(s: Signal) {
    setBuySignal(s);
    setBuyOpen(true);
  }

  async function onBuySuccess() {
    if (!buySignal) return;
    await supabase.from("signal_actions").insert({
      user_id: user!.id,
      signal_id: buySignal.id,
      action: "approved",
    });
    setDismissedIds((prev) => new Set(prev).add(buySignal.id));
    await refreshAfterTrade();
  }



  async function dismiss(s: Signal) {
    const { error } = await supabase.from("signal_actions").insert({
      user_id: user!.id,
      signal_id: s.id,
      action: "dismissed",
    });
    // Unique violation just means already dismissed — silent.
    if (error && error.code !== "23505") toast.error(error.message);
    setDismissedIds((prev) => new Set(prev).add(s.id));
    setSignals((prev) => prev ? prev.filter((x) => x.id !== s.id) : prev);
    toast("Signal dismissed");
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Live signals</h1>
            <p className="text-sm text-muted-foreground">Educational paper-trading desk. Approve trades manually.</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <NotificationsBell />
            {alpacaStatus && (
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    alpacaStatus === "ok" && "bg-bull",
                    alpacaStatus === "error" && "bg-bear",
                    alpacaStatus === "unknown" && "bg-warn"
                  )}
                />
                Alpaca{" "}
                <span className="text-foreground font-medium">
                  {alpacaStatus === "ok" ? "connected" : alpacaStatus === "error" ? "error" : "checking…"}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="pulse-dot" />
              Market <span className="text-foreground font-medium">{marketStatus()}</span>
            </div>
          </div>
        </div>
      </header>

      <MarketOverviewStrip />

      <PaperAccountCard />

      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat icon={DollarSign} label="Realized today" value={`$${fmtPL(todayRealizedPL)}`} accent={todayRealizedPL >= 0 ? "text-bull" : "text-bear"} />
        <Stat icon={todayRealizedPL + unrealizedPL >= 0 ? TrendingUp : TrendingDown} label="Unrealized open" value={`$${fmtPL(unrealizedPL)}`} accent={unrealizedPL >= 0 ? "text-bull" : "text-bear"} />
        <Stat icon={DollarSign} label="Daily P/L total" value={`$${fmtPL(dailyPL)}`} accent={dailyPL >= 0 ? "text-bull" : "text-bear"} />
        <Stat icon={Activity} label="Open trades" value={String(openTrades.length)} accent="text-info" />
        <Stat icon={Flame} label="Trades today" value={String(tradesOpenedToday)} accent="text-primary" />
        <Stat icon={Radio} label="Live signals" value={String(totalLive)} accent="text-primary" />
      </section>

      {dashboardTop.length > 0 && (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight uppercase text-muted-foreground flex items-center gap-2">
              <Trophy className="h-4 w-4 text-primary" /> Top Signals
            </h2>
            <Button asChild size="sm" variant="ghost" className="h-7 text-[11px]">
              <Link to="/app/top-signals">View all →</Link>
            </Button>
          </div>
          <div className="space-y-2">
            {dashboardTop.map(({ signal, rank }: { signal: Signal; rank: RankBreakdown }, i: number) => (
              <TopSignalRow
                key={signal.id}
                rank={i + 1}
                signal={signal}
                breakdown={rank}
                onApprove={approve}
                onReject={dismiss}
                onDetails={(s) => setDetailSignal(s)}
              />
            ))}
          </div>
        </section>
      )}

      <ProviderStatusBanner signals={signals} />


      <RiskStatusCard
        effective={effective}
        openTradesCount={openTrades.length}
        todayRealizedPL={todayRealizedPL}
      />

      {activeAlerts.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight uppercase text-muted-foreground">
              Active Trade Plans
            </h2>
            <span className="text-[11px] text-muted-foreground">{activeAlerts.length} active</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {activeAlerts.map(a => <TradeAlertCard key={a.id} alert={a} onChanged={reloadAlerts} />)}
          </div>
        </section>
      )}



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
          <Button
            size="sm"
            variant={includeExpired ? "secondary" : "outline"}
            className={cn(includeExpired ? "" : "bg-transparent", "ml-auto")}
            onClick={() => setIncludeExpired((v) => !v)}
            title="Show signals past their TTL"
          >
            {includeExpired ? "Active + expired" : "Active only"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground self-center mr-1">Provider</span>
          {SOURCE_FILTER_OPTIONS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={providerFilter === f.id ? "default" : "outline"}
              className={cn("h-7 text-[11px] px-2", providerFilter === f.id ? "" : "bg-transparent")}
              onClick={() => setProviderFilter(f.id)}
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
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground mr-1">Lifecycle</span>
          <Button
            size="sm"
            variant={lifecycleFilter === "all" ? "secondary" : "ghost"}
            className="h-7 text-[11px] px-2"
            onClick={() => setLifecycleFilter("all")}
          >
            All active
          </Button>
          {LIFECYCLE_ORDER.map((ls) => (
            <Button
              key={ls}
              size="sm"
              variant={lifecycleFilter === ls ? "secondary" : "ghost"}
              className="h-7 text-[11px] px-2 gap-1"
              onClick={() => setLifecycleFilter(lifecycleFilter === ls ? "all" : ls)}
              title={LIFECYCLE_META[ls].description}
            >
              <span>{LIFECYCLE_META[ls].emoji}</span> {LIFECYCLE_META[ls].label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TagIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mr-0.5" />
          <Button
            size="sm"
            variant={tagFilter === null ? "secondary" : "ghost"}
            className="h-7 text-[11px] px-2 shrink-0"
            onClick={() => setTagFilter(null)}
          >
            Any tag
          </Button>
          {ALL_TAGS.map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tagFilter === t ? "secondary" : "ghost"}
              className="h-7 text-[11px] px-2 shrink-0"
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            >
              {t}
            </Button>
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {!signals
          ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-lg" />)
          : filtered.length === 0
          ? <EmptyState />
          : filtered.map((s) => (
              <SignalCard
                key={s.id}
                signal={s}
                watchlist={watchSet}
                onApprove={approve}
                onReject={dismiss}
                onDetails={(sig) => setDetailSignal(sig)}
                outcome={signalOutcome(s, trades, dismissedIds)}
              />
            ))}
      </section>

      {developing && developing.length > 0 && (
        <section className="space-y-3 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight text-muted-foreground uppercase">
                Developing Signals
              </h2>
              <p className="text-xs text-muted-foreground">
                Below Threshold — Not Tradeable Yet · score 60–69 · last 24h only
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Min score</span>
                <input
                  type="range"
                  min={60}
                  max={69}
                  step={1}
                  value={Math.max(60, minDevelopingScore)}
                  onChange={(e) => setMinDevelopingScore(Number(e.target.value))}
                  className="w-24 accent-primary"
                />
                <span className="text-xs font-medium tabular-nums w-5">{Math.max(60, minDevelopingScore)}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="bg-transparent"
                onClick={() => setShowDeveloping((v) => !v)}
              >
                {showDeveloping ? `Hide (${filteredDeveloping.length})` : `Show (${filteredDeveloping.length})`}
              </Button>
            </div>
          </div>
          {showDeveloping && (
            filteredDeveloping.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="space-y-5 opacity-75 hover:opacity-100 transition-opacity">
                {developingGroups.map((g) => (
                  <div key={g.key} className="space-y-2">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                      {g.label} <span className="text-muted-foreground/60">· {g.items.length}</span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {g.items.map((s) => (
                        <SignalCard
                          key={s.id}
                          signal={s}
                          watchlist={watchSet}
                          onApprove={approve}
                          onReject={dismiss}
                          onDetails={(sig) => setDetailSignal(sig)}
                          outcome={signalOutcome(s, trades, dismissedIds)}
                          subLabel={
                            (effectiveConfidence(s as any) ?? s.confidence ?? 0) >= 65
                              ? "Near Watchlist — Paper Test"
                              : "Paper Test Candidate"
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </section>
      )}

      <SignalDetailDialog
        signal={detailSignal}
        open={!!detailSignal}
        onOpenChange={(v) => !v && setDetailSignal(null)}
        outcome={detailSignal ? signalOutcome(detailSignal, trades, dismissedIds) : undefined}
      />

      <BuyOptionDialog
        open={buyOpen}
        signal={buySignal}
        userId={user?.id ?? ""}
        risk={risk}
        openTradesCount={openTrades.length}
        todayRealizedPL={todayRealizedPL}
        cashBalance={cashBalance}
        onOpenChange={setBuyOpen}
        onSuccess={onBuySuccess}
        onFallbackApprove={fallbackApprove}
      />
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
