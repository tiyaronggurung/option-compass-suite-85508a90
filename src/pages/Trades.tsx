import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { invokeUpdatePaperMarks } from "@/lib/paperMarks";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar } from "@/components/Disclaimer";
import { PaperAccountCard } from "@/components/PaperAccountCard";
import { fmtPL, fmtPrice, timeAgo, type PaperTrade } from "@/lib/signalHelpers";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { Database } from "@/integrations/supabase/types";
import { OptionTradeCard } from "@/components/OptionTradeCard";
import { SignalDetailDialog } from "@/components/SignalDetailDialog";
import type { Signal } from "@/lib/signalHelpers";

type CloseReason = Database["public"]["Enums"]["trade_close_reason"];
type TradeReview = Database["public"]["Tables"]["trade_reviews"]["Row"];

const REASON_OPTIONS: { value: CloseReason; label: string }[] = [
  { value: "target_hit", label: "Target hit" },
  { value: "stop_hit", label: "Stop hit" },
  { value: "manual_close", label: "Manual close" },
  { value: "expired", label: "Expired" },
  { value: "invalidated", label: "Invalidated setup" },
];

export default function Trades() {
  const { user } = useAuth();
  const { isAdmin } = useIsAdmin();
  const [trades, setTrades] = useState<PaperTrade[] | null>(null);
  const [reviews, setReviews] = useState<Record<string, TradeReview>>({});
  const [closing, setClosing] = useState<PaperTrade | null>(null);
  const [partialClosing, setPartialClosing] = useState<PaperTrade | null>(null);
  const [addingMore, setAddingMore] = useState<PaperTrade | null>(null);
  const [reviewing, setReviewing] = useState<PaperTrade | null>(null);
  const [refreshingMarks, setRefreshingMarks] = useState(false);
  const [signalDetail, setSignalDetail] = useState<Signal | null>(null);
  const refreshRef = useRef<() => Promise<void>>();

  async function openSignalForTrade(trade: PaperTrade) {
    if (!trade.signal_id) {
      toast.error("This trade has no linked signal.");
      return;
    }
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .eq("id", trade.signal_id)
      .maybeSingle();
    if (error) { toast.error(error.message); return; }
    if (!data) { toast.error("Original signal no longer available."); return; }
    setSignalDetail(data as Signal);
  }

  async function refresh() {
    const [{ data }, { data: r }] = await Promise.all([
      supabase.from("paper_trades").select("*").eq("user_id", user!.id)
        .order("opened_at", { ascending: false }),
      supabase.from("trade_reviews").select("*").eq("user_id", user!.id),
    ]);
    setTrades(data ?? []);
    const map: Record<string, TradeReview> = {};
    (r ?? []).forEach((x) => { map[x.trade_id] = x; });
    setReviews(map);
  }
  refreshRef.current = refresh;

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [user]);

  // Trigger a live mark recompute on mount and every 30s while visible,
  // but only if there are open trades. Then re-read from DB.
  // 30s cadence × ~5 active users × 6.5h market session ≈ 3.9k UW calls/day,
  // well under the 20k/day budget.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function tick() {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      const hasOpen = (trades ?? []).some((t) => t.status === "OPEN");
      if (!hasOpen) return;
      try {
        await supabase.functions.invoke("update-paper-marks", { body: {} });
      } catch { /* swallow — UI will retry next tick */ }
      if (!cancelled) refreshRef.current?.();
    }
    // Kick immediately so the user sees fresh prices fast, then poll every 30s.
    tick();
    const id = setInterval(tick, 30_000);

    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, trades?.length]);

  // Realtime: patch rows in place when paper_trades changes for this user.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`paper_trades_${user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "paper_trades", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const next = payload.new as PaperTrade;
          setTrades((prev) => prev ? prev.map((t) => t.id === next.id ? { ...t, ...next } : t) : prev);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "paper_trades", filter: `user_id=eq.${user.id}` },
        () => { refreshRef.current?.(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);


  async function refreshMarks() {
    setRefreshingMarks(true);
    try {
      const { data, error } = await invokeUpdatePaperMarks();
      if (error) return toast.error(error.message);
      const updated = (data as any)?.updated ?? 0;
      toast.success(`Marks refreshed · ${updated} trade${updated === 1 ? "" : "s"} updated`);
      refresh();
    } finally {
      setRefreshingMarks(false);
    }
  }

  const open = trades?.filter((t) => t.status === "OPEN") ?? [];
  const closed = trades?.filter((t) => t.status !== "OPEN") ?? [];
  const lastMark = open
    .map((t) => t.last_mark_at)
    .filter(Boolean)
    .sort()
    .pop();

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Paper trades</h1>
          <p className="text-sm text-muted-foreground">
            Manually approved demo trades. No real money at risk.
            {open.length > 0 && (
              <span className="ml-1.5 text-xs block sm:inline">
                · Marks auto-refresh every 60s
                {lastMark && <> · Last mark {timeAgo(lastMark as string)}</>}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={refreshMarks} disabled={refreshingMarks}>
              <RefreshCw className={cn("h-4 w-4 mr-1.5", refreshingMarks && "animate-spin")} />
              {refreshingMarks ? "Refreshing…" : "Refresh marks"}
            </Button>
          )}
          <Badge className="bg-warn/15 text-warn border-0">Paper trading only</Badge>
        </div>
      </header>

      <DisclaimerBar />

      <PaperAccountCard />


      <Section title="Open">
        {!trades ? <Skeleton className="h-24" />
          : open.length === 0 ? <Empty text="No open paper trades. Approve a signal from the dashboard." />
          : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {open.map((t) => (
                <OptionTradeCard
                  key={t.id}
                  trade={t}
                  live
                  onClose={(x) => setClosing(x)}
                  onClosePartial={(x) => setPartialClosing(x)}
                  onAddMore={(x) => setAddingMore(x)}
                />
              ))}
            </div>
          )}
      </Section>

      <Section title="Closed">
        {!trades ? null
          : closed.length === 0 ? <Empty text="No closed trades yet." />
          : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {closed.map((t) => (
                <OptionTradeCard
                  key={t.id}
                  trade={t}
                  onReview={(x) => setReviewing(x)}
                  onShowSignal={(x) => openSignalForTrade(x)}
                  hasReview={!!reviews[t.id]}
                />
              ))}
            </div>
          )}
      </Section>

      <CloseTradeDialog
        trade={closing}
        onOpenChange={(v) => !v && setClosing(null)}
        onClosed={() => { setClosing(null); refresh(); }}
      />
      <PartialCloseDialog
        trade={partialClosing}
        onOpenChange={(v) => !v && setPartialClosing(null)}
        onClosed={() => { setPartialClosing(null); refresh(); }}
      />
      <AddMoreDialog
        trade={addingMore}
        onOpenChange={(v) => !v && setAddingMore(null)}
        onAdded={() => { setAddingMore(null); refresh(); }}
      />
      <ReviewDialog
        trade={reviewing}
        cached={reviewing ? reviews[reviewing.id] : undefined}
        onOpenChange={(v) => !v && setReviewing(null)}
        onSaved={(r) => setReviews((m) => ({ ...m, [r.trade_id]: r }))}
      />
      <SignalDetailDialog
        signal={signalDetail}
        open={!!signalDetail}
        onOpenChange={(v) => !v && setSignalDetail(null)}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="glass-card p-8 text-center text-sm text-muted-foreground">{text}</div>;
}

