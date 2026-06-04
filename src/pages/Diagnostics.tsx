import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Loader2, CheckCircle2, AlertTriangle, XCircle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type ProbeResult =
  | { skipped: true; reason: string }
  | {
      ok: boolean;
      status?: number;
      content_type?: string;
      final_url?: string;
      classified?: { kind: string; message: string };
      bytes?: number;
      preview?: string;
      ms?: number;
      error?: string;
    };

type DebugResponse = {
  ticker: string;
  results: Record<string, ProbeResult>;
  ts: string;
};

const PROVIDERS = [
  { key: "finviz_main", label: "Finviz main snapshot" },
  { key: "finviz_news", label: "Finviz news" },
  { key: "finviz_insider", label: "Finviz insider" },
  { key: "finviz_sectors", label: "Finviz sectors" },
  { key: "finnhub", label: "Finnhub" },
  { key: "apify", label: "Apify (X sentiment)" },
  { key: "alpaca", label: "Alpaca bars" },
  { key: "unusual_whales", label: "Unusual Whales (options flow)" },

];

function statusOf(r: ProbeResult): { kind: string; tone: "ok" | "warn" | "err" | "skip"; label: string } {
  if ("skipped" in r) return { kind: "missing_key", tone: "skip", label: "Missing key" };
  if (r.error) return { kind: "fetch_error", tone: "err", label: "Fetch error" };
  if (r.classified?.kind === "ok") return { kind: "ok", tone: "ok", label: "OK" };
  if (r.classified?.kind === "not_entitled") return { kind: "not_entitled", tone: "warn", label: "Not entitled" };
  if (r.classified?.kind === "auth_failed") return { kind: "auth_failed", tone: "err", label: "Auth failed" };
  if (r.classified?.kind === "html_response") return { kind: "html_response", tone: "warn", label: "HTML response" };
  if (r.classified?.kind === "empty") return { kind: "empty", tone: "warn", label: "Empty" };
  if (typeof r.status === "number" && r.status >= 400) return { kind: "http_error", tone: "err", label: `HTTP ${r.status}` };
  return { kind: "unknown", tone: "warn", label: "Unknown" };
}

function ToneIcon({ tone }: { tone: "ok" | "warn" | "err" | "skip" }) {
  if (tone === "ok") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (tone === "err") return <XCircle className="h-4 w-4 text-red-400" />;
  if (tone === "skip") return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
  return <AlertTriangle className="h-4 w-4 text-amber-400" />;
}

export default function Diagnostics() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [ticker, setTicker] = useState("NVDA");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DebugResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (adminLoading) {
    return <div className="p-6 text-muted-foreground text-sm">Checking permissions…</div>;
  }
  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card className="p-6 max-w-md mx-auto text-center space-y-2">
          <ShieldAlert className="h-8 w-8 text-amber-400 mx-auto" />
          <h2 className="text-lg font-semibold">Admin access required</h2>
          <p className="text-sm text-muted-foreground">
            This diagnostics page is restricted to administrators.
          </p>
        </Card>
      </div>
    );
  }

  const run = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const { data: res, error } = await supabase.functions.invoke<DebugResponse>("provider-debug", {
        body: { provider: "all", ticker: ticker.trim().toUpperCase() || "NVDA" },
      });
      if (error) throw error;
      setData(res ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold">Provider Diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Probes each data provider directly and classifies the response. Read-only — does not change scoring.
        </p>
      </div>

      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Test ticker</label>
          <Input
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            className="w-32 uppercase"
            placeholder="NVDA"
          />
        </div>
        <Button onClick={run} disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Probe all providers
        </Button>
        {data && (
          <span className="text-xs text-muted-foreground ml-auto">
            Last run: {new Date(data.ts).toLocaleTimeString()}
          </span>
        )}
      </Card>

      {error && (
        <Card className="p-4 border-red-500/30 bg-red-500/5 text-sm text-red-300">
          {error}
        </Card>
      )}

      <div className="grid gap-3">
        {PROVIDERS.map(({ key, label }) => {
          const r = data?.results?.[key];
          const st = r ? statusOf(r) : null;
          return (
            <Card key={key} className="p-4">
              <div className="flex items-start gap-3">
                <div className="pt-0.5">
                  {st ? <ToneIcon tone={st.tone} /> : <div className="h-4 w-4 rounded-full border border-border" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="font-medium">{label}</div>
                    {st && (
                      <span className={cn(
                        "text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border",
                        st.tone === "ok"   && "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
                        st.tone === "warn" && "bg-amber-500/15 text-amber-300 border-amber-500/30",
                        st.tone === "err"  && "bg-red-500/15 text-red-300 border-red-500/30",
                        st.tone === "skip" && "bg-muted text-muted-foreground border-border",
                      )}>
                        {st.label}
                      </span>
                    )}
                  </div>
                  {r && "skipped" in r && r.skipped && (
                    <div className="text-xs text-muted-foreground mt-1">{r.reason}</div>
                  )}
                  {r && !("skipped" in r) && (
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      {r.classified && (
                        <div>
                          <span className="text-foreground/80">{r.classified.kind}</span> — {r.classified.message}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-3 opacity-80">
                        {typeof r.status === "number" && <span>HTTP {r.status}</span>}
                        {r.content_type && <span>{r.content_type}</span>}
                        {typeof r.bytes === "number" && <span>{r.bytes} bytes</span>}
                        {typeof r.ms === "number" && <span>{r.ms} ms</span>}
                      </div>
                      {r.final_url && r.final_url.includes("utm_campaign=") && (
                        <div className="text-amber-400">Redirected to upsell: {r.final_url}</div>
                      )}
                      {r.error && <div className="text-red-300">{r.error}</div>}
                      {r.preview && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                            Show response preview
                          </summary>
                          <pre className="mt-1 p-2 bg-muted/30 rounded text-[10px] overflow-x-auto whitespace-pre-wrap break-all max-h-40">
                            {r.preview}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                  {!r && !loading && (
                    <div className="text-xs text-muted-foreground mt-1">Not yet probed.</div>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
