import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2, ShieldAlert, ArrowLeft, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

type Outcome = {
  signal_id: string;
  ticker: string;
  direction: string;
  confidence: number;
  tier: string | null;
  score_components: Record<string, any>;
  entry_price: number | null;
  entry_at: string;
  price_1d: number | null; price_3d: number | null; price_5d: number | null;
  price_10d: number | null; price_30d: number | null;
  return_1d: number | null; return_3d: number | null; return_5d: number | null;
  return_10d: number | null; return_30d: number | null;
  win_1d: boolean | null; win_3d: boolean | null; win_5d: boolean | null;
  win_10d: boolean | null; win_30d: boolean | null;
  status: string;
};

const WINDOWS = ["1d", "3d", "5d", "10d", "30d"] as const;
type W = typeof WINDOWS[number];
const MIN_N = 10;

type Agg = { n: number; wins: number; retSum: number };
const emptyAgg = (): Agg => ({ n: 0, wins: 0, retSum: 0 });
function fold(agg: Agg, win: boolean | null, ret: number | null): Agg {
  if (win === null || ret === null) return agg;
  return { n: agg.n + 1, wins: agg.wins + (win ? 1 : 0), retSum: agg.retSum + Number(ret) };
}
function winRate(a: Agg) { return a.n > 0 ? (a.wins / a.n) * 100 : 0; }
function avgRet(a: Agg) { return a.n > 0 ? a.retSum / a.n : 0; }

function bucketByConfidence(c: number): string {
  if (c >= 90) return "90+";
  if (c >= 80) return "80–89";
  if (c >= 70) return "70–79";
  if (c >= 60) return "60–69";
  return "<60";
}

function buildBuckets<K extends string>(rows: Outcome[], keyOf: (r: Outcome) => K | null): Record<string, Record<W, Agg>> {
  const out: Record<string, Record<W, Agg>> = {};
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null) continue;
    if (!out[k]) out[k] = { "1d": emptyAgg(), "3d": emptyAgg(), "5d": emptyAgg(), "10d": emptyAgg(), "30d": emptyAgg() };
    out[k]["1d"] = fold(out[k]["1d"], r.win_1d, r.return_1d);
    out[k]["3d"] = fold(out[k]["3d"], r.win_3d, r.return_3d);
    out[k]["5d"] = fold(out[k]["5d"], r.win_5d, r.return_5d);
    out[k]["10d"] = fold(out[k]["10d"], r.win_10d, r.return_10d);
    out[k]["30d"] = fold(out[k]["30d"], r.win_30d, r.return_30d);
  }
  return out;
}

function componentQuartile(rows: Outcome[], component: string): Record<string, Record<W, Agg>> {
  const scores = rows
    .map((r) => ({ r, s: Number(r.score_components?.components?.[component]?.score) }))
    .filter((x) => Number.isFinite(x.s));
  if (scores.length === 0) return {};
  const sorted = [...scores].sort((a, b) => a.s - b.s);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].s;
  const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
  return buildBuckets(rows, (r) => {
    const v = Number(r.score_components?.components?.[component]?.score);
    if (!Number.isFinite(v)) return null;
    if (v <= q1) return "Q1 (low)";
    if (v <= q2) return "Q2";
    if (v <= q3) return "Q3";
    return "Q4 (high)";
  });
}

function MetricCell({ agg }: { agg: Agg }) {
  const insufficient = agg.n < MIN_N;
  return (
    <td className={cn("py-1.5 px-2 text-right ticker-mono", insufficient && "text-muted-foreground/40")}>
      {agg.n === 0 ? "—" : (
        <>
          <span>{winRate(agg).toFixed(0)}%</span>
          <span className="text-muted-foreground/70 ml-1">/ {avgRet(agg) >= 0 ? "+" : ""}{avgRet(agg).toFixed(2)}%</span>
        </>
      )}
    </td>
  );
}

