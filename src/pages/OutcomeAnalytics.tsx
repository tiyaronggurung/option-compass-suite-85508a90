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

type SignalLifecycleLite = {
  id: string;
  lifecycle_state: string | null;
  confidence: number | null;
  confidence_at_birth: number | null;
  max_confidence_seen: number | null;
  min_confidence_seen: number | null;
  tier: string | null;
  max_tier_seen: string | null;
  min_tier_seen: string | null;
};

const PAPER_CLASS_ORDER = ["developing", "near_watchlist", "watchlist", "strong", "elite"] as const;
const PAPER_CLASS_LABEL: Record<string, string> = {
  developing: "Developing (50–64)",
  near_watchlist: "Near Watchlist (65–69)",
  watchlist: "Watchlist (70–79)",
  strong: "Strong (80–89)",
  elite: "Elite (90+)",
};

// Confidence Drift helpers (analytics only).
const TIER_RANK_UI: Record<string, number> = {
  rejected: 0, developing: 1, near_watchlist: 2, watchlist: 3, strong: 4, elite: 5,
};
function paperClassForConfidence(c: number | null | undefined): string | null {
  if (c == null) return null;
  if (c >= 90) return "elite";
  if (c >= 80) return "strong";
  if (c >= 70) return "watchlist";
  if (c >= 65) return "near_watchlist";
  if (c >= 50) return "developing";
  return null;
}
const DRIFT_BUCKETS = ["gain_10", "gain_5_9", "flat", "loss_5_9", "loss_10"] as const;
const DRIFT_LABEL: Record<string, string> = {
  gain_10: "Gained 10+",
  gain_5_9: "Gained 5–9",
  flat: "Flat (−4 … +4)",
  loss_5_9: "Lost 5–9",
  loss_10: "Lost 10+",
};
function driftBucket(delta: number): typeof DRIFT_BUCKETS[number] {
  if (delta >= 10) return "gain_10";
  if (delta >= 5) return "gain_5_9";
  if (delta <= -10) return "loss_10";
  if (delta <= -5) return "loss_5_9";
  return "flat";
}

const LIFECYCLE_ROW_ORDER = ["fresh", "active", "weakening", "expired", "invalidated"] as const;
const LIFECYCLE_ROW_LABEL: Record<string, string> = {
  fresh: "Fresh",
  active: "Active",
  weakening: "Weakening",
  expired: "Expired",
  invalidated: "Invalidated",
};


