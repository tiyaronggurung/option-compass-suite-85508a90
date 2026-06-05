// TradeAlertCard — surfaces the full V1.2 trade plan for an approved signal.
// Status badge + underlying trigger + entry zone + stop + T1/T2/T3 +
// invalidation + confidence + rationale. Pure presentation.
//
// Paper-only. Reads from public.trade_alerts.

import { AlertTriangle, Target, Crosshair, Shield, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";

export type TradeAlert = {
  id: string;
  user_id: string;
  signal_id: string;
  paper_trade_id: string | null;
  contract_snapshot_id: string | null;
  ticker: string;
  option_side: "call" | "put";
  strike: number | null;
  expiry: string | null;
  contract_symbol: string | null;
  underlying_trigger_price: number | null;
  trigger_direction: "above" | "below" | null;
  entry_contract_price_min: number | null;
  entry_contract_price_max: number | null;
  stop_loss_contract_price: number | null;
  target_1_contract_price: number | null;
  target_2_contract_price: number | null;
  target_3_contract_price: number | null;
  invalidation_underlying_price: number | null;
  alert_status: AlertStatus;
  triggered_at: string | null;
  entered_at: string | null;
  hit_t1_at: string | null;
  hit_t2_at: string | null;
  hit_t3_at: string | null;
  stopped_at: string | null;
  expires_at: string | null;
  confidence_score: number | null;
  trade_rationale: string | null;
  plan_metadata: { fallback_used?: string[]; notes?: string[] } | null;
  last_underlying_price: number | null;
  last_contract_mid: number | null;
  created_at: string;
};

export type AlertStatus =
  | "watching" | "triggered" | "entered"
  | "hit_t1" | "hit_t2" | "hit_t3"
  | "stopped" | "expired" | "cancelled";

const STATUS_LABEL: Record<AlertStatus, string> = {
  watching: "Watching",
  triggered: "Triggered",
  entered: "Entered",
  hit_t1: "Hit Target 1",
  hit_t2: "Hit Target 2",
  hit_t3: "Hit Target 3",
  stopped: "Stopped Out",
  expired: "Expired",
  cancelled: "Cancelled",
};

const STATUS_CLASS: Record<AlertStatus, string> = {
  watching:  "bg-muted text-muted-foreground",
  triggered: "bg-info/15 text-info",
  entered:   "bg-primary/15 text-primary",
  hit_t1:    "bg-bull/15 text-bull",
  hit_t2:    "bg-bull/20 text-bull",
  hit_t3:    "bg-bull/25 text-bull",
  stopped:   "bg-bear/15 text-bear",
  expired:   "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `$${Number(n).toFixed(2)}`;
}
function fmtStrike(n: number | null | undefined): string {
  if (n == null) return "";
  return `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;
}
function fmtExpiry(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !day) return d;
  return `${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(y).slice(2)}`;
}

export function TradeAlertCard({ alert, onChanged }: { alert: TradeAlert; onChanged?: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const status = alert.alert_status;
  const isActive = status === "watching" || status === "triggered" || status === "entered" ||
                   status === "hit_t1" || status === "hit_t2";
  const side = alert.option_side === "call" ? "CALL" : "PUT";
  const fallbacks = alert.plan_metadata?.fallback_used ?? [];
  const hasFallbacks = fallbacks.length > 0;

  const cancel = async () => {
    if (!confirm("Cancel this alert? You can always re-approve the signal.")) return;
    setCancelling(true);
    const { error } = await (supabase as any)
      .from("trade_alerts")
      .update({ alert_status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", alert.id);
    setCancelling(false);
    if (error) toast.error(error.message);
    else { toast.success("Alert cancelled"); onChanged?.(); }
  };

  return (
    <div className={cn(
      "glass-card border p-4 space-y-3 transition-colors",
      status === "stopped" ? "border-bear/30 bg-bear/[0.03]" :
      status.startsWith("hit_") ? "border-bull/30 bg-bull/[0.03]" :
      "border-border",
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-semibold ticker-mono leading-tight">
            {alert.ticker} {fmtStrike(alert.strike)} {side} {fmtExpiry(alert.expiry)}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {alert.confidence_score != null && <>Confidence {alert.confidence_score}% · </>}
            Plan created {new Date(alert.created_at).toLocaleDateString()}
          </div>
        </div>
        <Badge className={cn("border-0 text-[10px] uppercase tracking-wider", STATUS_CLASS[status])}>
          {STATUS_LABEL[status]}
        </Badge>
      </div>

      {/* Safety badges */}
      <div className="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wider">
        <Badge className="bg-warn/15 text-warn border-0">Paper Trade Alert</Badge>
        <Badge variant="outline" className="bg-transparent text-muted-foreground">Simulation Only</Badge>
        <Badge variant="outline" className="bg-transparent text-muted-foreground">No real money executed</Badge>
      </div>

      {hasFallbacks && (
        <div className="rounded-md border border-warn/40 bg-warn/10 p-2 flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-warn flex-shrink-0 mt-0.5" />
          <div className="text-[11px] text-warn leading-snug">
            <div className="font-medium">Plan used fallback values</div>
            <div className="text-warn/90 mt-0.5">{fallbacks.join(", ")}</div>
          </div>
        </div>
      )}

      {/* Trigger */}
      <div className="rounded-md border border-border/60 bg-card-elevated/40 p-2.5 space-y-1">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Crosshair className="h-3.5 w-3.5" /> Underlying Trigger
        </div>
        <div className="text-sm ticker-mono">
          {alert.underlying_trigger_price != null
            ? `${alert.ticker} ${alert.trigger_direction === "above" ? "breaks above" : "breaks below"} ${fmtPrice(alert.underlying_trigger_price)}`
            : "Trigger price unavailable"}
        </div>
        {alert.last_underlying_price != null && (
          <div className="text-[11px] text-muted-foreground ticker-mono">
            Last seen: {fmtPrice(alert.last_underlying_price)}
          </div>
        )}
      </div>

      {/* Entry / Stop / Targets grid */}
      <div className="grid grid-cols-2 gap-2">
        <PlanCell
          icon={<Target className="h-3.5 w-3.5" />}
          label="Entry Zone"
          value={
            alert.entry_contract_price_min != null && alert.entry_contract_price_max != null
              ? `${fmtPrice(alert.entry_contract_price_min)} – ${fmtPrice(alert.entry_contract_price_max)}`
              : "—"
          }
        />
        <PlanCell
          icon={<Shield className="h-3.5 w-3.5 text-bear" />}
          label="Stop Loss"
          value={fmtPrice(alert.stop_loss_contract_price)}
          accent="text-bear"
        />
        <PlanCell label="Target 1" value={fmtPrice(alert.target_1_contract_price)} accent="text-bull" />
        <PlanCell label="Target 2" value={fmtPrice(alert.target_2_contract_price)} accent="text-bull" />
        <PlanCell label="Target 3" value={fmtPrice(alert.target_3_contract_price)} accent="text-bull" />
        <PlanCell
          label="Invalidation"
          value={alert.invalidation_underlying_price != null
            ? `${alert.ticker} ${fmtPrice(alert.invalidation_underlying_price)}`
            : "—"}
          accent="text-muted-foreground"
        />
      </div>

      {/* Rationale */}
      {alert.trade_rationale && (
        <div className="text-[12px] text-foreground/80 leading-relaxed border-t border-border/50 pt-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Why:</span>
          {alert.trade_rationale}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1">
        <div className="text-[10px] text-muted-foreground">
          {alert.last_contract_mid != null && <>Last mid: {fmtPrice(alert.last_contract_mid)}</>}
        </div>
        {isActive && (
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={cancel} disabled={cancelling}>
            <X className="h-3 w-3 mr-1" /> Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function PlanCell({
  icon, label, value, accent,
}: { icon?: React.ReactNode; label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card-elevated/30 p-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div className={cn("mt-0.5 text-sm ticker-mono", accent)}>{value}</div>
    </div>
  );
}
