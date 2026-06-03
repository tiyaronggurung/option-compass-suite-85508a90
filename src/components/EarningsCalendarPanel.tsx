import { useEffect, useState } from "react";
import { CalendarClock, Loader2, RefreshCw, ShieldAlert, Stethoscope } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useIsAdmin } from "@/hooks/useIsAdmin";

type EarningsEvent = {
  ticker: string;
  report_date: string;
  estimate: number | null;
  currency: string | null;
};

export function EarningsCalendarPanel() {
  const { isAdmin, loading } = useIsAdmin();
  const [events, setEvents] = useState<EarningsEvent[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pinging, setPinging] = useState(false);

  async function load() {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("earnings_events")
      .select("ticker, report_date, estimate, currency")
      .gte("report_date", today)
      .lte("report_date", horizon)
      .order("report_date", { ascending: true })
      .limit(30);
    if (error) { toast.error(error.message); return; }
    setEvents((data ?? []) as EarningsEvent[]);
  }

  useEffect(() => { load(); }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke("refresh-earnings-calendar", { body: {} });
      if (error) throw error;
      const d = data as { matched?: number; upserted?: number; error?: string } | null;
      if (d?.error) {
        toast.error(d.error);
      } else {
        toast.success(`Earnings cache refreshed — ${d?.upserted ?? 0} events cached.`);
      }
      load();
    } catch (e: unknown) {
      const msg = (e as Error).message || "Refresh failed";
      // Distinguish friendly rate-limit message
      if (msg.toLowerCase().includes("rate limit")) {
        toast.error("Alpha Vantage rate limit reached. Scanner will continue without catalyst boost.");
      } else {
        toast.error(msg);
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function ping() {
    setPinging(true);
    try {
      const { data, error } = await supabase.functions.invoke("alpha-vantage-health", { method: "GET" });
      if (error) throw error;
      const d = data as { status?: string; error?: string | null };
      if (d?.status === "ok") toast.success("Alpha Vantage reachable");
      else toast.error(d?.error || "Alpha Vantage check failed");
    } catch (e: unknown) {
      toast.error((e as Error).message || "Health check failed");
    } finally {
      setPinging(false);
    }
  }

  if (loading) return <Skeleton className="h-40" />;

  return (
    <section className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" /> Earnings Catalyst Engine
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Upcoming earnings (next 30 days) sourced from Alpha Vantage. Scanner applies a small confidence
            boost inside the 2–7 day window and tags signals; reports today/tomorrow force HIGH risk.
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={ping} disabled={pinging}>
              {pinging ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Stethoscope className="h-3 w-3 mr-1.5" />}
              Test connection
            </Button>
            <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1.5" />}
              Refresh earnings calendar
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn flex items-start gap-2">
        <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>Earnings can increase volatility and option IV crush risk. Catalyst tags inform, they do not auto-trade.</span>
      </div>

      {!events ? (
        <div className="grid sm:grid-cols-2 gap-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : events.length === 0 ? (
        <div className="text-xs text-muted-foreground">No upcoming earnings cached for scanner tickers. Click "Refresh earnings calendar" to populate.</div>
      ) : (
        <ul className="grid sm:grid-cols-2 gap-1.5">
          {events.map((e) => {
            const days = Math.round((new Date(e.report_date + "T00:00:00Z").getTime() - Date.now()) / 86400000);
            const isUrgent = days <= 1;
            return (
              <li key={`${e.ticker}-${e.report_date}`} className="flex items-center justify-between text-xs rounded border border-border px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="ticker-mono font-semibold">{e.ticker}</span>
                  <Badge variant="outline" className={isUrgent ? "border-bear/40 text-bear text-[10px]" : "border-border text-muted-foreground text-[10px]"}>
                    {days <= 0 ? "today" : days === 1 ? "tomorrow" : `${days}d`}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>{e.report_date}</span>
                  {e.estimate != null && <span className="ticker-mono">est ${Number(e.estimate).toFixed(2)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
