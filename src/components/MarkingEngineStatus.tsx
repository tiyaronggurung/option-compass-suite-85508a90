import { useEffect, useState, useCallback } from "react";
import { Activity, RefreshCw, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { invokeUpdatePaperMarks } from "@/lib/paperMarks";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type Run = {
  id: string;
  ran_at: string;
  status: string;
  updated_count: number;
  skipped_count: number;
  missing_prices: string[];
  error: string | null;
  trigger: string;
  duration_ms: number | null;
};

export default function MarkingEngineStatus() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [{ data: roleRow }, { data: cfg }, { data: runs }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", user!.id).eq("role", "admin").maybeSingle(),
      supabase.from("mark_engine_config" as any).select("*").eq("id", "global").maybeSingle(),
      supabase.from("mark_engine_runs" as any).select("*").order("ran_at", { ascending: false }).limit(1),
    ]);
    setIsAdmin(!!roleRow);
    if (cfg) setEnabled((cfg as any).enabled);
    setLastRun((runs && (runs as any)[0]) || null);
    setLoading(false);
  }, [user]);

  useEffect(() => { if (user) load(); }, [user, load]);

  useEffect(() => {
    if (!isAdmin) return;
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [isAdmin, load]);

  if (loading) return <Skeleton className="h-40" />;
  if (!isAdmin) return null;

  async function toggleEnabled(v: boolean) {
    setEnabled(v);
    const { error } = await supabase.from("mark_engine_config" as any)
      .update({ enabled: v, updated_at: new Date().toISOString() }).eq("id", "global");
    if (error) {
      toast.error(error.message);
      setEnabled(!v);
    } else {
      toast.success(v ? "Marking engine enabled" : "Marking engine disabled");
    }
  }

  async function runNow() {
    setRefreshing(true);
    try {
      const { data, error } = await invokeUpdatePaperMarks({ trigger: "manual" });
      if (error) throw error;
      toast.success(`Run complete: ${(data as any)?.status ?? "ok"}`);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "Run failed");
    } finally {
      setRefreshing(false);
    }
  }

  const next = nextExpectedRun();

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" /> Marking engine status
        </h2>
        <Button size="sm" variant="outline" onClick={runNow} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          Run now
        </Button>
      </div>

      <label className="flex items-center justify-between rounded-md border border-border px-3 py-3">
        <div>
          <div className="text-sm font-medium">Scheduled marking enabled</div>
          <p className="text-xs text-muted-foreground">
            When on, cron updates open paper trade marks every minute during US market hours (Mon–Fri 9:30–16:00 ET).
            Manual “Run now” works regardless.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={toggleEnabled} />
      </label>

      <div className="grid sm:grid-cols-2 gap-3">
        <StatBlock label="Last run">
          {lastRun ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={lastRun.status} />
                <span className="text-xs text-muted-foreground">via {lastRun.trigger}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(lastRun.ran_at), { addSuffix: true })}
                {lastRun.duration_ms != null && ` · ${lastRun.duration_ms}ms`}
              </div>
              <div className="text-xs ticker-mono">
                updated {lastRun.updated_count} · skipped {lastRun.skipped_count}
                {lastRun.missing_prices?.length ? ` · missing ${lastRun.missing_prices.join(",")}` : ""}
              </div>
              {lastRun.error && (
                <div className="text-xs text-bear flex items-start gap-1.5 mt-1">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {lastRun.error}
                </div>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No runs yet.</span>
          )}
        </StatBlock>

        <StatBlock label="Next expected run">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm">{next.label}</span>
          </div>
          <div className="text-xs text-muted-foreground">{next.detail}</div>
        </StatBlock>
      </div>
    </section>
  );
}

function StatBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3 space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: any; label: string }> = {
    ok: { cls: "bg-bull/15 text-bull", icon: CheckCircle2, label: "ok" },
    outside_hours: { cls: "bg-muted text-muted-foreground", icon: Clock, label: "outside hours" },
    disabled: { cls: "bg-muted text-muted-foreground", icon: Clock, label: "disabled" },
    no_open_trades: { cls: "bg-muted text-muted-foreground", icon: CheckCircle2, label: "no open trades" },
    error: { cls: "bg-bear/15 text-bear", icon: AlertTriangle, label: "error" },
  };
  const cfg = map[status] ?? map.error;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${cfg.cls}`}>
      <Icon className="h-3 w-3" /> {cfg.label}
    </span>
  );
}

// Compute the next minute boundary that falls inside US market hours.
function nextExpectedRun(): { label: string; detail: string } {
  const now = new Date();
  // Next whole minute
  const next = new Date(now.getTime() + (60_000 - (now.getTime() % 60_000)));
  if (isInMarketHours(next)) {
    return {
      label: formatDistanceToNow(next, { addSuffix: true }),
      detail: next.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" }) + " local",
    };
  }
  // Walk forward up to 4 days to find next 9:30 ET weekday
  for (let i = 0; i < 5; i++) {
    const d = nextMarketOpen(i === 0 ? now : addDays(stripToMidnight(now), i));
    if (d.getTime() > now.getTime()) {
      return {
        label: formatDistanceToNow(d, { addSuffix: true }),
        detail: "next market open · " + d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) + " local",
      };
    }
  }
  return { label: "—", detail: "" };
}

function isInMarketHours(d: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  if (["Sat", "Sun"].includes(weekday)) return false;
  const mins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function nextMarketOpen(from: Date): Date {
  // Approximate: find a Date whose ET time is 09:30 on the same calendar day (or next weekday).
  // We iterate hour by hour from `from` for up to 5 days; cheap and DST-safe.
  let cursor = new Date(from);
  for (let i = 0; i < 60 * 24 * 5; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(cursor);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekday = get("weekday");
    const mins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
    if (!["Sat", "Sun"].includes(weekday) && mins === 9 * 60 + 30) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return cursor;
}

function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * 86400_000); }
function stripToMidnight(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
