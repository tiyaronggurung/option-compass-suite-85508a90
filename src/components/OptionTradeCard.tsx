// Robinhood-style paper option trade card.
// Renders a single option trade with entry/current/market value, P/L $ and %,
// Greeks line, and clear "Paper · Simulation Only" safety badges.
//
// When a contract_snapshot_id is present, a collapsible "Why this contract"
// section lazily fetches and renders the Contract Selection Engine rationale.
//
// Pure presentation — no mutations.

import { useEffect, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
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
  const unavailable = t.quote_source === "unavailable" || (live && t.current_premium == null && t.exit_premium == null);
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
