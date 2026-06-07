import { useEffect, useMemo, useState } from "react";
import { Trophy, Skull, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { PaperTrade, Signal } from "@/lib/signalHelpers";
import { fmtPL } from "@/lib/signalHelpers";
import { deriveTags } from "@/lib/signalTags";

type OutcomeRow = {
  signal_id: string;
  ticker: string;
  direction: string;
  confidence: number;
  tier: string | null;
  status: string;
  entry_at: string;
  entry_price: number | null;
  return_1d: number | null;
  return_3d: number | null;
  return_5d: number | null;
  win_1d: boolean | null;
  win_3d: boolean | null;
  win_5d: boolean | null;
};

function contractLabel(t: PaperTrade) {
  if (!t.is_option) return t.ticker;
  const side = (t.option_type ?? "").toUpperCase();
  const exp = t.expiry ? new Date(t.expiry).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
  return `${t.ticker} $${t.strike} ${side} ${exp}`;
}

function holdTime(opened: string, closed: string | null) {
  if (!closed) return "—";
  const ms = new Date(closed).getTime() - new Date(opened).getTime();
  const h = Math.floor(ms / 3.6e6);
  const m = Math.floor((ms % 3.6e6) / 6e4);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pctClass(n: number | null | undefined) {
  if (n == null) return "text-muted-foreground";
  return n >= 0 ? "text-bull" : "text-bear";
}

function ReasonList({ trade, signal }: { trade: PaperTrade; signal: Signal | undefined }) {
  const reasons = Array.isArray(signal?.reasons) ? (signal!.reasons as unknown as string[]) : [];
  const tags = signal ? deriveTags(signal, new Set()) : [];
  const exitReason = trade.exit_reason ? String(trade.exit_reason).replace(/_/g, " ") : null;

  return (
    <div className="space-y-2">
      {signal && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Badge variant="outline" className="border-border text-muted-foreground">
            Confidence {signal.confidence}
          </Badge>
          {signal.tier && (
            <Badge variant="outline" className="border-border text-muted-foreground">
              {signal.tier}
            </Badge>
          )}
          {(signal as any).confirmed_by_both && (
            <Badge className="bg-info/15 text-info border-0">Confirmed by both</Badge>
          )}
          {signal.source && (
            <Badge variant="outline" className="border-border text-muted-foreground">
              {signal.source}
            </Badge>
          )}
          {tags.map((t) => (
            <Badge key={t} variant="outline" className="border-border text-muted-foreground">{t}</Badge>
          ))}
        </div>
      )}
      {reasons.length > 0 && (
        <ul className="text-xs space-y-1">
          {reasons.map((r, i) => (
            <li key={i} className="flex gap-2"><span className="text-bull">✓</span><span>{r}</span></li>
          ))}
        </ul>
      )}
      {!signal && (
        <div className="text-xs text-muted-foreground">No originating signal recorded for this trade.</div>
      )}
      {exitReason && (
        <div className="text-xs text-muted-foreground">
          Exit reason: <span className="text-foreground capitalize">{exitReason}</span>
        </div>
      )}
    </div>
  );
}

function HighlightCard({
  kind, trade, signal,
}: { kind: "winner" | "loser"; trade: PaperTrade | null; signal: Signal | undefined }) {
  const Icon = kind === "winner" ? Trophy : Skull;
  const tone = kind === "winner" ? "text-bull" : "text-bear";
  const title = kind === "winner" ? "Biggest winner" : "Biggest loser";

  if (!trade) {
    return (
      <div className="glass-card p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Icon className={cn("h-4 w-4", tone)} /> {title}
        </div>
        <div className="mt-3 text-sm text-muted-foreground">No closed trades yet.</div>
      </div>
    );
  }

  const pl = Number(trade.current_pl ?? 0);
  const plPct = Number(trade.realized_pl_pct ?? trade.current_pl_pct ?? 0);

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Icon className={cn("h-4 w-4", tone)} /> {title}
        </div>
        <Badge variant="outline" className="border-border text-muted-foreground capitalize">
          {String(trade.direction).toLowerCase()}
        </Badge>
      </div>

      <div>
        <div className="text-lg font-semibold">{contractLabel(trade)}</div>
        <div className="text-xs text-muted-foreground">
          Held {holdTime(trade.opened_at, trade.closed_at)} ·{" "}
          {trade.closed_at ? new Date(trade.closed_at).toLocaleDateString() : "—"}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="P/L $" value={`${pl >= 0 ? "+" : ""}${fmtPL(pl)}`} tone={tone} />
        <Stat label="P/L %" value={`${plPct >= 0 ? "+" : ""}${plPct.toFixed(1)}%`} tone={tone} />
        <Stat
          label="Entry → Exit"
          value={`$${(Number(trade.entry_premium ?? 0)).toFixed(2)} → $${(Number(trade.exit_premium ?? 0)).toFixed(2)}`}
          tone="text-foreground"
        />
      </div>

      <div className="pt-2 border-t border-border">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Why</div>
        <ReasonList trade={trade} signal={signal} />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={cn("ticker-mono font-semibold", tone)}>{value}</div>
    </div>
  );
}

