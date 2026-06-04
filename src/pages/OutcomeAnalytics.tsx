import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, ShieldAlert, ArrowLeft, RefreshCw, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

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

type Agg = { n: number; wins: number; retSum: number; best: number; worst: number };
const emptyAgg = (): Agg => ({ n: 0, wins: 0, retSum: 0, best: -Infinity, worst: Infinity });
function fold(agg: Agg, win: boolean | null, ret: number | null): Agg {
  if (win === null || ret === null) return agg;
  const r = Number(ret);
  return {
    n: agg.n + 1,
    wins: agg.wins + (win ? 1 : 0),
    retSum: agg.retSum + r,
    best: Math.max(agg.best, r),
    worst: Math.min(agg.worst, r),
  };
}
const winRate = (a: Agg) => (a.n > 0 ? (a.wins / a.n) * 100 : 0);
const avgRet = (a: Agg) => (a.n > 0 ? a.retSum / a.n : 0);

function confBucket(c: number): string {
  if (c >= 90) return "90+";
  if (c >= 80) return "80–89";
  if (c >= 70) return "70–79";
  if (c >= 60) return "60–69";
  if (c >= 50) return "50–59";
  return "<50";
}
const CONF_ORDER = ["50–59", "60–69", "70–79", "80–89", "90+"];
const TIER_ORDER = ["elite", "strong", "watchlist", "rejected", "developing", "unscored"];

function buildBuckets<K extends string>(
  rows: Outcome[],
  keyOf: (r: Outcome) => K | null,
): Record<string, Record<W, Agg>> {
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

function quartileBuckets(rows: Outcome[], component: string): Record<string, Record<W, Agg>> {
  const scored = rows
    .map((r) => ({ r, s: Number(r.score_components?.components?.[component]?.score) }))
    .filter((x) => Number.isFinite(x.s));
  if (scored.length === 0) return {};
  const sorted = [...scored].sort((a, b) => a.s - b.s);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].s;
  const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
  return buildBuckets(rows, (r) => {
    const v = Number(r.score_components?.components?.[component]?.score);
    if (!Number.isFinite(v)) return null;
    if (v <= q1) return "low";
    if (v <= q2) return "medium";
    if (v <= q3) return "high";
    return "very high";
  });
}

function sourceStateOf(r: Outcome, component: string, active: string, fallback: string): string | null {
  const c = r.score_components?.components?.[component];
  if (!c) return null;
  const reason = String(c.reason ?? "").toLowerCase();
  const configured = c.configured !== false;
  // Heuristic: degraded/fallback when not configured OR reason mentions fallback/degraded/timeout/HTTP error/not entitled/not optionable
  const degraded =
    !configured ||
    /fallback|degraded|timeout|http \d{3}|not entitled|not optionable|not configured|unavailable/i.test(reason);
  return degraded ? fallback : active;
}

function MetricCell({ agg }: { agg: Agg }) {
  const low = agg.n > 0 && agg.n < MIN_N;
  const empty = agg.n === 0;
  return (
    <td
      className={cn(
        "py-1.5 px-2 text-right ticker-mono",
        (low || empty) && "text-muted-foreground/40",
      )}
      title={low ? "Low sample size" : undefined}
    >
      {empty ? "—" : (
        <>
          <span>{winRate(agg).toFixed(0)}%</span>
          <span className="text-muted-foreground/70 ml-1">
            / {avgRet(agg) >= 0 ? "+" : ""}{avgRet(agg).toFixed(2)}%
          </span>
        </>
      )}
    </td>
  );
}

