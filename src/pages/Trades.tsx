import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
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
  const [reviewing, setReviewing] = useState<PaperTrade | null>(null);
  const [refreshingMarks, setRefreshingMarks] = useState(false);
  const refreshRef = useRef<() => Promise<void>>();

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

  // Auto-refresh every 60s while page is mounted, only if there are open trades and tab visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshRef.current?.();
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  async function refreshMarks() {
    setRefreshingMarks(true);
    const { data, error } = await supabase.functions.invoke("update-paper-marks", { body: {} });
    setRefreshingMarks(false);
    if (error) return toast.error(error.message);
    const updated = (data as any)?.updated ?? 0;
    toast.success(`Marks refreshed · ${updated} trade${updated === 1 ? "" : "s"} updated`);
    refresh();
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
      <ReviewDialog
        trade={reviewing}
        cached={reviewing ? reviews[reviewing.id] : undefined}
        onOpenChange={(v) => !v && setReviewing(null)}
        onSaved={(r) => setReviews((m) => ({ ...m, [r.trade_id]: r }))}
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
  const currentPremium = t?.current_premium != null ? Number(t.current_premium) : null;

  const [exitPremiumStr, setExitPremiumStr] = useState("");
  const [reason, setReason] = useState<CloseReason>("manual_close");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (trade) {
      // Default exit premium to the latest mark, falling back to entry premium.
      const seed = currentPremium ?? entryPremium;
      setExitPremiumStr(seed ? String(seed) : "");
      setReason("manual_close");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade]);

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
            <Label htmlFor="exit-premium">Exit option premium ($ per share)</Label>
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
            <p className="text-[10px] text-muted-foreground">
              Realized P/L = (exit − entry) × 100 × contracts
            </p>
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
