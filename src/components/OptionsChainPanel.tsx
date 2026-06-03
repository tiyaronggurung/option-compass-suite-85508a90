import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Layers, RefreshCw, Plug } from "lucide-react";
import { toast } from "sonner";

type Row = {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  updated_at: string;
};

export default function OptionsChainPanel() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [ticker, setTicker] = useState("SPY");
  const [expiry, setExpiry] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);



  async function testConnection() {
    setTesting(true);
    const { data, error } = await supabase.functions.invoke("fetch-options-chain", { body: { action: "test" } });
    setTesting(false);
    if (error) { toast.error(error.message); setConfigured(false); return; }
    setConfigured(!!data?.configured && !!data?.ok);
    if (data?.ok) toast.success("Alpaca options API reachable");
    else toast.error(data?.error || "Connection failed");
  }

  async function loadCache() {
    if (!ticker) return;
    let q = supabase.from("options_contracts").select("*").eq("underlying", ticker.toUpperCase()).order("strike");
    if (expiry) q = q.eq("expiry", expiry);
    const { data, error } = await q.limit(500);
    if (error) { toast.error(error.message); return; }
    setRows((data ?? []) as Row[]);
  }

  async function refresh() {
    if (!ticker) { toast.error("Enter a ticker"); return; }
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("fetch-options-chain", {
      body: { ticker: ticker.toUpperCase(), expiry: expiry || undefined },
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    if (data?.error) { toast.error(data.error); return; }
    toast.success(`Fetched ${data?.count ?? 0} contracts`);
    await loadCache();
  }

  useEffect(() => { if (isAdmin) loadCache(); /* eslint-disable-next-line */ }, [isAdmin]);

  if (!isAdmin) return null;

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" /> Options Chain (Alpaca)
        </h2>
        <div className="flex items-center gap-2">
          {configured === true && <Badge variant="outline" className="text-bull border-bull/40">Connected</Badge>}
          {configured === false && <Badge variant="outline" className="text-bear border-bear/40">Not configured</Badge>}
          <Button size="sm" variant="outline" onClick={testConnection} disabled={testing}>
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
            <span className="ml-2">Test connection</span>
          </Button>
        </div>
      </div>

      <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Ticker</Label>
          <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} className="ticker-mono" placeholder="SPY" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Expiry (YYYY-MM-DD, optional)</Label>
          <Input value={expiry} onChange={(e) => setExpiry(e.target.value)} className="ticker-mono" placeholder="2026-06-19" />
        </div>
        <Button onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          <span className="ml-2">Refresh chain</span>
        </Button>
      </div>

      <div className="overflow-x-auto border border-border rounded-md">
        {loading ? (
          <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No cached contracts. Click "Refresh chain" to fetch.</div>
        ) : (
          <table className="w-full text-xs ticker-mono">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="text-left p-2">Symbol</th>
                <th className="text-left p-2">Exp</th>
                <th className="text-right p-2">Strike</th>
                <th className="text-left p-2">Type</th>
                <th className="text-right p-2">Bid</th>
                <th className="text-right p-2">Ask</th>
                <th className="text-right p-2">Last</th>
                <th className="text-right p-2">Vol</th>
                <th className="text-right p-2">OI</th>
                <th className="text-right p-2">Δ</th>
                <th className="text-right p-2">Γ</th>
                <th className="text-right p-2">Θ</th>
                <th className="text-right p-2">V</th>
                <th className="text-right p-2">IV</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="border-t border-border/50">
                  <td className="p-2">{r.symbol}</td>
                  <td className="p-2">{r.expiry}</td>
                  <td className="p-2 text-right">{Number(r.strike).toFixed(2)}</td>
                  <td className="p-2"><span className={r.type === "call" ? "text-bull" : "text-bear"}>{r.type}</span></td>
                  <td className="p-2 text-right">{fmt(r.bid)}</td>
                  <td className="p-2 text-right">{fmt(r.ask)}</td>
                  <td className="p-2 text-right">{fmt(r.last)}</td>
                  <td className="p-2 text-right">{r.volume ?? "—"}</td>
                  <td className="p-2 text-right">{r.open_interest ?? "—"}</td>
                  <td className="p-2 text-right">{fmt(r.delta, 3)}</td>
                  <td className="p-2 text-right">{fmt(r.gamma, 4)}</td>
                  <td className="p-2 text-right">{fmt(r.theta, 3)}</td>
                  <td className="p-2 text-right">{fmt(r.vega, 3)}</td>
                  <td className="p-2 text-right">{r.iv == null ? "—" : `${(Number(r.iv) * 100).toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function fmt(n: number | null, d = 2) {
  if (n == null) return "—";
  return Number(n).toFixed(d);
}
