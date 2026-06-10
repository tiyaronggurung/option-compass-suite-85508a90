import { useState } from "react";
import { TechnicalTrendCard, type TechSnapshot } from "@/components/TechnicalTrendCard";
import { TechnicalChart } from "@/components/TechnicalChart";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";

const SUGGESTIONS = ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "AAPL", "META", "MSFT", "AMZN", "GOOGL"];

export default function Technical() {
  const [input, setInput] = useState("");
  const [ticker, setTicker] = useState<string | null>(null);
  const [snap, setSnap] = useState<TechSnapshot | null>(null);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = input.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) setTicker(t);
  };

  return (
    <div className="space-y-4 p-3 sm:p-4 max-w-5xl mx-auto">
      <div className="space-y-1">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight font-display">Technical Trend</h1>
        <p className="text-xs sm:text-sm text-muted-foreground">
          RSI, MACD, EMAs, Bollinger, ATR, support/resistance and volume — distilled into a Bullish / Neutral / Bearish verdict.
        </p>
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="Enter ticker (e.g. NVDA)"
            className="pl-8 text-sm"
            maxLength={10}
          />
        </div>
        <Button type="submit" size="sm">Analyze</Button>
      </form>

      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((t) => (
          <button
            key={t}
            onClick={() => { setInput(t); setTicker(t); setSnap(null); }}
            className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent ticker-mono"
          >
            {t}
          </button>
        ))}
      </div>

      {ticker ? (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3 space-y-4">
            {snap?.payload?.recent_bars && snap.payload.recent_bars.length > 0 ? (
              <TechnicalChart bars={snap.payload.recent_bars} />
            ) : (
              <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                Loading chart…
              </div>
            )}
          </div>
          <div className="lg:col-span-2">
            <TechnicalTrendCard ticker={ticker} onSnapshot={setSnap} />
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Pick a ticker above to see its technical readout.
        </div>
      )}
    </div>
  );
}