function BucketTable({ title, buckets, order }: { title: string; buckets: Record<string, Record<W, Agg>>; order?: string[] }) {
  const keys = order ? order.filter((k) => buckets[k]) : Object.keys(buckets).sort();
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      {keys.length === 0 ? (
        <div className="text-xs text-muted-foreground">No data.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-1.5 px-2">Bucket</th>
                <th className="text-right py-1.5 px-2">n</th>
                {WINDOWS.map((w) => <th key={w} className="text-right py-1.5 px-2">{w.toUpperCase()} win / avg</th>)}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const maxN = Math.max(...WINDOWS.map((w) => buckets[k][w].n));
                return (
                  <tr key={k} className="border-b border-border/50">
                    <td className="py-1.5 px-2">{k}</td>
                    <td className="py-1.5 px-2 text-right ticker-mono">{maxN}</td>
                    {WINDOWS.map((w) => <MetricCell key={w} agg={buckets[k][w]} />)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-[10px] text-muted-foreground mt-2">Grayed = n &lt; {MIN_N}.</div>
    </Card>
  );
}

export default function PerformanceDiagnostics() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [rows, setRows] = useState<Outcome[] | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function refresh() {
    setRows(null);
    const [{ data }, { data: sigData }] = await Promise.all([
      supabase.from("signal_outcomes").select("*").order("entry_at", { ascending: false }).limit(5000),
      supabase.from("signals").select("id, is_demo, source").limit(5000),
    ]);

    // Exclude demo / test signals from analytics to prevent data contamination.
    const excludedIds = new Set<string>();
    for (const s of (sigData ?? [])) {
      if (s.is_demo || (s.source && String(s.source).includes("TEST_ONLY_OPTION_PL_VALIDATION"))) {
        excludedIds.add(s.id);
      }
    }
    const clean = ((data ?? []) as unknown as Outcome[])
      .filter((r) => !excludedIds.has(r.signal_id));
    setRows(clean);
  }

  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  async function runTracker() {
    setRunning(true); setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("outcome-tracker", { body: {} });
      setResult(error ? { error: error.message } : data);
      await refresh();
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally { setRunning(false); }
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

  const all = rows ?? [];
  const overall = buildBuckets(all, () => "Overall");
  const byConfidence = buildBuckets(all, (r) => bucketByConfidence(r.confidence));
  const byTier = buildBuckets(all, (r) => r.tier || "unscored");
  const byDirection = buildBuckets(all, (r) => r.direction);
  const compNames = ["options_flow", "technical", "news", "sentiment", "volatility"];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/app/diagnostics" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> Diagnostics
          </Link>
          <h1 className="text-xl font-semibold mt-1">Signal Performance</h1>
          <p className="text-xs text-muted-foreground">
            Read-only analytics from signal_outcomes. Win = direction-signed return ≥ 0. Sample = {all.length} signals.
          </p>
        </div>
        <Button onClick={runTracker} disabled={running} size="sm">
          {running ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Run tracker now
        </Button>
      </div>

      {result && (
        <Card className="p-3 text-[11px]">
          <pre className="overflow-x-auto">{JSON.stringify(result, null, 2).slice(0, 1500)}</pre>
        </Card>
      )}

      {rows === null ? (
        <Card className="p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin inline mr-1" /> Loading…</Card>
      ) : (
        <>
          <BucketTable title="Overall" buckets={overall} order={["Overall"]} />
          <BucketTable title="By confidence bucket" buckets={byConfidence} order={["90+", "80–89", "70–79", "60–69", "<60"]} />
          <BucketTable title="By tier" buckets={byTier} order={["elite", "strong", "watchlist", "rejected", "unscored"]} />
          <BucketTable title="By direction" buckets={byDirection} order={["CALL", "PUT"]} />
          {compNames.map((c) => {
            const b = componentQuartile(all, c);
            if (Object.keys(b).length === 0) return null;
            return <BucketTable key={c} title={`Component quartile · ${c}`} buckets={b} order={["Q1 (low)", "Q2", "Q3", "Q4 (high)"]} />;
          })}
        </>
      )}
    </div>
  );
}
