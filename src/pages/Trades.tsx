import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles, Target as TargetIcon, OctagonAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar } from "@/components/Disclaimer";
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
          : <TradeTable trades={open} live onCloseClick={(t) => setClosing(t)} reviews={reviews} onReviewClick={setReviewing} />}
      </Section>

      <Section title="Closed">
        {!trades ? null
          : closed.length === 0 ? <Empty text="No closed trades yet." />
          : <TradeTable trades={closed} reviews={reviews} onReviewClick={setReviewing} />}
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

function TradeTable({
  trades, onCloseClick, reviews, onReviewClick, live,
}: {
  trades: PaperTrade[];
  onCloseClick?: (t: PaperTrade) => void;
  reviews: Record<string, TradeReview>;
  onReviewClick: (t: PaperTrade) => void;
  live?: boolean;
}) {
  return (
    <div className="glass-card overflow-x-auto">
      <table className="min-w-max w-full text-sm whitespace-nowrap">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <Th>Ticker</Th><Th>Dir</Th><Th>Contract</Th><Th className="text-right">Entry</Th>
            <Th className="text-right">{live ? "Mark" : "Exit"}</Th>
            <Th className="text-right">P/L</Th><Th className="text-right">P/L %</Th>
            <Th>{live ? "Signals" : "Reason"}</Th>
            <Th>Status</Th><Th>{live ? "Mark age" : "Opened"}</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const pl = Number(t.current_pl ?? 0);
            const plPct = live
              ? (t.current_pl_pct != null ? Number(t.current_pl_pct) : null)
              : (t.realized_pl_pct != null ? Number(t.realized_pl_pct) : null);
            const tint = live && t.last_mark_at
              ? (pl > 0 ? "bg-bull/[0.04]" : pl < 0 ? "bg-bear/[0.04]" : "")
              : "";
            const touched = live ? targetStopTouched(t) : null;
            return (
              <tr key={t.id} className={cn("border-b border-border/60 last:border-0 transition-colors hover:bg-card-elevated/60", tint)}>
                <Td className="ticker-mono font-semibold">{t.ticker}</Td>
                <Td>
                  <Badge className={cn("border-0", t.direction === "CALL" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear")}>
                    {t.direction}
                  </Badge>
                </Td>
                <Td className="ticker-mono text-muted-foreground">{t.contract_idea ?? "—"}</Td>
                <Td className="text-right ticker-mono">${fmtPrice(Number(t.entry_price))}</Td>
                <Td className="text-right ticker-mono text-muted-foreground">
                  {live
                    ? (t.last_mark_price != null ? `$${fmtPrice(Number(t.last_mark_price))}` : "—")
                    : (t.exit_price != null ? `$${fmtPrice(Number(t.exit_price))}` : "—")}
                </Td>
                <Td className={cn("text-right ticker-mono", pl >= 0 ? "text-bull" : "text-bear")}>
                  ${fmtPL(pl)}
                </Td>
                <Td className={cn("text-right ticker-mono", (plPct ?? 0) >= 0 ? "text-bull" : "text-bear")}>
                  {plPct != null ? `${plPct.toFixed(1)}%` : "—"}
                </Td>
                <Td className="text-xs">
                  {live ? (
                    touched ? <TouchedBadge kind={touched} /> : <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="text-muted-foreground">{t.exit_reason ? reasonLabel(t.exit_reason) : "—"}</span>
                  )}
                </Td>
                <Td><StatusBadge status={t.status} /></Td>
                <Td className="text-muted-foreground whitespace-nowrap">
                  {live
                    ? (t.last_mark_at ? timeAgo(t.last_mark_at as string) : <span className="opacity-60">no mark yet</span>)
                    : timeAgo(t.opened_at)}
                </Td>
                <Td className="text-right whitespace-nowrap space-x-1">
                  {onCloseClick ? (
                    <Button size="sm" variant="ghost" onClick={() => onCloseClick(t)}>Close…</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => onReviewClick(t)}>
                      <Sparkles className="h-4 w-4 mr-1" />
                      {reviews[t.id] ? "Review" : "Review trade"}
                    </Button>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function targetStopTouched(t: PaperTrade): "target" | "stop" | null {
  const mark = t.last_mark_price != null ? Number(t.last_mark_price) : null;
  if (mark == null) return null;
  const entry = Number(t.entry_price ?? 0);
  if (!entry) return null;
  const dir = t.direction === "CALL" ? 1 : -1;
  const move = (mark - entry) * dir; // signed favorable price move

  // The stop/target ideas are stored as option premium-style numbers in Phase 4E,
  // but for live mark we compare against the favorable price move vs entry.
  // Target idea / stop idea are interpreted as required favorable / unfavorable
  // price move in same units as entry_price (best-effort heuristic).
  const target = t.target_idea != null ? Number(t.target_idea) : null;
  const stop = t.stop_idea != null ? Number(t.stop_idea) : null;

  // Heuristic: target_idea > entry means absolute price target; otherwise treat as % of entry.
  if (target != null) {
    const targetMove = target > entry ? (target - entry) : entry * (target / 100);
    if (move >= Math.max(0.01, targetMove)) return "target";
  }
  if (stop != null) {
    const stopMove = stop < entry && stop > 0 ? (entry - stop) : entry * (stop / 100);
    if (-move >= Math.max(0.01, stopMove)) return "stop";
  }
  return null;
}

function TouchedBadge({ kind }: { kind: "target" | "stop" }) {
  if (kind === "target") {
    return (
      <Badge className="bg-bull/15 text-bull border-0 gap-1">
        <TargetIcon className="h-3 w-3" /> Target touched
      </Badge>
    );
  }
  return (
    <Badge className="bg-bear/15 text-bear border-0 gap-1">
      <OctagonAlert className="h-3 w-3" /> Stop touched
    </Badge>
  );
}

const Th = ({ children, className }: any) => <th className={cn("px-3 py-2 text-left font-medium", className)}>{children}</th>;
const Td = ({ children, className }: any) => <td className={cn("px-3 py-3", className)}>{children}</td>;

function StatusBadge({ status }: { status: PaperTrade["status"] }) {
  const m: Record<string, string> = {
    OPEN: "bg-info/15 text-info",
    WIN: "bg-bull/15 text-bull",
    LOSS: "bg-bear/15 text-bear",
    CLOSED: "bg-muted text-muted-foreground",
  };
  return <Badge className={cn("border-0", m[status])}>{status}</Badge>;
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
  const [exitPrice, setExitPrice] = useState("");
  const [reason, setReason] = useState<CloseReason>("manual_close");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (trade) {
      setExitPrice(trade.entry_price != null ? String(trade.entry_price) : "");
      setReason("manual_close");
    }
  }, [trade]);

  if (!trade) return null;

  const entry = Number(trade.entry_price ?? 0);
  const exit = Number(exitPrice);
  const dir = trade.direction === "CALL" ? 1 : -1;
  const moveAbs = entry > 0 && !Number.isNaN(exit) ? (exit - entry) * dir : 0;
  const movePct = entry > 0 && !Number.isNaN(exit) ? (moveAbs / entry) * 100 : 0;
  const risk = Number(trade.risk_amount ?? 0);
  // Approximate realized P/L $ using risk_amount as position size proxy.
  const realizedPl = risk > 0 ? (moveAbs / entry) * risk * 2 : moveAbs;
  const status: PaperTrade["status"] =
    reason === "target_hit" ? "WIN"
    : reason === "stop_hit" ? "LOSS"
    : moveAbs > 0 ? "WIN" : moveAbs < 0 ? "LOSS" : "CLOSED";

  async function submit() {
    if (!exitPrice || Number.isNaN(exit)) {
      toast.error("Enter a valid exit price");
      return;
    }
    setSubmitting(true);
    // Defer real intra-trade MFE/MAE to Phase 4F — use close-time realized move.
    const mfe = moveAbs > 0 ? moveAbs : 0;
    const mae = moveAbs < 0 ? moveAbs : 0;
    const { error } = await supabase.from("paper_trades").update({
      status,
      exit_price: exit,
      exit_reason: reason,
      current_pl: Number(realizedPl.toFixed(2)),
      realized_pl_pct: Number(movePct.toFixed(2)),
      mfe: Number(mfe.toFixed(2)),
      mae: Number(mae.toFixed(2)),
      max_gain: Math.abs(mfe),
      max_drawdown: Math.abs(mae),
      closed_at: new Date().toISOString(),
    }).eq("id", trade!.id);
    setSubmitting(false);
    if (error) return toast.error(error.message);
    toast.success(`Trade closed: ${status}`);
    onClosed();
  }

  return (
    <Dialog open={!!trade} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Close paper trade</DialogTitle>
          <DialogDescription>
            {trade.ticker} {trade.direction} · entry ${fmtPrice(entry)}. Educational only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="exit-price">Exit price</Label>
            <Input
              id="exit-price"
              type="number"
              step="0.01"
              value={exitPrice}
              onChange={(e) => setExitPrice(e.target.value)}
              className="ticker-mono"
            />
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
              <span className="text-muted-foreground">Move</span>
              <span className={cn("ticker-mono", moveAbs >= 0 ? "text-bull" : "text-bear")}>
                {moveAbs >= 0 ? "+" : ""}{moveAbs.toFixed(2)} ({movePct.toFixed(2)}%)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Realized P/L (approx)</span>
              <span className={cn("ticker-mono", realizedPl >= 0 ? "text-bull" : "text-bear")}>
                ${fmtPL(realizedPl)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Outcome</span>
              <span className="ticker-mono">{status}</span>
            </div>
            <div className="text-[10px] text-muted-foreground pt-1">
              MFE/MAE recorded at close. Live intra-trade tracking arrives in Phase 4F.
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
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
