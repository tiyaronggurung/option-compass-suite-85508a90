import { useState } from "react";
import { Mail, Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { toast } from "sonner";

export function InviteUserPanel() {
  const { isAdmin, loading } = useIsAdmin();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);

  if (loading || !isAdmin) return null;

  async function send() {
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast.error("Enter a valid email");
      return;
    }
    setSending(true);
    const { data, error } = await supabase.functions.invoke("invite-user", {
      body: { email: trimmed },
    });
    setSending(false);
    if (error || (data as any)?.error) {
      toast.error((data as any)?.error ?? error?.message ?? "Failed to send invite");
      return;
    }
    toast.success(`Invite sent to ${trimmed}`);
    setEmail("");
  }

  return (
    <section className="glass-card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <Mail className="h-4 w-4 text-primary" /> Invite users
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed">
        Sign-ups are disabled. Send an invite email so a new user can create their account.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1"
        />
        <Button onClick={send} disabled={sending || !email}>
          <Send className="h-4 w-4 mr-1.5" />
          {sending ? "Sending…" : "Send invite"}
        </Button>
      </div>
    </section>
  );
}
