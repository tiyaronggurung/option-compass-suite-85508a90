import { useEffect, useState } from "react";
import { ShieldCheck, Smartphone, Loader2, Trash2, Copy, Check, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Factor = { id: string; friendly_name?: string | null; status: string; factor_type: string };

export default function TwoFactorPanel() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [pending, setPending] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  async function refresh() {
    setLoading(true);
    const { data, error } = await supabase.auth.mfa.listFactors();
    setLoading(false);
    if (error) return toast.error(error.message);
    const totp = (data?.totp ?? []) as Factor[];
    setFactors(totp);
  }

  useEffect(() => { refresh(); }, []);

  const verified = factors.filter((f) => f.status === "verified");
  const isEnabled = verified.length > 0;

  async function startEnroll() {
    setEnrolling(true);
    // Remove any previous unverified factor to avoid friendly_name conflicts
    const unverified = factors.find((f) => f.status === "unverified");
    if (unverified) await supabase.auth.mfa.unenroll({ factorId: unverified.id });
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
    });
    setEnrolling(false);
    if (error || !data) return toast.error(error?.message ?? "Could not start enrollment");
    setPending({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setCode("");
  }

  async function verifyEnroll() {
    if (!pending) return;
    if (!/^\d{6}$/.test(code)) return toast.error("Enter the 6-digit code");
    setVerifying(true);
    const { data: chal, error: chalErr } = await supabase.auth.mfa.challenge({ factorId: pending.factorId });
    if (chalErr || !chal) {
      setVerifying(false);
      return toast.error(chalErr?.message ?? "Challenge failed");
    }
    const { error } = await supabase.auth.mfa.verify({
      factorId: pending.factorId,
      challengeId: chal.id,
      code,
    });
    setVerifying(false);
    if (error) return toast.error(error.message);
    toast.success("Two-factor authentication enabled");
    setPending(null);
    setCode("");
    refresh();
  }

  async function cancelEnroll() {
    if (!pending) return;
    await supabase.auth.mfa.unenroll({ factorId: pending.factorId });
    setPending(null);
    setCode("");
    refresh();
  }

  async function removeFactor(id: string) {
    const ok = window.confirm("Remove this authenticator? You will no longer be asked for a code at sign-in.");
    if (!ok) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
    if (error) return toast.error(error.message);
    toast.success("Two-factor authentication removed");
    refresh();
  }

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> Two-factor authentication
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Optional. Add a 6-digit code from Google Authenticator, Authy, or 1Password to your sign-in.
          </p>
        </div>
        <div className={`text-[10px] uppercase tracking-[0.2em] px-2 py-1 rounded-sm border ${isEnabled ? "border-primary/40 text-primary bg-primary/10" : "border-border text-muted-foreground"}`}>
          {isEnabled ? "Enabled" : "Off"}
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : pending ? (
        <div className="space-y-3 rounded-md border border-border p-4 bg-background/40">
          <div className="text-sm font-medium flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" /> Scan this QR code
          </div>
          <p className="text-xs text-muted-foreground">
            Open your authenticator app and scan the QR. Or paste the secret manually. Then enter the 6-digit code below.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <img src={pending.qr} alt="2FA QR code" className="h-40 w-40 rounded bg-white p-2" />
            <div className="space-y-2 flex-1 min-w-0">
              <Label className="text-xs text-muted-foreground">Manual entry secret</Label>
              <Input readOnly value={pending.secret} className="ticker-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Label className="text-xs text-muted-foreground pt-2 block">6-digit code</Label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                className="ticker-mono tracking-[0.4em] text-lg"
              />
              <div className="flex gap-2 pt-1">
                <Button onClick={verifyEnroll} disabled={verifying || code.length !== 6} size="sm">
                  {verifying && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Verify & enable
                </Button>
                <Button onClick={cancelEnroll} variant="ghost" size="sm">Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      ) : isEnabled ? (
        <div className="space-y-2">
          {verified.map((f) => (
            <div key={f.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <Smartphone className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm truncate">{f.friendly_name || "Authenticator app"}</div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">TOTP · Active</div>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeFactor(f.id)} className="text-bear hover:text-bear">
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Button onClick={startEnroll} disabled={enrolling} size="sm">
          {enrolling && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          <Smartphone className="h-3.5 w-3.5 mr-1.5" /> Set up authenticator app
        </Button>
      )}
    </section>
  );
}
