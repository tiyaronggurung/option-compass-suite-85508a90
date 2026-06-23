import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { PaperTrade, Signal } from "@/lib/signalHelpers";
import { isExpired } from "@/lib/signalFreshness";
import { effectiveConfidence } from "@/lib/techAdjust";
import { rankSignals, getContractMeta, type RankBreakdown } from "@/lib/rankSignals";
import { sumTodayRealizedPL, type RiskSettingsLike } from "@/lib/riskGuard";
import { approveSignalAsPaperTrade } from "@/lib/approveSignal";
import { TopSignalRow } from "@/components/TopSignalRow";
import { SignalDetailDialog } from "@/components/SignalDetailDialog";
import { BuyOptionDialog } from "@/components/BuyOptionDialog";
import { DisclaimerBar } from "@/components/Disclaimer";
import { SOURCE_FILTER_OPTIONS, matchesSourceFilter, sourcePriority, type SourceFilter } from "@/lib/signalSource";
import { regimeAdjustConfidence } from "@/lib/regimeAdjust";
import { useMarketRegime } from "@/hooks/useMarketRegime";

type Tab = "calls" | "puts" | "all";
type MaxRisk = "LOW" | "MEDIUM" | "HIGH";

const TOP_N: Record<Tab, number> = { calls: 10, puts: 10, all: 20 };

