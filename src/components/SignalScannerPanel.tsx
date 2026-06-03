import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, PlayCircle, Radar } from "lucide-react";
import { toast } from "sonner";

type Run = {
  id: string;
  ran_at: string;
  status: string;
  trigger: string;
  tickers_scanned: string[];
  signals_created: number;
  skipped_count: number;
  error: string | null;
  duration_ms: number | null;
};

export default function SignalScannerPanel() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  async function loadRuns() {
    const { data } = await supabase.from("signal_scan_runs").select("*").order("ran_at", { ascending: false }).limit(10);
    setRuns((data ?? []) as Run[]);
  }

  useEffect(() => { if (isAdmin) loadRuns(); }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const id = setInterval(loadRuns, 30_000);
    return () => clearInterval(id);
  }, [isAdmin]);

  async function runNow() {
    setRunning(true);
    const { data, error } = await supabase.functions.invoke("scan-signals", { body: { trigger: "manual" } });
    setRunning(false);
    if (error) { toast.error(error.message); return; }
    if (data?.error) { toast.error(data.error); return; }
    const created = data?.signals_created ?? 0;
    const status = data?.status ?? "ok";
    if (status === "ok") toast.success(`Scan complete — ${created} signal${created === 1 ? "" : "s"} created`);
    else if (status === "outside_hours") toast(`Skipped — market closed`);
    else if (status === "weekend") toast(`Skipped — weekend`);
    else toast(`Scan ${status}`);
    await loadRuns();
  }

  if (!isAdmin) return null;

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Radar className="h-4 w-4 text-primary" /> Signal Scanner
          </h2>
          <p className="text-xs text-muted-foreground">Backend Alpaca scanner. Runs every 5 min during US market hours.</p>
        </div>
        <Button size="sm" onClick={runNow} disabled={running}>
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />}
          <span className="ml-2">Run scan now</span>
        </Button>
      </div>

      <div className="overflow-x-auto border border-border rounded-md">
        {!runs ? (
          <div className="p-3 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
        ) : runs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No scan runs yet.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Trigger</th>
                <th className="text-right p-2">Tickers</th>
                <th className="text-right p-2">Created</th>
                <th className="text-right p-2">Skipped</th>
                <th className="text-right p-2">Duration</th>
                <th className="text-left p-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-border/50">
                  <td className="p-2">{new Date(r.ran_at).toLocaleTimeString()}</td>
                  <td className="p-2"><StatusBadge status={r.status} /></td>
                  <td className="p-2 text-muted-foreground">{r.trigger}</td>
                  <td className="p-2 text-right ticker-mono">{r.tickers_scanned?.length ?? 0}</td>
                  <td className="p-2 text-right ticker-mono text-bull">{r.signals_created}</td>
                  <td className="p-2 text-right ticker-mono">{r.skipped_count}</td>
                  <td className="p-2 text-right ticker-mono">{r.duration_ms ? `${r.duration_ms}ms` : "—"}</td>
                  <td className="p-2 text-bear truncate max-w-[240px]" title={r.error ?? undefined}>{r.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ok: "text-bull border-bull/40",
    partial: "text-warn border-warn/40",
    error: "text-bear border-bear/40",
    outside_hours: "text-muted-foreground border-border",
    weekend: "text-muted-foreground border-border",
  };
  return <Badge variant="outline" className={map[status] ?? "text-muted-foreground border-border"}>{status}</Badge>;
}