export default function OutcomeAnalytics() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [rows, setRows] = useState<Outcome[] | null>(null);
  const [paperTrades, setPaperTrades] = useState<PaperTradeLite[]>([]);
  const [signalLifecycle, setSignalLifecycle] = useState<SignalLifecycleLite[]>([]);
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
    const [{ data: outcomeData }, { data: tradeData }, { data: sigData }] = await Promise.all([
      supabase.from("signal_outcomes").select("*").order("entry_at", { ascending: false }).limit(5000),
      supabase.from("paper_trades").select("signal_id, paper_test_class, confidence_at_approval").limit(5000),
      supabase.from("signals").select("id, lifecycle_state, confidence, confidence_at_birth, max_confidence_seen, min_confidence_seen, tier, max_tier_seen, min_tier_seen").limit(5000),

    ]);
    setRows((outcomeData ?? []) as unknown as Outcome[]);
    setPaperTrades((tradeData ?? []) as unknown as PaperTradeLite[]);
    setSignalLifecycle((sigData ?? []) as unknown as SignalLifecycleLite[]);
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
  // Lifecycle Win-Rate Comparison — bucket outcomes by the signal's current
  // lifecycle_state, then read 5D win/return.
  const lifecycleRows = useMemo(() => {
    const stateById = new Map<string, string>();
    for (const s of signalLifecycle) if (s.lifecycle_state) stateById.set(s.id, s.lifecycle_state);
    const agg: Record<string, { n: number; wins: number; retSum: number }> = {};
    for (const r of filtered) {
      const st = stateById.get(r.signal_id);
      if (!st) continue;
      if (r.win_5d === null || r.return_5d === null) continue;
      if (!agg[st]) agg[st] = { n: 0, wins: 0, retSum: 0 };
      agg[st].n += 1;
      agg[st].wins += r.win_5d ? 1 : 0;
      agg[st].retSum += Number(r.return_5d);
    }
    return LIFECYCLE_ROW_ORDER.filter((k) => agg[k]).map((k) => ({
      key: k,
      label: LIFECYCLE_ROW_LABEL[k] ?? k,
      n: agg[k].n,
      winRate: agg[k].n > 0 ? (agg[k].wins / agg[k].n) * 100 : 0,
      avgReturn: agg[k].n > 0 ? agg[k].retSum / agg[k].n : 0,
    }));
  }, [signalLifecycle, filtered]);

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

  // ---------- Confidence Drift Analytics (signals-wide, analytics only) ----------
  const driftByClass = useMemo(() => {
    const agg: Record<string, { n: number; deltaSum: number; maxSum: number; minSum: number }> = {};
    for (const s of signalLifecycle) {
      if (s.confidence == null || s.confidence_at_birth == null) continue;
      const cls = paperClassForConfidence(s.confidence_at_birth);
      if (!cls) continue;
      const delta = s.confidence - s.confidence_at_birth;
      const max = s.max_confidence_seen ?? s.confidence;
      const min = s.min_confidence_seen ?? s.confidence;
      if (!agg[cls]) agg[cls] = { n: 0, deltaSum: 0, maxSum: 0, minSum: 0 };
      agg[cls].n += 1;
      agg[cls].deltaSum += delta;
      agg[cls].maxSum += max;
      agg[cls].minSum += min;
    }
    return PAPER_CLASS_ORDER.filter((k) => agg[k]).map((k) => ({
      key: k,
      label: PAPER_CLASS_LABEL[k] ?? k,
      n: agg[k].n,
      avgDelta: agg[k].deltaSum / agg[k].n,
      avgMax: agg[k].maxSum / agg[k].n,
      avgMin: agg[k].minSum / agg[k].n,
    }));
  }, [signalLifecycle]);

  const driftTransitions = useMemo(() => {
    const promo: Record<string, number> = {
      "developing→near_watchlist": 0,
      "near_watchlist→watchlist": 0,
      "watchlist→strong": 0,
      "strong→elite": 0,
    };
    const demo: Record<string, number> = {
      "watchlist→near_watchlist": 0,
      "near_watchlist→developing": 0,
    };
    let invalidated = 0;
    for (const s of signalLifecycle) {
      if (s.lifecycle_state === "invalidated") invalidated += 1;
      const birth = s.confidence_at_birth ?? s.confidence;
      const birthClass = paperClassForConfidence(birth);
      const maxTier = s.max_tier_seen;
      const minTier = s.min_tier_seen;
      const birthRank = birthClass ? TIER_RANK_UI[birthClass] : null;
      // Promotions: max_tier_seen strictly above birth band.
      if (birthRank != null && maxTier && TIER_RANK_UI[maxTier] != null) {
        const order = ["developing", "near_watchlist", "watchlist", "strong", "elite"];
        const startIdx = order.indexOf(birthClass!);
        const endIdx = order.indexOf(maxTier);
        if (startIdx >= 0 && endIdx > startIdx) {
          for (let i = startIdx; i < endIdx; i++) {
            const key = `${order[i]}→${order[i + 1]}`;
            if (key in promo) promo[key] += 1;
          }
        }
      }
      // Demotions: min_tier_seen strictly below birth band.
      if (birthRank != null && minTier && TIER_RANK_UI[minTier] != null) {
        const order = ["developing", "near_watchlist", "watchlist", "strong", "elite"];
        const startIdx = order.indexOf(birthClass!);
        const endIdx = order.indexOf(minTier);
        if (startIdx >= 0 && endIdx >= 0 && endIdx < startIdx) {
          for (let i = startIdx; i > endIdx; i--) {
            const key = `${order[i]}→${order[i - 1]}`;
            if (key in demo) demo[key] += 1;
          }
        }
      }
    }
    return { promo, demo, invalidated };
  }, [signalLifecycle]);

  const driftHistogram = useMemo(() => {
    const buckets: Record<string, number> = { gain_10: 0, gain_5_9: 0, flat: 0, loss_5_9: 0, loss_10: 0 };
    let n = 0;
    for (const s of signalLifecycle) {
      if (s.confidence == null || s.confidence_at_birth == null) continue;
      buckets[driftBucket(s.confidence - s.confidence_at_birth)] += 1;
      n += 1;
    }
    return { buckets, n };
  }, [signalLifecycle]);

  // ---------- Confidence Calibration (uses birth confidence only) ----------
  // signal_outcomes.confidence is captured at insert time by the seed trigger,
  // so it equals confidence_at_birth and is safe to use here without leaking drift.
  const calibrationRows = useMemo(() => {
    const order = ["50–54", "55–59", "60–64", "65–69", "70–79", "80–89", "90+"] as const;
    const bucketOf = (c: number): typeof order[number] | null => {
      if (c >= 90) return "90+";
      if (c >= 80) return "80–89";
      if (c >= 70) return "70–79";
      if (c >= 65) return "65–69";
      if (c >= 60) return "60–64";
      if (c >= 55) return "55–59";
      if (c >= 50) return "50–54";
      return null;
    };
    const midpoint: Record<string, number> = {
      "50–54": 52, "55–59": 57, "60–64": 62, "65–69": 67,
      "70–79": 74.5, "80–89": 84.5, "90+": 92.5,
    };
    const agg: Record<string, { n: number; wins: number; retSum: number }> = {};
    for (const r of filtered) {
      const b = bucketOf(r.confidence);
      if (!b) continue;
      if (r.win_5d === null || r.return_5d === null) continue;
      if (!agg[b]) agg[b] = { n: 0, wins: 0, retSum: 0 };
      agg[b].n += 1;
      agg[b].wins += r.win_5d ? 1 : 0;
      agg[b].retSum += Number(r.return_5d);
    }
    return order.map((k) => {
      const a = agg[k] ?? { n: 0, wins: 0, retSum: 0 };
      const winRate = a.n > 0 ? (a.wins / a.n) * 100 : 0;
      const expected = midpoint[k];
      return {
        bucket: k,
        n: a.n,
        winRate,
        avgReturn: a.n > 0 ? a.retSum / a.n : 0,
        expected,
        gap: a.n > 0 ? winRate - expected : 0,
      };
    });
  }, [filtered]);

  // ---------- Promotion / Demotion rates (from watermarks vs birth band) ----------
  const promotionRows = useMemo(() => {
    const order = ["developing", "near_watchlist", "watchlist", "strong", "elite"] as const;
    const rank: Record<string, number> = {
      rejected: 0, developing: 1, near_watchlist: 2, watchlist: 3, strong: 4, elite: 5,
    };
    const promoTargets = [
      { key: "developing→near_watchlist", from: "developing", to: "near_watchlist" },
      { key: "developing→watchlist",      from: "developing", to: "watchlist" },
      { key: "near_watchlist→watchlist",  from: "near_watchlist", to: "watchlist" },
      { key: "watchlist→strong",          from: "watchlist", to: "strong" },
      { key: "strong→elite",              from: "strong", to: "elite" },
    ] as const;

    const bornInBand: Record<string, number> = Object.fromEntries(order.map((o) => [o, 0]));
    const promoHits: Record<string, number> = Object.fromEntries(promoTargets.map((p) => [p.key, 0]));
    const demoHits: Record<string, number> = Object.fromEntries(order.map((o) => [o, 0]));

    for (const s of signalLifecycle) {
      const cls = paperClassForConfidence(s.confidence_at_birth ?? null);
      if (!cls) continue;
      bornInBand[cls] += 1;
      const maxR = s.max_tier_seen ? (rank[s.max_tier_seen] ?? -1) : -1;
      const minR = s.min_tier_seen ? (rank[s.min_tier_seen] ?? 99) : 99;
      const birthR = rank[cls];
      for (const p of promoTargets) {
        if (p.from === cls && maxR >= rank[p.to]) promoHits[p.key] += 1;
      }
      if (minR < birthR) demoHits[cls] += 1;
    }

    const promotions = promoTargets.map((p) => ({
      key: p.key,
      label: p.key.replace("→", " → "),
      hits: promoHits[p.key],
      n: bornInBand[p.from],
      rate: bornInBand[p.from] > 0 ? (promoHits[p.key] / bornInBand[p.from]) * 100 : 0,
    }));
    const demotions = order
      .filter((b) => bornInBand[b] > 0 || demoHits[b] > 0)
      .map((b) => ({
        key: b,
        label: PAPER_CLASS_LABEL[b] ?? b,
        hits: demoHits[b],
        n: bornInBand[b],
        rate: bornInBand[b] > 0 ? (demoHits[b] / bornInBand[b]) * 100 : 0,
      }));
    return { promotions, demotions };
  }, [signalLifecycle]);





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
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Lifecycle Win-Rate Comparison</h2>
            <p className="text-[11px] text-muted-foreground mb-2">
              5D win rate and average return grouped by each signal's current lifecycle state.
              Tests whether Weakening signals still have predictive value.
            </p>
            {lifecycleRows.length === 0 ? (
              <div className="text-xs text-muted-foreground mt-2">No completed outcomes with lifecycle data yet.</div>
            ) : (
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="text-left py-1.5 px-2">Lifecycle</th>
                      <th className="text-right py-1.5 px-2">n (5D)</th>
                      <th className="text-right py-1.5 px-2">Win rate (5D)</th>
                      <th className="text-right py-1.5 px-2">Avg return (5D)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lifecycleRows.map((d) => {
                      const low = d.n > 0 && d.n < MIN_N;
                      return (
                        <tr key={d.key} className={cn("border-b border-border/50", low && "text-muted-foreground/60")}>
                          <td className="py-1.5 px-2">{d.label}{low && <span className="ml-2 text-[10px] uppercase tracking-wide">low sample</span>}</td>
                          <td className="py-1.5 px-2 text-right ticker-mono">{d.n}</td>
                          <td className="py-1.5 px-2 text-right ticker-mono">{d.winRate.toFixed(0)}%</td>
                          <td className="py-1.5 px-2 text-right ticker-mono">{d.avgReturn >= 0 ? "+" : ""}{d.avgReturn.toFixed(2)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Paper Trade Class Comparison</h2>
            <p className="text-[11px] text-muted-foreground mb-2">
              Approved paper trades bucketed by the confidence band at approval time.
              Win rate / avg return computed from the 5D outcome window for trades whose signal has a completed outcome.
            </p>
            {paperClassRows.length === 0 ? (
              <div className="text-xs text-muted-foreground mt-2">
                No paper trades with a recorded class yet. Approve some Developing / Near Watchlist signals to populate.
              </div>
            ) : (
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="text-left py-1.5 px-2">Class</th>
                      <th className="text-right py-1.5 px-2">Paper trades</th>
                      <th className="text-right py-1.5 px-2">With 5D outcome</th>
                      <th className="text-right py-1.5 px-2">Win rate (5D)</th>
                      <th className="text-right py-1.5 px-2">Avg return (5D)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paperClassRows.map((d) => {
                      const low = d.withOutcome > 0 && d.withOutcome < MIN_N;
                      const empty = d.withOutcome === 0;
                      return (
                        <tr key={d.key} className={cn("border-b border-border/50", (low || empty) && "text-muted-foreground/60")}>
                          <td className="py-1.5 px-2 flex items-center gap-2">
                            {d.label}
                            {low && <span className="text-[10px] uppercase tracking-wide">low sample</span>}
                          </td>
                          <td className="py-1.5 px-2 text-right ticker-mono">{d.n}</td>
                          <td className="py-1.5 px-2 text-right ticker-mono">{d.withOutcome}</td>
                          <td className="py-1.5 px-2 text-right ticker-mono">{empty ? "—" : `${d.winRate.toFixed(0)}%`}</td>
                          <td className="py-1.5 px-2 text-right ticker-mono">{empty ? "—" : `${d.avgReturn >= 0 ? "+" : ""}${d.avgReturn.toFixed(2)}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="text-[10px] text-muted-foreground mt-2">
              Goal: determine whether 65–69 performs like 70–79 and whether 50–64 has any predictive value.
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Confidence Drift Analytics</h2>
            <p className="text-[11px] text-muted-foreground mb-3">
              Tracks how each signal's confidence has moved since creation. Uses high/low watermarks
              and the current vs. birth confidence delta. Analytics only — no scoring impact.
            </p>

            {/* Avg drift by paper_test_class */}
            <div className="mt-2">
              <h3 className="text-xs font-medium mb-1">Average drift by class</h3>
              {driftByClass.length === 0 ? (
                <div className="text-xs text-muted-foreground">No signals with birth confidence yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="text-left py-1.5 px-2">Class</th>
                        <th className="text-right py-1.5 px-2">n</th>
                        <th className="text-right py-1.5 px-2">Avg Δ</th>
                        <th className="text-right py-1.5 px-2">Avg max</th>
                        <th className="text-right py-1.5 px-2">Avg min</th>
                      </tr>
                    </thead>
                    <tbody>
                      {driftByClass.map((d) => {
                        const low = d.n > 0 && d.n < MIN_N;
                        return (
                          <tr key={d.key} className={cn("border-b border-border/50", low && "text-muted-foreground/60")}>
                            <td className="py-1.5 px-2">{d.label}{low && <span className="ml-2 text-[10px] uppercase tracking-wide">low sample</span>}</td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{d.n}</td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{d.avgDelta >= 0 ? "+" : ""}{d.avgDelta.toFixed(1)}</td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{d.avgMax.toFixed(1)}</td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{d.avgMin.toFixed(1)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Promotions / demotions */}
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <h3 className="text-xs font-medium mb-1">Promotions</h3>
                <table className="w-full text-xs">
                  <tbody>
                    {Object.entries(driftTransitions.promo).map(([k, v]) => (
                      <tr key={k} className="border-b border-border/50">
                        <td className="py-1 px-2">{k.replace("→", " → ")}</td>
                        <td className="py-1 px-2 text-right ticker-mono">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3 className="text-xs font-medium mb-1">Demotions</h3>
                <table className="w-full text-xs">
                  <tbody>
                    {Object.entries(driftTransitions.demo).map(([k, v]) => (
                      <tr key={k} className="border-b border-border/50">
                        <td className="py-1 px-2">{k.replace("→", " → ")}</td>
                        <td className="py-1 px-2 text-right ticker-mono">{v}</td>
                      </tr>
                    ))}
                    <tr className="border-b border-border/50">
                      <td className="py-1 px-2">Invalidated</td>
                      <td className="py-1 px-2 text-right ticker-mono">{driftTransitions.invalidated}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <h3 className="text-xs font-medium mb-1">Drift histogram</h3>
                {driftHistogram.n === 0 ? (
                  <div className="text-xs text-muted-foreground">No data yet.</div>
                ) : (
                  <table className="w-full text-xs">
                    <tbody>
                      {DRIFT_BUCKETS.map((b) => (
                        <tr key={b} className="border-b border-border/50">
                          <td className="py-1 px-2">{DRIFT_LABEL[b]}</td>
                          <td className="py-1 px-2 text-right ticker-mono">{driftHistogram.buckets[b]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="text-[10px] text-muted-foreground mt-3">
              Goal: learn whether signals strengthen or weaken after creation and whether confidence
              is predictive over time.
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Confidence → Actual Win Rate</h2>
            <p className="text-[11px] text-muted-foreground mb-2">
              Calibration: each bucket uses <strong>birth confidence</strong> (captured at signal
              creation) so post-creation drift cannot leak in. Expected = bucket midpoint as a
              percent. Gap = actual − expected (positive = model under-predicted).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-1.5 px-2">Confidence</th>
                    <th className="text-right py-1.5 px-2">Signals</th>
                    <th className="text-right py-1.5 px-2">Win rate (5D)</th>
                    <th className="text-right py-1.5 px-2">Avg return (5D)</th>
                    <th className="text-right py-1.5 px-2">Expected</th>
                    <th className="text-right py-1.5 px-2">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {calibrationRows.map((d) => {
                    const low = d.n > 0 && d.n < MIN_N;
                    const empty = d.n === 0;
                    return (
                      <tr key={d.bucket} className={cn("border-b border-border/50", (low || empty) && "text-muted-foreground/60")}>
                        <td className="py-1.5 px-2">
                          {d.bucket}
                          {low && <span className="ml-2 text-[10px] uppercase tracking-wide">low sample</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right ticker-mono">{d.n}</td>
                        <td className="py-1.5 px-2 text-right ticker-mono">{empty ? "—" : `${d.winRate.toFixed(0)}%`}</td>
                        <td className="py-1.5 px-2 text-right ticker-mono">{empty ? "—" : `${d.avgReturn >= 0 ? "+" : ""}${d.avgReturn.toFixed(2)}%`}</td>
                        <td className="py-1.5 px-2 text-right ticker-mono">{d.expected.toFixed(0)}%</td>
                        <td className={cn("py-1.5 px-2 text-right ticker-mono", empty ? "" : d.gap >= 0 ? "text-emerald-400" : "text-rose-400")}>
                          {empty ? "—" : `${d.gap >= 0 ? "+" : ""}${d.gap.toFixed(0)}pp`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4" style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={calibrationRows.map((d) => ({
                  bucket: d.bucket,
                  Expected: d.expected,
                  Actual: d.n > 0 ? Number(d.winRate.toFixed(1)) : 0,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" unit="%" />
                  <RTooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Expected" fill="hsl(var(--muted-foreground))" />
                  <Bar dataKey="Actual" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">
              Low-sample buckets (n &lt; {MIN_N}) are dimmed in the table; the chart still plots them
              so you can see where evidence is missing.
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Promotion Rates</h2>
            <p className="text-[11px] text-muted-foreground mb-2">
              % of signals born in a band that <strong>ever reached</strong> a higher band
              (uses max_tier_seen vs. birth band). Demotion = ever fell below the birth band
              (uses min_tier_seen).
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <div>
                <h3 className="text-xs font-medium mb-1">Promotions</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="text-left py-1.5 px-2">Transition</th>
                        <th className="text-right py-1.5 px-2">Hits / n</th>
                        <th className="text-right py-1.5 px-2">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {promotionRows.promotions.map((d) => {
                        const low = d.n > 0 && d.n < MIN_N;
                        const empty = d.n === 0;
                        return (
                          <tr key={d.key} className={cn("border-b border-border/50", (low || empty) && "text-muted-foreground/60")}>
                            <td className="py-1.5 px-2">
                              {d.label}
                              {low && <span className="ml-2 text-[10px] uppercase tracking-wide">low sample</span>}
                            </td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{d.hits} / {d.n}</td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{empty ? "—" : `${d.rate.toFixed(0)}%`}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h3 className="text-xs font-medium mb-1">Demotions (fell below birth band)</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="text-left py-1.5 px-2">Birth band</th>
                        <th className="text-right py-1.5 px-2">Hits / n</th>
                        <th className="text-right py-1.5 px-2">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {promotionRows.demotions.length === 0 ? (
                        <tr><td colSpan={3} className="py-1.5 px-2 text-muted-foreground">No data yet.</td></tr>
                      ) : promotionRows.demotions.map((d) => {
                        const low = d.n > 0 && d.n < MIN_N;
                        return (
                          <tr key={d.key} className={cn("border-b border-border/50", low && "text-muted-foreground/60")}>
                            <td className="py-1.5 px-2">
                              {d.label}
                              {low && <span className="ml-2 text-[10px] uppercase tracking-wide">low sample</span>}
                            </td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{d.hits} / {d.n}</td>
                            <td className="py-1.5 px-2 text-right ticker-mono">{d.rate.toFixed(0)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground mt-3">
              Goal: learn whether 65–69 signals frequently mature into 70+ (validating Near
              Watchlist) and whether high-confidence births rarely demote (validating the gate).
            </div>
          </Card>
        </>


      )}
    </div>
  );
}
