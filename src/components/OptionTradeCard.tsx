// Robinhood-style paper option trade card.
// Renders a single option trade with entry/current/market value, P/L $ and %,
// Greeks line, and clear "Paper · Simulation Only" safety badges.
//
// When a contract_snapshot_id is present, a collapsible "Why this contract"
// section lazily fetches and renders the Contract Selection Engine rationale.
//
// Pure presentation — no mutations.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Sparkles, TrendingDown } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { fmtPrice, fmtPL, timeAgo, type PaperTrade } from "@/lib/signalHelpers";
import { cn } from "@/lib/utils";
import { TradeTimelinePanel } from "@/components/TradeTimelinePanel";
import { computeExitScore, dteFromExpiry, bandColor, type ExitScore } from "@/lib/exitScore";

type Props = {
  trade: PaperTrade;
  onClose?: (t: PaperTrade) => void;
  onClosePartial?: (t: PaperTrade) => void;
  onAddMore?: (t: PaperTrade) => void;
  onReview?: (t: PaperTrade) => void;
  hasReview?: boolean;
  live?: boolean; // open vs closed view
};

const PL_MODE_KEY = "paper:plMode"; // "dollar" | "percent"

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtExpiry(d: string | null | undefined): string {
  if (!d) return "—";
  // d is "YYYY-MM-DD"
  const [y, m, day] = d.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !day) return d;
  return `${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(y).slice(2)}`;
}

function optionLabel(t: PaperTrade): string {
  const type = String((t as any).option_type ?? t.direction ?? "").toUpperCase() === "PUT" ? "Put" : "Call";
  const strike = (t as any).strike;
  const strikeStr = strike != null ? `$${Number(strike).toFixed(2).replace(/\.00$/, "")}` : "";
  return `${t.ticker} ${strikeStr} ${type} ${fmtExpiry((t as any).expiry)}`.trim();
}

