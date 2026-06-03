import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Activity, BookmarkCheck, ClipboardList, LayoutDashboard, LineChart, LogOut, Menu, Settings, Sparkles, Trophy } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useBrowserPush } from "@/hooks/useBrowserPush";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/top-signals", label: "Top Signals", icon: Trophy },
  { to: "/app/watchlist", label: "Watchlist", icon: BookmarkCheck },
  { to: "/app/trades", label: "Paper trades", icon: ClipboardList },
  { to: "/app/analyst", label: "AI Analyst", icon: Sparkles, soon: true },
  { to: "/app/alerts", label: "Alerts", icon: Activity, soon: true },
  { to: "/app/performance", label: "Performance", icon: LineChart, soon: true },
  { to: "/app/settings", label: "Settings", icon: Settings, soon: true },
];

function SidebarBody({ email, onSignOut, onNavigate }: { email?: string | null; onSignOut: () => void; onNavigate?: () => void }) {
  return (
    <>
      <div className="px-4 py-4 flex items-center gap-2 border-b border-sidebar-border">
        <div className="h-7 w-7 rounded-sm bg-primary/15 text-primary grid place-items-center ring-1 ring-primary/30">
          <Activity className="h-3.5 w-3.5" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight font-display">Tradingflow</div>
          <div className="text-[9px] uppercase tracking-[0.2em] text-primary font-medium">AI Pro</div>
        </div>
      </div>
      <nav className="px-2 py-3 space-y-0.5 flex-1 overflow-y-auto">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors",
                isActive && "bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-primary pl-[9px]",
              )
            }
          >
            <item.icon className="h-3.5 w-3.5" />
            <span className="flex-1 tracking-tight">{item.label}</span>
            {item.soon && <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Soon</span>}
          </NavLink>
        ))}
      </nav>
      <div className="px-3 py-3 border-t border-sidebar-border">
        <div className="text-[11px] text-muted-foreground truncate ticker-mono">{email}</div>
        <Button variant="ghost" size="sm" className="mt-1.5 w-full justify-start h-7 text-[12px]" onClick={onSignOut}>
          <LogOut className="h-3.5 w-3.5 mr-1.5" /> Sign out
        </Button>
      </div>
    </>
  );
}

export default function AppShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useBrowserPush();

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  return (
    <div className="min-h-screen flex w-full">
      <aside className="w-52 shrink-0 border-r border-sidebar-border bg-sidebar hidden md:flex flex-col">
        <SidebarBody email={user?.email} onSignOut={handleSignOut} />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden border-b border-border px-3 py-2.5 flex items-center justify-between bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open menu">
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 p-0 bg-sidebar border-sidebar-border flex flex-col">
                <SidebarBody email={user?.email} onSignOut={handleSignOut} onNavigate={() => setOpen(false)} />
              </SheetContent>
            </Sheet>
            <div className="flex items-center gap-1.5">
              <div className="h-6 w-6 rounded-sm bg-primary/15 text-primary grid place-items-center ring-1 ring-primary/30">
                <Activity className="h-3 w-3" />
              </div>
              <div className="text-sm font-semibold font-display tracking-tight">
                Tradingflow <span className="text-primary text-[10px] uppercase tracking-[0.18em] ml-0.5">101</span>
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSignOut} aria-label="Sign out">
            <LogOut className="h-4 w-4" />
          </Button>
        </header>
        <main className="flex-1 overflow-auto">
          <div className="container max-w-7xl py-5 md:py-6">
            <Outlet />
          </div>
          <footer className="container max-w-7xl pb-6 text-[10.5px] text-muted-foreground hairline pt-4 leading-relaxed">
            Tradingflow 101 is educational software for research and paper trading. Signals are not financial advice.
            Options are risky and can expire worthless. Past performance and backtests do not guarantee future results.
          </footer>
        </main>
      </div>
    </div>
  );
}
