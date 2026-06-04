import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2, ShieldAlert, ArrowLeft, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

type StrengthRow = {
  ticker: string;
  score: number;
  label: string;
  buy_count_30d: number;
  sell_count_30d: number;
  buy_count_90d: number;
  sell_count_90d: number;
  total_buy_value_90d: number;
  as_of: string;
  signals: Array<{ kind: string; weight: number; detail: string }>;
};

type TxRow = {
  ticker: string;
  insider_name: string;
  role: string | null;
  transaction_type: string;
  transaction_date: string;
  shares: number | null;
  price: number | null;
  total_value: number | null;
  direction: string;
  source: string;
};

function labelTone(label: string): string {
  if (label === "strong_buy") return "bg-emerald-500/15 text-emerald-400";
  if (label === "buy") return "bg-emerald-500/10 text-emerald-300";
  if (label === "sell") return "bg-red-500/10 text-red-300";
  if (label === "strong_sell") return "bg-red-500/15 text-red-400";
  return "bg-muted text-muted-foreground";
}

export default function InsiderDiagnostics() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [strength, setStrength] = useState<StrengthRow[]>([]);
  const [recent, setRecent] = useState<TxRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const [{ data: s }, { data: t }] = await Promise.all([
      supabase.from("insider_strength_scores").select("*").order("score", { ascending: false }).limit(100),
      supabase.from("insider_transactions").select("ticker, insider_name, role, transaction_type, transaction_date, shares, price, total_value, direction, source").order("transaction_date", { ascending: false }).limit(50),
    ]);
    setStrength((s ?? []) as StrengthRow[]);
    setRecent((t ?? []) as TxRow[]);
    setLoading(false);
  }

  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  async function runSync() {
    setSyncing(true); setSyncResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("insider-sync", { body: {} });
      setSyncResult(error ? { error: error.message } : data);
      await refresh();
    } catch (e) {
      setSyncResult({ error: (e as Error).message });
    } finally { setSyncing(false); }
  }

  if (adminLoading) return <div className="p-6 text-muted-foreground text-sm">Checking permissions…</div>;
  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card className="p-6 max-w-md mx-auto text-center space-y-2">
          <ShieldAlert className="h-8 w-8 text-amber-400 mx-auto" />
          <h2 className="text-lg font-semibold">Admin access required</h2>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/app/diagnostics" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> Diagnostics
          </Link>
          <h1 className="text-xl font-semibold mt-1">Insider Intelligence</h1>
          <p className="text-xs text-muted-foreground">Metadata only — does not affect confidence score.</p>
        </div>
        <Button onClick={runSync} disabled={syncing} size="sm">
          {syncing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Sync now
        </Button>
      </div>

      {syncResult && (
        <Card className="p-3 text-[11px]">
          <pre className="overflow-x-auto">{JSON.stringify(syncResult, null, 2).slice(0, 1500)}</pre>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold mb-2">Strength scores ({strength.length})</h2>
        {loading ? (
          <div className="text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin inline mr-1" /> Loading…</div>
        ) : strength.length === 0 ? (
          <div className="text-xs text-muted-foreground">No data yet — click Sync now.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 px-2">Ticker</th>
                  <th className="text-left py-1.5 px-2">Label</th>
                  <th className="text-right py-1.5 px-2">Score</th>
                  <th className="text-right py-1.5 px-2">Buys 30d</th>
                  <th className="text-right py-1.5 px-2">Sells 30d</th>
                  <th className="text-right py-1.5 px-2">Buys 90d</th>
                  <th className="text-right py-1.5 px-2">$ Buys 90d</th>
                  <th className="text-left py-1.5 px-2">Top signals</th>
                </tr>
              </thead>
              <tbody>
                {strength.map((r) => (
                  <tr key={r.ticker} className="border-b border-border/50">
                    <td className="py-1.5 px-2 ticker-mono">{r.ticker}</td>
                    <td className="py-1.5 px-2"><span className={cn("px-1.5 py-0.5 rounded text-[10px]", labelTone(r.label))}>{r.label}</span></td>
                    <td className="py-1.5 px-2 text-right ticker-mono">{r.score}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono text-emerald-400">{r.buy_count_30d}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono text-red-400">{r.sell_count_30d}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono">{r.buy_count_90d}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono">${Math.round(Number(r.total_buy_value_90d) || 0).toLocaleString()}</td>
                    <td className="py-1.5 px-2 text-[10px] text-muted-foreground">
                      {(r.signals ?? []).slice(0, 3).map((s) => `${s.kind} ${s.weight >= 0 ? "+" : ""}${s.weight}`).join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold mb-2">Recent transactions ({recent.length})</h2>
        {recent.length === 0 ? (
          <div className="text-xs text-muted-foreground">None.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 px-2">Date</th>
                  <th className="text-left py-1.5 px-2">Ticker</th>
                  <th className="text-left py-1.5 px-2">Insider</th>
                  <th className="text-left py-1.5 px-2">Role</th>
                  <th className="text-left py-1.5 px-2">Type</th>
                  <th className="text-left py-1.5 px-2">Dir</th>
                  <th className="text-right py-1.5 px-2">Shares</th>
                  <th className="text-right py-1.5 px-2">Price</th>
                  <th className="text-right py-1.5 px-2">Value</th>
                  <th className="text-left py-1.5 px-2">Src</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-1.5 px-2 ticker-mono">{r.transaction_date}</td>
                    <td className="py-1.5 px-2 ticker-mono">{r.ticker}</td>
                    <td className="py-1.5 px-2">{r.insider_name}</td>
                    <td className="py-1.5 px-2">{r.role ?? "—"}</td>
                    <td className="py-1.5 px-2 text-[10px]">{r.transaction_type}</td>
                    <td className={cn("py-1.5 px-2 text-[10px]", r.direction === "buy" ? "text-emerald-400" : r.direction === "sell" ? "text-red-400" : "text-muted-foreground")}>{r.direction}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono">{r.shares?.toLocaleString() ?? "—"}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono">{r.price ?? "—"}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono">{r.total_value ? `$${Math.round(r.total_value).toLocaleString()}` : "—"}</td>
                    <td className="py-1.5 px-2 text-[10px] text-muted-foreground">{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