function BucketTable({
  title,
  subtitle,
  buckets,
  order,
  showExtremes = false,
}: {
  title: string;
  subtitle?: string;
  buckets: Record<string, Record<W, Agg>>;
  order?: string[];
  showExtremes?: boolean;
}) {
  const keys = order ? order.filter((k) => buckets[k]) : Object.keys(buckets).sort();
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {subtitle && <p className="text-[11px] text-muted-foreground mb-2">{subtitle}</p>}
      {keys.length === 0 ? (
        <div className="text-xs text-muted-foreground mt-2">No data.</div>
      ) : (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-1.5 px-2">Bucket</th>
                <th className="text-right py-1.5 px-2">n</th>
                {WINDOWS.map((w) => (
                  <th key={w} className="text-right py-1.5 px-2">{w.toUpperCase()} win / avg</th>
                ))}
                {showExtremes && (
                  <>
                    <th className="text-right py-1.5 px-2">Best (5D)</th>
                    <th className="text-right py-1.5 px-2">Worst (5D)</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const maxN = Math.max(...WINDOWS.map((w) => buckets[k][w].n));
                const low = maxN > 0 && maxN < MIN_N;
                const ext = buckets[k]["5d"];
                return (
                  <tr key={k} className="border-b border-border/50">
                    <td className="py-1.5 px-2 flex items-center gap-2">
                      <span>{k}</span>
                      {low && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                          low sample
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right ticker-mono">{maxN}</td>
                    {WINDOWS.map((w) => <MetricCell key={w} agg={buckets[k][w]} />)}
                    {showExtremes && (
                      <>
                        <td className={cn("py-1.5 px-2 text-right ticker-mono", ext.n < MIN_N && "text-muted-foreground/40")}>
                          {ext.n === 0 ? "—" : `${ext.best >= 0 ? "+" : ""}${ext.best.toFixed(2)}%`}
                        </td>
                        <td className={cn("py-1.5 px-2 text-right ticker-mono", ext.n < MIN_N && "text-muted-foreground/40")}>
                          {ext.n === 0 ? "—" : `${ext.worst >= 0 ? "+" : ""}${ext.worst.toFixed(2)}%`}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-[10px] text-muted-foreground mt-2">
        Grayed / “low sample” = n &lt; {MIN_N}. Win = direction-signed return ≥ 0.
      </div>
    </Card>
  );
}

type PaperTradeLite = {
  signal_id: string | null;
  paper_test_class: string | null;
  confidence_at_approval: number | null;
};

const PAPER_CLASS_ORDER = ["developing", "near_watchlist", "watchlist", "strong", "elite"] as const;
const PAPER_CLASS_LABEL: Record<string, string> = {
  developing: "Developing (50–64)",
  near_watchlist: "Near Watchlist (65–69)",
  watchlist: "Watchlist (70–79)",
  strong: "Strong (80–89)",
  elite: "Elite (90+)",
};

export default function OutcomeAnalytics() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [rows, setRows] = useState<Outcome[] | null>(null);
  const [paperTrades, setPaperTrades] = useState<PaperTradeLite[]>([]);
  const [running, setRunning] = useState(false);

  // Filters
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [ticker, setTicker] = useState<string>("");
  const [direction, setDirection] = useState<string>("all");
  const [tier, setTier] = useState<string>("all");
  const [confBucketF, setConfBucketF] = useState<string>("all");

  async function refresh() {
    setRows(null);
    const [{ data: outcomeData }, { data: tradeData }] = await Promise.all([
      supabase.from("signal_outcomes").select("*").order("entry_at", { ascending: false }).limit(5000),
      supabase.from("paper_trades").select("signal_id, paper_test_class, confidence_at_approval").limit(5000),
    ]);
    setRows((outcomeData ?? []) as unknown as Outcome[]);
    setPaperTrades((tradeData ?? []) as unknown as PaperTradeLite[]);
  }
  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  async function runTracker() {
    setRunning(true);
    try {
      await supabase.functions.invoke("outcome-tracker", { body: {} });
      await refresh();
    } finally { setRunning(false); }
  }

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (dateFrom && new Date(r.entry_at) < new Date(dateFrom)) return false;
      if (dateTo && new Date(r.entry_at) > new Date(dateTo + "T23:59:59")) return false;
      if (ticker && !r.ticker.toLowerCase().includes(ticker.toLowerCase())) return false;
      if (direction !== "all" && r.direction !== direction) return false;
      if (tier !== "all" && (r.tier || "unscored") !== tier) return false;
      if (confBucketF !== "all" && confBucket(r.confidence) !== confBucketF) return false;
      return true;
    });
  }, [rows, dateFrom, dateTo, ticker, direction, tier, confBucketF]);

  const byConfidence = useMemo(() => buildBuckets(filtered, (r) => confBucket(r.confidence)), [filtered]);
  const byTier = useMemo(() => buildBuckets(filtered, (r) => r.tier || "developing"), [filtered]);
  const byDirection = useMemo(() => buildBuckets(filtered, (r) => r.direction), [filtered]);
  const overall = useMemo(() => buildBuckets(filtered, () => "Overall"), [filtered]);

  const truthData = useMemo(() => {
    return CONF_ORDER.map((k) => {
      const b = byConfidence[k];
      if (!b) return { bucket: k, winRate: 0, avgReturn: 0, n: 0 };
      const w5 = b["5d"];
      return {
        bucket: k,
        winRate: Number(winRate(w5).toFixed(1)),
        avgReturn: Number(avgRet(w5).toFixed(2)),
        n: w5.n,
      };
    });
  }, [byConfidence]);

  const compNames = ["options_flow", "technical", "news", "sentiment", "volatility"];
  const compBuckets = useMemo(
    () => compNames.map((c) => ({ name: c, buckets: quartileBuckets(filtered, c) })),
    [filtered],
  );

  const sourceMatrix = useMemo(() => {
    const defs: Array<[string, string, string, string]> = [
      ["options_flow", "Unusual Whales", "UW active", "UW fallback"],
      ["sentiment", "TwitterAPI.io / sentiment", "Sentiment active", "Sentiment neutral"],
      ["technical", "Finviz / Alpaca technical", "Technical active", "Technical degraded"],
      ["news", "News", "News active", "News fallback"],
    ];
    return defs.map(([comp, label, active, fallback]) => ({
      label,
      buckets: buildBuckets(filtered, (r) => sourceStateOf(r, comp, active, fallback)),
    }));
  }, [filtered]);

  // Paper Trade Class Comparison — bucket paper trades by their stored class,
  // join to the matching signal_outcomes row to read 5D win/return.
  const paperClassRows = useMemo(() => {
    const outcomeBySignal = new Map<string, Outcome>();
    for (const r of filtered) outcomeBySignal.set(r.signal_id, r);
    const aggByClass: Record<string, { n: number; withOutcome: number; wins: number; retSum: number }> = {};
    for (const t of paperTrades) {
      const cls = (t.paper_test_class || "").trim();
      if (!cls) continue;
      if (!aggByClass[cls]) aggByClass[cls] = { n: 0, withOutcome: 0, wins: 0, retSum: 0 };
      aggByClass[cls].n += 1;
      if (!t.signal_id) continue;
      const o = outcomeBySignal.get(t.signal_id);
      if (!o) continue;
      if (o.win_5d === null || o.return_5d === null) continue;
      aggByClass[cls].withOutcome += 1;
      aggByClass[cls].wins += o.win_5d ? 1 : 0;
      aggByClass[cls].retSum += Number(o.return_5d);
    }
    return PAPER_CLASS_ORDER
      .filter((k) => aggByClass[k])
      .map((k) => {
        const a = aggByClass[k];
        return {
          key: k,
          label: PAPER_CLASS_LABEL[k] ?? k,
          n: a.n,
          withOutcome: a.withOutcome,
          winRate: a.withOutcome > 0 ? (a.wins / a.withOutcome) * 100 : 0,
          avgReturn: a.withOutcome > 0 ? a.retSum / a.withOutcome : 0,
        };
      });
  }, [paperTrades, filtered]);

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

  const total = rows?.length ?? 0;
  const inFilter = filtered.length;
  const completeCount = filtered.filter((r) => r.status === "complete").length;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link to="/app/diagnostics" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> Diagnostics
          </Link>
          <h1 className="text-xl font-semibold mt-1 flex items-center gap-2">
            <TrendingUp className="h-5 w-5" /> Outcome Analytics
          </h1>
          <p className="text-xs text-muted-foreground">
            Read-only. Proves whether higher-confidence signals actually outperform. Source: signal_outcomes ({total} total · {inFilter} after filters · {completeCount} marked complete).
          </p>
        </div>
        <Button onClick={runTracker} disabled={running} size="sm" variant="outline">
          {running ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Run outcome tracker
        </Button>
      </div>

      {/* Filters */}
      <Card className="p-3">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">From</label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 text-xs" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">To</label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 text-xs" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">Ticker</label>
            <Input placeholder="e.g. NVDA" value={ticker} onChange={(e) => setTicker(e.target.value)} className="h-8 text-xs" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">Direction</label>
            <Select value={direction} onValueChange={setDirection}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="CALL">CALL</SelectItem>
                <SelectItem value="PUT">PUT</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">Tier</label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {TIER_ORDER.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">Confidence</label>
            <Select value={confBucketF} onValueChange={setConfBucketF}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {CONF_ORDER.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex justify-end mt-2">
          <Button
            size="sm" variant="ghost"
            onClick={() => { setDateFrom(""); setDateTo(""); setTicker(""); setDirection("all"); setTier("all"); setConfBucketF("all"); }}
            className="h-7 text-xs"
          >Reset filters</Button>
        </div>
      </Card>

      {rows === null ? (
        <Card className="p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin inline mr-1" /> Loading…</Card>
      ) : (
        <>
          <BucketTable title="Overall" buckets={overall} order={["Overall"]} showExtremes />

          <BucketTable
            title="Confidence Bucket Performance"
            subtitle="Sample size + win rate + avg return by confidence bucket, all windows. Best/worst column shows 5D extremes."
            buckets={byConfidence}
            order={CONF_ORDER}
            showExtremes
          />

          {/* Truth Metric */}
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Truth Metric — Does higher confidence produce higher win rate?</h2>
            <p className="text-[11px] text-muted-foreground mb-3">5D window. Bars: win rate (%) — line implied by avg return ($)·100. Empty/low-sample buckets render at 0.</p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={truthData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="bucket" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <RTooltip
                    contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                    formatter={(v: any, name: string) => [typeof v === "number" ? v.toFixed(2) : v, name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="winRate" name="Win rate %" fill="hsl(var(--primary))" />
                  <Bar dataKey="avgReturn" name="Avg return %" fill="hsl(var(--accent))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-1.5 px-2">Bucket</th>
                    <th className="text-right py-1.5 px-2">n (5D)</th>
                    <th className="text-right py-1.5 px-2">Win rate</th>
                    <th className="text-right py-1.5 px-2">Avg return</th>
                  </tr>
                </thead>
                <tbody>
                  {truthData.map((d) => {
                    const low = d.n > 0 && d.n < MIN_N;
                    const empty = d.n === 0;
                    return (
                      <tr key={d.bucket} className={cn("border-b border-border/50", (low || empty) && "text-muted-foreground/40")}>
                        <td className="py-1.5 px-2 flex items-center gap-2">
                          {d.bucket}
                          {low && <span className="text-[10px] uppercase">low sample</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right ticker-mono">{d.n}</td>
                        <td className="py-1.5 px-2 text-right ticker-mono">{empty ? "—" : `${d.winRate}%`}</td>
                        <td className="py-1.5 px-2 text-right ticker-mono">{empty ? "—" : `${d.avgReturn >= 0 ? "+" : ""}${d.avgReturn}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <BucketTable title="Tier Performance" buckets={byTier} order={TIER_ORDER} />
          <BucketTable title="Direction Split" buckets={byDirection} order={["CALL", "PUT"]} />

          {compBuckets.map(({ name, buckets }) =>
            Object.keys(buckets).length === 0 ? null : (
              <BucketTable
                key={name}
                title={`Component Dominance · ${name}`}
                subtitle={`Outcomes bucketed by quartile of the ${name} subscore. Higher quartiles should win more if this component is predictive.`}
                buckets={buckets}
                order={["low", "medium", "high", "very high"]}
              />
            ),
          )}

          {sourceMatrix.map(({ label, buckets }) =>
            Object.keys(buckets).length === 0 ? null : (
              <BucketTable
                key={label}
                title={`Source Quality · ${label}`}
                subtitle="Active = component configured + healthy. Fallback/degraded = neutral score, timeout, or missing entitlement."
                buckets={buckets}
              />
            ),
          )}
        </>
      )}
    </div>
  );
}
