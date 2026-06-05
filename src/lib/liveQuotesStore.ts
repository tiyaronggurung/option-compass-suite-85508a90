// Shared subscription store for live stock quotes from Unusual Whales.
// Batches all subscribed tickers into one edge-function call every POLL_MS.
import { supabase } from "@/integrations/supabase/client";

const POLL_MS = 5000;

type Quote = { price: number | null; ts: string | null };
type Listener = (q: Quote | null) => void;

const counts = new Map<string, number>();           // ticker -> #subscribers
const latest = new Map<string, Quote>();             // ticker -> last quote
const listeners = new Map<string, Set<Listener>>();  // ticker -> listeners

let timer: ReturnType<typeof setInterval> | null = null;
let inflight = false;

async function tick() {
  if (inflight) return;
  const tickers = Array.from(counts.keys()).filter((t) => (counts.get(t) ?? 0) > 0);
  if (!tickers.length) return;
  inflight = true;
  try {
    const { data, error } = await supabase.functions.invoke("uw-quote", {
      body: { tickers },
    });
    if (error) return;
    const quotes = (data as any)?.quotes ?? {};
    for (const t of tickers) {
      const q = quotes[t];
      if (!q) continue;
      const next: Quote = { price: q.price ?? null, ts: q.ts ?? null };
      latest.set(t, next);
      const ls = listeners.get(t);
      if (ls) ls.forEach((fn) => fn(next));
    }
  } catch {
    /* swallow — keep stale value */
  } finally {
    inflight = false;
  }
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(tick, POLL_MS);
  // Kick off an immediate fetch so first subscribers don't wait 5s.
  void tick();
}

function maybeStopTimer() {
  if (!timer) return;
  const anyActive = Array.from(counts.values()).some((n) => n > 0);
  if (!anyActive) {
    clearInterval(timer);
    timer = null;
  }
}

export function subscribeQuote(ticker: string, listener: Listener): () => void {
  const T = ticker.toUpperCase();
  counts.set(T, (counts.get(T) ?? 0) + 1);
  let set = listeners.get(T);
  if (!set) { set = new Set(); listeners.set(T, set); }
  set.add(listener);
  // Immediately fire any cached value.
  const cached = latest.get(T);
  if (cached) listener(cached);
  ensureTimer();
  // If this is a brand-new ticker, kick a fetch so we don't wait POLL_MS.
  if ((counts.get(T) ?? 0) === 1) void tick();

  return () => {
    counts.set(T, Math.max(0, (counts.get(T) ?? 1) - 1));
    set!.delete(listener);
    if ((counts.get(T) ?? 0) === 0) {
      counts.delete(T);
      listeners.delete(T);
    }
    maybeStopTimer();
  };
}

export function getCachedQuote(ticker: string): Quote | null {
  return latest.get(ticker.toUpperCase()) ?? null;
}
