import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { z } from "zod";
import { Activity, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { DisclaimerBar } from "@/components/Disclaimer";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email").max(255),
  password: z.string().min(8, "At least 8 characters").max(72),
});

export default function AuthPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!loading && user) navigate("/app", { replace: true }); }, [user, loading, navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: parsed.data.email,
          password: parsed.data.password,
          options: { emailRedirectTo: `${window.location.origin}/app` },
        });
        if (error) throw error;
        toast.success("Account created. Welcome to the desk.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: parsed.data.email,
          password: parsed.data.password,
        });
        if (error) throw error;
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-10 relative overflow-hidden border-r border-border"
        style={{ backgroundImage: "var(--gradient-hero)" }}>
        <Link to="/" className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-md bg-primary/20 text-primary grid place-items-center">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Tradingflow</div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-primary">101</div>
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
        <div className="text-xs text-muted-foreground">© Tradingflow 101 — educational use only.</div>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-6 flex items-center gap-2">
            <div className="h-8 w-8 rounded-md bg-primary/15 text-primary grid place-items-center">
              <Activity className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold">Tradingflow <span className="text-primary">101</span></span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Sign in to the desk</h2>
          <p className="text-sm text-muted-foreground mt-1">Educational paper-trading dashboard.</p>

          <Tabs value={mode} onValueChange={(v) => setMode(v as any)} className="mt-6">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Create account</TabsTrigger>
            </TabsList>
            <TabsContent value={mode}>
              <form onSubmit={submit} className="space-y-4 mt-6">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" autoComplete="email" value={email}
                    onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password"
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {mode === "signup" ? "Create account" : "Sign in"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