export default function TopSignals() {
  const { user } = useAuth();
  const regime = useMarketRegime();
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [watch, setWatch] = useState<string[]>([]);
  const [risk, setRisk] = useState<RiskSettingsLike>(null);

  const [tab, setTab] = useState<Tab>("calls");
  const [watchOnly, setWatchOnly] = useState(false);
  const [minScore, setMinScore] = useState(0);
  const [maxRisk, setMaxRisk] = useState<MaxRisk>("HIGH");
  const [freshOnly, setFreshOnly] = useState(false);
  const [includeDebug, setIncludeDebug] = useState(false);
  const [providerFilter, setProviderFilter] = useState<SourceFilter>("all");

  const [detail, setDetail] = useState<{ signal: Signal; breakdown: RankBreakdown } | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buySignal, setBuySignal] = useState<Signal | null>(null);
  const [cashBalance, setCashBalance] = useState<number>(0);

  const watchSet = useMemo(() => new Set(watch), [watch]);

  // Deep-link target from notifications bell: /app/top-signals?signal=<id>
  const [searchParams, setSearchParams] = useSearchParams();
  const targetSignalId = searchParams.get("signal");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const scrolledForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!targetSignalId || !signals) return;
    if (scrolledForRef.current === targetSignalId) return;
    // Wait a frame for the rows to render
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-signal-id="${CSS.escape(targetSignalId)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightId(targetSignalId);
        scrolledForRef.current = targetSignalId;
        // Clear the highlight + URL param after a bit
        setTimeout(() => {
          setHighlightId(null);
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("signal");
            return next;
          }, { replace: true });
        }, 2800);
      }
    }, 80);
    return () => clearTimeout(t);
  }, [targetSignalId, signals, setSearchParams]);


  useEffect(() => {
    if (!user) return;
    let cancel = false;
    (async () => {
      const [{ data: s }, { data: dev }, { data: t }, { data: w }, { data: rs }, { data: pa }] = await Promise.all([
        supabase.from("signals").select("*").eq("hidden", false).order("created_at", { ascending: false }).limit(200),
        supabase.from("signals").select("*").eq("hidden", true).eq("tier", "rejected").gte("confidence", 60).order("created_at", { ascending: false }).limit(60),
        supabase.from("paper_trades").select("*").eq("user_id", user.id),
        supabase.from("watchlist_items").select("ticker").eq("user_id", user.id),
        supabase.from("risk_settings").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("paper_accounts").select("cash_balance").eq("user_id", user.id).maybeSingle(),
      ]);
      if (cancel) return;
      // Merge visible signals with hidden-rejected pool (same as Dashboard hero), dedupe by id.
      const pool = new Map<string, Signal>();
      for (const x of (s ?? []) as Signal[]) pool.set(x.id, x);
      for (const x of (dev ?? []) as Signal[]) if (!pool.has(x.id)) pool.set(x.id, x);
      setSignals(Array.from(pool.values()));
      setTrades(t ?? []);
      setWatch((w ?? []).map((x: any) => x.ticker));
      setRisk(rs as RiskSettingsLike);
      setCashBalance(Number((pa as any)?.cash_balance ?? 0));
    })();
    return () => { cancel = true; };
  }, [user]);

  const openTrades = trades.filter((t) => t.status === "OPEN");
  const todayRealizedPL = useMemo(() => sumTodayRealizedPL(trades as any), [trades]);

  const ranked = useMemo(() => {
    if (!signals) return [];
    const base = signals.filter((s) => {
      if (!includeDebug) {
        // NOTE: do NOT exclude `hidden` here — the fetch above already merges
        // the hidden+rejected (confidence>=60) pool the Dashboard hero uses.
        if (s.is_demo) return false;
        if (s.status !== "LIVE") return false;
        if (isExpired(s)) return false;
        // Regime-aware gate: in bear/high_vol PUTs get a small boost (and CALLs
        // a small drag); in bull the reverse. Sideways = unchanged.
        const eff = effectiveConfidence(s as any) ?? 0;
        const adj = regimeAdjustConfidence(eff, s.direction as "CALL" | "PUT", regime) ?? eff;
        if (adj < 70) return false;
      }
      return true;
    });
    return rankSignals(base);
  }, [signals, includeDebug, regime]);

  // Compute call vs put total contract volume across the broadly-filtered set
  // (before the call/put tab split) so the bias reflects the whole board.
  const sideVolumes = useMemo(() => {
    let call = 0; let put = 0;
    for (const { signal } of ranked) {
      const fm = (signal.flow_metrics ?? {}) as any;
      const cm = getContractMeta(signal) as any;
      const v = Number(fm.volume ?? fm.option_volume ?? fm.total_volume ?? cm?.volume ?? 0) || 0;
      if (signal.direction === "CALL") call += v;
      else if (signal.direction === "PUT") put += v;
    }
    const bias: "CALL" | "PUT" | null =
      call === 0 && put === 0 ? null : call >= put ? "CALL" : "PUT";
    return { call, put, bias };
  }, [ranked]);

  const filteredByTab = useMemo(() => {
    const filtered = ranked.filter(({ signal, rank }) => {
      if (tab === "calls" && signal.direction !== "CALL") return false;
      if (tab === "puts" && signal.direction !== "PUT") return false;
      if (watchOnly && !watchSet.has(signal.ticker)) return false;
      if (rank.total < minScore) return false;
      const riskOrder = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
      if (riskOrder[signal.risk_level as MaxRisk] > riskOrder[maxRisk]) return false;
      if (freshOnly) {
        const ageMs = Date.now() - new Date(signal.created_at).getTime();
        if (ageMs > 60 * 60_000) return false;
      }
      if (!matchesSourceFilter(signal as any, providerFilter)) return false;
      return true;
    });
    // Re-sort: winning-side bias (only on the "All" tab) → source priority → score.
    const sorted = [...filtered].sort((a, b) => {
      if (tab === "all" && sideVolumes.bias) {
        const aWin = a.signal.direction === sideVolumes.bias ? 0 : 1;
        const bWin = b.signal.direction === sideVolumes.bias ? 0 : 1;
        if (aWin !== bWin) return aWin - bWin;
      }
      const pa = sourcePriority(a.signal as any);
      const pb = sourcePriority(b.signal as any);
      if (pa !== pb) return pa - pb;
      return b.rank.total - a.rank.total;
    });
    return sorted.slice(0, TOP_N[tab]);
  }, [ranked, tab, watchOnly, watchSet, minScore, maxRisk, freshOnly, providerFilter, sideVolumes]);

  async function refreshAfterTrade() {
    if (!user) return;
    const [{ data: t }, { data: pa }] = await Promise.all([
      supabase.from("paper_trades").select("*").eq("user_id", user.id),
      supabase.from("paper_accounts").select("cash_balance").eq("user_id", user.id).maybeSingle(),
    ]);
    setTrades(t ?? []);
    setCashBalance(Number((pa as any)?.cash_balance ?? 0));
  }

  // Fallback: 1-click approve when option chain isn't cached for this ticker.
  async function fallbackApprove(s: Signal) {
    if (!user) return;
    const res = await approveSignalAsPaperTrade({
      userId: user.id,
      signal: s,
      risk,
      openTradesCount: openTrades.length,
      todayRealizedPL,
    });
    if (!res.ok) return toast.error((res as { reason: string }).reason);
    toast.success(`Paper trade opened on ${s.ticker}`);
    await refreshAfterTrade();
  }

  function handleApprove(s: Signal) {
    setBuySignal(s);
    setBuyOpen(true);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-primary" />
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Top Signals</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Ranked by confidence, contract liquidity, delta match, spread, freshness and risk.
        </p>
      </header>

      <DisclaimerBar />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="calls" className="flex-1 sm:flex-none">Top Calls</TabsTrigger>
          <TabsTrigger value="puts" className="flex-1 sm:flex-none">Top Puts</TabsTrigger>
          <TabsTrigger value="all" className="flex-1 sm:flex-none">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <section className="glass-card p-3 sm:p-4 grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-center justify-between gap-3 min-w-0">
          <label className="text-sm text-muted-foreground truncate">Watchlist only</label>
          <Switch checked={watchOnly} onCheckedChange={setWatchOnly} />
        </div>
        <div className="flex items-center justify-between gap-3 min-w-0">
          <label className="text-sm text-muted-foreground truncate">Fresh only (&lt;1h)</label>
          <Switch checked={freshOnly} onCheckedChange={setFreshOnly} />
        </div>
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Min ranking score</span>
            <span className="ticker-mono text-foreground">{minScore}</span>
          </div>
          <Slider value={[minScore]} max={100} step={5} onValueChange={(v) => setMinScore(v[0] ?? 0)} />
        </div>
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-sm text-muted-foreground mr-1">Max risk</span>
          {(["LOW", "MEDIUM", "HIGH"] as const).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={maxRisk === r ? "secondary" : "outline"}
              className={cn("h-7 text-[11px] px-2", maxRisk === r ? "" : "bg-transparent")}
              onClick={() => setMaxRisk(r)}
            >
              {r}
            </Button>
          ))}
        </div>
        <div className="md:col-span-2 xl:col-span-4 flex items-center justify-between gap-3 pt-2 border-t border-border min-w-0">
          <label className="text-xs text-muted-foreground truncate">Include demo / expired (debug)</label>
          <Switch checked={includeDebug} onCheckedChange={setIncludeDebug} />
        </div>
      </section>

      <section className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Provider</span>
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
        {sideVolumes.bias && (
          <div className="glass-card px-3 py-2 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-muted-foreground uppercase tracking-wider text-[10px]">Flow bias</span>
            <span className="ticker-mono">
              CALL vol <span className={cn(sideVolumes.bias === "CALL" ? "text-bull font-semibold" : "text-muted-foreground")}>
                {sideVolumes.call.toLocaleString()}
              </span>
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="ticker-mono">
              PUT vol <span className={cn(sideVolumes.bias === "PUT" ? "text-bear font-semibold" : "text-muted-foreground")}>
                {sideVolumes.put.toLocaleString()}
              </span>
            </span>
            <span className="ml-auto text-[11px]">
              Bias:{" "}
              <span className={cn("font-semibold", sideVolumes.bias === "CALL" ? "text-bull" : "text-bear")}>
                {sideVolumes.bias}S
              </span>
              {tab === "all" && <span className="text-muted-foreground"> · boosted in list</span>}
            </span>
          </div>
        )}
        {!signals ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
        ) : filteredByTab.length === 0 ? (
          <div className="glass-card p-10 text-center text-sm text-muted-foreground">
            No signals match these filters.
          </div>
        ) : (
          filteredByTab.map(({ signal, rank }, i) => (
            <div
              key={signal.id}
              data-signal-id={signal.id}
              className={cn(
                "rounded-lg transition-all duration-500",
                highlightId === signal.id && "ring-2 ring-primary ring-offset-2 ring-offset-background animate-pulse",
              )}
            >
              <TopSignalRow
                rank={i + 1}
                signal={signal}
                breakdown={rank}
                onApprove={handleApprove}
                onDetails={(s, b) => setDetail({ signal: s, breakdown: b })}
              />
            </div>
          ))
        )}
      </section>

      <SignalDetailDialog
        signal={detail?.signal ?? null}
        open={!!detail}
        onOpenChange={(v) => !v && setDetail(null)}
        rankBreakdown={detail?.breakdown}
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
        onSuccess={refreshAfterTrade}
        onFallbackApprove={fallbackApprove}
      />
    </div>
  );
}
