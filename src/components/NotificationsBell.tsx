import { useEffect, useState, useSyncExternalStore } from "react";
import { Bell, Volume2, VolumeX, BellOff, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { signalNotifStore, playChime } from "@/lib/signalNotificationsStore";

let cachedSnap = {
  items: signalNotifStore.items,
  unread: signalNotifStore.unreadCount(),
  sound: signalNotifStore.soundEnabled,
};
let cachedKey = "";
function getSnapshot() {
  const key = `${signalNotifStore.items.length}|${signalNotifStore.items[0]?.id ?? ""}|${signalNotifStore.lastSeen}|${signalNotifStore.soundEnabled ? 1 : 0}`;
  if (key !== cachedKey) {
    cachedKey = key;
    cachedSnap = {
      items: signalNotifStore.items,
      unread: signalNotifStore.unreadCount(),
      sound: signalNotifStore.soundEnabled,
    };
  }
  return cachedSnap;
}

function useNotifStore() {
  return useSyncExternalStore(signalNotifStore.subscribe, getSnapshot, getSnapshot);
}

function relTime(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function NotificationsBell() {
  const { items, unread, sound } = useNotifStore();
  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  // Mark read when opened
  useEffect(() => {
    if (open && unread > 0) signalNotifStore.markAllRead();
  }, [open, unread]);

  async function requestPush() {
    if (typeof Notification === "undefined") return;
    const res = await Notification.requestPermission();
    setPushState(res);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-bear text-[10px] font-semibold text-white grid place-items-center ring-2 ring-background">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="text-sm font-semibold">Signal alerts</div>
          <div className="flex items-center gap-1">
            {import.meta.env.DEV && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Send test notification"
                title="Send test notification (dev only)"
                onClick={() => {
                  signalNotifStore.push({
                    id: `test-${Date.now()}`,
                    ticker: "TEST",
                    direction: Math.random() > 0.5 ? "CALL" : "PUT",
                    confidence: 88,
                    risk_level: "MEDIUM",
                    contract_symbol: "TEST 250101C00100000",
                    received_at: Date.now(),
                  });
                  if (signalNotifStore.soundEnabled) playChime();
                }}
              >
                <Zap className="h-3.5 w-3.5 text-warn" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={sound ? "Mute sound" : "Enable sound"}
              title={sound ? "Sound on — click to mute" : "Sound off — click to enable"}
              onClick={() => signalNotifStore.setSound(!sound)}
            >
              {sound ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5 text-muted-foreground" />}
            </Button>
            {pushState !== "granted" && pushState !== "unsupported" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Enable browser notifications"
                title="Enable browser notifications"
                onClick={requestPush}
              >
                <BellOff className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            )}
          </div>
        </div>

        {pushState === "default" && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground border-b border-border bg-muted/40">
            Click the bell-off icon above to allow OS-level push notifications.
          </div>
        )}

        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              No new signals yet. We'll chime when one arrives.
            </div>
          ) : (
            items.map((s) => {
              const to =
                s.confidence >= 70
                  ? `/app/top-signals?signal=${encodeURIComponent(s.id)}`
                  : `/app?signal=${encodeURIComponent(s.id)}`;
              return (
              <Link
                key={s.id}
                to={to}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 border-b border-border/60 hover:bg-accent/50 transition-colors"
              >
                <span
                  className={cn(
                    "text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded",
                    s.direction === "CALL" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear",
                  )}
                >
                  {s.direction}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {s.ticker}
                    <span className="text-xs font-normal text-muted-foreground ml-1.5">
                      {s.confidence}/100 · {s.risk_level}
                    </span>
                  </div>
                  {s.contract_symbol && (
                    <div className="text-[10.5px] text-muted-foreground truncate ticker-mono">
                      {s.contract_symbol}
                    </div>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground shrink-0">{relTime(s.received_at)}</div>
              </Link>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
