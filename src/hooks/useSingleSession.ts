import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

const STORAGE_KEY = "tf_session_id";
const HEARTBEAT_MS = 30_000;

function getOrCreateSessionId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id =
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  const platform = (navigator as any).platform || "";
  return `${platform} · ${ua.slice(0, 80)}`;
}

/**
 * Enforces single-device login. On mount, claims this device as the active session.
 * Every 30s (and on focus), verifies the active session is still this device.
 * If another device has taken over, signs this device out and notifies the user.
 *
 * Last login wins.
 */
export function useSingleSession() {
  const { user } = useAuth();
  const claimedRef = useRef(false);

  useEffect(() => {
    if (!user) {
      claimedRef.current = false;
      return;
    }

    let cancelled = false;
    const sessionId = getOrCreateSessionId();

    const claim = async () => {
      try {
        await supabase
          .from("active_sessions")
          .upsert(
            {
              user_id: user.id,
              session_id: sessionId,
              device_label: deviceLabel(),
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "user_id" },
          );
        claimedRef.current = true;
      } catch (e) {
        // Silent — don't block the user if the table is briefly unreachable.
        console.warn("[single-session] claim failed", e);
      }
    };

    const check = async () => {
      if (cancelled) return;
      try {
        const { data, error } = await supabase
          .from("active_sessions")
          .select("session_id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error || cancelled) return;

        if (data && data.session_id && data.session_id !== sessionId) {
          // Someone else logged in. Kick this device.
          localStorage.removeItem(STORAGE_KEY);
          toast.error("Signed out", {
            description: "Your account was opened on another device.",
          });
          await supabase.auth.signOut();
        } else {
          // Touch last_seen_at
          await supabase
            .from("active_sessions")
            .update({ last_seen_at: new Date().toISOString() })
            .eq("user_id", user.id)
            .eq("session_id", sessionId);
        }
      } catch (e) {
        console.warn("[single-session] check failed", e);
      }
    };

    claim();
    const interval = window.setInterval(check, HEARTBEAT_MS);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [user]);
}
