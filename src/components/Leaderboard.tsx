import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Row = {
  user_id: string;
  display_name: string;
  realized_pl: number;
  live_equity: number;
  closed_trades: number;
};

type Window = "7d" | "30d" | "all";

const WINDOWS: { id: Window; label: string }[] = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All-time" },
];

function fmtMoney(n: number) {
  const v = Number(n ?? 0);
  const sign = v >= 0 ? "" : "-";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function Leaderboard({ currentUserId }: { currentUserId?: string | null }) {
  const [win, setWin] = useState<Window>("all");
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    (async () => {
      const { data, error } = await supabase.rpc("get_leaderboard", { _window: win });
      if (cancelled) return;
      if (error) {
        console.error("[leaderboard] rpc error", error);
        setRows([]);
        return;
      }
      setRows((data ?? []) as Row[]);
    })();
    return () => { cancelled = true; };
  }, [win]);

  return (
    <section className="glass-card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-400" />
          <h2 className="text-sm font-semibold">Leaderboard</h2>
          <span className="text-xs text-muted-foreground">Top traders by realized P&L</span>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setWin(w.id)}
              className={cn(
                "px-2 py-1 text-xs rounded transition-colors",
                win === w.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {rows === null ? (
        <div className="p-4"><Skeleton className="h-40" /></div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">No traders yet.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="text-left px-4 py-2 font-medium w-10">#</th>
              <th className="text-left px-4 py-2 font-medium">Trader</th>
              <th className="text-right px-4 py-2 font-medium">Realized P&L</th>
              <th className="text-right px-4 py-2 font-medium">Live equity</th>
              <th className="text-right px-4 py-2 font-medium">Closed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isMe = currentUserId && r.user_id === currentUserId;
              return (
                <tr
                  key={r.user_id}
                  className={cn(
                    "border-b border-border/60 last:border-0",
                    isMe && "bg-primary/5",
                  )}
                >
                  <td className="px-4 py-2 ticker-mono text-muted-foreground">
                    {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
                  </td>
                  <td className="px-4 py-2">
                    <span className={cn("font-medium", isMe && "text-primary")}>
                      {r.display_name}
                    </span>
                    {isMe && <span className="ml-2 text-[10px] uppercase text-primary/70">you</span>}
                  </td>
                  <td className={cn(
                    "px-4 py-2 text-right ticker-mono font-medium",
                    Number(r.realized_pl) >= 0 ? "text-bull" : "text-bear",
                  )}>
                    {fmtMoney(Number(r.realized_pl))}
                  </td>
                  <td className="px-4 py-2 text-right ticker-mono">
                    {fmtMoney(Number(r.live_equity))}
                  </td>
                  <td className="px-4 py-2 text-right ticker-mono text-muted-foreground">
                    {r.closed_trades}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
