import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, Brain, Loader2, RefreshCw, Sparkles, TrendingUp, AlertTriangle, BarChart3, Scale } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar } from "@/components/Disclaimer";
import { fmtPrice, timeAgo, type Signal } from "@/lib/signalHelpers";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Analysis = {
  signal_id: string;
  summary: string | null;
  bull_case: string | null;
  bear_case: string | null;
  why_triggered: string | null;
  flow_interpretation: string | null;
  technical_confirmation: string | null;
  catalyst_context: string | null;
  macro_context: string | null;
  risk_warnings: string | null;
  verdict: "WAIT" | "CHASE" | "AVOID" | null;
  desks: Array<{ desk: string; stance: "bullish" | "bearish" | "neutral"; conviction: number; note: string }>;
  historical: { prior_occurrences?: number; win_rate_pct?: number; avg_move_pct?: number; max_drawdown_pct?: number; best_dte?: number };
  model: string | null;
};

type TickerSentiment = {
  ticker: string;
  call_volume: number;
  put_volume: number;
  call_premium: number;
  put_premium: number;
  put_call_ratio: number;
  call_share: number;
  put_share: number;
  avg_30d_call_volume: number;
  avg_30d_put_volume: number;
  sentiment: "bullish" | "bearish" | "neutral";
  reason: string;
  as_of: string | null;
};