export function OptionTradeCard({ trade, onClose, onClosePartial, onAddMore, onReview, hasReview, live }: Props) {
  const t = trade as any;
  const closedTrade = trade.status !== "OPEN";
  const hasClosedPricing = closedTrade && (t.exit_premium != null || t.realized_pl != null);
  const contracts = Number(t.contracts ?? 1);
  const multiplier = Number(t.multiplier ?? 100);
  const entryPremium = Number(t.entry_premium ?? trade.entry_price ?? 0);
  const totalCost = Number(t.total_cost ?? entryPremium * multiplier * contracts);

  const closed = trade.status !== "OPEN";
  const exitPremium = t.exit_premium != null ? Number(t.exit_premium) : null;
  const livePremium = closed && exitPremium != null
    ? exitPremium
    : (t.current_premium != null ? Number(t.current_premium) : null);
  const currentPremium = !closed && livePremium == null ? entryPremium : livePremium;

  const currentValue = currentPremium != null ? currentPremium * multiplier * contracts : null;
  const pl = closed
    ? (t.realized_pl != null ? Number(t.realized_pl)
       : exitPremium != null ? (exitPremium - entryPremium) * multiplier * contracts : null)
    : (t.unrealized_pl != null ? Number(t.unrealized_pl)
       : currentValue != null ? currentValue - totalCost : null);
  const plPct = pl != null && totalCost > 0 ? (pl / totalCost) * 100 : null;
  const quoteUnavailable = !closed && t.quote_source === "unavailable" && livePremium == null;
  const waitingForFirstQuote = !closed && livePremium == null && !quoteUnavailable;

  const dayPl = !closed && t.day_pl != null ? Number(t.day_pl) : null;
  const dayPlPct = !closed && t.day_pl_pct != null ? Number(t.day_pl_pct) : null;

  const isWin = (pl ?? 0) > 0;
  const isLoss = (pl ?? 0) < 0;
  const tint = isWin ? "border-bull/30 bg-bull/[0.03]" : isLoss ? "border-bear/30 bg-bear/[0.03]" : "border-border";

  // Live flash: when current_premium changes on an open trade, briefly tint the headline.
  const prevPremiumRef = useRef<number | null>(currentPremium);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (closed) return;
    const prev = prevPremiumRef.current;
    if (prev != null && currentPremium != null && currentPremium !== prev) {
      setFlash(currentPremium > prev ? "up" : "down");
      const id = setTimeout(() => setFlash(null), 900);
      prevPremiumRef.current = currentPremium;
      return () => clearTimeout(id);
    }
    prevPremiumRef.current = currentPremium;
  }, [currentPremium, closed]);
  // P/L display mode — persisted across cards via localStorage.
  const [plMode, setPlMode] = useState<"dollar" | "percent">(() => {
    if (typeof window === "undefined") return "dollar";
    return (window.localStorage.getItem(PL_MODE_KEY) as "dollar" | "percent") || "dollar";
  });
  function togglePlMode() {
    const next = plMode === "dollar" ? "percent" : "dollar";
    setPlMode(next);
    try { window.localStorage.setItem(PL_MODE_KEY, next); } catch { /* ignore */ }
    try { window.dispatchEvent(new StorageEvent("storage", { key: PL_MODE_KEY, newValue: next })); } catch { /* ignore */ }
  }
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === PL_MODE_KEY && e.newValue) setPlMode(e.newValue as "dollar" | "percent");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);


  // Watch linked trade_alert for terminal lifecycle hints (target/stop/expire).
  // Auto-close is OFF — we only surface a "consider closing" banner so the user
  // can decide when to manually exit.
  const [alertHint, setAlertHint] = useState<
    | { kind: "target" | "stop" | "expired"; label: string }
    | null
  >(null);
  const [alertStatusRaw, setAlertStatusRaw] = useState<string | null>(null);
  useEffect(() => {
    if (closed) { setAlertHint(null); setAlertStatusRaw(null); return; }
    let cancelled = false;
    async function load() {
      const { data } = await (supabase as any)
        .from("trade_alerts")
        .select("alert_status")
        .eq("paper_trade_id", trade.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const s = data?.alert_status as string | undefined;
      setAlertStatusRaw(s ?? null);
      if (s === "hit_t3" || s === "hit_t2" || s === "hit_t1") {
        setAlertHint({ kind: "target", label: s === "hit_t3" ? "Target 3 hit" : s === "hit_t2" ? "Target 2 hit" : "Target 1 hit" });
      } else if (s === "stopped") {
        setAlertHint({ kind: "stop", label: "Stop level breached" });
      } else if (s === "expired") {
        setAlertHint({ kind: "expired", label: "Plan expired" });
      } else {
        setAlertHint(null);
      }
    }
    load();
    // Realtime: react to alert updates for this paper_trade.
    const ch = supabase
      .channel(`alert_for_trade_${trade.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "trade_alerts", filter: `paper_trade_id=eq.${trade.id}` },
        () => { load(); },
      )
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, [trade.id, closed]);

  // ---- Exit Score engine -------------------------------------------------
  // Tracks trailing peak + last marks per trade in refs (no re-renders).
  const peakRef = useRef<number | null>(null);
  const marksRef = useRef<number[]>([]);
  const lastToastAtRef = useRef<number>(0);
  const [exitScore, setExitScore] = useState<ExitScore | null>(null);

  useEffect(() => {
    if (closed || currentPremium == null) return;
    // Update peak
    peakRef.current = peakRef.current == null
      ? currentPremium
      : Math.max(peakRef.current, currentPremium);
    // Update recent marks (keep last 5)
    const last = marksRef.current[marksRef.current.length - 1];
    if (last !== currentPremium) {
      marksRef.current = [...marksRef.current, currentPremium].slice(-5);
    }
    const optType = (String(t.option_type ?? trade.direction ?? "").toUpperCase() === "PUT" ? "PUT" : "CALL") as "CALL" | "PUT";
    const score = computeExitScore({
      optionType: optType,
      entryPremium,
      currentPremium,
      peakPremium: peakRef.current,
      recentMarks: marksRef.current,
      plPct,
      dte: dteFromExpiry(t.expiry),
      theta: t.theta != null ? Number(t.theta) : null,
      alertStatus: alertStatusRaw,
    });
    setExitScore(score);

    // Toast on EXIT band, with 30-min per-trade cooldown
    if (score.band === "EXIT") {
      const now = Date.now();
      const cooldownMs = 30 * 60 * 1000;
      if (now - lastToastAtRef.current >= cooldownMs) {
        lastToastAtRef.current = now;
        toast.warning(`${trade.ticker}: ${score.headline}`, {
          description: `Exit Score ${score.score}/100 · ${contracts} contract${contracts === 1 ? "" : "s"}`,
          duration: 8000,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPremium, alertStatusRaw, closed]);



  return (
    <div className={cn("glass-card border p-4 space-y-3 transition-colors", tint)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-semibold ticker-mono leading-tight">{optionLabel(trade)}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {contracts} contract{contracts === 1 ? "" : "s"} · {multiplier}× multiplier
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {!closed && exitScore && (
            <Badge
              className={cn(
                "border text-[10px] uppercase tracking-wider",
                bandColor(exitScore.band).bg,
                bandColor(exitScore.band).text,
                bandColor(exitScore.band).border,
                exitScore.band === "EXIT" && "animate-pulse",
              )}
              title={exitScore.headline}
            >
              Exit {exitScore.score}
            </Badge>
          )}
          {!closed && (
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bull/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-bull" />
              </span>
              Live
            </span>
          )}
          <Badge className={cn("border-0 text-[10px]", closed ? "bg-muted text-muted-foreground" : "bg-info/15 text-info")}>
            {trade.status}
          </Badge>
        </div>

      </div>

      {/* Safety banner */}
      <div className="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wider">
        <Badge className="bg-warn/15 text-warn border-0">Paper Option Trade</Badge>
        <Badge variant="outline" className="bg-transparent text-muted-foreground">Simulation Only</Badge>
        <Badge variant="outline" className="bg-transparent text-muted-foreground">No real money executed</Badge>
      </div>

      {/* Consider-closing hint when linked alert hits terminal state. Manual close only. */}
      {!closed && alertHint && (
        <div
          className={cn(
            "rounded-md border p-2.5 flex items-start gap-2 text-xs",
            alertHint.kind === "target" && "border-bull/40 bg-bull/10 text-bull",
            alertHint.kind === "stop" && "border-bear/40 bg-bear/10 text-bear",
            alertHint.kind === "expired" && "border-warn/40 bg-warn/10 text-warn",
          )}
        >
          <span className="font-semibold">{alertHint.label}</span>
          <span className="opacity-80">— consider closing manually.</span>
        </div>
      )}

      {/* Exit Score panel */}
      {!closed && exitScore && <ExitScorePanel score={exitScore} />}




      <>
          {/* Robinhood-style headline — click to toggle $ / % */}
          <div className="pt-1">
            <button
              type="button"
              onClick={togglePlMode}
              title={`Show ${plMode === "dollar" ? "percent" : "dollar"} P/L`}
              className={cn(
                "text-2xl font-semibold ticker-mono transition-colors duration-700 rounded px-1 -mx-1 block text-left hover:bg-card-elevated/40",
                isWin ? "text-bull" : isLoss ? "text-bear" : "text-foreground",
                flash === "up" && "bg-bull/15",
                flash === "down" && "bg-bear/15",
              )}
            >
              {plMode === "dollar"
                ? (pl == null ? "—" : `${pl >= 0 ? "+" : ""}$${fmtPL(pl)}`)
                : (plPct == null ? "—" : `${plPct >= 0 ? "+" : ""}${plPct.toFixed(2)}%`)}
            </button>
            <div className={cn("text-sm ticker-mono", isWin ? "text-bull" : isLoss ? "text-bear" : "text-muted-foreground")}>
              {plMode === "dollar"
                ? (plPct == null ? "—" : `${plPct >= 0 ? "+" : ""}${plPct.toFixed(2)}%`)
                : (pl == null ? "—" : `${pl >= 0 ? "+" : ""}$${fmtPL(pl)}`)}
              {closed && <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">realized</span>}
            </div>
            {!closed && dayPl != null && (
              <div className="text-[11px] text-muted-foreground mt-1">
                Today:{" "}
                <span className={cn("ticker-mono", dayPl >= 0 ? "text-bull" : "text-bear")}>
                  {dayPl >= 0 ? "+" : ""}${fmtPL(dayPl)}
                </span>
                {dayPlPct != null && (
                  <span className={cn("ticker-mono ml-1", dayPl >= 0 ? "text-bull" : "text-bear")}>
                    ({dayPlPct >= 0 ? "+" : ""}{dayPlPct.toFixed(2)}%)
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Detail grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Row k="Entry" v={`$${fmtPrice(entryPremium)}`} />
            <Row k={closed ? "Exit" : "Current"} v={currentPremium != null ? `$${fmtPrice(currentPremium)}` : "—"} />
            <Row k="Market Value" v={currentValue != null ? `$${fmtPL(currentValue)}` : "—"} />
            <Row k="Total Cost" v={`$${fmtPL(totalCost)}`} />
          </div>

          {!closed && (quoteUnavailable || waitingForFirstQuote) && (
            <div className="rounded-md border border-dashed border-border bg-card-elevated/40 p-2.5 text-[11px] text-muted-foreground">
              {quoteUnavailable
                ? "Live quote unavailable right now — showing entry premium until UW returns a mark."
                : "Waiting for the first live quote — current P/L is seeded from your entry premium."}
            </div>
          )}

          {/* Quote / Greeks line */}
          {(t.bid != null || t.ask != null || t.iv != null || t.delta != null) && !closed && (
            <div className="text-[11px] text-muted-foreground border-t border-border/50 pt-2 flex flex-wrap gap-x-3 gap-y-0.5 ticker-mono">
              {t.bid != null && <span>Bid {Number(t.bid).toFixed(2)}</span>}
              {t.ask != null && <span>Ask {Number(t.ask).toFixed(2)}</span>}
              {t.iv != null && <span>IV {(Number(t.iv) * (Number(t.iv) <= 5 ? 100 : 1)).toFixed(1)}%</span>}
              {t.delta != null && <span>Δ {Number(t.delta).toFixed(2)}</span>}
              {t.theta != null && <span>Θ {Number(t.theta).toFixed(3)}</span>}
              {t.gamma != null && <span>Γ {Number(t.gamma).toFixed(3)}</span>}
              {t.vega != null && <span>V {Number(t.vega).toFixed(3)}</span>}
              {t.open_interest != null && <span>OI {Number(t.open_interest).toLocaleString()}</span>}
              {t.option_volume != null && <span>Vol {Number(t.option_volume).toLocaleString()}</span>}
            </div>
          )}
      </>

      {/* Why this contract — Contract Selection Engine rationale */}
      {t.contract_snapshot_id && <RationalePanel snapshotId={t.contract_snapshot_id as string} />}

      {/* Status timeline — lifecycle events from trade_alerts */}
      <TradeTimelinePanel trade={trade} />




      {/* Footer meta */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1">
        <span>
          {closed
            ? `Closed ${trade.closed_at ? timeAgo(trade.closed_at as string) : "—"}`
            : quoteUnavailable
              ? "Live quote unavailable · showing entry premium"
              : waitingForFirstQuote
                ? "Waiting for first live quote"
            : t.quote_updated_at
              ? `Quote ${timeAgo(t.quote_updated_at as string)} · ${t.quote_source ?? "—"}`
              : "No mark yet"}
        </span>
        <span className="opacity-70">Opened {timeAgo(trade.opened_at)}</span>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap justify-end gap-1 pt-1">
        {live && onAddMore && (
          <Button size="sm" variant="outline" className="bg-transparent" onClick={() => onAddMore(trade)}>
            Add more
          </Button>
        )}
        {live && onClosePartial && contracts > 1 && (
          <Button size="sm" variant="outline" className="bg-transparent" onClick={() => onClosePartial(trade)}>
            Close partial
          </Button>
        )}
        {live && onClose && (
          <Button size="sm" variant="outline" className="bg-transparent" onClick={() => onClose(trade)}>
            Close all
          </Button>
        )}
        {!live && onReview && (
          <Button size="sm" variant="ghost" onClick={() => onReview(trade)}>
            <Sparkles className="h-4 w-4 mr-1" />
            {hasReview ? "Review" : "Review trade"}
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="text-muted-foreground">{k}</div>
      <div className="text-right ticker-mono">{v}</div>
    </>
  );
}

type Snapshot = {
  contract_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  delta: number | null;
  spread_pct: number | null;
  open_interest: number | null;
  volume: number | null;
  iv: number | null;
  contract_score: number | null;
  liquidity_score: number | null;
  rationale: string | null;
  rationale_factors: Record<string, number> | null;
  contract_source: string | null;
  risk_profile: string | null;
  candidates_considered: number | null;
  selection_mode: string | null;
  below_band: boolean | null;
  warning: string | null;
};

function RationalePanel({ snapshotId }: { snapshotId: string }) {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from("contract_selection_snapshots")
        .select("contract_symbol,strike,expiry,dte,delta,spread_pct,open_interest,volume,iv,contract_score,liquidity_score,rationale,rationale_factors,contract_source,risk_profile,candidates_considered,selection_mode,below_band,warning")
        .eq("id", snapshotId)
        .maybeSingle();
      if (!cancelled) {
        setSnap((data ?? null) as Snapshot | null);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open, loaded, snapshotId]);

  const isBestEffort = snap?.selection_mode === "best_effort" || snap?.below_band === true;

  return (
    <div className="border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="uppercase tracking-wider flex items-center gap-1.5">
          Why this contract
          {loaded && snap && (
            <Badge
              className={cn(
                "border-0 text-[9px] uppercase tracking-wider",
                isBestEffort ? "bg-warn/15 text-warn" : "bg-info/15 text-info",
              )}
            >
              {isBestEffort ? "Best Effort" : "Normal"}
            </Badge>
          )}
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {!loaded && <div className="text-[11px] text-muted-foreground">Loading…</div>}
          {loaded && !snap && <div className="text-[11px] text-muted-foreground">No rationale stored.</div>}
          {snap && (
            <>
              {isBestEffort && (
                <div className="rounded-md border border-warn/40 bg-warn/10 p-2 flex gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-warn flex-shrink-0 mt-0.5" />
                  <div className="text-[11px] text-warn leading-snug">
                    <div className="font-medium">Below Preferred Contract Band</div>
                    <div className="text-warn/90 mt-0.5">
                      {snap.warning ??
                        "This contract was selected because no candidate met all preferred liquidity and spread requirements. Review before approval."}
                    </div>
                  </div>
                </div>
              )}
              <div className="text-[11px] text-foreground/90 leading-relaxed">{snap.rationale ?? "—"}</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] ticker-mono text-muted-foreground">
                <span>Score {snap.contract_score ?? "—"}/100</span>
                <span className="text-right">Liquidity {snap.liquidity_score ?? "—"}/100</span>
                {snap.spread_pct != null && <span>Spread {Number(snap.spread_pct).toFixed(1)}%</span>}
                {snap.dte != null && <span className="text-right">DTE {snap.dte}</span>}
                {snap.delta != null && <span>Δ {Number(snap.delta).toFixed(2)}</span>}
                {snap.iv != null && <span className="text-right">IV {((Number(snap.iv) <= 5 ? Number(snap.iv) * 100 : Number(snap.iv))).toFixed(1)}%</span>}
                {snap.open_interest != null && <span>OI {Number(snap.open_interest).toLocaleString()}</span>}
                {snap.volume != null && <span className="text-right">Vol {Number(snap.volume).toLocaleString()}</span>}
              </div>
              {snap.rationale_factors && Object.keys(snap.rationale_factors).length > 0 && (
                <div className="space-y-1 pt-1">
                  {Object.entries(snap.rationale_factors).map(([k, v]) => (
                    <FactorBar key={k} label={k.replace(/_/g, " ")} value={Number(v)} />
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1">
                <span>Source: {snap.contract_source ?? "—"}</span>
                {snap.risk_profile && <span>Profile: {snap.risk_profile}</span>}
                {snap.candidates_considered != null && <span>{snap.candidates_considered} candidates</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FactorBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-24 capitalize text-muted-foreground">{label}</span>
      <div className="flex-1 h-1.5 bg-card-elevated rounded overflow-hidden">
        <div className="h-full bg-primary/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right ticker-mono text-muted-foreground">{Math.round(pct)}</span>
    </div>
  );
}

function ExitScorePanel({ score }: { score: ExitScore }) {
  const [open, setOpen] = useState(false);
  const c = bandColor(score.band);
  return (
    <div className={cn("rounded-md border", c.border, c.bg)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-xs"
      >
        <span className="flex items-center gap-2">
          <TrendingDown className={cn("h-3.5 w-3.5", c.text)} />
          <span className={cn("font-semibold uppercase tracking-wider", c.text)}>
            Exit Score {score.score} · {score.band}
          </span>
          <span className="text-muted-foreground hidden sm:inline">— {score.headline}</span>
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", c.text, open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-1.5">
          {score.hardTrigger ? (
            <div className="text-[11px] text-muted-foreground">
              Hard trigger fired — {score.headline}.
            </div>
          ) : score.factors.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No factor data yet.</div>
          ) : (
            score.factors.map((f) => (
              <FactorBar key={f.key} label={f.label} value={f.value} />
            ))
          )}
          <div className="text-[10px] text-muted-foreground pt-1">
            Signal only — you decide when to close. Re-fires every 30 min while ≥75.
          </div>
        </div>
      )}
    </div>
  );
}
