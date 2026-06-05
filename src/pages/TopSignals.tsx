import { useEffect, useMemo, useState } from "react";
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
import { rankSignals, type RankBreakdown } from "@/lib/rankSignals";
import { sumTodayRealizedPL, type RiskSettingsLike } from "@/lib/riskGuard";
import { approveSignalAsPaperTrade } from "@/lib/approveSignal";
import { TopSignalRow } from "@/components/TopSignalRow";
import { SignalDetailDialog } from "@/components/SignalDetailDialog";
import { BuyOptionDialog } from "@/components/BuyOptionDialog";
import { DisclaimerBar } from "@/components/Disclaimer";

type Tab = "calls" | "puts" | "all";
type MaxRisk = "LOW" | "MEDIUM" | "HIGH";

const TOP_N: Record<Tab, number> = { calls: 10, puts: 10, all: 20 };

export default function TopSignals() {
  const { user } = useAuth();
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

  const [detail, setDetail] = useState<{ signal: Signal; breakdown: RankBreakdown } | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buySignal, setBuySignal] = useState<Signal | null>(null);
  const [cashBalance, setCashBalance] = useState<number>(0);

  const watchSet = useMemo(() => new Set(watch), [watch]);

  useEffect(() => {
    if (!user) return;
    let cancel = false;
    (async () => {
      const [{ data: s }, { data: t }, { data: w }, { data: rs }, { data: pa }] = await Promise.all([
        supabase.from("signals").select("*").order("created_at", { ascending: false }).limit(200),
        supabase.from("paper_trades").select("*").eq("user_id", user.id),
        supabase.from("watchlist_items").select("ticker").eq("user_id", user.id),
        supabase.from("risk_settings").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("paper_accounts").select("cash_balance").eq("user_id", user.id).maybeSingle(),
      ]);
      if (cancel) return;
      setSignals(s ?? []);
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
        if (s.hidden) return false;
        if (s.is_demo) return false;
        if (s.status !== "LIVE") return false;
        if (isExpired(s)) return false;
      }
      return true;
    });
    return rankSignals(base);
  }, [signals, includeDebug]);

  const filteredByTab = useMemo(() => {
    return ranked.filter(({ signal, rank }) => {
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
      return true;
    }).slice(0, TOP_N[tab]);
  }, [ranked, tab, watchOnly, watchSet, minScore, maxRisk, freshOnly]);

  async function handleApprove(s: Signal) {
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
    const { data } = await supabase.from("paper_trades").select("*").eq("user_id", user.id);
    setTrades(data ?? []);
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
        {!signals ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
        ) : filteredByTab.length === 0 ? (
          <div className="glass-card p-10 text-center text-sm text-muted-foreground">
            No signals match these filters.
          </div>
        ) : (
          filteredByTab.map(({ signal, rank }, i) => (
            <TopSignalRow
              key={signal.id}
              rank={i + 1}
              signal={signal}
              breakdown={rank}
              onApprove={handleApprove}
              onDetails={(s, b) => setDetail({ signal: s, breakdown: b })}
            />
          ))
        )}
      </section>

      <SignalDetailDialog
        signal={detail?.signal ?? null}
        open={!!detail}
        onOpenChange={(v) => !v && setDetail(null)}
        rankBreakdown={detail?.breakdown}
      />
    </div>
  );
}
