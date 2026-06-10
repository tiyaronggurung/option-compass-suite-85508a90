import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { Database } from "@/integrations/supabase/types";

type Signal = Database["public"]["Tables"]["signals"]["Row"];
type AlertSettings = Database["public"]["Tables"]["alert_settings"]["Row"];

const RISK_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

/**
 * Foreground browser-push: when a new signal arrives via realtime and matches
 * the user's alert thresholds, show a Notification. Requires user-granted permission.
 * Suppresses duplicate pushes for the same ticker+direction+source within
 * `cooldown_minutes` (per-user setting).
 */
export function useBrowserPush() {
  const { user } = useAuth();
  const settingsRef = useRef<AlertSettings | null>(null);
  const watchlistRef = useRef<Set<string>>(new Set());
  const lastFiredRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!user) return;
    let cancel = false;

    const load = async () => {
      const [{ data: s }, { data: w }] = await Promise.all([
        supabase.from("alert_settings").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("watchlist_items").select("ticker").eq("user_id", user.id),
      ]);
      if (cancel) return;
      settingsRef.current = s ?? null;
      watchlistRef.current = new Set((w ?? []).map((x: { ticker: string }) => x.ticker));
    };
    load();

    const channel = supabase
      .channel("push-stream")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "signals" }, (payload) => {
        const sig = payload.new as Signal;
        const set = settingsRef.current;
        if (!set?.browser_push_enabled) return;
        if (sig.hidden) return;
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        if (sig.confidence < set.min_confidence) return;
        if (RISK_RANK[sig.risk_level] > RISK_RANK[set.max_risk_level as keyof typeof RISK_RANK]) return;
        if (set.watchlist_only && !watchlistRef.current.has(sig.ticker)) return;
        if (!set.include_0dte && sig.dte === 0) return;
        if (set.bullish_only && sig.direction !== "CALL") return;
        if (set.bearish_only && sig.direction !== "PUT") return;

        // Cooldown: same ticker+direction+source within window → suppress
        const cooldownMs = (set.cooldown_minutes ?? 15) * 60_000;
        if (cooldownMs > 0) {
          const key = `${sig.ticker}|${sig.direction}|${sig.source ?? "n/a"}`;
          const last = lastFiredRef.current.get(key) ?? 0;
          if (Date.now() - last < cooldownMs) return;
          lastFiredRef.current.set(key, Date.now());
          // garbage-collect occasionally
          if (lastFiredRef.current.size > 200) {
            const cutoff = Date.now() - cooldownMs;
            for (const [k, t] of lastFiredRef.current) {
              if (t < cutoff) lastFiredRef.current.delete(k);
            }
          }
        }

        const body = `${sig.direction} · ${sig.confidence}/100 · ${sig.risk_level} risk` +
          (sig.contract_symbol ? ` · ${sig.contract_symbol}` : "");
        try {
          new Notification(`Xalgoflow alert: ${sig.ticker}`, {
            body,
            tag: `signal-${sig.id}`,
          });
        } catch { /* ignore */ }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "alert_settings" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "watchlist_items" }, load)
      .subscribe();

    return () => { cancel = true; supabase.removeChannel(channel); };
  }, [user]);
}

