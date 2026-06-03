import { useEffect, useState } from "react";
import { Bell, BellOff, Mail, MessageSquare, Phone, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { DisclaimerBar } from "@/components/Disclaimer";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["alert_settings"]["Row"];

export default function Alerts() {
  const { user } = useAuth();
  const [s, setS] = useState<Settings | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>("default");

  useEffect(() => {
    if ("Notification" in window) setPermission(Notification.permission);
    supabase.from("alert_settings").select("*").eq("user_id", user!.id).maybeSingle()
      .then(({ data }) => setS(data as Settings | null));
  }, [user]);

  async function save(patch: Partial<Settings>) {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    const { error } = await supabase.from("alert_settings").update(patch).eq("user_id", user!.id);
    if (error) toast.error(error.message);
  }

  async function enableBrowserPush(enable: boolean) {
    if (!("Notification" in window)) {
      toast.error("This browser doesn't support notifications.");
      return;
    }
    if (enable && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      setPermission(p);
      if (p !== "granted") {
        toast.error("Permission denied. Enable notifications in your browser settings.");
        return;
      }
    }
    await save({ browser_push_enabled: enable });
    if (enable) {
      try { new Notification("OptionFlow alerts enabled", { body: "You'll receive alerts that match your thresholds." }); } catch {}
    }
  }

  if (!s) {
    return <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in max-w-4xl">
      <header>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Alerts</h1>
        <p className="text-sm text-muted-foreground">Choose what gets pushed, where, and at what threshold.</p>
      </header>

      <section className="glass-card p-5 space-y-4">
        <h2 className="font-semibold flex items-center gap-2"><Bell className="h-4 w-4 text-primary" /> Thresholds</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Minimum confidence (0–100)">
            <Input type="number" min={0} max={100} defaultValue={s.min_confidence} className="w-28 ticker-mono"
              onBlur={(e) => save({ min_confidence: Math.max(0, Math.min(100, Number(e.target.value))) })} />
          </Field>
          <Field label="Maximum risk level">
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={s.max_risk_level}
              onChange={(e) => save({ max_risk_level: e.target.value })}
            >
              <option value="LOW">LOW only</option>
              <option value="MEDIUM">Up to MEDIUM</option>
              <option value="HIGH">Up to HIGH</option>
            </select>
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 pt-2">
          <Toggle label="Watchlist tickers only" v={s.watchlist_only} on={(v) => save({ watchlist_only: v })} />
          <Toggle label="Include 0DTE alerts" v={s.include_0dte} on={(v) => save({ include_0dte: v })} />
          <Toggle label="Bullish (CALL) only" v={s.bullish_only} on={(v) => save({ bullish_only: v, bearish_only: v ? false : s.bearish_only })} />
          <Toggle label="Bearish (PUT) only" v={s.bearish_only} on={(v) => save({ bearish_only: v, bullish_only: v ? false : s.bullish_only })} />
        </div>

        <div className="pt-2">
          <Field label="Cooldown (suppress repeats for same ticker + direction + source)">
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={s.cooldown_minutes ?? 15}
              onChange={(e) => save({ cooldown_minutes: Number(e.target.value) })}
            >
              <option value={0}>Off</option>
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>60 minutes</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="glass-card p-5 space-y-4">
        <h2 className="font-semibold">Channels</h2>

        <Channel
          icon={Bell}
          name="Browser push"
          status={
            s.browser_push_enabled && permission === "granted" ? <Badge className="bg-bull/15 text-bull border-0">Active</Badge> :
            permission === "denied" ? <Badge className="bg-bear/15 text-bear border-0">Permission denied</Badge> :
            <Badge className="bg-muted text-muted-foreground border-0">Off</Badge>
          }
          right={
            <Switch checked={s.browser_push_enabled} onCheckedChange={enableBrowserPush} />
          }
        >
          <p className="text-xs text-muted-foreground">
            Live in this browser tab. Shows desktop notifications for matching signals while OptionFlow is open.
          </p>
          {s.browser_push_enabled && permission === "granted" && (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => {
              try { new Notification("Test notification", { body: "If you see this, alerts are wired up." }); }
              catch { toast.error("Couldn't show notification."); }
            }}>
              Send test
            </Button>
          )}
        </Channel>

        <Channel
          icon={Mail} name="Email"
          status={<PlaceholderBadge />}
          right={<Switch checked={s.email_enabled} onCheckedChange={(v) => save({ email_enabled: v })} />}
        >
          <Field label="Send to">
            <Input type="email" defaultValue={s.notify_email ?? ""} className="max-w-xs"
              onBlur={(e) => save({ notify_email: e.target.value })} />
          </Field>
        </Channel>

        <Channel
          icon={Send} name="Telegram"
          status={<PlaceholderBadge />}
          right={<Switch checked={s.telegram_enabled} onCheckedChange={(v) => save({ telegram_enabled: v })} />}
        >
          <Field label="Telegram chat ID">
            <Input defaultValue={s.telegram_chat_id ?? ""} placeholder="e.g. 123456789" className="max-w-xs"
              onBlur={(e) => save({ telegram_chat_id: e.target.value })} />
          </Field>
        </Channel>

        <Channel
          icon={MessageSquare} name="Discord"
          status={<PlaceholderBadge />}
          right={<Switch checked={s.discord_enabled} onCheckedChange={(v) => save({ discord_enabled: v })} />}
        >
          <Field label="Webhook URL">
            <Input defaultValue={s.discord_webhook_url ?? ""} placeholder="https://discord.com/api/webhooks/…" className="max-w-md"
              onBlur={(e) => save({ discord_webhook_url: e.target.value })} />
          </Field>
        </Channel>

        <Channel
          icon={Phone} name="SMS"
          status={<PlaceholderBadge />}
          right={<Switch checked={s.sms_enabled} onCheckedChange={(v) => save({ sms_enabled: v })} />}
        >
          <Field label="Phone number">
            <Input defaultValue={s.sms_phone ?? ""} placeholder="+1 555 555 5555" className="max-w-xs"
              onBlur={(e) => save({ sms_phone: e.target.value })} />
          </Field>
        </Channel>
      </section>

      <DisclaimerBar />
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

function Toggle({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-md border border-border px-3 py-2.5 text-sm cursor-pointer">
      <span>{label}</span>
      <Switch checked={v} onCheckedChange={on} />
    </label>
  );
}

function Channel({ icon: Icon, name, status, right, children }: any) {
  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-md bg-primary/10 text-primary grid place-items-center">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-medium">{name}</div>
            <div className="mt-0.5">{status}</div>
          </div>
        </div>
        {right}
      </div>
      <div className="mt-3 space-y-2">{children}</div>
    </div>
  );
}

function PlaceholderBadge() {
  return <Badge variant="outline" className="border-warn/40 text-warn text-[10px]"><BellOff className="h-3 w-3 mr-1" />Saved · sending not wired</Badge>;
}
