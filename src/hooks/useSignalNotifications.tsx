import { useEffect } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { signalNotifStore, playChime } from "@/lib/signalNotificationsStore";
import type { Database } from "@/integrations/supabase/types";

type Signal = Database["public"]["Tables"]["signals"]["Row"];

/**
 * Global in-app notifications for newly-arrived signals.
 * - Pushes to the in-memory store (powers the bell dropdown + unread badge).
 * - Plays a chime (if user-enabled).
 * - Shows a sonner toast.
 *
 * Browser push notifications are handled separately by useBrowserPush.
 * Realtime is already enabled on the `signals` table.
 */
export function useSignalNotifications() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel("signal-notif-stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "signals" },
        (payload) => {
          const sig = payload.new as Signal;
          if (sig.hidden) return;
          if ((sig as unknown as { is_demo?: boolean }).is_demo) return;

          signalNotifStore.push({
            id: sig.id,
            ticker: sig.ticker,
            direction: sig.direction,
            confidence: sig.confidence,
            risk_level: sig.risk_level,
            contract_symbol: sig.contract_symbol ?? null,
            received_at: Date.now(),
          });

          if (signalNotifStore.soundEnabled) playChime();

          toast(`${sig.ticker} · ${sig.direction}`, {
            description: `${sig.confidence}/100 · ${sig.risk_level} risk${sig.contract_symbol ? ` · ${sig.contract_symbol}` : ""}`,
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);
}
