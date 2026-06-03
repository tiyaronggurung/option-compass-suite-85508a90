import { ShieldAlert, ShieldCheck, Activity, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EffectiveRisk } from "@/lib/riskGuard";

type Props = {
  effective: EffectiveRisk;
  openTradesCount: number;
  todayRealizedPL: number;
};

export function RiskStatusCard({ effective, openTradesCount, todayRealizedPL }: Props) {
  const atOpenCap = openTradesCount >= effective.max_open_trades;
  const realizedLoss = Math.max(0, -todayRealizedPL);
  const lossPct = effective.daily_loss_cap > 0
    ? Math.min(100, (realizedLoss / effective.daily_loss_cap) * 100)
    : 0;
  const atLossCap = realizedLoss >= effective.daily_loss_cap;
  const blocked = effective.kill_switch || atOpenCap || atLossCap;

  return (
    <section
      className={cn(
        "glass-card p-4 ring-1",
        effective.kill_switch ? "ring-bear/40" : blocked ? "ring-warn/40" : "ring-border",
      )}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          {effective.kill_switch ? (
            <ShieldAlert className="h-4 w-4 text-bear" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-primary" />
          )}
          <h3 className="text-sm font-semibold">Risk status</h3>
        </div>
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border",
            effective.kill_switch
              ? "border-bear/50 bg-bear/10 text-bear"
              : blocked
              ? "border-warn/50 bg-warn/10 text-warn"
              : "border-bull/40 bg-bull/10 text-bull",
          )}
        >
          {effective.kill_switch ? "Kill switch on" : blocked ? "Approvals blocked" : "Approvals open"}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          icon={Activity}
          label="Open trades"
          value={
            <span className={cn("ticker-mono", atOpenCap && "text-bear")}>
              {openTradesCount} / {effective.max_open_trades}
            </span>
          }
        />
        <Tile
          icon={DollarSign}
          label="Realized today"
          value={
            <span className={cn("ticker-mono", todayRealizedPL < 0 ? "text-bear" : "text-bull")}>
              {todayRealizedPL >= 0 ? "+" : "−"}${Math.abs(todayRealizedPL).toFixed(2)}
            </span>
          }
        />
        <Tile
          icon={ShieldAlert}
          label="Daily loss cap"
          value={
            <div className="space-y-1">
              <div className={cn("ticker-mono text-xs", atLossCap && "text-bear")}>
                ${realizedLoss.toFixed(0)} / ${effective.daily_loss_cap.toFixed(0)}
              </div>
              <div className="h-1 w-full rounded bg-muted/40 overflow-hidden">
                <div
                  className={cn("h-full", atLossCap ? "bg-bear" : lossPct >= 75 ? "bg-warn" : "bg-bull/70")}
                  style={{ width: `${lossPct}%` }}
                />
              </div>
            </div>
          }
        />
        <Tile
          icon={ShieldCheck}
          label="Max risk / trade"
          value={<span className="ticker-mono">${effective.max_risk_per_trade.toFixed(0)}</span>}
        />
      </div>
    </section>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="text-sm mt-1">{value}</div>
    </div>
  );
}
