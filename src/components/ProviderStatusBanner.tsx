import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Info, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type ProviderState =
  | "active"
  | "reserved"
  | "missing_key"
  | "auth_failed"
  | "not_entitled"
  | "degraded";

type ProviderStatus = {
  provider: string;
  role: string;
  state: ProviderState;
  detail?: string;
  note?: string;
};

const WARNING_STATES = new Set<ProviderState>(["degraded", "missing_key", "auth_failed", "not_entitled"]);

const STATE_LABEL: Record<ProviderState, string> = {
  active: "Active",
  reserved: "Reserved",
  missing_key: "Missing key",
  auth_failed: "Auth failed",
  not_entitled: "Not entitled",
  degraded: "Degraded",
};

const STATE_CLASSES: Record<ProviderState, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  reserved: "bg-muted text-muted-foreground border-border",
  missing_key: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  auth_failed: "bg-red-500/15 text-red-300 border-red-500/30",
  not_entitled: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  degraded: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

function StateIcon({ state }: { state: ProviderState }) {
  if (state === "active") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (state === "reserved") return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  if (state === "auth_failed") return <XCircle className="h-3.5 w-3.5 text-red-400" />;
  return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
}

function StatusPill({ state }: { state: ProviderState }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide", STATE_CLASSES[state])}>
      {STATE_LABEL[state]}
    </span>
  );
}

export function ProviderStatusBanner({ signals }: { signals: any[] | null }) {
  const [expanded, setExpanded] = useState(false);

  const statuses = useMemo<ProviderStatus[]>(() => {
    if (!signals || signals.length === 0) return [];
    for (const s of signals) {
      const ps = (s as any)?.score_components?.provider_status;
      if (Array.isArray(ps) && ps.length > 0) return ps as ProviderStatus[];
    }
    return [];
  }, [signals]);

  // Inject Alpaca as a synthetic entry — it's always used by the scanner trend
  // component but isn't currently emitted into provider_status.
  const enriched: ProviderStatus[] = useMemo(() => {
    if (statuses.length === 0) return [];
    const hasAlpaca = statuses.some((p) => p.provider === "alpaca");
    if (hasAlpaca) return statuses;
    return [
      {
        provider: "alpaca",
        role: "price bars + base trend",
        state: "active" as ProviderState,
        note: "Powers scanner trend baseline + technical blend.",
      },
      ...statuses,
    ];
  }, [statuses]);

  if (statuses.length === 0) return null;

  const nonReserved = enriched.filter((p) => p.state !== "reserved");
  const reserved = enriched.filter((p) => p.state === "reserved");
  const degradedNonReserved = nonReserved.filter((p) => WARNING_STATES.has(p.state));
  const showDegradedBanner = degradedNonReserved.length > 0;

  return (
    <div className="rounded-md border border-border bg-card/60 text-xs">
      {/* Degraded-mode top banner */}
      {showDegradedBanner && (
        <div className="flex items-start gap-2 border-b border-border bg-amber-500/5 px-3 py-2 text-amber-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">
              Signals are currently running in degraded mode.
            </div>
            <div className="text-amber-300/80 text-[11px] mt-0.5">
              Some paid data feeds are unavailable — scores may be conservative.
              {" "}
              {degradedNonReserved.length} of {nonReserved.length} active providers degraded.
            </div>
          </div>
        </div>
      )}

      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          <span>Provider Data Quality</span>
          <span className="text-[10px] opacity-70">
            ({nonReserved.filter((p) => p.state === "active").length}/{nonReserved.length} active · {reserved.length} reserved)
          </span>
        </div>
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {/* Expanded data quality panel */}
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-1.5">
          {nonReserved.map((p, i) => (
            <div key={`p-${i}`} className="flex items-start gap-2 py-1">
              <StateIcon state={p.state} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-foreground">{p.provider}</span>
                  <StatusPill state={p.state} />
                  <span className="text-muted-foreground text-[11px]">{p.role}</span>
                </div>
                {(p.detail || p.note) && (
                  <div className="text-muted-foreground text-[11px] mt-0.5">
                    {p.detail && <span>{p.detail}</span>}
                    {p.detail && p.note && <span> · </span>}
                    {p.note && <span className="opacity-70">{p.note}</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
          {reserved.length > 0 && (
            <div className="pt-1.5 mt-1.5 border-t border-border/50 space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Reserved (inactive)</div>
              {reserved.map((p, i) => (
                <div key={`r-${i}`} className="flex items-start gap-2 py-0.5">
                  <StateIcon state={p.state} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-foreground/80">{p.provider}</span>
                      <StatusPill state={p.state} />
                      <span className="text-muted-foreground text-[11px]">{p.role}</span>
                    </div>
                    {p.note && (
                      <div className="text-muted-foreground/70 text-[11px] mt-0.5">{p.note}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ProviderStatusBanner;
