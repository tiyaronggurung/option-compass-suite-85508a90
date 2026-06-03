import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import type { WatchlistItem } from "@/lib/signalHelpers";

export default function Watchlist() {
  const { user } = useAuth();
  const [items, setItems] = useState<WatchlistItem[] | null>(null);
  const [ticker, setTicker] = useState("");

  async function refresh() {
    const { data } = await supabase
      .from("watchlist_items")
      .select("*")
      .eq("user_id", user!.id)
      .order("ticker");
    setItems(data ?? []);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [user]);

  async function addTicker(e: React.FormEvent) {
    e.preventDefault();
    const t = ticker.trim().toUpperCase().slice(0, 8);
    if (!/^[A-Z][A-Z0-9.]{0,7}$/.test(t)) return toast.error("Enter a valid ticker symbol");
    const { error } = await supabase.from("watchlist_items").insert({ user_id: user!.id, ticker: t });
    if (error) return toast.error(error.message.includes("duplicate") ? `${t} is already on your watchlist` : error.message);
    setTicker("");
    refresh();
  }

  async function remove(id: string) {
    const { error } = await supabase.from("watchlist_items").delete().eq("id", id);
    if (error) return toast.error(error.message);
    refresh();
  }

  async function update(id: string, patch: Partial<WatchlistItem>) {
    setItems((prev) => prev?.map((i) => (i.id === id ? { ...i, ...patch } : i)) ?? null);
    const { error } = await supabase.from("watchlist_items").update(patch).eq("id", id);
    if (error) { toast.error(error.message); refresh(); }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Watchlist</h1>
          <p className="text-sm text-muted-foreground">Tickers you want priority alerts on.</p>
        </div>
        <form onSubmit={addTicker} className="flex items-center gap-2 w-full sm:w-auto">
          <Input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="Add ticker (e.g. NVDA)"
            className="flex-1 sm:w-48 ticker-mono"
            maxLength={8}
          />
          <Button type="submit" className="shrink-0"><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </form>
      </header>

      <div className="glass-card divide-y divide-border">
        {!items ? (
          <div className="p-4 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">No tickers yet — add your first one above.</div>
        ) : (
          items.map((it) => (
            <div key={it.id} className="grid grid-cols-12 items-center gap-3 px-4 py-3">
              <div className="col-span-3 md:col-span-2 ticker-mono font-semibold">{it.ticker}</div>
              <div className="col-span-5 md:col-span-5 flex items-center gap-3">
                <Label htmlFor={`c-${it.id}`} className="text-xs text-muted-foreground w-32">Min confidence</Label>
                <Input
                  id={`c-${it.id}`}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={it.min_confidence}
                  className="w-20 ticker-mono"
                  onBlur={(e) => {
                    const v = Math.max(0, Math.min(100, Number(e.target.value)));
                    update(it.id, { min_confidence: v });
                  }}
                />
              </div>
              <div className="col-span-3 md:col-span-4 flex items-center gap-2">
                <Switch
                  id={`d-${it.id}`}
                  checked={it.enable_0dte}
                  onCheckedChange={(v) => update(it.id, { enable_0dte: v })}
                />
                <Label htmlFor={`d-${it.id}`} className="text-xs text-muted-foreground">0DTE alerts</Label>
              </div>
              <div className="col-span-1 md:col-span-1 text-right">
                <Button variant="ghost" size="icon" onClick={() => remove(it.id)} aria-label={`Remove ${it.ticker}`}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
