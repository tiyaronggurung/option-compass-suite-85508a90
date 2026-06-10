// Lightweight pub/sub store for in-app signal notifications.
// Holds the most recent N signals received via realtime, plus a per-user
// "last seen" timestamp persisted to localStorage so the unread badge
// survives reloads.

export type NotifSignal = {
  id: string;
  ticker: string;
  direction: string;
  confidence: number;
  risk_level: string;
  contract_symbol: string | null;
  received_at: number; // ms epoch
};

const MAX = 30;
const LS_LAST_SEEN = "tf_notif_last_seen_v1";
const LS_SOUND = "tf_notif_sound_v1";

type Listener = () => void;

class Store {
  items: NotifSignal[] = [];
  lastSeen: number = Number(localStorage.getItem(LS_LAST_SEEN) ?? 0);
  soundEnabled: boolean = (localStorage.getItem(LS_SOUND) ?? "1") === "1";
  private listeners = new Set<Listener>();

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  private emit() { this.listeners.forEach((l) => l()); }

  push(s: NotifSignal) {
    if (this.items.some((x) => x.id === s.id)) return;
    this.items = [s, ...this.items].slice(0, MAX);
    this.emit();
  }

  markAllRead() {
    this.lastSeen = Date.now();
    localStorage.setItem(LS_LAST_SEEN, String(this.lastSeen));
    this.emit();
  }

  setSound(on: boolean) {
    this.soundEnabled = on;
    localStorage.setItem(LS_SOUND, on ? "1" : "0");
    this.emit();
  }

  unreadCount() {
    return this.items.filter((i) => i.received_at > this.lastSeen).length;
  }
}

export const signalNotifStore = new Store();

// Tiny WebAudio chime — no asset file needed.
let audioCtx: AudioContext | null = null;
export function playChime() {
  try {
    if (!audioCtx) {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      audioCtx = new Ctor();
    }
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.18, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };
    beep(880, 0, 0.12);
    beep(1320, 0.1, 0.16);
  } catch { /* ignore */ }
}
