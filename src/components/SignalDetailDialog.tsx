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
      <DialogContent className="max-w-lg">
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


