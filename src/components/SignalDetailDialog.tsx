import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { Signal } from "@/lib/signalHelpers";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { OUTCOME_CLASS, OUTCOME_LABEL, type SignalOutcome } from "@/lib/signalOutcome";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import type { RankBreakdown } from "@/lib/rankSignals";
import { ConfirmationMatrix } from "@/components/ConfirmationMatrix";
import type { ConfirmationMatrix as MatrixT } from "@/lib/confirmations";

interface Props {
  signal: Signal | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  outcome?: SignalOutcome;
  rankBreakdown?: RankBreakdown;
}

export function SignalDetailDialog({ signal, open, onOpenChange, outcome, rankBreakdown }: Props) {
  const { isAdmin } = useIsAdmin();
  const [siblings, setSiblings] = useState<Signal[] | null>(null);
  const [current, setCurrent] = useState<Signal | null>(signal);
  const [picking, setPicking] = useState(false);

  useEffect(() => { setCurrent(signal); }, [signal]);

  useEffect(() => {
    if (!open || !signal || !isAdmin) { setSiblings(null); return; }
    const created = new Date(signal.created_at).getTime();
    const windowMs = 30 * 60_000; // ±30 min
    const from = new Date(created - windowMs).toISOString();
    const to = new Date(created + windowMs).toISOString();
    supabase
      .from("signals")
      .select("*")
      .eq("ticker", signal.ticker)
      .eq("direction", signal.direction)
      .gte("created_at", from)
      .lte("created_at", to)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        const list = (data ?? []).filter((s: Signal) => s.id !== signal.id);
        setSiblings(list as Signal[]);
      });
  }, [open, signal, isAdmin]);

  if (!current) return null;
  const s = current;

  const refreshContract = async () => {
    setPicking(true);
    try {
      const { data, error } = await supabase.functions.invoke("pick-contract", {
        body: { signal_id: s.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      if ((data as any)?.picked) {
        toast.success("Contract picked", { description: (data as any).picked.reason });
      } else {
        toast.info("No contract match yet.");
      }
      const { data: fresh } = await supabase.from("signals").select("*").eq("id", s.id).maybeSingle();
      if (fresh) setCurrent(fresh as Signal);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to pick contract");
    } finally {
      setPicking(false);
    }
  };

  const contractMeta = (s.technical_metrics as any)?.contract as
    | { delta?: number; iv?: number; bid?: number; ask?: number; mid?: number; dte?: number; spread_pct?: number; liquidity_score?: number; reason?: string }
    | undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="ticker-mono">{s.ticker}</span>
            <Badge variant="outline" className="border-border">{s.direction}</Badge>
            {s.is_demo
              ? <Badge variant="outline" className="text-muted-foreground">Demo</Badge>
              : <Badge className="bg-emerald-500/15 text-emerald-400 border-0">Live</Badge>}
            {outcome && outcome !== "none" && (
              <Badge className={cn("border-0", OUTCOME_CLASS[outcome])}>{OUTCOME_LABEL[outcome]}</Badge>
            )}
          </DialogTitle>
        </DialogHeader>


        <div className="space-y-3 text-sm">
          <Row label="Confidence" value={`${s.confidence}/100`} />
          <Row label="Risk" value={s.risk_level} />
          <Row label="DTE" value={s.dte != null ? String(s.dte) : "—"} />
          <Row label="Price" value={s.price != null ? `$${Number(s.price).toFixed(2)}` : "—"} />
          <Row label="Source" value={s.source ?? "—"} mono />
          <Row label="Created" value={new Date(s.created_at).toLocaleString()} />
          {isAdmin && <Row label="signal_id" value={s.id} mono small />}
          {isAdmin && <Row label="external_id" value={s.external_id ?? "—"} mono small />}

          {Array.isArray(s.reasons) && s.reasons.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Reasons</div>
              <ul className="space-y-0.5 text-xs">
                {(s.reasons as string[]).map((r, i) => (
                  <li key={i} className="text-foreground/80">• {r}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground mb-1.5 flex items-center justify-between">
              <span>Recommended contract</span>
              {isAdmin && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={picking} onClick={refreshContract}>
                  <RefreshCw className={cn("h-3 w-3 mr-1", picking && "animate-spin")} />
                  {picking ? "Picking…" : "Refresh chain + pick"}
                </Button>
              )}
            </div>
            {s.contract_symbol ? (
              <div className="space-y-1 text-xs">
                <Row label="Symbol" value={s.contract_symbol} mono small />
                <Row label="Strike" value={s.strike != null ? `$${Number(s.strike).toFixed(2)}` : "—"} />
                <Row label="Expiry" value={s.expiry ?? "—"} />
                <Row label="DTE" value={s.dte != null ? `${s.dte}d` : "—"} />
                {contractMeta?.delta != null && <Row label="Delta" value={contractMeta.delta.toFixed(2)} />}
                {contractMeta?.iv != null && <Row label="IV" value={`${(contractMeta.iv * 100).toFixed(1)}%`} />}
                {(contractMeta?.bid != null || contractMeta?.ask != null) && (
                  <Row
                    label="Bid / Ask / Mid"
                    value={`${contractMeta?.bid?.toFixed(2) ?? "—"} / ${contractMeta?.ask?.toFixed(2) ?? "—"} / ${contractMeta?.mid?.toFixed(2) ?? (s.premium != null ? Number(s.premium).toFixed(2) : "—")}`}
                  />
                )}
                {contractMeta?.liquidity_score != null && (
                  <Row label="Liquidity" value={`${contractMeta.liquidity_score}/100`} />
                )}
                {contractMeta?.reason && (
                  <div className="text-[11px] text-muted-foreground pt-1">{contractMeta.reason}</div>
                )}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No contract match yet.</div>
            )}
          </div>

          <InstitutionalBreakdown sc={(s as any).score_components} tier={(s as any).tier} />

          <ComponentBreakdown tm={s.technical_metrics as any} />

          {rankBreakdown && <RankingBreakdown b={rankBreakdown} />}

          <ConfirmationMatrix
            matrix={(s as any).source_confirmations as MatrixT | null}
            direction={s.direction as "CALL" | "PUT"}
            score={(s as any).confirmation_score ?? null}
            label={(s as any).confirmation_label ?? null}
          />

          <InsiderActivity ticker={s.ticker} />








          {isAdmin && (
            <div className="pt-2 border-t border-border">
              <div className="text-xs text-muted-foreground mb-1.5">
                Sibling signals (±30 min, same ticker+direction)
              </div>
              {siblings === null ? (
                <div className="text-xs text-muted-foreground">Loading…</div>
              ) : siblings.length === 0 ? (
                <div className="text-xs text-muted-foreground">None — unique.</div>
              ) : (
                <ul className="space-y-1 text-xs">
                  {siblings.slice(0, 8).map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        {new Date(s.created_at).toLocaleTimeString()}
                      </span>
                      <span className="truncate text-foreground/80">{s.source ?? "n/a"}</span>
                      <span className="ticker-mono">{s.confidence}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono, small }: { label: string; value: string; mono?: boolean; small?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right ${mono ? "ticker-mono" : ""} ${small ? "text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}

const COMPONENT_ORDER = ["trend", "momentum", "levels", "volume", "options", "macro"] as const;
const COMPONENT_LABEL: Record<string, string> = {
  trend: "Trend", momentum: "Momentum", levels: "Levels",
  volume: "Volume", options: "Options", macro: "Macro",
};

function ComponentBreakdown({ tm }: { tm: Record<string, any> | null | undefined }) {
  const comps = tm && typeof tm === "object" ? (tm as any).components : null;
  if (!comps || typeof comps !== "object") return null;
  const total = typeof (tm as any).score === "number" ? (tm as any).score : null;
  return (
    <div className="pt-2 border-t border-border">
      <div className="text-xs text-muted-foreground mb-1.5 flex items-center justify-between">
        <span>Score breakdown</span>
        {total !== null && (
          <span className={cn("ticker-mono", total >= 0 ? "text-bull" : "text-bear")}>
            blended {total >= 0 ? "+" : ""}{total.toFixed(2)}
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {COMPONENT_ORDER.map((k) => {
          const c = comps[k];
          if (!c) return null;
          const score = Number(c.score ?? 0);
          const pct = Math.min(100, Math.abs(score) * 100);
          const pos = score >= 0;
          return (
            <div key={k} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground w-16 shrink-0">{COMPONENT_LABEL[k]}</span>
                <span className="flex-1 truncate text-foreground/70">{c.reason ?? ""}</span>
                <span className={cn("ticker-mono w-12 text-right", pos ? "text-bull" : "text-bear")}>
                  {pos ? "+" : ""}{score.toFixed(2)}
                </span>
              </div>
              <div className="mt-0.5 relative h-1 rounded bg-muted/40 overflow-hidden">
                <div className="absolute top-0 bottom-0 left-1/2 w-px bg-border" />
                <div
                  className={cn("absolute top-0 bottom-0", pos ? "bg-bull/60" : "bg-bear/60")}
                  style={{
                    left: pos ? "50%" : `${50 - pct / 2}%`,
                    width: `${pct / 2}%`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RANK_ROWS: Array<{ key: keyof RankBreakdown; label: string; max: number; negative?: boolean }> = [
  { key: "confidence", label: "Confidence (35%)", max: 35 },
  { key: "liquidity", label: "Liquidity (20%)", max: 20 },
  { key: "delta", label: "Delta match (15%)", max: 15 },
  { key: "spread", label: "Spread quality (15%)", max: 15 },
  { key: "freshness", label: "Freshness (10%)", max: 10 },
  { key: "riskPenalty", label: "Risk penalty (−5%)", max: 5, negative: true },
];

function RankingBreakdown({ b }: { b: RankBreakdown }) {
  return (
    <div className="pt-2 border-t border-border">
      <div className="text-xs text-muted-foreground mb-1.5 flex items-center justify-between">
        <span>Ranking breakdown</span>
        <span className={cn(
          "ticker-mono",
          b.total >= 75 ? "text-bull" : b.total >= 50 ? "text-primary" : "text-muted-foreground",
        )}>
          total {b.total.toFixed(1)}
        </span>
      </div>
      <div className="space-y-1.5">
        {RANK_ROWS.map((row) => {
          const val = b[row.key];
          const pct = Math.min(100, (val / row.max) * 100);
          return (
            <div key={row.key} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{row.label}</span>
                <span className={cn("ticker-mono", row.negative ? "text-bear" : "text-foreground/80")}>
                  {row.negative ? "−" : ""}{val.toFixed(1)} / {row.max}
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded bg-muted/40 overflow-hidden">
                <div
                  className={cn("h-full", row.negative ? "bg-bear/60" : "bg-primary/60")}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const INSTITUTIONAL_COMPONENTS: Array<{ key: string; label: string; weight: number }> = [
  { key: "options_flow", label: "Options Flow", weight: 30 },
  { key: "technical",    label: "Technical",    weight: 25 },
  { key: "news",         label: "News",         weight: 20 },
  { key: "sentiment",    label: "Sentiment",    weight: 15 },
  { key: "volatility",   label: "Volatility",   weight: 10 },
];

function InstitutionalBreakdown({ sc, tier }: { sc: any; tier?: string | null }) {
  if (!sc || typeof sc !== "object" || !sc.components) return null;
  const final = Number(sc.final ?? 0);
  const base = Number(sc.base ?? final);
  const adj = Number(sc.regime_adjust ?? 0);
  const regime = sc.regime as string | null;
  const sourcesUsed: string[] = Array.isArray(sc.sources_used) ? sc.sources_used : [];
  return (
    <div className="pt-2 border-t border-border">
      <div className="text-xs text-muted-foreground mb-1.5 flex items-center justify-between">
        <span>Institutional score (v2)</span>
        <span className="ticker-mono text-foreground">
          {tier ? <span className="text-muted-foreground mr-1">{tier}</span> : null}
          {final}/100
        </span>
      </div>
      {(regime || adj !== 0) && (
        <div className="text-[11px] text-muted-foreground mb-1.5">
          base {base} {adj !== 0 ? `· regime ${regime} (${adj >= 0 ? "+" : ""}${adj})` : ""}
        </div>
      )}
      <div className="space-y-1.5">
        {INSTITUTIONAL_COMPONENTS.map((row) => {
          const c = sc.components?.[row.key];
          if (!c) return null;
          const score = Number(c.score ?? 50);
          const configured = !!c.configured;
          return (
            <div key={row.key} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground w-24 shrink-0">
                  {row.label} <span className="opacity-60">({row.weight}%)</span>
                </span>
                <span className="flex-1 truncate text-foreground/70">
                  {configured ? c.reason : "not configured"}
                </span>
                <span className={cn(
                  "ticker-mono w-12 text-right",
                  !configured ? "text-muted-foreground" : score >= 70 ? "text-bull" : score <= 40 ? "text-bear" : "text-foreground/80",
                )}>
                  {Math.round(score)}
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded bg-muted/40 overflow-hidden">
                <div
                  className={cn("h-full", !configured ? "bg-muted-foreground/40" : score >= 70 ? "bg-bull/60" : score <= 40 ? "bg-bear/60" : "bg-primary/60")}
                  style={{ width: `${score}%` }}
                />
              </div>
              {row.key === "news" && configured && <NewsTransparency details={c.details} source={c.source} />}
              {row.key === "technical" && configured && (c.details as any)?.trendline?.human_reason && (
                <div className="text-[11px] text-muted-foreground/90 mt-1 pl-0.5">
                  ↳ {(c.details as any).trendline.human_reason}
                </div>
              )}
              {row.key === "technical" && configured && <DealerLevelsTransparency details={(c.details as any)?.dealer_levels} />}
              {row.key === "options_flow" && configured && <OptionsFlowTransparency details={c.details} source={c.source} />}
              {row.key === "sentiment" && configured && <SocialIntelTransparency details={c.details} source={c.source} />}
            </div>
          );
        })}
      </div>
      {sourcesUsed.length > 0 && (
        <div className="text-[10px] text-muted-foreground mt-2">
          Sources: {sourcesUsed.join(" · ")}
        </div>
      )}
    </div>
  );
}

function OptionsFlowTransparency({ details, source }: { details: any; source?: string }) {
  if (!details || typeof details !== "object") return null;
  const provider = String(details.provider ?? source ?? "");
  const usingUW = provider === "unusual_whales";
  if (!usingUW) {
    const ps = String(details.provider_status ?? "");
    if (!ps || ps === "uw_missing_key") return null;
    return (
      <div className="mt-1.5 ml-24 pl-2 border-l border-border/60 text-[10px] text-muted-foreground">
        Unusual Whales unavailable ({ps}) — using Finviz aggregate proxy
        {typeof details.finviz_fallback_score === "number" && (
          <span className="ml-1 opacity-70">· proxy score {Math.round(details.finviz_fallback_score)}</span>
        )}
      </div>
    );
  }
  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K`
    : `$${Math.round(n)}`;
  const bull = Number(details.bullish_premium ?? 0);
  const bear = Number(details.bearish_premium ?? 0);
  const cp = Number(details.call_put_bias ?? 1);
  const sweeps = Number(details.sweep_count ?? 0);
  const blocks = Number(details.block_count ?? 0);
  const largest: any[] = Array.isArray(details.largest_flows) ? details.largest_flows : [];
  return (
    <div className="mt-1.5 ml-24 pl-2 border-l border-border/60 space-y-1">
      <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
        <span className="text-bull/90">UW active</span>
        <span>Bullish <span className="text-bull ticker-mono">{fmt(bull)}</span></span>
        <span>Bearish <span className="text-bear ticker-mono">{fmt(bear)}</span></span>
        <span>C/P <span className="ticker-mono text-foreground/80">{cp.toFixed(2)}x</span></span>
        <span>{sweeps} sweeps · {blocks} blocks</span>
      </div>
      {largest.length > 0 && (
        <ul className="text-[10px] text-foreground/70 space-y-0.5">
          {largest.slice(0, 3).map((f, i) => (
            <li key={i} className="truncate">
              <span className="ticker-mono">{String(f.type ?? "").toUpperCase()}</span>
              {f.strike != null && <span className="ml-1 ticker-mono">${f.strike}</span>}
              {f.expiry && <span className="ml-1 opacity-70">{String(f.expiry).slice(0, 10)}</span>}
              <span className="ml-1 opacity-70">{f.side}</span>
              <span className="ml-2 ticker-mono">{fmt(Number(f.premium ?? 0))}</span>
              {f.is_sweep && <span className="ml-1 text-amber-400">sweep</span>}
              {f.is_block && <span className="ml-1 text-amber-400">block</span>}
            </li>
          ))}
        </ul>
      )}
      {typeof details.finviz_fallback_score === "number" && (
        <div className="text-[10px] text-muted-foreground/80">
          Finviz fallback proxy: {Math.round(details.finviz_fallback_score)}
        </div>
      )}
    </div>
  );
}

function SocialIntelTransparency({ details, source }: { details: any; source?: string }) {
  if (!details || typeof details !== "object") return null;
  const provider = String(details.source ?? source ?? "");
  const status = String(details.provider_status ?? "");
  if (provider !== "twitterapi_io" || status !== "active") {
    if (!status || status === "missing_key") return null;
    return (
      <div className="mt-1.5 ml-24 pl-2 border-l border-border/60 text-[10px] text-muted-foreground">
        TwitterAPI.io unavailable ({status}) — Sentiment fell back to neutral 50
      </div>
    );
  }
  const samples = (details.samples ?? {}) as any;
  const subs = (details.subscores ?? {}) as any;
  const top: any[] = Array.isArray(samples.top_kol_tweets) ? samples.top_kol_tweets : [];
  const bullPct = Number(samples.bullish_pct ?? 0);
  const bearPct = Number(samples.bearish_pct ?? 0);
  const neuPct = Number(samples.neutral_pct ?? 0);
  const totalTweets = Number(samples.total_tweets ?? 0);
  const velocity = Number(samples.mention_velocity_ratio ?? 0);
  const kolCount = Number(samples.kol_count ?? 0);
  const classifier = String(details.classifier ?? "");
  const humanReason = String(details.human_reason ?? "");
  return (
    <div className="mt-1.5 ml-24 pl-2 border-l border-border/60 space-y-1.5">
      <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
        <span className="text-bull/90">TwitterAPI.io active</span>
        <span>Tweets <span className="ticker-mono text-foreground/80">{totalTweets}</span></span>
        <span>Velocity <span className="ticker-mono text-foreground/80">{velocity.toFixed(1)}x</span></span>
        <span>KOLs <span className="ticker-mono text-foreground/80">{kolCount}</span></span>
        {classifier && <span>· {classifier}</span>}
      </div>
      <div className="flex h-1.5 rounded overflow-hidden bg-muted/30">
        <div className="bg-bull/70" style={{ width: `${bullPct}%` }} title={`Bullish ${bullPct}%`} />
        <div className="bg-muted-foreground/40" style={{ width: `${neuPct}%` }} title={`Neutral ${neuPct}%`} />
        <div className="bg-bear/70" style={{ width: `${bearPct}%` }} title={`Bearish ${bearPct}%`} />
      </div>
      <div className="text-[10px] text-foreground/70 flex gap-2">
        <span className="text-bull">▲ {bullPct.toFixed(0)}%</span>
        <span className="text-muted-foreground">— {neuPct.toFixed(0)}%</span>
        <span className="text-bear">▼ {bearPct.toFixed(0)}%</span>
      </div>
      <div className="grid grid-cols-5 gap-1 text-[10px]">
        {[
          { k: "polarity", l: "Polarity", w: "35%" },
          { k: "velocity", l: "Velocity", w: "20%" },
          { k: "kol", l: "KOL", w: "15%" },
          { k: "engagement", l: "Engage", w: "10%" },
          { k: "trusted_source", l: "Trusted", w: "20%" },
        ].map((s) => (
          <div key={s.k} className="bg-muted/20 rounded px-1 py-0.5">
            <div className="text-muted-foreground">{s.l} <span className="opacity-60">{s.w}</span></div>
            <div className="ticker-mono text-foreground/80">{Math.round(Number(subs[s.k] ?? 50))}</div>
          </div>
        ))}
      </div>
      <TrustedSourceBlock details={details} />
      {top.length > 0 && (
        <ul className="text-[10px] space-y-0.5">
          {top.slice(0, 3).map((t, i) => (
            <li key={i} className="text-foreground/70">
              <span className={cn(
                "ticker-mono mr-1",
                t.sentiment === "bullish" ? "text-bull" : t.sentiment === "bearish" ? "text-bear" : "text-muted-foreground",
              )}>
                {t.sentiment === "bullish" ? "▲" : t.sentiment === "bearish" ? "▼" : "—"}
              </span>
              {t.userName && (
                <span className="opacity-80">@{t.userName}</span>
              )}
              <span className="opacity-50 ml-1">({Math.round((t.followers ?? 0) / 1000)}k)</span>
              {t.url ? (
                <a href={t.url} target="_blank" rel="noreferrer" className="ml-1 hover:underline">
                  {String(t.text).slice(0, 120)}
                </a>
              ) : (
                <span className="ml-1">{String(t.text).slice(0, 120)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {humanReason && (
        <div className="text-[10px] text-muted-foreground/90 italic">↳ {humanReason}</div>
      )}
    </div>
  );
}

function TrustedSourceBlock({ details }: { details: any }) {
  const score = Number(details?.trusted_source_score ?? 50);
  const hits = Number(details?.trusted_source_hits ?? 0);
  const accounts: string[] = Array.isArray(details?.trusted_source_accounts) ? details.trusted_source_accounts : [];
  const headlines: any[] = Array.isArray(details?.trusted_source_headlines) ? details.trusted_source_headlines : [];
  const summary = String(details?.trusted_source_summary ?? "");
  const dist = (details?.trusted_tier_distribution ?? {}) as Record<string, number>;
  const monitored = Number(details?.monitored_account_count ?? 0);
  return (
    <div className="mt-1 rounded border border-border/60 bg-muted/10 px-2 py-1.5 space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-foreground/80 font-medium">Trusted Source Intelligence</span>
        <span className="ticker-mono text-foreground/80">{Math.round(score)}</span>
      </div>
      <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
        <span>Hits <span className="ticker-mono text-foreground/80">{hits}</span></span>
        <span>Accounts <span className="ticker-mono text-foreground/80">{accounts.length}</span></span>
        <span>Monitored <span className="ticker-mono text-foreground/80">{monitored}</span></span>
        {[1, 2, 3, 4, 5].map((t) => (
          <span key={t} className="opacity-80">T{t}:<span className="ticker-mono text-foreground/80 ml-0.5">{Number(dist[String(t)] ?? 0)}</span></span>
        ))}
      </div>
      {headlines.length > 0 && (
        <ul className="text-[10px] space-y-0.5">
          {headlines.slice(0, 4).map((h, i) => (
            <li key={i} className="text-foreground/75">
              <span className={cn(
                "ticker-mono mr-1",
                h.sentiment === "bullish" ? "text-bull" : h.sentiment === "bearish" ? "text-bear" : "text-muted-foreground",
              )}>
                {h.sentiment === "bullish" ? "▲" : h.sentiment === "bearish" ? "▼" : "—"}
              </span>
              <span className="opacity-80">@{h.account}</span>
              <span className="opacity-50 ml-1">T{h.tier}</span>
              {h.url ? (
                <a href={h.url} target="_blank" rel="noreferrer" className="ml-1 hover:underline">{String(h.headline).slice(0, 140)}</a>
              ) : (
                <span className="ml-1">{String(h.headline).slice(0, 140)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {summary && <div className="text-[10px] text-muted-foreground/90 italic">↳ {summary}</div>}
    </div>
  );
}


type Headline = { headline: string; source: "finnhub" | "finviz"; url?: string };

function NewsTransparency({ details, source }: { details: any; source?: string }) {
  if (!details || typeof details !== "object") return null;
  const articles = Number(details.article_count ?? 0);
  const finnhubN = Number(details.finnhub_articles ?? 0);
  const finvizN = Number(details.finviz_extra_articles ?? 0);
  const reasonCode = String(details.reason_code ?? "");
  const sent403 = !!details.finnhub_sentiment_403;
  const fallback = !!details.finviz_fallback_active;
  const headlines: Headline[] = Array.isArray(details.top_headlines) ? details.top_headlines : [];

  const srcLabel =
    source === "finnhub" ? "Finnhub company-news + sentiment" :
    source === "finnhub+finviz_news" ? "Finnhub + Finviz news" :
    source === "finnhub_news" ? "Finnhub company-news" :
    source === "finnhub_news+finviz_news" ? "Finnhub company-news + Finviz news" :
    source === "finviz_news" ? "Finviz news (fallback)" :
    source || "—";

  return (
    <div className="mt-1.5 ml-24 pl-2 border-l border-border/60 space-y-1">
      <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
        <span>Source: <span className="text-foreground/80">{srcLabel}</span></span>
        <span>Articles: <span className="text-foreground/80 ticker-mono">{articles}</span>{(finnhubN > 0 || finvizN > 0) && (
          <span className="opacity-70"> ({finnhubN} Finnhub · {finvizN} Finviz)</span>
        )}</span>
        {reasonCode && <span>Reason: <span className="text-foreground/80 ticker-mono">{reasonCode}</span></span>}
      </div>
      {(sent403 || fallback) && (
        <div className="text-[10px] flex flex-wrap gap-1">
          {sent403 && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 ticker-mono">
              finnhub_sentiment_403
            </span>
          )}
          {fallback && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 ticker-mono">
              finnhub_403_finviz_news_fallback_active
            </span>
          )}
        </div>
      )}
      {headlines.length > 0 && (
        <ul className="text-[10px] space-y-0.5">
          {headlines.slice(0, 5).map((h, i) => (
            <li key={i} className="flex gap-1.5 text-foreground/70">
              <span className={cn(
                "shrink-0 px-1 rounded ticker-mono text-[9px] leading-4",
                h.source === "finnhub" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
              )}>
                {h.source === "finnhub" ? "FH" : "FV"}
              </span>
              {h.url ? (
                <a href={h.url} target="_blank" rel="noreferrer" className="truncate hover:text-foreground hover:underline">
                  {h.headline}
                </a>
              ) : (
                <span className="truncate">{h.headline}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type InsiderStrength = {
  score: number;
  label: string;
  buy_count_30d: number;
  sell_count_30d: number;
  buy_count_90d: number;
  sell_count_90d: number;
  signals: Array<{ kind: string; weight: number; detail?: string }>;
  as_of: string;
};
type InsiderTx = {
  insider_name: string;
  role: string | null;
  transaction_type: string;
  transaction_date: string;
  shares: number | null;
  price: number | null;
  total_value: number | null;
  direction: string;
};

function labelTone(label: string): string {
  if (label === "strong_buy") return "bg-emerald-500/15 text-emerald-400";
  if (label === "buy") return "bg-emerald-500/10 text-emerald-300";
  if (label === "sell") return "bg-red-500/10 text-red-300";
  if (label === "strong_sell") return "bg-red-500/15 text-red-400";
  return "bg-muted text-muted-foreground";
}

function InsiderActivity({ ticker }: { ticker: string }) {
  const [strength, setStrength] = useState<InsiderStrength | null>(null);
  const [txs, setTxs] = useState<InsiderTx[] | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [{ data: s }, { data: t }] = await Promise.all([
        supabase.from("insider_strength_scores").select("*").eq("ticker", ticker).maybeSingle(),
        supabase.from("insider_transactions")
          .select("insider_name, role, transaction_type, transaction_date, shares, price, total_value, direction")
          .eq("ticker", ticker)
          .order("transaction_date", { ascending: false })
          .limit(5),
      ]);
      if (!active) return;
      setStrength((s as unknown as InsiderStrength) ?? null);
      setTxs((t as unknown as InsiderTx[]) ?? []);
    })();
    return () => { active = false; };
  }, [ticker]);

  if (txs === null) {
    return (
      <div className="pt-2 border-t border-border">
        <div className="text-xs text-muted-foreground">Insider activity: loading…</div>
      </div>
    );
  }
  if (!strength && txs.length === 0) {
    return (
      <div className="pt-2 border-t border-border">
        <div className="text-xs text-muted-foreground mb-1">Insider activity</div>
        <div className="text-[11px] text-muted-foreground">No insider data on file for {ticker}.</div>
        <div className="text-[10px] text-muted-foreground/70 mt-1 italic">Metadata only — does not affect confidence score.</div>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-border">
      <div className="text-xs text-muted-foreground mb-1.5 flex items-center justify-between">
        <span>Insider activity</span>
        {strength && (
          <span className="flex items-center gap-1.5">
            <span className={cn("px-1.5 py-0.5 rounded text-[10px]", labelTone(strength.label))}>{strength.label}</span>
            <span className="ticker-mono text-foreground/80">{strength.score}/100</span>
          </span>
        )}
      </div>

      {strength && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <div className="flex justify-between"><span className="text-muted-foreground">30d buys</span><span className="ticker-mono text-emerald-400">{strength.buy_count_30d}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">30d sells</span><span className="ticker-mono text-red-400">{strength.sell_count_30d}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">90d buys</span><span className="ticker-mono text-emerald-400">{strength.buy_count_90d}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">90d sells</span><span className="ticker-mono text-red-400">{strength.sell_count_90d}</span></div>
          </div>
          {Array.isArray(strength.signals) && strength.signals.length > 0 && (
            <div className="mt-1.5 text-[10px] text-muted-foreground">
              {strength.signals.slice(0, 4).map((s, i) => (
                <span key={i} className="mr-2">
                  {s.kind} <span className={s.weight >= 0 ? "text-emerald-400" : "text-red-400"}>{s.weight >= 0 ? "+" : ""}{s.weight}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {txs.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] text-muted-foreground mb-0.5">Top 5 recent transactions</div>
          <ul className="space-y-0.5 text-[11px]">
            {txs.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="ticker-mono text-muted-foreground w-16 shrink-0">{t.transaction_date}</span>
                <span className="truncate flex-1">{t.insider_name}{t.role ? <span className="text-muted-foreground"> · {t.role}</span> : null}</span>
                <span className={cn("text-[10px]", t.direction === "buy" ? "text-emerald-400" : t.direction === "sell" ? "text-red-400" : "text-muted-foreground")}>{t.direction}</span>
                <span className="ticker-mono w-20 text-right text-muted-foreground">
                  {t.total_value ? `$${Math.round(t.total_value).toLocaleString()}` : t.shares ? `${t.shares.toLocaleString()}sh` : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground/70 mt-2 italic">Metadata only — does not affect confidence score.</div>
    </div>
  );
}




