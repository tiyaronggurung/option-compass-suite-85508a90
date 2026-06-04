// Compact market-overview strip for the dashboard top — SPY / QQQ / VIX + regime badge.
// Reads from public.market_regime (populated by detect-market-regime cron).
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Activity, TrendingDown, TrendingUp, Waves, Zap } from "lucide-react";

type Row = {
  regime: "bull" | "bear" | "sideways" | "high_vol" | string;
  spy_trend: number | null;
  qqq_trend: number | null;
  vix_level: number | null;
  updated_at: string;
};

const REGIME_META: Record<string, { label: string; className: string; Icon: any }> = {
  bull:      { label: "Bull",      className: "bg-bull/15 text-bull",   Icon: TrendingUp },
  bear:      { label: "Bear",      className: "bg-bear/15 text-bear",   Icon: TrendingDown },
  sideways:  { label: "Sideways",  className: "bg-muted text-muted-foreground", Icon: Waves },
  high_vol:  { label: "High Vol",  className: "bg-warn/15 text-warn",   Icon: Zap },
};

export default function MarketOverviewStrip() {
  const [row, setRow] = useState<Row | null | undefined>(undefined);

  useEffect(() => {
    supabase.from("market_regime").select("*").eq("id", "global").maybeSingle()
      .then(({ data }) => setRow((data as Row | null) ?? null));
  }, []);

  if (row === undefined) return <Skeleton className="h-14" />;
  const meta = REGIME_META[row?.regime ?? "sideways"] ?? REGIME_META.sideways;
  const Icon = meta.Icon;

  return (
    <section className="glass-card p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-medium">Market regime</span>
          <Badge className={cn("border-0 gap-1 text-[11px]", meta.className)}>
            <Icon className="h-3 w-3" /> {meta.label}
          </Badge>
        </div>
        <div className="flex items-center gap-4 text-xs ticker-mono">
          <Stat label="SPY" value={row?.spy_trend} suffix="%" />
          <Stat label="QQQ" value={row?.qqq_trend} suffix="%" />
          <Stat label="VIX" value={row?.vix_level} />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, suffix = "" }: { label: string; value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">{label} —</span>;
  }
  const cls = label === "VIX" ? (value > 22 ? "text-warn" : "text-foreground")
    : value > 0 ? "text-bull" : value < 0 ? "text-bear" : "text-foreground";
  return (
    <span>
      <span className="text-muted-foreground mr-1">{label}</span>
      <span className={cls}>{value > 0 && suffix ? "+" : ""}{value.toFixed(2)}{suffix}</span>
    </span>
  );
}
