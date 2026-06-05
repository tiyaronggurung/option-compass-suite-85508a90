// Robinhood-style paper option trade card.
// Renders a single option trade with entry/current/market value, P/L $ and %,
// Greeks line, and clear "Paper · Simulation Only" safety badges.
//
// When a contract_snapshot_id is present, a collapsible "Why this contract"
// section lazily fetches and renders the Contract Selection Engine rationale.
//
// Pure presentation — no mutations.

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { fmtPrice, fmtPL, timeAgo, type PaperTrade } from "@/lib/signalHelpers";
import { cn } from "@/lib/utils";

type Props = {
  trade: PaperTrade;
  onClose?: (t: PaperTrade) => void;
  onReview?: (t: PaperTrade) => void;
  hasReview?: boolean;
  live?: boolean; // open vs closed view
};

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

export function OptionTradeCard({ trade, onClose, onReview, hasReview, live }: Props) {
  const t = trade as any;
  const closedTrade = trade.status !== "OPEN";
  const hasClosedPricing = closedTrade && (t.exit_premium != null || t.realized_pl != null);
  const unavailable = !hasClosedPricing && (
    t.quote_source === "unavailable" ||
    (live && t.current_premium == null && t.exit_premium == null)
  );
  const contracts = Number(t.contracts ?? 1);
  const multiplier = Number(t.multiplier ?? 100);
  const entryPremium = Number(t.entry_premium ?? trade.entry_price ?? 0);
  const totalCost = Number(t.total_cost ?? entryPremium * multiplier * contracts);

  const closed = trade.status !== "OPEN";
  const exitPremium = t.exit_premium != null ? Number(t.exit_premium) : null;
  const currentPremium = closed && exitPremium != null
    ? exitPremium
    : (t.current_premium != null ? Number(t.current_premium) : null);

  const currentValue = currentPremium != null ? currentPremium * multiplier * contracts : null;
  const pl = closed
    ? (t.realized_pl != null ? Number(t.realized_pl)
       : exitPremium != null ? (exitPremium - entryPremium) * multiplier * contracts : null)
    : (t.unrealized_pl != null ? Number(t.unrealized_pl)
       : currentValue != null ? currentValue - totalCost : null);
  const plPct = pl != null && totalCost > 0 ? (pl / totalCost) * 100 : null;

  const dayPl = !closed && t.day_pl != null ? Number(t.day_pl) : null;
  const dayPlPct = !closed && t.day_pl_pct != null ? Number(t.day_pl_pct) : null;

  const isWin = (pl ?? 0) > 0;
  const isLoss = (pl ?? 0) < 0;
  const tint = isWin ? "border-bull/30 bg-bull/[0.03]" : isLoss ? "border-bear/30 bg-bear/[0.03]" : "border-border";

  return (
    <div className={cn("glass-card border p-4 space-y-3 transition-colors", tint)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-semibold ticker-mono leading-tight">{optionLabel(trade)}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {contracts} contract{contracts === 1 ? "" : "s"} · {multiplier}× multiplier
          </div>
        </div>
        <Badge className={cn("border-0 text-[10px]", closed ? "bg-muted text-muted-foreground" : "bg-info/15 text-info")}>
          {trade.status}
        </Badge>
      </div>

      {/* Safety banner */}
      <div className="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wider">
        <Badge className="bg-warn/15 text-warn border-0">Paper Option Trade</Badge>
        <Badge variant="outline" className="bg-transparent text-muted-foreground">Simulation Only</Badge>
        <Badge variant="outline" className="bg-transparent text-muted-foreground">No real money executed</Badge>
      </div>

      {unavailable ? (
        <div className="rounded-md border border-dashed border-border bg-card-elevated/40 p-3 text-center">
          <div className="text-sm font-medium text-muted-foreground">Pricing unavailable</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            No option quote source returned a premium. P/L not computed.
          </div>
        </div>
      ) : (
        <>
          {/* Robinhood-style headline */}
          <div className="pt-1">
            <div className={cn("text-2xl font-semibold ticker-mono", isWin ? "text-bull" : isLoss ? "text-bear" : "text-foreground")}>
              {pl == null ? "—" : `${pl >= 0 ? "+" : ""}$${fmtPL(pl)}`}
            </div>
            <div className={cn("text-sm ticker-mono", isWin ? "text-bull" : isLoss ? "text-bear" : "text-muted-foreground")}>
              {plPct == null ? "—" : `${plPct >= 0 ? "+" : ""}${plPct.toFixed(2)}%`}
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
      )}

      {/* Why this contract — Contract Selection Engine rationale */}
      {t.contract_snapshot_id && <RationalePanel snapshotId={t.contract_snapshot_id as string} />}

      {/* Status timeline — lifecycle events from trade_alerts */}
      <TradeTimelinePanel trade={trade} />




      {/* Footer meta */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1">
        <span>
          {closed
            ? `Closed ${trade.closed_at ? timeAgo(trade.closed_at as string) : "—"}`
            : t.quote_updated_at
              ? `Quote ${timeAgo(t.quote_updated_at as string)} · ${t.quote_source ?? "—"}`
              : "No mark yet"}
        </span>
        <span className="opacity-70">Opened {timeAgo(trade.opened_at)}</span>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-1 pt-1">
        {live && onClose && (
          <Button size="sm" variant="outline" className="bg-transparent" onClick={() => onClose(trade)}>
            Close…
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
