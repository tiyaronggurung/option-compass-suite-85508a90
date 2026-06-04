import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import AppShell from "@/components/AppShell";
import Landing from "@/pages/Landing";
import AuthPage from "@/pages/Auth";
import Dashboard from "@/pages/Dashboard";
import TopSignals from "@/pages/TopSignals";
import Watchlist from "@/pages/Watchlist";
import Trades from "@/pages/Trades";
import Analyst from "@/pages/Analyst";
import Alerts from "@/pages/Alerts";
import Performance from "@/pages/Performance";
import SettingsPage from "@/pages/Settings";
import Diagnostics from "@/pages/Diagnostics";
import InsiderDiagnostics from "@/pages/InsiderDiagnostics";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner theme="dark" />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/app" element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
              <Route index element={<Dashboard />} />
              <Route path="top-signals" element={<TopSignals />} />
              <Route path="watchlist" element={<Watchlist />} />
              <Route path="trades" element={<Trades />} />
              <Route path="analyst" element={<Analyst />} />
              <Route path="alerts" element={<Alerts />} />
              <Route path="performance" element={<Performance />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="diagnostics" element={<Diagnostics />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