export default function Analyst() {
  const [params] = useSearchParams();
  const focusedId = params.get("signal");
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusedId);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [sentiment, setSentiment] = useState<TickerSentiment | null>(null);
  const [loadingSentiment, setLoadingSentiment] = useState(false);

  useEffect(() => {
    supabase.from("signals").select("*").order("created_at", { ascending: false }).limit(50)
      .then(({ data }) => {
        setSignals(data ?? []);
        if (data?.length && !selectedId) setSelectedId(data[0].id);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If route changes ?signal=… after mount, follow it.
  useEffect(() => {
    if (focusedId) setSelectedId(focusedId);
  }, [focusedId]);

  const selected = useMemo(() => signals?.find((s) => s.id === selectedId) ?? null, [signals, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancel = false;
    setAnalysis(null);
    (async () => {
      const { data } = await supabase.from("signal_analyses").select("*").eq("signal_id", selectedId).maybeSingle();
      if (!cancel) setAnalysis((data as unknown as Analysis | null) ?? null);
    })();
    return () => { cancel = true; };
  }, [selectedId]);

  // Fetch ticker-wide call/put sentiment whenever selected ticker changes.
  useEffect(() => {
    const ticker = selected?.ticker;
    if (!ticker) { setSentiment(null); return; }
    let cancel = false;
    setSentiment(null);
    setLoadingSentiment(true);
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        const base = `https://${import.meta.env.VITE_SUPABASE_PROJECT_ID}.supabase.co/functions/v1`;
        const res = await fetch(`${base}/uw-ticker-sentiment?ticker=${encodeURIComponent(ticker)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const j = await res.json();
          if (!cancel) setSentiment(j as TickerSentiment);
        }
      } catch { /* ignore */ }
      finally { if (!cancel) setLoadingSentiment(false); }
    })();
    return () => { cancel = true; };
  }, [selected?.ticker]);

  async function generate(force = false) {
    if (!selectedId) return;
    setLoadingAnalysis(true);
    try {
      const { data, error } = await supabase.functions.invoke("analyze-signal", { body: { signal_id: selectedId, force } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setAnalysis(data.analysis);
      toast.success(data.cached ? "Loaded cached analysis" : "Fresh analysis generated");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to generate analysis");
    } finally {
      setLoadingAnalysis(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <header>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight flex items-center gap-2">
          <Brain className="h-6 w-6 text-primary" /> AI Analyst
        </h1>
        <p className="text-sm text-muted-foreground">Plain-English breakdowns. Educational, not financial advice.</p>
      </header>

      <div className="grid lg:grid-cols-[300px_1fr] gap-4">
        {/* List */}
        <aside className="glass-card divide-y divide-border max-h-[70vh] overflow-y-auto">
          {!signals ? (
            <div className="p-3 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : signals.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No signals yet.</div>
          ) : signals.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={cn(
                "w-full text-left px-3 py-3 hover:bg-card-elevated transition",
                selectedId === s.id && "bg-card-elevated ring-1 ring-primary/30",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {s.direction === "CALL"
                    ? <ArrowUpRight className="h-4 w-4 text-bull" />
                    : <ArrowDownRight className="h-4 w-4 text-bear" />}
                  <span className="ticker-mono font-semibold">{s.ticker}</span>
                  <Badge className={cn("border-0 text-[10px]", s.direction === "CALL" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear")}>
                    {s.direction}
                  </Badge>
                </div>
                <div className="text-xs ticker-mono text-muted-foreground">{s.confidence}</div>
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">{timeAgo(s.created_at)} · {s.contract_symbol ?? "—"}</div>
            </button>
          ))}
        </aside>

        {/* Detail */}
        <section className="space-y-4 min-w-0">
          {!selected ? (
            <div className="glass-card p-10 text-center text-sm text-muted-foreground">Pick a signal to analyze.</div>
          ) : (
            <>
              <div className="glass-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-semibold ticker-mono">{selected.ticker}</h2>
                      <Badge className={cn("border-0", selected.direction === "CALL" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear")}>
                        {selected.direction}
                      </Badge>
                      <Badge variant="outline" className="border-border text-muted-foreground">{selected.confidence}/100</Badge>
                      <Badge variant="outline" className="border-border text-muted-foreground">{selected.risk_level} risk</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      ${fmtPrice(Number(selected.price))} · {selected.contract_symbol ?? "—"} · {timeAgo(selected.created_at)}
                    </div>
                  </div>
                  <Button onClick={() => generate(!!analysis)} disabled={loadingAnalysis} size="sm">
                    {loadingAnalysis ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : analysis ? <RefreshCw className="h-4 w-4 mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                    {analysis ? "Regenerate" : "Generate analysis"}
                  </Button>
                </div>
              </div>

              <SentimentPanel sentiment={sentiment} loading={loadingSentiment} signalDirection={selected.direction as "CALL" | "PUT"} />



              {!analysis && !loadingAnalysis && (
                <div className="glass-card p-10 text-center">
                  <Sparkles className="h-8 w-8 mx-auto text-primary" />
                  <div className="mt-3 font-medium">No analysis yet</div>
                  <p className="text-sm text-muted-foreground mt-1">Click <span className="text-foreground">Generate analysis</span> to ask the AI desk.</p>
                </div>
              )}

              {loadingAnalysis && !analysis && (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
                </div>
              )}

              {analysis && (
                <>
                  {analysis.verdict && <VerdictBanner verdict={analysis.verdict} />}
                  <Section title="Plain-English summary" icon={Brain}>{analysis.summary}</Section>

                  <div className="grid md:grid-cols-2 gap-4">
                    <Section title="Bull case" icon={TrendingUp} tone="bull">{analysis.bull_case}</Section>
                    <Section title="Bear case" icon={TrendingUp} tone="bear">{analysis.bear_case}</Section>
                  </div>

                  <Section title="Why the alert triggered">{analysis.why_triggered}</Section>
                  <Section title="Options flow interpretation">{analysis.flow_interpretation}</Section>
                  <Section title="Technical confirmation">{analysis.technical_confirmation}</Section>
                  {analysis.catalyst_context && <Section title="Catalyst / news context">{analysis.catalyst_context}</Section>}
                  {analysis.macro_context && <Section title="Macro / regime context">{analysis.macro_context}</Section>}
                  <Section title="Risk warnings" icon={AlertTriangle} tone="warn">{analysis.risk_warnings}</Section>

                  <DeskDesk desks={analysis.desks} />
                  <Historical h={analysis.historical} />

                  <DisclaimerBar />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function VerdictBanner({ verdict }: { verdict: "WAIT" | "CHASE" | "AVOID" }) {
  const tone = verdict === "CHASE" ? "bg-bull/15 text-bull border-bull/30"
            : verdict === "AVOID" ? "bg-bear/15 text-bear border-bear/30"
            : "bg-warn/15 text-warn border-warn/30";
  return (
    <div className={cn("rounded-md border px-4 py-3 flex items-center justify-between", tone)}>
      <div className="text-sm">Suggested verdict <span className="font-semibold">(illustrative only)</span></div>
      <div className="text-xl font-semibold tracking-wide">{verdict}</div>
    </div>
  );
}

function Section({ title, children, icon: Icon, tone }: { title: string; children: React.ReactNode; icon?: any; tone?: "bull" | "bear" | "warn" }) {
  const toneClass = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "warn" ? "text-warn" : "text-primary";
  return (
    <div className="glass-card p-4">
      <div className={cn("flex items-center gap-2 text-xs uppercase tracking-wider font-medium", toneClass)}>
        {Icon && <Icon className="h-3.5 w-3.5" />}{title}
      </div>
      <div className="mt-2 text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{children}</div>
    </div>
  );
}

function DeskDesk({ desks }: { desks: Analysis["desks"] }) {
  if (!desks?.length) return null;
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-medium text-primary">
        <BarChart3 className="h-3.5 w-3.5" /> Analyst desks
      </div>
      <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {desks.map((d) => {
          const tone = d.stance === "bullish" ? "bg-bull/15 text-bull"
                     : d.stance === "bearish" ? "bg-bear/15 text-bear"
                     : "bg-muted text-muted-foreground";
          return (
            <div key={d.desk} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{d.desk} Desk</div>
                <Badge className={cn("border-0 capitalize", tone)}>{d.stance}</Badge>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">Conviction</div>
              <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, d.conviction))}%` }} />
              </div>
              <div className="mt-2 text-xs text-muted-foreground leading-relaxed">{d.note}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Historical({ h }: { h: Analysis["historical"] }) {
  const items: [string, string][] = [
    ["Prior occurrences", h.prior_occurrences != null ? String(h.prior_occurrences) : "—"],
    ["Win rate", h.win_rate_pct != null ? `${h.win_rate_pct.toFixed(0)}%` : "—"],
    ["Avg move", h.avg_move_pct != null ? `${h.avg_move_pct.toFixed(1)}%` : "—"],
    ["Max drawdown", h.max_drawdown_pct != null ? `${h.max_drawdown_pct.toFixed(1)}%` : "—"],
    ["Best DTE", h.best_dte != null ? String(h.best_dte) : "—"],
  ];
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider font-medium text-primary">Historical similar setups</div>
        <Badge variant="outline" className="border-warn/40 text-warn text-[10px]">Illustrative backtest</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
        {items.map(([k, v]) => (
          <div key={k} className="rounded-md border border-border p-3">
            <div className="text-[11px] text-muted-foreground">{k}</div>
            <div className="mt-1 text-lg font-semibold ticker-mono">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
