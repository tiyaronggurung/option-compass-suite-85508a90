import { useEffect, useState, Fragment } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, PlayCircle, Radar, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

type SkippedCandidate = { ticker: string; direction: string; score: number; reasons: string[] };

type AvgComponents = {
  trend?: number | null; momentum?: number | null; levels?: number | null;
  volume?: number | null; options?: number | null; macro?: number | null;
  candidate_count?: number;
};

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
  would_have_created: number | null;
  candidates_scanned: number | null;
  avg_score: number | null;
  avg_components: AvgComponents | null;
  skipped_candidates: SkippedCandidate[] | null;
  profile: string | null;
  threshold: number | null;
};

type CronJob = { jobname: string; schedule: string; active: boolean };


type ProfileKey = "conservative" | "balanced" | "active_mvp" | "testing";
const PROFILE_LABEL: Record<ProfileKey, string> = {
  conservative: "Conservative (≥60)",
  balanced: "Balanced (≥50)",
  active_mvp: "Active MVP (≥40)",
  testing: "Testing (≥25)",
};

export default function SignalScannerPanel() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [running, setRunning] = useState(false);
  const [profile, setProfile] = useState<ProfileKey>("balanced");
  const [debugMode, setDebugMode] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [forceRun, setForceRun] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  async function loadSettings() {
    const { data } = await supabase.from("scanner_settings").select("profile, debug_mode").eq("id", "global").maybeSingle();
    if (data) {
      setProfile(((data as any).profile as ProfileKey) ?? "balanced");
      setDebugMode(!!(data as any).debug_mode);
    }
  }

  async function loadRuns() {
    const { data } = await supabase.from("signal_scan_runs").select("*").order("ran_at", { ascending: false }).limit(10);
    setRuns((data ?? []) as unknown as Run[]);
  }

  useEffect(() => { if (isAdmin) { loadSettings(); loadRuns(); } }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const id = setInterval(loadRuns, 30_000);
    return () => clearInterval(id);
  }, [isAdmin]);

  async function saveSettings(nextProfile: ProfileKey, nextDebug: boolean) {
    setSavingSettings(true);
    const { error } = await supabase.from("scanner_settings")
      .update({ profile: nextProfile, debug_mode: nextDebug, updated_at: new Date().toISOString() })
      .eq("id", "global");
    setSavingSettings(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Scanner settings saved");
  }

  async function onProfileChange(value: string) {
    const p = value as ProfileKey;
    setProfile(p);
    await saveSettings(p, debugMode);
  }
  async function onDebugChange(value: boolean) {
    setDebugMode(value);
    await saveSettings(profile, value);
  }

  async function runNow() {
    setRunning(true);
    const { data, error } = await supabase.functions.invoke("scan-signals", {
      body: { trigger: "manual", force: forceRun },
    });
    setRunning(false);
    if (error) { toast.error(error.message); return; }
    if ((data as any)?.error) { toast.error((data as any).error); return; }
    const created = (data as any)?.signals_created ?? 0;
    const would = (data as any)?.would_have_created ?? 0;
    const cand = (data as any)?.candidates_scanned ?? 0;
    const status = (data as any)?.status ?? "ok";
    if (status === "outside_hours") toast(`Skipped — market closed (enable Force run to override)`);
    else if (status === "weekend") toast(`Skipped — weekend (enable Force run to override)`);
    else if (created > 0) toast.success(`Scan complete — ${created} signal${created === 1 ? "" : "s"} created`);
    else toast(`Scan ${status} — 0 created · ${cand} candidates${would ? ` · ${would} would-have` : ""}`);
    await loadRuns();
  }

  if (!isAdmin) return null;

  const last = runs?.[0];

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Radar className="h-4 w-4 text-primary" /> Signal Scanner
          </h2>
          <p className="text-xs text-muted-foreground">Backend Alpaca scanner. Runs every 2 min during US market hours (tiered cadence keeps providers within budget).</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={forceRun}
              onChange={(e) => setForceRun(e.target.checked)}
              className="h-3 w-3 accent-primary"
            />
            Force run (ignore market hours)
          </label>
          <Button size="sm" onClick={runNow} disabled={running}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />}
            <span className="ml-2">Run scan now</span>
          </Button>
        </div>
      </div>

      {/* Scanner sensitivity */}
      <div className="rounded-md border border-border p-3 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="text-sm font-medium">Sensitivity</div>
            <div className="text-xs text-muted-foreground">Minimum confidence required to publish a signal.</div>
          </div>
          {savingSettings && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <RadioGroup value={profile} onValueChange={onProfileChange} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {(Object.keys(PROFILE_LABEL) as ProfileKey[]).map((p) => (
            <label key={p} htmlFor={`profile-${p}`} className={`flex items-center gap-2 rounded-md border p-2 cursor-pointer hover:bg-muted/30 ${p === "testing" ? "border-amber-500/60 bg-amber-500/5" : "border-border"}`}>
              <RadioGroupItem value={p} id={`profile-${p}`} />
              <span className="text-xs">{PROFILE_LABEL[p]}</span>
            </label>
          ))}
        </RadioGroup>
        {profile === "testing" && (
          <div className="rounded-md border border-amber-500/60 bg-amber-500/5 p-2 text-[11px] text-amber-600 dark:text-amber-400">
            Testing mode — may generate lower-quality signals. Uses real Alpaca data only. Use for verifying live-signal visibility, not for trading decisions.
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <div>
            <Label htmlFor="debug-mode" className="text-xs">Debug mode</Label>
            <p className="text-[11px] text-muted-foreground">Persist top 3 skipped candidates per run.</p>
          </div>
          <Switch id="debug-mode" checked={debugMode} onCheckedChange={onDebugChange} />
        </div>
      </div>

      {/* Last run metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Metric label="Last status" value={last ? <StatusBadge status={last.status} /> : "—"} />
        <Metric label="Created" value={<span className="text-bull ticker-mono">{last?.signals_created ?? 0}</span>} />
        <Metric label="Would-have" value={<span className="text-warn ticker-mono">{last?.would_have_created ?? 0}</span>} />
        <Metric label="Candidates" value={<span className="ticker-mono">{last?.candidates_scanned ?? 0}</span>} />
        <Metric label="Avg score" value={<span className="ticker-mono">{last?.avg_score != null ? Number(last.avg_score).toFixed(1) : "—"}</span>} />
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
                <th className="p-2 w-6"></th>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Profile</th>
                <th className="text-right p-2">Created</th>
                <th className="text-right p-2">Would</th>
                <th className="text-right p-2">Cand.</th>
                <th className="text-right p-2">Avg</th>
                <th className="text-right p-2">Skip</th>
                <th className="text-right p-2">Dur</th>
                <th className="text-left p-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const hasSkipped = (r.skipped_candidates?.length ?? 0) > 0;
                const ac = r.avg_components ?? null;
                const hasAvgComps = !!(ac && (ac.candidate_count ?? 0) > 0);
                const expandable = hasSkipped || hasAvgComps;
                const isOpen = !!expanded[r.id];
                return (
                  <Fragment key={r.id}>
                    <tr className="border-t border-border/50">
                      <td className="p-2">
                        {expandable ? (
                          <button onClick={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))} className="text-muted-foreground hover:text-foreground">
                            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          </button>
                        ) : null}
                      </td>
                      <td className="p-2">{new Date(r.ran_at).toLocaleTimeString()}</td>
                      <td className="p-2"><StatusBadge status={r.status} /></td>
                      <td className="p-2 text-muted-foreground">{r.profile ? `${r.profile}${r.threshold ? ` (${r.threshold})` : ""}` : "—"}</td>
                      <td className="p-2 text-right ticker-mono text-bull">{r.signals_created}</td>
                      <td className="p-2 text-right ticker-mono text-warn">{r.would_have_created ?? 0}</td>
                      <td className="p-2 text-right ticker-mono">{r.candidates_scanned ?? 0}</td>
                      <td className="p-2 text-right ticker-mono">{r.avg_score != null ? Number(r.avg_score).toFixed(1) : "—"}</td>
                      <td className="p-2 text-right ticker-mono">{r.skipped_count}</td>
                      <td className="p-2 text-right ticker-mono">{r.duration_ms ? `${r.duration_ms}ms` : "—"}</td>
                      <td className="p-2 text-bear truncate max-w-[200px]" title={r.error ?? undefined}>{r.error ?? ""}</td>
                    </tr>
                    {isOpen && expandable && (
                      <tr className="bg-muted/10">
                        <td></td>
                        <td colSpan={10} className="p-2 space-y-3">
                          {hasAvgComps && <AvgComponentRow ac={ac!} />}
                          {hasSkipped && (
                            <div>
                              <div className="text-[11px] text-muted-foreground mb-1">
                                Top skipped candidates (below threshold {r.threshold ?? "—"}):
                              </div>
                              <div className="space-y-1">
                                {r.skipped_candidates!.map((c, i) => (
                                  <div key={i} className="flex items-start gap-2 flex-wrap">
                                    <span className="ticker-mono font-medium">{c.ticker}</span>
                                    <Badge variant="outline" className={c.direction === "CALL" ? "text-bull border-bull/40" : "text-bear border-bear/40"}>{c.direction}</Badge>
                                    <span className="ticker-mono">score {c.score}</span>
                                    <span className="text-muted-foreground">— {c.reasons.join(" · ")}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}

            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm mt-1">{value}</div>
    </div>
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

const AVG_COMP_KEYS = ["trend", "momentum", "levels", "volume", "options", "macro"] as const;
const AVG_COMP_LABEL: Record<string, string> = {
  trend: "Trend", momentum: "Mom", levels: "Levels",
  volume: "Vol", options: "Opt", macro: "Macro",
};

function AvgComponentRow({ ac }: { ac: AvgComponents }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground mb-1">
        Avg component scores ({ac.candidate_count ?? 0} candidates, range −1.0 to +1.0):
      </div>
      <div className="flex flex-wrap gap-2">
        {AVG_COMP_KEYS.map((k) => {
          const v = ac[k];
          const num = typeof v === "number" ? v : null;
          const cls = num == null ? "text-muted-foreground border-border"
            : num > 0.05 ? "text-bull border-bull/40"
            : num < -0.05 ? "text-bear border-bear/40"
            : "text-muted-foreground border-border";
          return (
            <Badge key={k} variant="outline" className={`${cls} gap-1.5 font-normal`}>
              <span className="text-[10px] uppercase tracking-wide">{AVG_COMP_LABEL[k]}</span>
              <span className="ticker-mono">
                {num == null ? "—" : `${num >= 0 ? "+" : ""}${num.toFixed(2)}`}
              </span>
            </Badge>
          );
        })}
      </div>
    </div>
  );
}

