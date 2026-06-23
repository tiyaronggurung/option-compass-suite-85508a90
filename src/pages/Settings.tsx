import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck, Monitor } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar, DISCLAIMER_TEXT } from "@/components/Disclaimer";
import { ProviderEnginesPanel } from "@/components/ProviderEnginesPanel";
import { EarningsCalendarPanel } from "@/components/EarningsCalendarPanel";
import { SignalModePanel } from "@/components/SignalModePanel";
import { SignalAuditPanel } from "@/components/SignalAuditPanel";
import { InviteUserPanel } from "@/components/InviteUserPanel";
import SignalLearningPanel from "@/components/SignalLearningPanel";
import MarkingEngineStatus from "@/components/MarkingEngineStatus";
import OptionsChainPanel from "@/components/OptionsChainPanel";
import SignalScannerPanel from "@/components/SignalScannerPanel";
import ScannerUniversePanel from "@/components/ScannerUniversePanel";
import ConfirmationProvidersPanel from "@/components/ConfirmationProvidersPanel";
import TwoFactorPanel from "@/components/TwoFactorPanel";
import AutoExitRulesPanel from "@/components/AutoExitRulesPanel";
import AutoEntryRulesPanel from "@/components/AutoEntryRulesPanel";
import ExitDecisionsPanel from "@/components/ExitDecisionsPanel";
import BrokerExecutionPanel from "@/components/BrokerExecutionPanel";
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
      <SectionHeader title="Account & Security" subtitle="Risk limits, two-factor auth, invites, and paper account." />

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

      <AutoExitRulesPanel />

      <ExitDecisionsPanel />

      <AutoEntryRulesPanel />

      <BrokerExecutionPanel />

      <ActiveSessionPanel />

      <TwoFactorPanel />

      <InviteUserPanel />

      <ResetPaperAccountPanel />

      <SectionHeader title="Signal Engine" subtitle="Mode, audit, learning, scanning, and confirmations." />

      <SignalModePanel />

      <SignalAuditPanel />

      <SignalLearningPanel />

      <MarkingEngineStatus />

      <SignalScannerPanel />

      <ScannerUniversePanel />

      <ConfirmationProvidersPanel />

      <SectionHeader title="Data & Integrations" subtitle="Provider engines, earnings calendar, and options chain." />

      <ProviderEnginesPanel />

      <EarningsCalendarPanel />

      <OptionsChainPanel />

      <SectionHeader title="Compliance" subtitle="Legal disclaimer and acknowledgements." />

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

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="pt-4 pb-1 border-b border-border/60">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground/70 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function ResetPaperAccountPanel() {
  const [resetting, setResetting] = useState(false);

  async function onReset() {
    const ok = window.confirm(
      "This will clear/reset your paper balance and paper performance history. Continue?"
    );
    if (!ok) return;
    setResetting(true);
    const { error } = await (supabase as any).rpc("reset_paper_account");
    setResetting(false);
    if (error) return toast.error(error.message);
    toast.success("Paper account reset to $10,000");
  }

  return (
    <section className="glass-card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-warn" /> Paper account
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed">
        Reset your paper trading account back to the $10,000 starting balance. This deletes
        all open and closed paper trades and their related alerts. Real money is never involved.
      </p>
      <button
        type="button"
        onClick={onReset}
        disabled={resetting}
        className="inline-flex h-9 items-center justify-center rounded-md border border-bear/40 bg-bear/10 px-4 text-sm font-medium text-bear hover:bg-bear/20 disabled:opacity-50"
      >
        {resetting ? "Resetting…" : "Reset Paper Account"}
      </button>
    </section>
  );
}

function ActiveSessionPanel() {
  const { user } = useAuth();
  const [session, setSession] = useState<{ device_label: string; last_seen_at: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase.from("active_sessions")
      .select("device_label,last_seen_at")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => setSession(data));
  }, [user]);

  function parseDevice(label: string): string {
    // Label format: "platform · userAgent"
    const parts = label.split(" · ");
    const ua = parts[1] || parts[0] || "";
    const platform = parts[0] || "";

    const osMatch = ua.match(/(Windows|Mac OS X|Linux|Android|iOS|iPhone|iPad)/i);
    const os = osMatch ? osMatch[0] : platform;

    const browserMatch = ua.match(/(Chrome|Safari|Firefox|Edge|Opera)\//i);
    const browser = browserMatch ? browserMatch[1] : "Browser";

    return `${os} · ${browser}`;
  }

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return "Just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  if (!session) return null;

  return (
    <section className="glass-card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <Monitor className="h-4 w-4 text-primary" /> Active Session
      </h2>
      <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{parseDevice(session.device_label)}</p>
          <p className="text-xs text-muted-foreground">Last seen {relativeTime(session.last_seen_at)}</p>
        </div>
        <span className="inline-flex items-center rounded-full bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-500 ring-1 ring-inset ring-green-500/20">
          Active
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Only one device can be signed in at a time. Signing in elsewhere will sign this device out.
      </p>
    </section>
  );
}

