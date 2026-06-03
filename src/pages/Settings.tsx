import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar, DISCLAIMER_TEXT } from "@/components/Disclaimer";
import { ProviderEnginesPanel } from "@/components/ProviderEnginesPanel";
import { SignalModePanel } from "@/components/SignalModePanel";
import { SignalAuditPanel } from "@/components/SignalAuditPanel";
import SignalLearningPanel from "@/components/SignalLearningPanel";
import MarkingEngineStatus from "@/components/MarkingEngineStatus";
import OptionsChainPanel from "@/components/OptionsChainPanel";
import SignalScannerPanel from "@/components/SignalScannerPanel";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

type Risk = Database["public"]["Tables"]["risk_settings"]["Row"];

export default function Settings() {
  const { user } = useAuth();
  const [risk, setRisk] = useState<Risk | null>(null);

  useEffect(() => {
    supabase.from("risk_settings").select("*").eq("user_id", user!.id).maybeSingle()
      .then(({ data }) => setRisk(data as Risk | null));
  }, [user]);

  async function save(patch: Partial<Risk>) {
    if (!risk) return;
    setRisk({ ...risk, ...patch });
    const { error } = await supabase.from("risk_settings").update(patch).eq("user_id", user!.id);
    if (error) toast.error(error.message);
  }

  return (
    <div className="space-y-6 animate-fade-in max-w-4xl">
      <header>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Risk controls, data sources, and compliance.</p>
      </header>

      <section className="glass-card p-5 space-y-4">
        <h2 className="font-semibold flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /> Risk controls</h2>
        {!risk ? (
          <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Max risk per trade ($)">
              <Input type="number" min={0} step={10} defaultValue={Number(risk.max_risk_per_trade)} className="ticker-mono"
                onBlur={(e) => save({ max_risk_per_trade: Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="Daily loss cap ($)">
              <Input type="number" min={0} step={50} defaultValue={Number(risk.daily_loss_cap)} className="ticker-mono"
                onBlur={(e) => save({ daily_loss_cap: Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="Max open trades">
              <Input type="number" min={1} max={50} defaultValue={risk.max_open_trades} className="ticker-mono"
                onBlur={(e) => save({ max_open_trades: Math.max(1, Math.min(50, Number(e.target.value))) })} />
            </Field>
            <div className="space-y-3 sm:col-span-2">
              <label className="flex items-center justify-between rounded-md border border-border px-3 py-3">
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    Require manual approval
                  </div>
                  <p className="text-xs text-muted-foreground">No signal becomes a paper trade until you click Approve.</p>
                </div>
                <Switch checked={risk.require_manual_approval} onCheckedChange={(v) => save({ require_manual_approval: v })} />
              </label>
              <label className={`flex items-center justify-between rounded-md border px-3 py-3 ${risk.kill_switch ? "border-bear/40 bg-bear/5" : "border-border"}`}>
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    <ShieldAlert className={`h-4 w-4 ${risk.kill_switch ? "text-bear" : "text-muted-foreground"}`} /> Kill switch
                  </div>
                  <p className="text-xs text-muted-foreground">When on, the engine pauses all new alerts and trade approvals.</p>
                </div>
                <Switch checked={risk.kill_switch} onCheckedChange={(v) => save({ kill_switch: v })} />
              </label>
            </div>
          </div>
        )}
      </section>

      <SignalModePanel />

      <ProviderEnginesPanel />

      <SignalAuditPanel />

      <SignalLearningPanel />

      <MarkingEngineStatus />

      <OptionsChainPanel />

      <section className="glass-card p-5 space-y-3">
        <h2 className="font-semibold flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-warn" /> Compliance</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">{DISCLAIMER_TEXT}</p>
        <DisclaimerBar />
      </section>
    </div>
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