export function HighlightsRow({
  trades, signals,
}: { trades: PaperTrade[]; signals: Record<string, Signal> }) {
  const { winner, loser } = useMemo(() => {
    const closed = trades.filter((t) => t.status !== "OPEN");
    if (closed.length === 0) return { winner: null, loser: null };
    const sorted = [...closed].sort((a, b) => Number(b.current_pl) - Number(a.current_pl));
    return { winner: sorted[0] ?? null, loser: sorted[sorted.length - 1] ?? null };
  }, [trades]);

  return (
    <section className="grid md:grid-cols-2 gap-4">
      <HighlightCard kind="winner" trade={winner} signal={winner?.signal_id ? signals[winner.signal_id] : undefined} />
      <HighlightCard kind="loser" trade={loser} signal={loser?.signal_id ? signals[loser.signal_id] : undefined} />
    </section>
  );
}

export function TradeHistoryTable({
  trades, signals,
}: { trades: PaperTrade[]; signals: Record<string, Signal> }) {
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    return [...trades]
      .filter((t) => t.status !== "OPEN")
      .sort((a, b) =>
        new Date(b.closed_at ?? b.opened_at).getTime() - new Date(a.closed_at ?? a.opened_at).getTime(),
      );
  }, [trades]);

  return (
    <div className="glass-card p-0 overflow-hidden">
      <div className="px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b border-border flex items-center justify-between">
        <span>Trade history</span>
        <span className="text-muted-foreground/70">{rows.length} closed</span>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">No closed trades yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="w-6" />
                <th className="text-left px-3 py-2 font-medium">Closed</th>
                <th className="text-left px-3 py-2 font-medium">Contract</th>
                <th className="text-left px-3 py-2 font-medium">Dir</th>
                <th className="text-right px-3 py-2 font-medium">P/L $</th>
                <th className="text-right px-3 py-2 font-medium">P/L %</th>
                <th className="text-left px-3 py-2 font-medium">Exit</th>
                <th className="text-left px-3 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const sig = t.signal_id ? signals[t.signal_id] : undefined;
                const pl = Number(t.current_pl ?? 0);
                const plPct = Number(t.realized_pl_pct ?? t.current_pl_pct ?? 0);
                const isOpen = open === t.id;
                return (
                  <>
                    <tr
                      key={t.id}
                      className="border-b border-border/60 hover:bg-card-elevated/40 cursor-pointer"
                      onClick={() => setOpen(isOpen ? null : t.id)}
                    >
                      <td className="px-2 py-2 text-muted-foreground">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {t.closed_at ? new Date(t.closed_at).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2">{contractLabel(t)}</td>
                      <td className="px-3 py-2 capitalize">{String(t.direction).toLowerCase()}</td>
                      <td className={cn("px-3 py-2 text-right ticker-mono", pl >= 0 ? "text-bull" : "text-bear")}>
                        {pl >= 0 ? "+" : ""}{fmtPL(pl)}
                      </td>
                      <td className={cn("px-3 py-2 text-right ticker-mono", plPct >= 0 ? "text-bull" : "text-bear")}>
                        {plPct >= 0 ? "+" : ""}{plPct.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-muted-foreground capitalize">
                        {t.exit_reason ? String(t.exit_reason).replace(/_/g, " ").toLowerCase() : "—"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-[140px]" title={sig?.source ?? ""}>
                        {sig?.source ?? "—"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${t.id}-x`} className="border-b border-border/60 bg-card-elevated/30">
                        <td />
                        <td colSpan={7} className="px-3 py-3">
                          <ReasonList trade={t} signal={sig} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function NotTakenSignalHistory({
  userId, fromDate = null, toDate = null, ticker = null,
}: {
  userId: string;
  fromDate?: string | null;
  toDate?: string | null;
  ticker?: string | null;
}) {
  const [rows, setRows] = useState<OutcomeRow[] | null>(null);

  useEffect(() => {
    (async () => {
      // Trades the user took — exclude their signals.
      const { data: trades } = await supabase
        .from("paper_trades").select("signal_id").eq("user_id", userId);
      const takenIds = new Set((trades ?? []).map((x) => x.signal_id).filter(Boolean) as string[]);

      let q = supabase
        .from("signal_outcomes")
        .select("signal_id,ticker,direction,confidence,tier,status,entry_at,entry_price,return_1d,return_3d,return_5d,win_1d,win_3d,win_5d")
        .neq("status", "pending")
        .order("entry_at", { ascending: false })
        .limit(200);
      if (ticker) q = q.eq("ticker", ticker);
      if (fromDate) q = q.gte("entry_at", new Date(fromDate + "T00:00:00").toISOString());
      if (toDate) q = q.lte("entry_at", new Date(toDate + "T23:59:59").toISOString());
      const { data: outs } = await q;

      const filtered = (outs ?? []).filter((o) => !takenIds.has(o.signal_id));
      setRows(filtered as OutcomeRow[]);
    })();
  }, [userId, fromDate, toDate, ticker]);

  if (!rows) return <Skeleton className="h-48" />;

  return (
    <div className="glass-card p-0 overflow-hidden">
      <div className="px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b border-border flex items-center gap-2">
        <Eye className="h-3.5 w-3.5" />
        <span>Signals you didn't take</span>
        <span className="text-muted-foreground/70">· How they actually performed ({rows.length})</span>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          No untaken signal outcomes yet.
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[480px]">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground sticky top-0 bg-card-elevated/80 backdrop-blur">
              <tr className="border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Entry</th>
                <th className="text-left px-3 py-2 font-medium">Ticker</th>
                <th className="text-left px-3 py-2 font-medium">Dir</th>
                <th className="text-right px-3 py-2 font-medium">Conf</th>
                <th className="text-left px-3 py-2 font-medium">Tier</th>
                <th className="text-right px-3 py-2 font-medium">1d %</th>
                <th className="text-right px-3 py-2 font-medium">3d %</th>
                <th className="text-right px-3 py-2 font-medium">5d %</th>
                <th className="text-right px-3 py-2 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const verdict = r.win_5d ?? r.win_3d ?? r.win_1d;
                return (
                  <tr key={r.signal_id} className="border-b border-border/60 hover:bg-card-elevated/40">
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {new Date(r.entry_at).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-1.5 font-medium">{r.ticker}</td>
                    <td className="px-3 py-1.5 capitalize">{r.direction.toLowerCase()}</td>
                    <td className="px-3 py-1.5 text-right ticker-mono">{r.confidence}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.tier ?? "—"}</td>
                    <td className={cn("px-3 py-1.5 text-right ticker-mono", pctClass(r.return_1d))}>
                      {r.return_1d == null ? "—" : `${r.return_1d >= 0 ? "+" : ""}${Number(r.return_1d).toFixed(2)}`}
                    </td>
                    <td className={cn("px-3 py-1.5 text-right ticker-mono", pctClass(r.return_3d))}>
                      {r.return_3d == null ? "—" : `${r.return_3d >= 0 ? "+" : ""}${Number(r.return_3d).toFixed(2)}`}
                    </td>
                    <td className={cn("px-3 py-1.5 text-right ticker-mono", pctClass(r.return_5d))}>
                      {r.return_5d == null ? "—" : `${r.return_5d >= 0 ? "+" : ""}${Number(r.return_5d).toFixed(2)}`}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {verdict == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : verdict ? (
                        <Badge className="bg-bull/15 text-bull border-0">Would've won</Badge>
                      ) : (
                        <Badge className="bg-bear/15 text-bear border-0">Would've lost</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
