// Flying news-headline marquee for the Technical page only.
// Polls market-breadth every 30s; shows a scrolling banner when ≥6/10 mega-caps
// agree direction. Display-only — no signal scoring impact yet.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { TrendingDown, TrendingUp, Activity } from "lucide-react";

type Row = { sym: string; chgPct: number | null; dir: "up" | "down" | "flat" };
type Breadth = {
  bias: "bullish" | "bearish" | "neutral";
  up: number; down: number; total: number; threshold: number;
  tickers: Row[];
};

export default function MarketBreadthMarquee() {
  const [b, setB] = useState<Breadth | null>(null);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("market-breadth");
        if (!cancelled && !error && data && typeof data === "object" && "bias" in data) {
          setB(data as Breadth);
        }
      } catch { /* ignore */ }
    };
    pull();
    const id = setInterval(pull, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!b) return null;

  const isBull = b.bias === "bullish";
  const isBear = b.bias === "bearish";
  const isNeutral = b.bias === "neutral";

  const Icon = isBull ? TrendingUp : isBear ? TrendingDown : Activity;
  const headline = isBull
    ? `BULLISH BREADTH — ${b.up}/${b.total} mega-caps GREEN → favor CALLs`
    : isBear
    ? `BEARISH BREADTH — ${b.down}/${b.total} mega-caps RED → favor PUTs`
    : `MIXED TAPE — ${b.up} up / ${b.down} down · no clear bias`;

  const tickerStr = b.tickers
    .slice()
    .sort((a, z) => (z.chgPct ?? 0) - (a.chgPct ?? 0))
    .map((t) => `${t.sym} ${t.chgPct == null ? "—" : (t.chgPct >= 0 ? "+" : "") + t.chgPct.toFixed(2) + "%"}`)
    .join("  •  ");

  const line = `${headline}    ${tickerStr}`;
  // Repeat content so the marquee fills the viewport seamlessly.
  const content = `${line}     ★     ${line}     ★     `;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border ticker-mono text-[12px] sm:text-[13px]",
        isBull && "border-bull/40 bg-bull/10 text-bull",
        isBear && "border-bear/40 bg-bear/10 text-bear",
        isNeutral && "border-border bg-muted/40 text-muted-foreground",
      )}
      role="status"
      aria-live="polite"
      title={`Market breadth across ${b.total} mega-caps — threshold ${b.threshold}/${b.total} to trigger a bias.`}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-semibold tracking-wide shrink-0">BREADTH</span>
        <div className="relative flex-1 overflow-hidden">
          <div
            className="whitespace-nowrap inline-block"
            style={{
              animation: `breadth-marquee ${isNeutral ? 60 : 40}s linear infinite`,
            }}
          >
            {content}
            {content}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes breadth-marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
