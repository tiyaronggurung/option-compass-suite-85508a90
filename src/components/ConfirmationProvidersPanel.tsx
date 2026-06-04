import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Plug } from "lucide-react";

type ProviderRow = {
  provider: string;
  enabled: boolean;
  mode: string;
  last_status: string;
  last_sync_at: string | null;
  last_error: string | null;
};

// Confirmation engine providers (Alpaca handled separately as primary)
const CONFIRMATION_PROVIDERS: Array<{ provider: string; label: string; description: string }> = [
  { provider: "tradier",        label: "Tradier",         description: "Reserved — per-contract options flow & Greeks (future)" },
  { provider: "finviz",         label: "Finviz",          description: "Active — technical + options flow + volatility (aggregate)" },
  { provider: "finnhub",        label: "Finnhub",         description: "News sentiment · analyst actions" },
  { provider: "apify",          label: "Apify (X/Twitter)", description: "X cashtag sentiment & mention velocity" },
  { provider: "unusual_whales", label: "Unusual Whales",  description: "Reserved — future flow expansion" },
  { provider: "x_twitter",      label: "X / Twitter API", description: "Direct X API (placeholder)" },
  { provider: "reddit",         label: "Reddit API",      description: "WSB / investing post velocity (noisy)" },
  { provider: "polymarket",     label: "Polymarket",      description: "Prediction-market pricing" },
  { provider: "kalshi",         label: "Kalshi",          description: "Event contract pricing" },
  { provider: "news",           label: "News API",        description: "Generic headline catalysts" },
  { provider: "alpha_vantage",  label: "Alpha Vantage",   description: "Earnings calendar enrichment" },
];

export default function ConfirmationProvidersPanel() {
  const [rows, setRows] = useState<Record<string, ProviderRow> | null>(null);

  useEffect(() => {
    supabase.from("provider_configs")
      .select("provider, enabled, mode, last_status, last_sync_at, last_error")
      .then(({ data }) => {
        const map: Record<string, ProviderRow> = {};
        (data ?? []).forEach((r: any) => { map[r.provider] = r as ProviderRow; });
        setRows(map);
      });
  }, []);

  return (
    <section className="glass-card p-5 space-y-3">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-semibold flex items-center gap-2">
          <Plug className="h-4 w-4 text-primary" />
          Confirmation Sources
        </h2>
        <Badge variant="outline" className="text-[10px]">Alpaca = primary</Badge>
      </header>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Each provider below can confirm or conflict an Alpaca-generated signal. Unconfigured providers
        return neutral. Social channels are inherently noisy — they never create a signal alone.
      </p>

      {rows === null ? (
        <div className="space-y-2">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-2">
          {CONFIRMATION_PROVIDERS.map((p) => {
            const row = rows[p.provider];
            const configured = !!row;
            const enabled = row?.enabled === true;
            const status = row?.last_status ?? "unknown";
            const statusClass =
              status === "ok" ? "bg-bull/15 text-bull"
              : status === "error" ? "bg-bear/15 text-bear"
              : "bg-muted text-muted-foreground";
            return (
              <div key={p.provider} className="rounded-md border border-border/60 p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{p.label}</div>
                    <div className="text-[11px] text-muted-foreground line-clamp-1">{p.description}</div>
                  </div>
                  <Badge className={cn("border-0 text-[10px] px-1.5 py-0", enabled ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
                    {enabled ? "enabled" : "disabled"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{configured ? "configured" : "not configured"}</span>
                  <Badge className={cn("border-0 text-[10px] px-1.5 py-0", statusClass)}>{status}</Badge>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Last sync: {row?.last_sync_at ? new Date(row.last_sync_at).toLocaleString() : "never"}
                </div>
                {row?.last_error && (
                  <div className="text-[10px] text-bear line-clamp-1" title={row.last_error}>
                    {row.last_error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
