import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { BookmarkCheck, CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Gauge, LayoutDashboard, LineChart, LogOut, Menu, Settings, Sparkles, Trophy, Activity } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useBrowserPush } from "@/hooks/useBrowserPush";
import { useSignalNotifications } from "@/hooks/useSignalNotifications";
import { useSingleSession } from "@/hooks/useSingleSession";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NotificationsBell } from "@/components/NotificationsBell";
import { cn } from "@/lib/utils";
import logoAsset from "@/assets/xalgoflow-logo.png.asset.json";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/top-signals", label: "Top Signals", icon: Trophy },
  { to: "/app/watchlist", label: "Watchlist", icon: BookmarkCheck },
  { to: "/app/trades", label: "Paper trades", icon: ClipboardList },
  { to: "/app/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/app/analyst", label: "AI Analyst", icon: Sparkles, soon: true },
  { to: "/app/alerts", label: "Alerts", icon: Activity, soon: true },
  { to: "/app/performance", label: "Performance", icon: LineChart, soon: true },
  { to: "/app/technical", label: "Technical", icon: Gauge },
  { to: "/app/settings", label: "Settings", icon: Settings, soon: true },
];

function SidebarBody({ email, onSignOut, onNavigate, collapsed = false }: { email?: string | null; onSignOut: () => void; onNavigate?: () => void; collapsed?: boolean }) {
  return (
    <>
      <div className={cn("py-4 flex items-center gap-2 border-b border-sidebar-border", collapsed ? "px-2 justify-center" : "px-4")}>
        <img src={logoAsset.url} alt="Xalgoflow" className="h-8 w-8 object-contain shrink-0" />
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight font-display">Xalgoflow</div>
            <div className="text-[9px] uppercase tracking-[0.2em] text-primary font-medium">AI Pro</div>
          </div>
        )}
      </div>
      <nav className={cn("py-3 space-y-0.5 flex-1 overflow-y-auto", collapsed ? "px-1.5" : "px-2")}>
        {NAV.map((item) => {
          const link = (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  "group flex items-center rounded-sm text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors",
                  collapsed ? "justify-center px-2 py-2" : "gap-2.5 px-2.5 py-1.5",
                  isActive && (collapsed
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-primary pl-[9px]"),
                )
              }
            >
              <item.icon className="h-3.5 w-3.5 shrink-0" />
              {!collapsed && <span className="flex-1 tracking-tight">{item.label}</span>}
              {!collapsed && item.soon && <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Soon</span>}
            </NavLink>
          );
          return collapsed ? (
            <Tooltip key={item.to} delayDuration={100}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right" className="text-xs">{item.label}</TooltipContent>
            </Tooltip>
          ) : link;
        })}
      </nav>
      <div className={cn("py-3 border-t border-sidebar-border", collapsed ? "px-1.5" : "px-3")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <ThemeToggle />
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onSignOut} aria-label="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-muted-foreground truncate ticker-mono flex-1 min-w-0">{email}</div>
              <ThemeToggle />
            </div>
            <Button variant="ghost" size="sm" className="mt-1.5 w-full justify-start h-7 text-[12px]" onClick={onSignOut}>
              <LogOut className="h-3.5 w-3.5 mr-1.5" /> Sign out
            </Button>
          </>
        )}
      </div>
    </>
  );
}

export default function AppShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  useBrowserPush();
  useSignalNotifications();
  useSingleSession();

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  return (
    <div className="min-h-screen flex w-full">
      {/* Desktop sidebar (lg+) — always full width */}
      <aside className="w-52 shrink-0 border-r border-sidebar-border bg-sidebar hidden lg:flex flex-col">
        <SidebarBody email={user?.email} onSignOut={handleSignOut} />
      </aside>

      {/* Tablet sidebar (md–lg) — collapsible icon rail / expanded */}
      <aside
        className={cn(
          "shrink-0 border-r border-sidebar-border bg-sidebar hidden md:flex lg:hidden flex-col relative transition-[width] duration-200",
          tabletExpanded ? "w-52" : "w-14",
        )}
      >
        <SidebarBody
          email={user?.email}
          onSignOut={handleSignOut}
          collapsed={!tabletExpanded}
          onNavigate={() => setTabletExpanded(false)}
        />
        <button
          type="button"
          aria-label={tabletExpanded ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setTabletExpanded((v) => !v)}
          className="absolute -right-3 top-4 h-6 w-6 rounded-full border border-sidebar-border bg-background text-muted-foreground hover:text-foreground grid place-items-center shadow-sm z-10"
        >
          {tabletExpanded ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
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
              <img src={logoAsset.url} alt="Xalgoflow" className="h-7 w-7 object-contain" />
              <div className="text-sm font-semibold font-display tracking-tight">
                Xalgoflow
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <NotificationsBell />
            <ThemeToggle />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSignOut} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>
        {/* Desktop/tablet floating bell — Dashboard renders its own inline; this covers all other pages */}
        <div className="hidden md:block fixed top-3 right-4 z-40">
          <div className="rounded-full bg-background/80 backdrop-blur border border-border shadow-sm">
            <NotificationsBell />
          </div>
        </div>
        <main className="flex-1 overflow-auto">
          <div className="container max-w-7xl py-5 md:py-6">
            <Outlet />
          </div>
          <footer className="container max-w-7xl pb-6 text-[10.5px] text-muted-foreground hairline pt-4 leading-relaxed">
            Xalgoflow is educational software for research and paper trading. Signals are not financial advice.
            Options are risky and can expire worthless. Past performance and backtests do not guarantee future results.
          </footer>
        </main>
      </div>
    </div>
  );
}
