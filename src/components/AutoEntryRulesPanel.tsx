import { useEffect, useState } from "react";
import { Bot, AlertTriangle, X, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type Rules = {
  user_id: string;
  enabled: boolean;
  dry_run: boolean;
  min_tier: string | null;
  min_confidence: number | null;
  allowed_directions: string[] | null;
  max_premium_usd: number | null;
  max_risk_usd: number | null;
  start_time_et: string | null;
  end_time_et: string | null;
  cooldown_minutes: number;
  max_signal_age_minutes: number;
  max_trades_per_day: number;
  daily_spend_cap_usd: number;
  block_if_open_on_ticker: boolean;
};

type LogRow = {
  id: string;
  ticker: string;
  status: string;
  skip_reason: string | null;
  paper_trade_id: string | null;
  created_at: string;
};

const DIRS = ["CALL", "PUT"] as const;

export default function AutoEntryRulesPanel() {
  const { user } = useAuth();
  const [rules, setRules] = useState<Rules | null>(null);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [tickerInput, setTickerInput] = useState("");
  const [log, setLog] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    if (!user) return;
    const [{ data: r }, { data: wl }, { data: lg }] = await Promise.all([
      (supabase as any).from("auto_entry_rules").select("*").eq("user_id", user.id).maybeSingle(),
      (supabase as any).from("auto_entry_whitelist").select("ticker").eq("user_id", user.id).order("ticker"),
      (supabase as any).from("auto_entry_log").select("id,ticker,status,skip_reason,paper_trade_id,created_at")
        .eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
    ]);

    if (r) setRules(r as Rules);
    else {
      const defaults: Rules = {
        user_id: user.id,
        enabled: false, dry_run: true,
        min_tier: "GOLD", min_confidence: 80,
        allowed_directions: ["CALL", "PUT"],
        max_premium_usd: 5, max_risk_usd: 500,
        start_time_et: "10:00", end_time_et: "15:00",
        cooldown_minutes: 30, max_signal_age_minutes: 5,
        max_trades_per_day: 5, daily_spend_cap_usd: 2000,
        block_if_open_on_ticker: true,
      };
      const { data: ins } = await (supabase as any).from("auto_entry_rules").insert(defaults).select("*").single();
      setRules((ins as Rules) ?? defaults);
    }
    setWhitelist((wl ?? []).map((r: any) => r.ticker));
    setLog((lg ?? []) as LogRow[]);
    setLoading(false);
  }

  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [user]);

  async function save(patch: Partial<Rules>) {
    if (!rules || !user) return;
    setRules({ ...rules, ...patch });
    const { error } = await (supabase as any).from("auto_entry_rules").update(patch).eq("user_id", user.id);
    if (error) toast.error(error.message);
  }

  async function addTicker() {
    if (!user) return;
    const t = tickerInput.trim().toUpperCase();
    if (!t) return;
    setTickerInput("");
    if (whitelist.includes(t)) return;
    const { error } = await (supabase as any).from("auto_entry_whitelist").insert({ user_id: user.id, ticker: t });
    if (error) { toast.error(error.message); return; }
    setWhitelist([...whitelist, t].sort());
  }

  async function removeTicker(t: string) {
    if (!user) return;
    setWhitelist(whitelist.filter((x) => x !== t));
    const { error } = await (supabase as any).from("auto_entry_whitelist").delete().eq("user_id", user.id).eq("ticker", t);
    if (error) toast.error(error.message);
  }

  function toggleDir(d: string) {
    const cur = new Set(rules?.allowed_directions ?? []);
    if (cur.has(d)) cur.delete(d); else cur.add(d);
    save({ allowed_directions: Array.from(cur) });
  }

  return (
    <section className="glass-card p-5 space-y-4">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" /> Auto-entry rules
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Whitelist-only. When a fresh signal matches every rule below, the engine auto-opens
          a paper trade. Real money is never involved.
        </p>
      </div>

      {loading || !rules ? (
        <div className="grid sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className={`flex items-center justify-between rounded-md border px-3 py-3 ${rules.enabled ? "border-primary/40 bg-primary/5" : "border-border"}`}>
              <div>
                <div className="text-sm font-medium">Enable auto-entry</div>
                <p className="text-xs text-muted-foreground">Master switch.</p>
              </div>
              <Switch checked={rules.enabled} onCheckedChange={(v) => save({ enabled: v })} />
            </label>
            <label className={`flex items-center justify-between rounded-md border px-3 py-3 ${rules.dry_run ? "border-warn/40 bg-warn/5" : "border-border"}`}>
              <div>
                <div className="text-sm font-medium flex items-center gap-2">
                  {rules.dry_run && <AlertTriangle className="h-3.5 w-3.5 text-warn" />}
                  Dry-run mode
                </div>
                <p className="text-xs text-muted-foreground">Logs would-be buys without spending. Recommended for 1–2 weeks.</p>
              </div>
              <Switch checked={rules.dry_run} onCheckedChange={(v) => save({ dry_run: v })} />
            </label>
          </div>

          {/* Whitelist */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Ticker whitelist (empty = engine no-ops)</Label>
            <div className="flex flex-wrap gap-1.5">
              {whitelist.length === 0 && (
                <span className="text-xs text-muted-foreground">No tickers yet — add one to enable.</span>
              )}
              {whitelist.map((t) => (
                <Badge key={t} variant="outline" className="gap-1 pl-2 pr-1">
                  {t}
                  <button onClick={() => removeTicker(t)} className="hover:text-bear">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={tickerInput}
                onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTicker(); } }}
                placeholder="NVDA"
                className="ticker-mono max-w-[140px]"
              />
              <button
                type="button"
                onClick={addTicker}
                className="inline-flex h-10 items-center gap-1 rounded-md border border-border px-3 text-sm hover:bg-accent"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
          </div>

          {/* Filters */}
          <div className="grid sm:grid-cols-2 gap-4 pt-2">
            <Field label="Min tier (ELITE / GOLD / SILVER)">
              <Input defaultValue={rules.min_tier ?? ""} className="ticker-mono"
                onBlur={(e) => save({ min_tier: e.target.value.trim().toUpperCase() || null })} />
            </Field>
            <Field label="Min confidence (0–100)">
              <Input type="number" min={0} max={100} defaultValue={rules.min_confidence ?? ""} className="ticker-mono"
                onBlur={(e) => save({ min_confidence: e.target.value === "" ? null : Math.max(0, Math.min(100, Number(e.target.value))) })} />
            </Field>
            <Field label="Allowed directions">
              <div className="flex gap-2">
                {DIRS.map((d) => {
                  const on = (rules.allowed_directions ?? []).includes(d);
                  return (
                    <button key={d} type="button" onClick={() => toggleDir(d)}
                      className={`h-9 px-3 rounded-md border text-sm ${on ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                      {d}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Max premium $ per contract">
              <Input type="number" step="0.1" min={0} defaultValue={rules.max_premium_usd ?? ""} className="ticker-mono"
                onBlur={(e) => save({ max_premium_usd: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="Max $ risk per trade">
              <Input type="number" step="10" min={0} defaultValue={rules.max_risk_usd ?? ""} className="ticker-mono"
                onBlur={(e) => save({ max_risk_usd: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="Time window (ET start)">
              <Input type="time" defaultValue={(rules.start_time_et ?? "").slice(0, 5)} className="ticker-mono"
                onBlur={(e) => save({ start_time_et: e.target.value || null })} />
            </Field>
            <Field label="Time window (ET end)">
              <Input type="time" defaultValue={(rules.end_time_et ?? "").slice(0, 5)} className="ticker-mono"
                onBlur={(e) => save({ end_time_et: e.target.value || null })} />
            </Field>
            <Field label="Per-ticker cooldown (minutes)">
              <Input type="number" min={0} defaultValue={rules.cooldown_minutes} className="ticker-mono"
                onBlur={(e) => save({ cooldown_minutes: Math.max(0, Number(e.target.value || 0)) })} />
            </Field>
            <Field label="Max signal age (minutes)">
              <Input type="number" min={1} defaultValue={rules.max_signal_age_minutes} className="ticker-mono"
                onBlur={(e) => save({ max_signal_age_minutes: Math.max(1, Number(e.target.value || 1)) })} />
            </Field>
            <Field label="Max trades / day">
              <Input type="number" min={1} defaultValue={rules.max_trades_per_day} className="ticker-mono"
                onBlur={(e) => save({ max_trades_per_day: Math.max(1, Number(e.target.value || 1)) })} />
            </Field>
            <Field label="Daily spend cap $">
              <Input type="number" min={0} step="50" defaultValue={rules.daily_spend_cap_usd} className="ticker-mono"
                onBlur={(e) => save({ daily_spend_cap_usd: Math.max(0, Number(e.target.value || 0)) })} />
            </Field>
            <label className="flex items-center justify-between rounded-md border border-border px-3 py-3 sm:col-span-2">
              <div>
                <div className="text-sm font-medium">Skip if an open position already exists on the ticker</div>
                <p className="text-xs text-muted-foreground">Prevents stacking multiple paper trades on the same name.</p>
              </div>
              <Switch checked={rules.block_if_open_on_ticker} onCheckedChange={(v) => save({ block_if_open_on_ticker: v })} />
            </label>
          </div>

          {/* Recent activity */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Recent activity (last 20)</Label>
              <button onClick={loadAll} className="text-xs text-muted-foreground hover:text-foreground">Refresh</button>
            </div>
            {log.length === 0 ? (
              <p className="text-xs text-muted-foreground">No activity yet. Engine runs every minute during market hours.</p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-2">When</th>
                      <th className="text-left px-3 py-2">Ticker</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Reason / Trade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-3 py-1.5 text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="px-3 py-1.5 ticker-mono">{r.ticker}</td>
                        <td className="px-3 py-1.5">
                          <Badge variant="outline" className={
                            r.status === "fired" ? "border-bull/40 text-bull"
                            : r.status === "dry_run" ? "border-warn/40 text-warn"
                            : "border-border text-muted-foreground"
                          }>
                            {r.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {r.paper_trade_id ? <span className="ticker-mono">trade {r.paper_trade_id.slice(0, 8)}</span> : (r.skip_reason ?? "—")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Engine runs every minute during US market hours (Mon–Fri 09:30–16:00 ET). Honors
            kill switch, max-open-trades, and daily loss cap from Risk controls. Each signal
            can only fire once per user.
          </p>
        </>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
