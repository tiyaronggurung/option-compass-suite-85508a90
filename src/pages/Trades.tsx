import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, CircleSlash } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DisclaimerBar } from "@/components/Disclaimer";
import { fmtPL, fmtPrice, timeAgo, type PaperTrade } from "@/lib/signalHelpers";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Trades() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<PaperTrade[] | null>(null);

  async function refresh() {
    const { data } = await supabase
      .from("paper_trades").select("*").eq("user_id", user!.id)
      .order("opened_at", { ascending: false });
    setTrades(data ?? []);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [user]);

  async function setStatus(t: PaperTrade, status: PaperTrade["status"]) {
    const pl = status === "WIN" ? Number(t.risk_amount ?? 0) * 1.8
             : status === "LOSS" ? -Number(t.risk_amount ?? 0)
             : Number(t.current_pl ?? 0);
    const { error } = await supabase.from("paper_trades")
      .update({ status, current_pl: pl, closed_at: status === "OPEN" ? null : new Date().toISOString() })
      .eq("id", t.id);
    if (error) return toast.error(error.message);
    toast.success(`Trade marked ${status}`);
    refresh();
  }

  const open = trades?.filter((t) => t.status === "OPEN") ?? [];
  const closed = trades?.filter((t) => t.status !== "OPEN") ?? [];

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Paper trades</h1>
          <p className="text-sm text-muted-foreground">Manually approved demo trades. No real money at risk.</p>
        </div>
        <Badge className="bg-warn/15 text-warn border-0">Paper trading only</Badge>
      </header>

      <DisclaimerBar />

      <Section title="Open">
        {!trades ? <Skeleton className="h-24" />
          : open.length === 0 ? <Empty text="No open paper trades. Approve a signal from the dashboard." />
          : <TradeTable trades={open} onClose={setStatus} />}
      </Section>

      <Section title="Closed">
        {!trades ? null
          : closed.length === 0 ? <Empty text="No closed trades yet." />
          : <TradeTable trades={closed} />}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="glass-card p-8 text-center text-sm text-muted-foreground">{text}</div>;
}

function TradeTable({ trades, onClose }: { trades: PaperTrade[]; onClose?: (t: PaperTrade, s: PaperTrade["status"]) => void }) {
  return (
    <div className="glass-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <Th>Ticker</Th><Th>Dir</Th><Th>Contract</Th><Th className="text-right">Entry</Th>
            <Th className="text-right">Stop</Th><Th className="text-right">Target</Th><Th className="text-right">Risk</Th>
            <Th className="text-right">P/L</Th><Th>Status</Th><Th>Opened</Th>
            {onClose && <Th className="text-right">Actions</Th>}
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b border-border/60 last:border-0 hover:bg-card-elevated/60">
              <Td className="ticker-mono font-semibold">{t.ticker}</Td>
              <Td>
                <Badge className={cn("border-0", t.direction === "CALL" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear")}>
                  {t.direction}
                </Badge>
              </Td>
              <Td className="ticker-mono text-muted-foreground">{t.contract_idea ?? "—"}</Td>
              <Td className="text-right ticker-mono">${fmtPrice(Number(t.entry_price))}</Td>
              <Td className="text-right ticker-mono text-muted-foreground">${fmtPrice(Number(t.stop_idea))}</Td>
              <Td className="text-right ticker-mono text-muted-foreground">${fmtPrice(Number(t.target_idea))}</Td>
              <Td className="text-right ticker-mono">${fmtPrice(Number(t.risk_amount))}</Td>
              <Td className={cn("text-right ticker-mono", Number(t.current_pl) >= 0 ? "text-bull" : "text-bear")}>
                ${fmtPL(Number(t.current_pl))}
              </Td>
              <Td><StatusBadge status={t.status} /></Td>
              <Td className="text-muted-foreground whitespace-nowrap">{timeAgo(t.opened_at)}</Td>
              {onClose && (
                <Td className="text-right whitespace-nowrap space-x-1">
                  <Button size="sm" variant="ghost" className="text-bull" onClick={() => onClose(t, "WIN")}>
                    <CheckCircle2 className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-bear" onClick={() => onClose(t, "LOSS")}>
                    <XCircle className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onClose(t, "CLOSED")}>
                    <CircleSlash className="h-4 w-4" />
                  </Button>
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Th = ({ children, className }: any) => <th className={cn("px-3 py-2 text-left font-medium", className)}>{children}</th>;
const Td = ({ children, className }: any) => <td className={cn("px-3 py-3", className)}>{children}</td>;

function StatusBadge({ status }: { status: PaperTrade["status"] }) {
  const m: Record<string, string> = {
    OPEN: "bg-info/15 text-info",
    WIN: "bg-bull/15 text-bull",
    LOSS: "bg-bear/15 text-bear",
    CLOSED: "bg-muted text-muted-foreground",
  };
  return <Badge className={cn("border-0", m[status])}>{status}</Badge>;
}
