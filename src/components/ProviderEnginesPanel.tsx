import { useEffect, useState } from "react";
import { Activity, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useIsAdmin } from "@/hooks/useIsAdmin";

type ProviderId = "alpaca" | "tradier" | "polygon" | "unusual_whales" | "news";

const PROVIDER_META: Record<ProviderId, { name: string; purpose: string }> = {
  alpaca: { name: "Alpaca", purpose: "Stock quotes, bars, paper trading" },
  tradier: { name: "Tradier", purpose: "Options chains + Greeks" },
  polygon: { name: "Polygon", purpose: "Realtime quotes + options" },
  unusual_whales: { name: "Unusual Whales", purpose: "Options flow + dark pool" },
  news: { name: "News & Catalysts", purpose: "Headlines + earnings" },
};

interface ProviderRow {
  provider: ProviderId;
  enabled: boolean;
  mode: "live" | "simulated";
  last_sync_at: string | null;
  last_status: "ok" | "error" | "unknown";
  last_error: string | null;
  latency_ms: number | null;
}

interface HealthResult {
  provider: ProviderId;
  status: "ok" | "error" | "unknown";
  latency_ms: number | null;
  error: string | null;
  configured: boolean;
}

export function ProviderEnginesPanel() {
  const { isAdmin, loading: roleLoading } = useIsAdmin();
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [health, setHealth] = useState<Record<string, HealthResult>>({});
  const [testing, setTesting] = useState(false);

  async function load() {
    const { data, error } = await supabase
      .from("provider_configs")
      .select("*")
      .order("provider");
    if (error) { toast.error(error.message); return; }
    setRows((data || []) as ProviderRow[]);
  }

  useEffect(() => { load(); }, []);

  async function runHealth() {
    setTesting(true);
    try {
      const { data, error } = await supabase.functions.invoke("provider-health", { method: "GET" });
      if (error) throw error;
      const map: Record<string, HealthResult> = {};
      for (const r of (data?.results || []) as HealthResult[]) map[r.provider] = r;
      setHealth(map);
      toast.success("Provider health checked");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message || "Health check failed");
    } finally {
      setTesting(false);
    }
  }

  async function toggle(provider: ProviderId, patch: { enabled?: boolean; mode?: "live" | "simulated" }) {
    // optimistic
    setRows((prev) => prev?.map((r) => r.provider === provider ? { ...r, ...patch } : r) || null);
    const { error } = await supabase.functions.invoke("toggle-provider", {
      body: { provider, ...patch },
    });
    if (error) { toast.error(error.message); load(); }
  }

  if (roleLoading) return <Skeleton className="h-40" />;

  const order: ProviderId[] = ["alpaca", "tradier", "polygon", "unusual_whales", "news"];

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> Market Data Engines
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Provider readiness, health, and mode. {isAdmin ? "Admin controls active." : "View-only — admin required to change."}
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={runHealth} disabled={testing}>
            {testing ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1.5" />}
            Test connections
          </Button>
        )}
      </div>

      {!rows ? (
        <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {order.map((id) => {
            const row = rows.find((r) => r.provider === id);
            if (!row) return null;
            const meta = PROVIDER_META[id];
            const live = health[id];
            const configured = live?.configured ?? (row.last_status !== "unknown");
            const status = live?.status ?? row.last_status;
            const dotClass = status === "ok" ? "bg-emerald-500" : status === "error" ? "bg-bear" : "bg-muted-foreground/40";
            const lastSync = row.last_sync_at ? new Date(row.last_sync_at).toLocaleString() : "never";
            return (
              <div key={id} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                    <div className="text-sm font-medium truncate">{meta.name}</div>
                  </div>
                  <Badge variant="outline" className="border-border text-muted-foreground text-[10px] shrink-0">
                    <KeyRound className="h-3 w-3 mr-1" />
                    {configured ? "Configured" : "Not configured"}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">{meta.purpose}</div>
                <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>Last sync: <span className="text-foreground/80">{lastSync}</span></span>
                  {row.latency_ms != null && <span>Latency: <span className="text-foreground/80">{row.latency_ms}ms</span></span>}
                </div>
                {row.last_error && status === "error" && (
                  <div className="text-[11px] text-bear truncate" title={row.last_error}>Error: {row.last_error}</div>
                )}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={row.enabled}
                      disabled={!isAdmin || !configured}
                      onCheckedChange={(v) => toggle(id, { enabled: v })}
                    />
                    <span className="text-muted-foreground">Enabled</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Live</span>
                    <Switch
                      checked={row.mode === "live"}
                      disabled={!isAdmin || !configured}
                      onCheckedChange={(v) => toggle(id, { mode: v ? "live" : "simulated" })}
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Provider secrets stay in the backend. Enabling Live mode only affects health checks — signal generation still flows
        through the Python engine → secured ingest webhook.
      </p>
    </section>
  );
}
