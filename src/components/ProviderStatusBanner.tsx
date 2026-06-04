import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Info } from "lucide-react";
import { cn } from "@/lib/utils";

type ProviderStatus = {
  provider: string;
  role: string;
  state: "active" | "reserved" | "missing_key" | "auth_failed" | "not_entitled" | "degraded";
  detail?: string;
  note?: string;
};

const WARNING_STATES = new Set(["degraded", "missing_key", "auth_failed", "not_entitled"]);

const COPY: Record<string, (p: ProviderStatus) => string> = {
  degraded: (p) =>
    `${p.provider} degraded — valid data not available. ${p.role} is using neutral fallback.`,
  missing_key: (p) =>
    `${p.provider} key missing — ${p.role} is using neutral fallback.`,
  auth_failed: (p) =>
    `${p.provider} authentication failed — ${p.role} is using neutral fallback.`,
  not_entitled: (p) =>
    `${p.provider} plan not entitled — ${p.role} is using neutral fallback.`,
};

export function ProviderStatusBanner({ signals }: { signals: any[] | null }) {
  const [showReserved, setShowReserved] = useState(false);

  const statuses = useMemo<ProviderStatus[]>(() => {
    if (!signals || signals.length === 0) return [];
    // Pick most recent signal with score_components.provider_status
    for (const s of signals) {
      const ps = (s as any)?.score_components?.provider_status;
      if (Array.isArray(ps) && ps.length > 0) return ps as ProviderStatus[];
    }
    return [];
  }, [signals]);

  if (statuses.length === 0) return null;

  const warnings = statuses.filter((p) => WARNING_STATES.has(p.state));
  const reserved = statuses.filter((p) => p.state === "reserved");

  if (warnings.length === 0 && reserved.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-card/60 px-3 py-2 text-xs space-y-1.5">
      {warnings.map((p, i) => (
        <div key={`w-${i}`} className="flex items-start gap-2 text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1">
            <span>⚠ {(COPY[p.state] ?? ((x: ProviderStatus) => `${x.provider} ${x.state}`))(p)}</span>
            {p.detail && (
              <span className="text-muted-foreground"> — {p.detail}</span>
            )}
          </div>
        </div>
      ))}

      {reserved.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowReserved((v) => !v)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Info className="h-3 w-3" />
            <span>{reserved.length} reserved provider{reserved.length === 1 ? "" : "s"}</span>
            {showReserved ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {showReserved && (
            <ul className="mt-1 ml-4 space-y-0.5 text-muted-foreground">
              {reserved.map((p, i) => (
                <li key={`r-${i}`} className={cn("text-[11px]")}>
                  {p.provider} — Reserved ({p.role})
                  {p.note ? <span className="opacity-70"> · {p.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default ProviderStatusBanner;
