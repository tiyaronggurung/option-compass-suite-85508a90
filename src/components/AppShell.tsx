import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Activity, BookmarkCheck, ClipboardList, LayoutDashboard, LineChart, LogOut, Settings, Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useBrowserPush } from "@/hooks/useBrowserPush";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/watchlist", label: "Watchlist", icon: BookmarkCheck },
  { to: "/app/trades", label: "Paper trades", icon: ClipboardList },
  { to: "/app/analyst", label: "AI Analyst", icon: Sparkles, soon: true },
  { to: "/app/alerts", label: "Alerts", icon: Activity, soon: true },
  { to: "/app/performance", label: "Performance", icon: LineChart, soon: true },
  { to: "/app/settings", label: "Settings", icon: Settings, soon: true },
];

export default function AppShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  useBrowserPush();

  return (
    <div className="min-h-screen flex w-full">
      <aside className="w-60 shrink-0 border-r border-sidebar-border bg-sidebar hidden md:flex flex-col">
        <div className="p-5 flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-primary/15 text-primary grid place-items-center">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">OptionFlow</div>
            <div className="text-[10px] uppercase tracking-widest text-primary">AI Pro</div>
          </div>
        </div>
        <nav className="px-3 py-2 space-y-0.5 flex-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition",
                  isActive && "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/30",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              <span className="flex-1">{item.label}</span>
              {item.soon && <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Soon</span>}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start"
            onClick={async () => { await signOut(); navigate("/auth"); }}>
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden border-b border-border px-4 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold">OptionFlow <span className="text-primary">AI Pro</span></div>
          <Button variant="ghost" size="sm" onClick={async () => { await signOut(); navigate("/auth"); }}>
            <LogOut className="h-4 w-4" />
          </Button>
        </header>
        <main className="flex-1 overflow-auto">
          <div className="container max-w-7xl py-6 md:py-8">
            <Outlet />
          </div>
          <footer className="container max-w-7xl pb-8 text-[11px] text-muted-foreground">
            OptionFlow AI Pro is educational software for research and paper trading. Signals are not financial advice.
            Options are risky and can expire worthless. Past performance and backtests do not guarantee future results.
          </footer>
        </main>
      </div>
    </div>
  );
}
