// Radar-style breakdown of a signal's quality. Purely presentational — derives
// from existing score_components + contract metadata. Does not modify any scoring.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Signal } from "@/lib/signalHelpers";
import { getContractMeta } from "@/lib/rankSignals";
import { getExpiryMs } from "@/lib/signalFreshness";
import { effectiveConfidence } from "@/lib/techAdjust";

export type RadarMetrics = {
  flow: number;       // 0..100
  liquidity: number;  // 0..100
  freshness: number;  // 0..100
  trend: number;      // 0..100
  risk: number;       // 0..100 (higher = safer)
  composite: number;  // 0..100 — uses signal.confidence
};

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function readComponentScore(components: any, ...keys: string[]): number | null {
  if (!components || typeof components !== "object") return null;
  for (const k of keys) {
    const v = components?.[k];
    if (v == null) continue;
    if (typeof v === "number") return v;
    if (typeof v?.score === "number") return v.score;
  }
  return null;
}

export function deriveRadarMetrics(s: Signal, now = Date.now()): RadarMetrics {
  const sc = (s.score_components as any) ?? {};
  const components = sc.components ?? sc;
  const contract = getContractMeta(s);

  const flow =
    readComponentScore(components, "flow", "options_flow", "uw_flow") ??
    Math.round(clamp(Number(s.confidence ?? 0)));

  const liquidity =
    contract?.liquidity_score != null
      ? Math.round(clamp(Number(contract.liquidity_score)))
      : Math.round(clamp(readComponentScore(components, "liquidity") ?? 50));

  // Freshness — fraction of TTL remaining, 0..100.
  const created = new Date(s.created_at).getTime();
  const expiry = getExpiryMs(s);
  const total = Math.max(1, expiry - created);
  const remaining = Math.max(0, expiry - now);
  const freshness = Math.round(clamp((remaining / total) * 100));

  const trend = Math.round(clamp(
    readComponentScore(components, "trend", "technical", "tech") ??
    readComponentScore(components, "macro") ??
    50
  ));

  const risk = s.risk_level === "LOW" ? 80 : s.risk_level === "MEDIUM" ? 55 : 30;

  const composite = Math.round(clamp(Number(effectiveConfidence(s as any) ?? 0)));

  return {
    flow: clamp(flow),
    liquidity: clamp(liquidity),
    freshness: clamp(freshness),
    trend: clamp(trend),
    risk: clamp(risk),
    composite: clamp(composite),
  };
}

function barColor(v: number): string {
  if (v >= 75) return "bg-bull";
  if (v >= 50) return "bg-primary";
  if (v >= 30) return "bg-warn";
  return "bg-bear";
}

function fmtScore(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const rounded = Math.round(v * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <div className="w-16 text-muted-foreground shrink-0">{label}</div>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", barColor(value))} style={{ width: `${value}%` }} />
      </div>
      <div className="w-12 text-right ticker-mono text-foreground tabular-nums">{fmtScore(value)}</div>
    </div>
  );
}

export function SignalRadar({ signal, className, compact = false }: { signal: Signal; className?: string; compact?: boolean }) {
  // Re-render every 30s so freshness bar updates live.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const m = deriveRadarMetrics(signal);
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Composite</span>
        <span className={cn(
          "ticker-mono font-semibold",
          compact ? "text-base" : "text-lg",
          m.composite >= 75 ? "text-bull" : m.composite >= 50 ? "text-primary" : "text-muted-foreground",
        )}>
          {m.composite}
        </span>
      </div>
      <Bar label="Flow" value={m.flow} />
      <Bar label="Liquidity" value={m.liquidity} />
      <Bar label="Freshness" value={m.freshness} />
      <Bar label="Trend" value={m.trend} />
      <Bar label="Risk" value={m.risk} />
    </div>
  );
}
