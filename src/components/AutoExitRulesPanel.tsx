import { useEffect, useState } from "react";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

type Rules = {
  user_id: string;
  enabled: boolean;
  dry_run: boolean;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  trailing_stop_pct: number | null;
  time_exit_et: string | null; // "HH:MM" or "HH:MM:SS"
  theta_burn_pct: number | null;
};

export default function AutoExitRulesPanel() {
  const { user } = useAuth();
  const [rules, setRules] = useState<Rules | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await (supabase as any)
        .from("auto_exit_rules")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) setRules(data as Rules);
      else {
        // Create defaults row (all OFF, dry_run ON)
        const defaults: Rules = {
          user_id: user.id,
          enabled: false,
          dry_run: true,
          stop_loss_pct: -50,
          take_profit_pct: 100,
          trailing_stop_pct: 25,
          time_exit_et: "15:30",
          theta_burn_pct: null,
        };
        const { data: ins, error } = await (supabase as any)
          .from("auto_exit_rules")
          .insert(defaults)
          .select("*")
          .single();
        if (!error && ins) setRules(ins as Rules);
        else setRules(defaults);
      }
      setLoading(false);
    })();
  }, [user]);

  async function save(patch: Partial<Rules>) {
    if (!rules || !user) return;
    const next = { ...rules, ...patch };
    setRules(next);
    const { error } = await (supabase as any)
      .from("auto_exit_rules")
      .update(patch)
      .eq("user_id", user.id);
    if (error) toast.error(error.message);
  }

  const time = rules?.time_exit_et ? String(rules.time_exit_et).slice(0, 5) : "";

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> Auto-exit rules
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Automatically close open paper trades when a rule fires. Leave fields blank to
            disable that rule. Real money is never involved.
          </p>
        </div>
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
                <div className="text-sm font-medium">Enable auto-exit</div>
                <p className="text-xs text-muted-foreground">Master switch. Off = engine ignores you.</p>
              </div>
              <Switch checked={rules.enabled} onCheckedChange={(v) => save({ enabled: v })} />
            </label>
            <label className={`flex items-center justify-between rounded-md border px-3 py-3 ${rules.dry_run ? "border-warn/40 bg-warn/5" : "border-border"}`}>
              <div>
                <div className="text-sm font-medium flex items-center gap-2">
                  {rules.dry_run && <AlertTriangle className="h-3.5 w-3.5 text-warn" />}
                  Dry-run mode
                </div>
                <p className="text-xs text-muted-foreground">Logs would-be closes without acting. Turn off when you trust it.</p>
              </div>
              <Switch checked={rules.dry_run} onCheckedChange={(v) => save({ dry_run: v })} />
            </label>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 pt-2">
            <Field label="Stop-loss % (e.g. -50)">
              <Input type="number" step="1" defaultValue={rules.stop_loss_pct ?? ""} className="ticker-mono"
                onBlur={(e) => save({ stop_loss_pct: e.target.value === "" ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Take-profit % (e.g. 100)">
              <Input type="number" step="1" defaultValue={rules.take_profit_pct ?? ""} className="ticker-mono"
                onBlur={(e) => save({ take_profit_pct: e.target.value === "" ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Trailing stop % from peak (e.g. 25)">
              <Input type="number" step="1" min={0} defaultValue={rules.trailing_stop_pct ?? ""} className="ticker-mono"
                onBlur={(e) => save({ trailing_stop_pct: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="0DTE time exit (ET, HH:MM)">
              <Input type="time" defaultValue={time} className="ticker-mono"
                onBlur={(e) => save({ time_exit_et: e.target.value || null })} />
            </Field>
            <Field label="Theta burn % of premium / day (e.g. 0.05)">
              <Input type="number" step="0.01" min={0} defaultValue={rules.theta_burn_pct ?? ""} className="ticker-mono"
                onBlur={(e) => save({ theta_burn_pct: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
            </Field>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Engine runs every minute during US market hours (Mon–Fri 09:30–16:00 ET). Honors
            the kill switch above. Won&apos;t double-close. Closes use the latest mark price.
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
