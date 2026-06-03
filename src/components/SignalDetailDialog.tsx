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

interface Props {
  signal: Signal | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  outcome?: SignalOutcome;
}

export function SignalDetailDialog({ signal, open, onOpenChange, outcome }: Props) {
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

  if (!signal) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="ticker-mono">{signal.ticker}</span>
            <Badge variant="outline" className="border-border">{signal.direction}</Badge>
            {signal.is_demo
              ? <Badge variant="outline" className="text-muted-foreground">Demo</Badge>
              : <Badge className="bg-emerald-500/15 text-emerald-400 border-0">Live</Badge>}
            {outcome && outcome !== "none" && (
              <Badge className={cn("border-0", OUTCOME_CLASS[outcome])}>{OUTCOME_LABEL[outcome]}</Badge>
            )}
          </DialogTitle>
        </DialogHeader>


        <div className="space-y-3 text-sm">
          <Row label="Confidence" value={`${signal.confidence}/100`} />
          <Row label="Risk" value={signal.risk_level} />
          <Row label="DTE" value={signal.dte != null ? String(signal.dte) : "—"} />
          <Row label="Price" value={signal.price != null ? `$${Number(signal.price).toFixed(2)}` : "—"} />
          <Row label="Source" value={signal.source ?? "—"} mono />
          <Row label="Created" value={new Date(signal.created_at).toLocaleString()} />
          {isAdmin && <Row label="signal_id" value={signal.id} mono small />}
          {isAdmin && <Row label="external_id" value={signal.external_id ?? "—"} mono small />}

          {Array.isArray(signal.reasons) && signal.reasons.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Reasons</div>
              <ul className="space-y-0.5 text-xs">
                {(signal.reasons as string[]).map((r, i) => (
                  <li key={i} className="text-foreground/80">• {r}</li>
                ))}
              </ul>
            </div>
          )}

          <ComponentBreakdown tm={signal.technical_metrics as any} />


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

