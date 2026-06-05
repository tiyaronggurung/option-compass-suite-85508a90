import { useEffect, useState } from "react";
import { subscribeQuote, getCachedQuote } from "@/lib/liveQuotesStore";

/**
 * Subscribe to a live stock quote for `ticker`. Returns the latest price
 * (or null until first fetch lands). Auto-unsubscribes on unmount.
 * Pass null/undefined to disable.
 */
export function useLiveQuote(ticker: string | null | undefined): { price: number | null; ts: string | null } | null {
  const [quote, setQuote] = useState<{ price: number | null; ts: string | null } | null>(
    ticker ? getCachedQuote(ticker) : null,
  );

  useEffect(() => {
    if (!ticker) { setQuote(null); return; }
    const unsub = subscribeQuote(ticker, (q) => setQuote(q));
    return unsub;
  }, [ticker]);

  return quote;
}
