import { useEffect, useState } from "react";
import { EyeOff, Eye, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useIsAdmin } from "@/hooks/useIsAdmin";

type Mode = "demo" | "live" | "both";

const MODES: { id: Mode; label: string; desc: string }[] = [
  { id: "both", label: "Both", desc: "Show demo and live market signals" },
  { id: "live", label: "Live only", desc: "Only signals from real market engines (e.g. Alpaca)" },
  { id: "demo", label: "Demo only", desc: "Only seeded test signals" },
];

export function SignalModePanel() {
  const { isAdmin, loading } = useIsAdmin();
  const [mode, setMode] = useState<Mode | null>(null);
  const [stats, setStats] = useState<{ demo: number; live: number; hiddenDemo: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadStats() {
    const [{ count: demo }, { count: live }, { count: hiddenDemo }] = await Promise.all([
      supabase.from("signals").select("*", { count: "exact", head: true }).eq("is_demo", true).eq("hidden", false),
      supabase.from("signals").select("*", { count: "exact", head: true }).eq("is_demo", false).eq("hidden", false),
      supabase.from("signals").select("*", { count: "exact", head: true }).eq("is_demo", true).eq("hidden", true),
    ]);
    setStats({ demo: demo ?? 0, live: live ?? 0, hiddenDemo: hiddenDemo ?? 0 });
  }

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("app_settings").select("signal_mode").eq("id", "global").maybeSingle();
      setMode((data?.signal_mode as Mode) || "both");
      await loadStats();
    })();
  }, []);

  async function setSignalMode(next: Mode) {
    setMode(next);
    const { error } = await supabase.from("app_settings").update({ signal_mode: next, updated_at: new Date().toISOString() }).eq("id", "global");
    if (error) { toast.error(error.message); return; }
    toast.success(`Default signal view: ${next}`);
  }

  async function hideDemo() {
    setBusy(true);
    const { error, count } = await supabase
      .from("signals")
      .update({ hidden: true }, { count: "exact" })
      .eq("is_demo", true)
      .eq("hidden", false);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Hid ${count ?? 0} demo signals (not deleted)`);
    loadStats();
  }

  async function restoreDemo() {
    setBusy(true);
    const { error, count } = await supabase
      .from("signals")
      .update({ hidden: false }, { count: "exact" })
      .eq("is_demo", true)
      .eq("hidden", true);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Restored ${count ?? 0} demo signals`);
    loadStats();
  }

  if (loading) return <Skeleton className="h-32" />;
  if (!isAdmin) return null;

  return (
    <section className="glass-card p-5 space-y-4">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" /> Signal display mode <span className="text-[10px] uppercase tracking-wider text-muted-foreground ml-1">admin</span>
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Default view applied to the dashboard. Users can still override their own filter per session.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setSignalMode(m.id)}
            className={`text-left rounded-md border p-3 transition ${
              mode === m.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
            }`}
          >
            <div className="text-sm font-medium">{m.label}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{m.desc}</div>
          </button>
        ))}
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Stat label="Demo (visible)" value={stats.demo} />
          <Stat label="Live (visible)" value={stats.live} />
          <Stat label="Demo (hidden)" value={stats.hiddenDemo} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={hideDemo} disabled={busy || (stats?.demo ?? 0) === 0}>
          <EyeOff className="h-3.5 w-3.5 mr-1.5" /> Hide all demo signals
        </Button>
        <Button size="sm" variant="ghost" onClick={restoreDemo} disabled={busy || (stats?.hiddenDemo ?? 0) === 0}>
          <Eye className="h-3.5 w-3.5 mr-1.5" /> Restore demo signals
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Hide is a soft toggle — rows are never deleted. Paper trading remains the only execution path.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wider">{label}</div>
      <div className="ticker-mono text-lg font-semibold">{value}</div>
    </div>
  );
}