function reasonLabel(r: CloseReason): string {
  return REASON_OPTIONS.find((x) => x.value === r)?.label ?? r;
}

function CloseTradeDialog({
  trade, onOpenChange, onClosed,
}: {
  trade: PaperTrade | null;
  onOpenChange: (v: boolean) => void;
  onClosed: () => void;
}) {
  const t = trade as any;
  const contracts = Math.max(1, Number(t?.contracts ?? 1));
  const multiplier = Number(t?.multiplier ?? 100);
  const entryPremium = Number(t?.entry_premium ?? trade?.entry_price ?? 0);

  const [livePremium, setLivePremium] = useState<number | null>(null);
  const [liveMarkAt, setLiveMarkAt] = useState<string | null>(null);
  const [fetchingMark, setFetchingMark] = useState(false);
  const [exitPremiumStr, setExitPremiumStr] = useState("");
  const [reason, setReason] = useState<CloseReason>("manual_close");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (trade) {
      const seedLive = t?.current_premium != null ? Number(t.current_premium) : null;
      setLivePremium(seedLive);
      setLiveMarkAt(t?.last_mark_at ?? null);
      const seed = seedLive ?? entryPremium;
      setExitPremiumStr(seed ? String(seed) : "");
      setReason("manual_close");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade]);

  async function useLiveMark() {
    if (!trade) return;
    setFetchingMark(true);
    try {
      const { error } = await invokeUpdatePaperMarks();
      if (error) {
        return toast.error(error.message);
      }
      const { data: fresh } = await supabase
        .from("paper_trades")
        .select("current_premium,last_mark_at")
        .eq("id", trade.id)
        .maybeSingle();
      const mark = fresh?.current_premium != null ? Number(fresh.current_premium) : null;
      if (mark == null) {
        toast.error("No live mark available for this contract");
        return;
      }
      setLivePremium(mark);
      setLiveMarkAt((fresh as any)?.last_mark_at ?? new Date().toISOString());
      setExitPremiumStr(String(mark));
      toast.success(`Live mark applied · $${fmtPrice(mark)}`);
    } finally {
      setFetchingMark(false);
    }
  }

  if (!trade) return null;

  const exitPremium = Number(exitPremiumStr);
  const validExit = exitPremiumStr !== "" && !Number.isNaN(exitPremium) && exitPremium >= 0;
  const totalCost = entryPremium * multiplier * contracts;
  const exitValue = validExit ? exitPremium * multiplier * contracts : 0;
  const realizedPl = validExit ? (exitPremium - entryPremium) * multiplier * contracts : 0;
  const realizedPlPct = validExit && totalCost > 0 ? (realizedPl / totalCost) * 100 : 0;
  const status: PaperTrade["status"] =
    reason === "target_hit" ? "WIN"
    : reason === "stop_hit" ? "LOSS"
    : realizedPl > 0 ? "WIN" : realizedPl < 0 ? "LOSS" : "CLOSED";

  async function submit() {
    if (!validExit) {
      toast.error("Enter a valid exit premium");
      return;
    }
    setSubmitting(true);
    const mfe = realizedPl > 0 ? realizedPl : 0;
    const mae = realizedPl < 0 ? realizedPl : 0;
    const { error } = await supabase.from("paper_trades").update({
      status,
      // New option close fields
      exit_premium: Number(exitPremium.toFixed(4)),
      realized_pl: Number(realizedPl.toFixed(2)),
      realized_pl_dollars: Number(realizedPl.toFixed(2)),
      // Mirror to legacy columns so existing UI/queries stay accurate
      exit_price: Number(exitPremium.toFixed(4)),
      current_pl: Number(realizedPl.toFixed(2)),
      current_pl_pct: Number(realizedPlPct.toFixed(2)),
      current_premium: Number(exitPremium.toFixed(4)),
      current_value: Number(exitValue.toFixed(2)),
      unrealized_pl: Number(realizedPl.toFixed(2)),
      unrealized_pl_pct: Number(realizedPlPct.toFixed(2)),
      realized_pl_pct: Number(realizedPlPct.toFixed(2)),
      exit_reason: reason,
      mfe: Number(mfe.toFixed(2)),
      mae: Number(mae.toFixed(2)),
      max_gain: Math.abs(mfe),
      max_drawdown: Math.abs(mae),
      closed_at: new Date().toISOString(),
    } as any).eq("id", trade!.id);
    setSubmitting(false);
    if (error) return toast.error(error.message);
    toast.success(`Trade closed: ${status} · ${realizedPl >= 0 ? "+" : ""}$${fmtPL(realizedPl)}`);
    onClosed();
  }

  return (
    <Dialog open={!!trade} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Close paper option trade</DialogTitle>
          <DialogDescription>
            {trade.ticker} {trade.direction} · entry premium ${fmtPrice(entryPremium)} · {contracts} contract{contracts === 1 ? "" : "s"}.
            Educational only — no real money executed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="exit-premium">Exit option premium ($ per share)</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={useLiveMark}
                disabled={fetchingMark}
              >
                <RefreshCw className={cn("h-3 w-3 mr-1", fetchingMark && "animate-spin")} />
                {fetchingMark ? "Fetching…" : "Use live mark"}
              </Button>
            </div>
            <Input
              id="exit-premium"
              type="number"
              step="0.01"
              min="0"
              value={exitPremiumStr}
              onChange={(e) => setExitPremiumStr(e.target.value)}
              className="ticker-mono"
              placeholder="e.g. 5.10"
            />
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Realized P/L = (exit − entry) × 100 × contracts</span>
              {livePremium != null && (
                <span className="ticker-mono">
                  Live mark ${fmtPrice(livePremium)}
                  {liveMarkAt && <> · {timeAgo(liveMarkAt)}</>}
                </span>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Close reason</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as CloseReason)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md border border-border bg-card-elevated/40 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total cost</span>
              <span className="ticker-mono">${fmtPL(totalCost)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Exit value</span>
              <span className="ticker-mono">${fmtPL(exitValue)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Realized P/L</span>
              <span className={cn("ticker-mono", realizedPl >= 0 ? "text-bull" : "text-bear")}>
                {realizedPl >= 0 ? "+" : ""}${fmtPL(realizedPl)} ({realizedPlPct >= 0 ? "+" : ""}{realizedPlPct.toFixed(2)}%)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Outcome</span>
              <span className="ticker-mono">{status}</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !validExit}>
            {submitting ? "Closing…" : "Close trade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialog({
  trade, cached, onOpenChange, onSaved,
}: {
  trade: PaperTrade | null;
  cached?: TradeReview;
  onOpenChange: (v: boolean) => void;
  onSaved: (r: TradeReview) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<TradeReview | null>(null);

  useEffect(() => {
    setReview(cached ?? null);
  }, [cached, trade]);

  async function run(force = false) {
    if (!trade) return;
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("review-trade", {
      body: { trade_id: trade.id, force },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    if (data?.review) {
      setReview(data.review as TradeReview);
      onSaved(data.review as TradeReview);
    }
  }

  useEffect(() => {
    if (trade && !cached) run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade]);

  if (!trade) return null;

  return (
    <Dialog open={!!trade} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI post-trade review · {trade.ticker} {trade.direction}
          </DialogTitle>
          <DialogDescription>Educational analysis. Not financial advice.</DialogDescription>
        </DialogHeader>

        {loading && !review ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : review ? (
          <div className="space-y-3 text-sm">
            <ReviewRow label="Summary" value={review.summary} />
            <ReviewRow label="Entry quality" value={review.entry_quality} />
            <ReviewRow label="Risk/reward" value={review.rr_quality} />
            <ReviewRow label="Timing" value={review.timing} />
            <ReviewRow label="Signal strength" value={review.signal_strength} />
            <ReviewRow label="Lessons" value={review.lessons} accent />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No review yet.</div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => run(true)} disabled={loading}>
            {loading ? "Regenerating…" : "Regenerate"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewRow({ label, value, accent }: { label: string; value: string | null; accent?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">{label}</div>
      <div className={cn("leading-snug", accent && "text-primary")}>{value}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Partial close: split-row approach. Reduce parent contracts/cost, then insert
// a child OPEN row at parent entry premium, then update child to CLOSED at exit.
// Net cash via existing trigger = realized P/L on the slice.
// -----------------------------------------------------------------------------
function PartialCloseDialog({
  trade, onOpenChange, onClosed,
}: {
  trade: PaperTrade | null;
  onOpenChange: (v: boolean) => void;
  onClosed: () => void;
}) {
  const t = trade as any;
  const totalContracts = Math.max(1, Number(t?.contracts ?? 1));
  const multiplier = Number(t?.multiplier ?? 100);
  const entryPremium = Number(t?.entry_premium ?? trade?.entry_price ?? 0);

  const [qtyStr, setQtyStr] = useState("1");
  const [exitPremiumStr, setExitPremiumStr] = useState("");
  const [reason, setReason] = useState<CloseReason>("manual_close");
  const [livePremium, setLivePremium] = useState<number | null>(null);
  const [fetchingMark, setFetchingMark] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (trade) {
      setQtyStr("1");
      const seed = t?.current_premium != null ? Number(t.current_premium) : entryPremium;
      setLivePremium(t?.current_premium != null ? Number(t.current_premium) : null);
      setExitPremiumStr(seed ? String(seed) : "");
      setReason("manual_close");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade]);

  async function useLiveMark() {
    if (!trade) return;
    setFetchingMark(true);
    try {
      const { error } = await invokeUpdatePaperMarks();
      if (error) { return toast.error(error.message); }
      const { data: fresh } = await supabase
        .from("paper_trades").select("current_premium").eq("id", trade.id).maybeSingle();
      const mark = fresh?.current_premium != null ? Number(fresh.current_premium) : null;
      if (mark == null) return toast.error("No live mark available");
      setLivePremium(mark);
      setExitPremiumStr(String(mark));
      toast.success(`Live mark applied · $${fmtPrice(mark)}`);
    } finally {
      setFetchingMark(false);
    }
  }

  if (!trade) return null;

  const qty = Math.floor(Number(qtyStr));
  const validQty = Number.isFinite(qty) && qty >= 1 && qty < totalContracts;
  const exitPremium = Number(exitPremiumStr);
  const validExit = exitPremiumStr !== "" && !Number.isNaN(exitPremium) && exitPremium >= 0;
  const valid = validQty && validExit;

  const sliceCost = entryPremium * multiplier * qty;
  const sliceExitValue = validExit ? exitPremium * multiplier * qty : 0;
  const realizedPl = validExit ? (exitPremium - entryPremium) * multiplier * qty : 0;
  const realizedPlPct = validExit && sliceCost > 0 ? (realizedPl / sliceCost) * 100 : 0;
  const childStatus: PaperTrade["status"] =
    reason === "target_hit" ? "WIN"
    : reason === "stop_hit" ? "LOSS"
    : realizedPl > 0 ? "WIN" : realizedPl < 0 ? "LOSS" : "CLOSED";

  async function submit() {
    if (!valid || !trade) return;
    setSubmitting(true);

    // 1) Reduce parent contracts and total_cost proportionally. Cash unchanged here
    //    (trigger only moves cash on INSERT and on status transitions).
    const remainingContracts = totalContracts - qty;
    const remainingTotalCost = entryPremium * multiplier * remainingContracts;
    const remainingValue = (t?.current_premium != null ? Number(t.current_premium) : entryPremium)
      * multiplier * remainingContracts;
    const remainingUnreal = remainingValue - remainingTotalCost;
    const remainingUnrealPct = remainingTotalCost > 0 ? (remainingUnreal / remainingTotalCost) * 100 : 0;

    const { error: parentErr } = await supabase.from("paper_trades").update({
      contracts: remainingContracts,
      total_cost: Number(remainingTotalCost.toFixed(2)),
      current_value: Number(remainingValue.toFixed(2)),
      unrealized_pl: Number(remainingUnreal.toFixed(2)),
      unrealized_pl_pct: Number(remainingUnrealPct.toFixed(2)),
      current_pl: Number(remainingUnreal.toFixed(2)),
      current_pl_pct: Number(remainingUnrealPct.toFixed(2)),
    } as any).eq("id", trade.id);
    if (parentErr) { setSubmitting(false); return toast.error(`Parent update failed: ${parentErr.message}`); }

    // 2) Insert child OPEN row (clones option contract identity from parent).
    //    Trigger debits cash for the slice cost.
    const { data: child, error: insErr } = await supabase.from("paper_trades").insert({
      user_id: trade.user_id,
      signal_id: trade.signal_id as any,
      ticker: trade.ticker,
      direction: trade.direction,
      contract_idea: t?.contract_idea ?? null,
      is_option: true,
      option_type: t?.option_type ?? null,
      strike: t?.strike ?? null,
      expiry: t?.expiry ?? null,
      contracts: qty,
      multiplier,
      entry_premium: Number(entryPremium.toFixed(4)),
      entry_price: Number(entryPremium.toFixed(4)),
      total_cost: Number(sliceCost.toFixed(2)),
      status: "OPEN",
      paper_test_class: (t?.paper_test_class ?? null),
      contract_snapshot_id: t?.contract_snapshot_id ?? null,
      confidence_at_approval: t?.confidence_at_approval ?? null,
      opened_at: trade.opened_at,
    } as any).select("id").maybeSingle();
    if (insErr || !child) {
      // Roll back the parent reduction so the user isn't left in a broken state.
      await supabase.from("paper_trades").update({
        contracts: totalContracts,
        total_cost: Number((entryPremium * multiplier * totalContracts).toFixed(2)),
      } as any).eq("id", trade.id);
      setSubmitting(false);
      return toast.error(`Child insert failed: ${insErr?.message ?? "unknown"}`);
    }

    // 3) Close the child row with exit premium. Trigger credits cash with proceeds.
    const mfe = realizedPl > 0 ? realizedPl : 0;
    const mae = realizedPl < 0 ? realizedPl : 0;
    const { error: closeErr } = await supabase.from("paper_trades").update({
      status: childStatus,
      exit_premium: Number(exitPremium.toFixed(4)),
      exit_price: Number(exitPremium.toFixed(4)),
      realized_pl: Number(realizedPl.toFixed(2)),
      realized_pl_dollars: Number(realizedPl.toFixed(2)),
      realized_pl_pct: Number(realizedPlPct.toFixed(2)),
      current_pl: Number(realizedPl.toFixed(2)),
      current_pl_pct: Number(realizedPlPct.toFixed(2)),
      current_premium: Number(exitPremium.toFixed(4)),
      current_value: Number(sliceExitValue.toFixed(2)),
      unrealized_pl: Number(realizedPl.toFixed(2)),
      unrealized_pl_pct: Number(realizedPlPct.toFixed(2)),
      exit_reason: reason,
      mfe: Number(mfe.toFixed(2)),
      mae: Number(mae.toFixed(2)),
      max_gain: Math.abs(mfe),
      max_drawdown: Math.abs(mae),
      closed_at: new Date().toISOString(),
    } as any).eq("id", child.id);
    setSubmitting(false);
    if (closeErr) return toast.error(`Child close failed: ${closeErr.message}`);

    toast.success(`Closed ${qty} of ${totalContracts} · ${realizedPl >= 0 ? "+" : ""}$${fmtPL(realizedPl)}`);
    onClosed();
  }

  return (
    <Dialog open={!!trade} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Close part of position</DialogTitle>
          <DialogDescription>
            {trade.ticker} {trade.direction} · {totalContracts} open · entry ${fmtPrice(entryPremium)}.
            Closes a slice; rest stays open.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="partial-qty">Contracts to close (1–{totalContracts - 1})</Label>
            <Input
              id="partial-qty" type="number" min={1} max={totalContracts - 1} step={1}
              value={qtyStr} onChange={(e) => setQtyStr(e.target.value)} className="ticker-mono"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="partial-exit">Exit premium ($ per share)</Label>
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                onClick={useLiveMark} disabled={fetchingMark}>
                <RefreshCw className={cn("h-3 w-3 mr-1", fetchingMark && "animate-spin")} />
                {fetchingMark ? "Fetching…" : "Use live mark"}
              </Button>
            </div>
            <Input
              id="partial-exit" type="number" step="0.01" min="0"
              value={exitPremiumStr} onChange={(e) => setExitPremiumStr(e.target.value)}
              className="ticker-mono" placeholder="e.g. 5.10"
            />
            {livePremium != null && (
              <div className="text-[10px] text-muted-foreground ticker-mono">
                Live mark ${fmtPrice(livePremium)}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Close reason</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as CloseReason)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md border border-border bg-card-elevated/40 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Slice cost</span>
              <span className="ticker-mono">${fmtPL(sliceCost)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Slice exit value</span>
              <span className="ticker-mono">${fmtPL(sliceExitValue)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Realized P/L (slice)</span>
              <span className={cn("ticker-mono", realizedPl >= 0 ? "text-bull" : "text-bear")}>
                {realizedPl >= 0 ? "+" : ""}${fmtPL(realizedPl)} ({realizedPlPct >= 0 ? "+" : ""}{realizedPlPct.toFixed(2)}%)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Remaining open</span>
              <span className="ticker-mono">{Math.max(0, totalContracts - (validQty ? qty : 0))} contract(s)</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !valid}>
            {submitting ? "Closing…" : "Close slice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Add more: creates a separate sibling OPEN row at the chosen entry premium.
// Kept as a distinct row so each leg can be closed independently with clean
// cash accounting via the existing INSERT trigger.
// -----------------------------------------------------------------------------
function AddMoreDialog({
  trade, onOpenChange, onAdded,
}: {
  trade: PaperTrade | null;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const t = trade as any;
  const multiplier = Number(t?.multiplier ?? 100);

  const [qtyStr, setQtyStr] = useState("1");
  const [entryStr, setEntryStr] = useState("");
  const [livePremium, setLivePremium] = useState<number | null>(null);
  const [fetchingMark, setFetchingMark] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (trade) {
      setQtyStr("1");
      const seed = t?.current_premium != null
        ? Number(t.current_premium)
        : Number(t?.entry_premium ?? trade.entry_price ?? 0);
      setLivePremium(t?.current_premium != null ? Number(t.current_premium) : null);
      setEntryStr(seed ? String(seed) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade]);

  async function useLiveMark() {
    if (!trade) return;
    setFetchingMark(true);
    try {
      const { error } = await invokeUpdatePaperMarks();
      if (error) { return toast.error(error.message); }
      const { data: fresh } = await supabase
        .from("paper_trades").select("current_premium").eq("id", trade.id).maybeSingle();
      const mark = fresh?.current_premium != null ? Number(fresh.current_premium) : null;
      if (mark == null) return toast.error("No live mark available");
      setLivePremium(mark);
      setEntryStr(String(mark));
      toast.success(`Live mark applied · $${fmtPrice(mark)}`);
    } finally {
      setFetchingMark(false);
    }
  }

  if (!trade) return null;

  const qty = Math.floor(Number(qtyStr));
  const validQty = Number.isFinite(qty) && qty >= 1;
  const entry = Number(entryStr);
  const validEntry = entryStr !== "" && !Number.isNaN(entry) && entry > 0;
  const valid = validQty && validEntry;
  const newCost = valid ? entry * multiplier * qty : 0;

  async function submit() {
    if (!valid || !trade) return;
    setSubmitting(true);
    const { error } = await supabase.from("paper_trades").insert({
      user_id: trade.user_id,
      signal_id: trade.signal_id as any,
      ticker: trade.ticker,
      direction: trade.direction,
      contract_idea: t?.contract_idea ?? null,
      is_option: true,
      option_type: t?.option_type ?? null,
      strike: t?.strike ?? null,
      expiry: t?.expiry ?? null,
      contracts: qty,
      multiplier,
      entry_premium: Number(entry.toFixed(4)),
      entry_price: Number(entry.toFixed(4)),
      current_premium: Number(entry.toFixed(4)),
      total_cost: Number(newCost.toFixed(2)),
      status: "OPEN",
      paper_test_class: t?.paper_test_class ?? null,
      contract_snapshot_id: t?.contract_snapshot_id ?? null,
      confidence_at_approval: t?.confidence_at_approval ?? null,
    } as any);
    setSubmitting(false);
    if (error) return toast.error(error.message);
    toast.success(`Added ${qty} contract${qty === 1 ? "" : "s"} · $${fmtPL(newCost)} cost`);
    onAdded();
  }

  return (
    <Dialog open={!!trade} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to position</DialogTitle>
          <DialogDescription>
            {trade.ticker} {trade.direction} · same contract. Added as a separate leg you can close independently.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-qty">Contracts to add</Label>
            <Input
              id="add-qty" type="number" min={1} step={1}
              value={qtyStr} onChange={(e) => setQtyStr(e.target.value)} className="ticker-mono"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="add-entry">Entry premium ($ per share)</Label>
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                onClick={useLiveMark} disabled={fetchingMark}>
                <RefreshCw className={cn("h-3 w-3 mr-1", fetchingMark && "animate-spin")} />
                {fetchingMark ? "Fetching…" : "Use live mark"}
              </Button>
            </div>
            <Input
              id="add-entry" type="number" step="0.01" min="0"
              value={entryStr} onChange={(e) => setEntryStr(e.target.value)}
              className="ticker-mono" placeholder="e.g. 5.10"
            />
            {livePremium != null && (
              <div className="text-[10px] text-muted-foreground ticker-mono">
                Live mark ${fmtPrice(livePremium)}
              </div>
            )}
          </div>
          <div className="rounded-md border border-border bg-card-elevated/40 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">New cost</span>
              <span className="ticker-mono">${fmtPL(newCost)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              A new OPEN trade row will be created. Existing position is unchanged.
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !valid}>
            {submitting ? "Adding…" : "Add contracts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
