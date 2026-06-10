import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { z } from "zod";
import { Activity, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { DisclaimerBar } from "@/components/Disclaimer";
import { ThemeToggle } from "@/components/ThemeToggle";
import logoAsset from "@/assets/xalgoflow-logo.png.asset.json";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email").max(255),
  password: z.string().min(8, "At least 8 characters").max(72),
});

export default function AuthPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // MFA challenge state — set when a signed-in session needs a 2nd factor before /app.
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  async function checkAndPrepareMfa(): Promise<boolean> {
    try {
      const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalErr || !aal) return false;
      if (aal.currentLevel === "aal1" && aal.nextLevel === "aal2") {
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const totp = factors?.totp?.find((f) => f.status === "verified");
        if (!totp) return false;
        const { data: chal, error: chalErr } = await supabase.auth.mfa.challenge({ factorId: totp.id });
        if (chalErr || !chal) {
          toast.error(chalErr?.message ?? "Could not start 2FA challenge");
          await supabase.auth.signOut();
          return false;
        }
        setMfaFactorId(totp.id);
        setMfaChallengeId(chal.id);
        setMfaCode("");
        return true;
      }
    } catch {
      // not required
    }
    return false;
  }

  useEffect(() => {
    if (loading || !user) return;
    if (mfaFactorId) return;
    let cancelled = false;
    (async () => {
      const needs = await checkAndPrepareMfa();
      if (cancelled) return;
      if (!needs) navigate("/app", { replace: true });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading]);

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaFactorId || !mfaChallengeId) return;
    if (!/^\d{6}$/.test(mfaCode)) return toast.error("Enter the 6-digit code");
    setMfaBusy(true);
    const { error } = await supabase.auth.mfa.verify({
      factorId: mfaFactorId,
      challengeId: mfaChallengeId,
      code: mfaCode,
    });
    setMfaBusy(false);
    if (error) return toast.error(error.message);
    setMfaFactorId(null);
    setMfaChallengeId(null);
    setMfaCode("");
    navigate("/app", { replace: true });
  }

  async function cancelMfa() {
    setMfaFactorId(null);
    setMfaChallengeId(null);
    setMfaCode("");
    await supabase.auth.signOut();
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: parsed.data.email,
        password: parsed.data.password,
      });
      if (error) throw error;
    } catch (err: any) {
      toast.error(err?.message ?? "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: { emailRedirectTo: `${window.location.origin}/app` },
      });
      if (error) throw error;
      toast.success("Account created — you're signed in.");
    } catch (err: any) {
      toast.error(err?.message ?? "Sign up failed");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setBusy(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: `${window.location.origin}/app`,
      });
      if (result.error) throw new Error(result.error.message ?? "Google sign-in failed");
      if (result.redirected) return;
    } catch (err: any) {
      toast.error(err?.message ?? "Google sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 relative">
      <div className="absolute top-3 right-3 z-20">
        <ThemeToggle />
      </div>
      <div className="hidden lg:flex flex-col justify-between p-10 relative overflow-hidden border-r border-border"
        style={{ backgroundImage: "var(--gradient-hero)" }}>
        <Link to="/" className="flex items-center gap-2">
          <img src={logoAsset.url} alt="Xalgoflow" className="h-10 w-10 object-contain" />
          <div>
            <div className="text-sm font-semibold tracking-tight">Xalgoflow</div>
          </div>
        </Link>
        <div className="space-y-4 max-w-md">
          <h1 className="text-4xl font-semibold tracking-tight">
            Options signals, <span className="text-primary">explained</span> before you click.
          </h1>
          <p className="text-muted-foreground">
            A trading-desk dashboard for research and paper trading — watch live signals, review the AI's reasoning,
            and approve manual paper trades. Built for learning, not for guarantees.
          </p>
          <DisclaimerBar />
        </div>
        <div className="text-xs text-muted-foreground">© Xalgoflow — educational use only.</div>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-6 flex items-center gap-2">
            <img src={logoAsset.url} alt="Xalgoflow" className="h-9 w-9 object-contain" />
            <span className="text-sm font-semibold">Xalgoflow</span>
          </div>
          {mfaFactorId ? (
            <>
              <h2 className="text-2xl font-semibold tracking-tight">Two-factor code</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Enter the 6-digit code from your authenticator app to finish signing in.
              </p>
              <form onSubmit={submitMfa} className="space-y-4 mt-6">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-code">Authenticator code</Label>
                  <Input
                    id="mfa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="123456"
                    className="ticker-mono tracking-[0.4em] text-lg text-center"
                  />
                </div>
                <Button type="submit" disabled={mfaBusy || mfaCode.length !== 6} className="w-full">
                  {mfaBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Verify
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={cancelMfa}>
                  Cancel & sign out
                </Button>
              </form>
            </>
          ) : (
          <>
          <h2 className="text-2xl font-semibold tracking-tight">Welcome to the desk</h2>
          <p className="text-sm text-muted-foreground mt-1">Sign in or create a new account.</p>

          <Button type="button" variant="outline" disabled={busy} onClick={signInWithGoogle} className="w-full mt-6">
            <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.5-1.7 4.4-5.5 4.4-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.7 14.7 2.8 12 2.8 6.9 2.8 2.8 6.9 2.8 12s4.1 9.2 9.2 9.2c5.3 0 8.8-3.7 8.8-9 0-.6-.1-1-.2-1.5H12z"/>
            </svg>
            Continue with Google
          </Button>
          <div className="my-4 flex items-center gap-2 text-[11px] text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> OR <div className="h-px flex-1 bg-border" />
          </div>

          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Sign up</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form onSubmit={signIn} className="space-y-4 mt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email-in">Email</Label>
                  <Input id="email-in" type="email" autoComplete="email" value={email}
                    onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password-in">Password</Label>
                  <Input id="password-in" type="password" autoComplete="current-password"
                    value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Sign in
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={signUp} className="space-y-4 mt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email-up">Email</Label>
                  <Input id="email-up" type="email" autoComplete="email" value={email}
                    onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password-up">Password</Label>
                  <Input id="password-up" type="password" autoComplete="new-password"
                    value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <p className="text-[11px] text-muted-foreground">At least 8 characters.</p>
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create account
                </Button>
              </form>
            </TabsContent>
          </Tabs>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

