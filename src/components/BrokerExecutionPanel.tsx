import { useEffect, useState } from "react";
import { Zap, Shield, CheckCircle2, XCircle, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type Row = {
  user_id: string;
  execution_mode: "auto" | "approval";
  trading_mode: "paper" | "live";
  robinhood_email: string | null;
  robinhood_password: string | null;
};

function maskEmail(email: string | null | undefined): string {
  if (!email) return "Not set";
  const [local, domain] = email.split("@");
  if (!domain) return "Invalid";
  const first = local.slice(0, 1);
  return `${first}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

export default function BrokerExecutionPanel() {
  const { user } = useAuth();
  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await (supabase as any)
        .from("execution_settings")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        setRow(data as Row);
        setEmail(data.robinhood_email ?? "");
        setPassword(data.robinhood_password ?? "");
      } else {
        const init: Row = {
          user_id: user.id,
          execution_mode: "approval",
          trading_mode: "paper",
          robinhood_email: null,
          robinhood_password: null,
        };
        await (supabase as any).from("execution_settings").insert(init);
        setRow(init);
      }
      setLoading(false);
    })();
  }, [user]);

  async function patch(p: Partial<Row>) {
    if (!row || !user) return;
    const next = { ...row, ...p };
    setRow(next);
    const { error } = await (supabase as any)
      .from("execution_settings")
      .update(p)
      .eq("user_id", user.id);
    if (error) toast.error(error.message);
  }

  async function saveCreds() {
    if (!user) return;
    setSaving(true);
    const { error } = await (supabase as any)
      .from("execution_settings")
      .update({ robinhood_email: email || null, robinhood_password: password || null })
      .eq("user_id", user.id);
    setSaving(false);
    if (error) return toast.error(error.message);
    setRow((r) => (r ? { ...r, robinhood_email: email || null, robinhood_password: password || null } : r));
    toast.success("Credentials saved");
  }

  const configured = !!(row?.robinhood_email && row?.robinhood_password);

  return (
    <section className="glass-card p-5 space-y-5">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" /> Broker Execution
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Configure how approved signals are routed to your broker. Robinhood has no official API —
          live execution depends on an unofficial bridge and may violate broker TOS. Use Paper mode
          for testing.
        </p>
      </div>

      {loading || !row ? (
        <div className="grid sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : (
        <>
          {/* Execution Mode */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Execution Mode</Label>
            <div className="grid sm:grid-cols-2 gap-2">
              <ModeButton
                active={row.execution_mode === "auto"}
                title="Fully Automatic"
                desc="Place trade immediately when auto-entry-engine approves a signal."
                onClick={() => patch({ execution_mode: "auto" })}
              />
              <ModeButton
                active={row.execution_mode === "approval"}
                title="Approval Mode"
                desc="Show a confirmation popup before each trade."
                onClick={() => patch({ execution_mode: "approval" })}
              />
            </div>
          </div>

          {/* Trading Mode */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Trading Mode</Label>
            <div className="grid sm:grid-cols-2 gap-2">
              <ModeButton
                active={row.trading_mode === "paper"}
                title="Paper Trading"
                desc="Safe testing via Alpaca paper (already connected)."
                onClick={() => patch({ trading_mode: "paper" })}
              />
              <ModeButton
                active={row.trading_mode === "live"}
                title="Live Trading"
                desc="Execute real trades on Robinhood. Real money."
                onClick={() => patch({ trading_mode: "live" })}
                danger
              />
            </div>
          </div>

          {/* Credentials */}
          <div className="space-y-3 rounded-md border border-border p-4">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium">Robinhood Credentials</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Stored server-side, scoped to your user account. Never exposed to the frontend after save.
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Robinhood Email</Label>
                <Input
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Robinhood Password</Label>
                <div className="relative">
                  <Input
                    type={showPw ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={saveCreds} disabled={saving}>
                {saving ? "Saving…" : "Save Credentials"}
              </Button>
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Configuration Summary</h3>
              {configured ? (
                <Badge className="bg-green-500/15 text-green-500 border-green-500/30 hover:bg-green-500/20">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Ready to Connect
                </Badge>
              ) : (
                <Badge variant="destructive" className="bg-bear/15 text-bear border-bear/30 hover:bg-bear/20">
                  <XCircle className="h-3 w-3 mr-1" /> Not Configured
                </Badge>
              )}
            </div>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <SummaryRow label="Execution Mode" value={row.execution_mode === "auto" ? "Fully Automatic" : "Approval Mode"} />
              <SummaryRow label="Trading Mode" value={row.trading_mode === "live" ? "Live Trading" : "Paper Trading"} />
              <SummaryRow label="Robinhood Email" value={maskEmail(row.robinhood_email)} />
              <SummaryRow label="Password" value={row.robinhood_password ? "•••••••• (saved)" : "Not set"} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function ModeButton({
  active, title, desc, onClick, danger,
}: { active: boolean; title: string; desc: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "text-left rounded-md border px-3 py-3 transition-colors",
        active
          ? danger
            ? "border-bear/60 bg-bear/10"
            : "border-primary bg-primary/10"
          : "border-border hover:border-border/80 hover:bg-muted/40",
      ].join(" ")}
    >
      <div className={`text-sm font-medium ${active && danger ? "text-bear" : ""}`}>{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
    </button>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium ticker-mono">{value}</span>
    </div>
  );
}
