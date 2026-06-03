import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Globe, RefreshCw, Eye, PlayCircle, Loader2, BarChart3 } from "lucide-react";
import { toast } from "sonner";

type UniverseMode = "base_8" | "watchlist_earnings" | "top_100" | "top_250" | "top_500";

const MODE_LABEL: Record<UniverseMode, string> = {
  base_8: "Base 8 (SPY, QQQ, NVDA, TSLA, AMD, AAPL, META, MSFT)",
  watchlist_earnings: "Watchlist + Earnings (next 14d)",
  top_100: "Market-Wide Top 100",
  top_250: "Market-Wide Top 250",
  top_500: "Market-Wide Top 500",
};

type UniverseRow = {
  ticker: string;
  company_name: string | null;
  avg_volume: number | null;
  last_price: number | null;
  optionable: boolean;
  exchange: string | null;
};

type LastScan = {
  ran_at: string;
  signals_created: number;
  skipped_count: number;
  universe_mode: string | null;
  universe_count: number | null;
  watchlist_count: number | null;
  earnings_count: number | null;
  skipped_due_to_cap: number | null;
  tickers_scanned: string[] | null;
};

export default function ScannerUniversePanel() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [mode, setMode] = useState<UniverseMode>("base_8");
  const [saving, setSaving] = useState(false);
  const [universeSize, setUniverseSize] = useState<number | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [upcomingEarnings, setUpcomingEarnings] = useState<number | null>(null);
  const [lastScan, setLastScan] = useState<LastScan | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRows, setPreviewRows] = useState<UniverseRow[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  async function loadAll() {
    const [settingsRes, sizeRes, refreshRes, earningsRes, scanRes] = await Promise.all([
      supabase.from("scanner_settings").select("universe_mode").eq("id", "global").maybeSingle(),
      supabase.from("tradable_universe").select("ticker", { count: "exact", head: true }),
      supabase.from("tradable_universe").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("earnings_events")
        .select("ticker", { count: "exact", head: true })
        .gte("report_date", new Date().toISOString().slice(0, 10))
        .lte("report_date", new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)),
      supabase.from("signal_scan_runs")
        .select("ran_at, signals_created, skipped_count, universe_mode, universe_count, watchlist_count, earnings_count, skipped_due_to_cap, tickers_scanned")
        .order("ran_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const m = ((settingsRes.data as any)?.universe_mode as UniverseMode) ?? "base_8";
    setMode(m);
    setUniverseSize(sizeRes.count ?? 0);
    setLastRefresh((refreshRes.data as any)?.updated_at ?? null);
    setUpcomingEarnings(earningsRes.count ?? 0);
    setLastScan((scanRes.data as LastScan) ?? null);
  }

  useEffect(() => { if (isAdmin) loadAll(); }, [isAdmin]);

  async function saveMode(next: UniverseMode) {
    setSaving(true);
    const prev = mode;
    setMode(next);
    const { error } = await supabase.from("scanner_settings")
      .update({ universe_mode: next }).eq("id", "global");
    setSaving(false);
    if (error) {
      setMode(prev);
      toast.error(error.message);
    } else {
      toast.success(`Scanner mode → ${MODE_LABEL[next]}`);
    }
  }

  async function refreshUniverse() {
    setRefreshing(true);
    const { data, error } = await supabase.functions.invoke("refresh-tradable-universe", { body: {} });
    setRefreshing(false);
    if (error) { toast.error(error.message); return; }
    const d = data as any;
    toast.success(`Universe refreshed: ${d?.upserted ?? 0} stocks (${d?.optionable_count ?? 0} optionable)`);
    loadAll();
  }

  async function runScan() {
    setScanning(true);
    const { data, error } = await supabase.functions.invoke("scan-signals", { body: { force: true } });
    setScanning(false);
    if (error) { toast.error(error.message); return; }
    const d = data as any;
    if (d?.status === "scan_in_progress") {
      toast.info("Another scan is already running.");
    } else {
      toast.success(`Scan complete: ${d?.signals_created ?? 0} signals from ${d?.universe_count ?? 0} stocks`);
    }
    loadAll();
  }

  async function backfillVolume() {
    setBackfilling(true);
    let offset = 0;
    let totalProcessed = 0, totalUpdated = 0, totalFailed = 0;
    const maxIterations = 20; // safety bound
    try {
      for (let i = 0; i < maxIterations; i++) {
        const { data, error } = await supabase.functions.invoke(
          `backfill-universe-volume?offset=${offset}&limit=1000`,
          { body: {} },
        );
        if (error) throw new Error(error.message);
        const d = data as any;
        totalProcessed += d?.processed ?? 0;
        totalUpdated += d?.updated ?? 0;
        totalFailed += d?.failed ?? 0;
        toast.info(`Backfill: ${totalUpdated} updated / ${totalProcessed} processed (${totalFailed} failed)`);
        if (d?.done) break;
        offset = d?.next_offset ?? (offset + 1000);
      }
      toast.success(`Backfill complete: ${totalUpdated} updated, ${totalFailed} failed`);
    } catch (e: any) {
      toast.error(`Backfill error: ${e.message}`);
    } finally {
      setBackfilling(false);
      loadAll();
    }
  }

  async function openPreview() {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewRows(null);

    // Replicate universe resolution client-side for preview
    let rows: UniverseRow[] = [];
    if (mode === "base_8") {
      const base = ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "AAPL", "META", "MSFT"];
      rows = base.map((t) => ({ ticker: t, company_name: null, avg_volume: null, last_price: null, optionable: true, exchange: null }));
    } else if (mode === "watchlist_earnings") {
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      const [wl, earn] = await Promise.all([
        supabase.from("watchlist_items").select("ticker"),
        supabase.from("earnings_events").select("ticker").gte("report_date", today).lte("report_date", horizon),
      ]);
      const merged = new Map<string, UniverseRow>();
      (wl.data ?? []).forEach((r: any) => merged.set(r.ticker, {
        ticker: r.ticker, company_name: "(watchlist)", avg_volume: null, last_price: null, optionable: true, exchange: null,
      }));
      (earn.data ?? []).forEach((r: any) => {
        const existing = merged.get(r.ticker);
        merged.set(r.ticker, existing
          ? { ...existing, company_name: "(watchlist + earnings)" }
          : { ticker: r.ticker, company_name: "(earnings)", avg_volume: null, last_price: null, optionable: true, exchange: null });
      });
      rows = [...merged.values()];
    } else {
      const cap = mode === "top_100" ? 100 : mode === "top_250" ? 250 : 500;
      const { data } = await supabase.from("tradable_universe")
        .select("ticker, company_name, avg_volume, last_price, optionable, exchange")
        .eq("optionable", true).eq("active", true).eq("tradable", true)
        .order("avg_volume", { ascending: false, nullsFirst: false })
        .limit(cap);
      rows = (data ?? []) as UniverseRow[];
    }
    setPreviewRows(rows);
    setPreviewLoading(false);
  }

  function sourceFor(r: UniverseRow): string {
    if (r.company_name?.includes("watchlist") || r.company_name?.includes("earnings")) return r.company_name;
    if (mode === "base_8") return "Base";
    return "Market";
  }

  function liquidityScore(r: UniverseRow): string {
    if (r.avg_volume == null) return "—";
    const v = Number(r.avg_volume);
    if (v >= 10_000_000) return "★★★";
    if (v >= 1_000_000) return "★★";
    return "★";
  }

  if (!user) return null;
  if (!isAdmin) return null;

  return (
    <section className="glass-card p-5 space-y-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-semibold flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" /> Scanner Universe
          <Badge variant="outline" className="ml-2">Admin</Badge>
        </h2>
      </header>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Current mode</Label>
          <Select value={mode} onValueChange={(v) => saveMode(v as UniverseMode)} disabled={saving}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(MODE_LABEL) as UniverseMode[]).map((k) => (
                <SelectItem key={k} value={k}>{MODE_LABEL[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Default <strong>Base 8</strong>. Top 250 only activates when you select it here.
          </p>
        </div>

        <div className="space-y-2 text-sm">
          <Stat label="Universe size (tradable_universe)" value={universeSize === null ? "—" : `${universeSize.toLocaleString()} stocks`} />
          <Stat label="Last universe refresh" value={lastRefresh ? new Date(lastRefresh).toLocaleString() : "Never — click Refresh"} />
          <Stat label="Upcoming earnings (14d)" value={upcomingEarnings === null ? "—" : `${upcomingEarnings} stocks`} />
        </div>
      </div>

      <div className="rounded-md border border-border p-3 space-y-1 text-sm">
        <div className="font-medium text-xs uppercase tracking-wide text-muted-foreground">Last scan</div>
        {lastScan ? (
          <div className="grid sm:grid-cols-4 gap-2 text-xs">
            <Stat label="When" value={new Date(lastScan.ran_at).toLocaleString()} />
            <Stat label="Mode" value={lastScan.universe_mode ?? "—"} />
            <Stat label="Scanned" value={`${lastScan.tickers_scanned?.length ?? 0} / ${lastScan.universe_count ?? 0}`} />
            <Stat label="Signals" value={`${lastScan.signals_created} (skipped ${lastScan.skipped_count})`} />
            <Stat label="Watchlist hits" value={String(lastScan.watchlist_count ?? 0)} />
            <Stat label="Earnings hits" value={String(lastScan.earnings_count ?? 0)} />
            <Stat label="Skipped (cap)" value={String(lastScan.skipped_due_to_cap ?? 0)} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No scans yet.</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={refreshUniverse} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Refresh Universe
        </Button>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" onClick={openPreview}>
              <Eye className="h-4 w-4 mr-1" /> Preview Universe
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Preview — {MODE_LABEL[mode]}</DialogTitle>
            </DialogHeader>
            <div className="overflow-y-auto -mx-6 px-6">
              {previewLoading ? (
                <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
              ) : !previewRows || previewRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tickers. Try Refresh Universe first.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-muted-foreground sticky top-0 bg-background">
                    <tr>
                      <th className="text-left py-2">Ticker</th>
                      <th className="text-left">Source</th>
                      <th className="text-right">Avg vol</th>
                      <th className="text-right">Liquidity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((r) => (
                      <tr key={r.ticker} className="border-t border-border/50">
                        <td className="py-1.5 ticker-mono font-medium">{r.ticker}</td>
                        <td className="text-xs text-muted-foreground">{sourceFor(r)}</td>
                        <td className="text-right ticker-mono text-xs">{r.avg_volume?.toLocaleString() ?? "—"}</td>
                        <td className="text-right text-xs">{liquidityScore(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {previewRows && <p className="text-xs text-muted-foreground">{previewRows.length} tickers shown.</p>}
          </DialogContent>
        </Dialog>

        <Button size="sm" onClick={runScan} disabled={scanning}>
          {scanning ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PlayCircle className="h-4 w-4 mr-1" />}
          Run Scan Now
        </Button>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
