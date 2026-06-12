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

    let cancelled = false;
    let currentChannel: ReturnType<typeof supabase.channel> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    const handleInsert = (payload: { new: Signal }) => {
      const sig = payload.new;
      if ((sig as unknown as { is_demo?: boolean }).is_demo) return;
      // Only notify for signals that actually appear as Developing-Signal cards
      if (sig.hidden === true) return;
      if (sig.tier === "rejected") return;
      const conf = Number(sig.confidence ?? 0);
      if (conf < 60 || conf > 100) return;

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
    };

    const connect = () => {
      if (cancelled) return;
      const channel = supabase
        .channel(`signal-notif-stream-${Date.now()}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "signals" },
          handleInsert as (payload: { new: Signal }) => void
        )
        .subscribe((status) => {
          if (import.meta.env.DEV) {
            console.log("[signal-notif] channel status:", status);
          }
          if (status === "SUBSCRIBED") {
            retryDelay = 1000;
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            if (cancelled) return;
            if (currentChannel) {
              supabase.removeChannel(currentChannel);
              currentChannel = null;
            }
            retryTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 15000);
          }
        });
      currentChannel = channel;
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (currentChannel) supabase.removeChannel(currentChannel);
    };
  }, [user]);
}
