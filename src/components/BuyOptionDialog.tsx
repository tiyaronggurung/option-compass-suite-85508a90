// Robinhood / Webull-style Buy Option modal.
// - Loads option chain from cached `options_contracts` for the signal's ticker.
// - Lets the user pick expiry, call/put, strike and quantity.
// - Shows live Black-Scholes (or greeks-approx fallback) profit projection.
// - On confirm, opens a paper trade with the selected contract.
//
// If the chain is empty/unavailable, the parent's `onFallbackApprove` runs
// so the existing 1-click approval flow is preserved.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Signal } from "@/lib/signalHelpers";
import type { RiskSettingsLike } from "@/lib/riskGuard";
import { buyOptionAsPaperTrade, type SelectedContract, type BuyOptionReceipt } from "@/lib/buyOption";
import { buildProjection, breakeven, daysToExpiry } from "@/lib/blackScholes";
import { computeEntryQuality } from "@/lib/entryQuality";
import { getUsMarketStatus } from "@/lib/marketHours";
import {
  analyzeCostEfficiency,
  COST_EFFICIENCY_CLASS,
  COST_EFFICIENCY_ICON,
  COST_EFFICIENCY_LABEL,
} from "@/lib/costEfficiency";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";


// Per-signal last selection memory (side/expiry/strike/qty), kept in localStorage.
type SavedSelection = { side: "call" | "put"; expiry: string; strike: number | null; qty: number };
const SAVED_KEY = (signalId: string) => `buyOptionDialog:lastSelection:${signalId}`;
function loadSavedSelection(signalId: string): SavedSelection | null {
  try {
    const raw = localStorage.getItem(SAVED_KEY(signalId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || (v.side !== "call" && v.side !== "put")) return null;
    return {
      side: v.side,
      expiry: typeof v.expiry === "string" ? v.expiry : "",
      strike: v.strike == null ? null : Number(v.strike),
      qty: Math.max(1, Math.floor(Number(v.qty) || 1)),
    };
  } catch { return null; }
}
function saveSelection(signalId: string, sel: SavedSelection) {
  try { localStorage.setItem(SAVED_KEY(signalId), JSON.stringify(sel)); } catch { /* ignore */ }
}

type ChainRow = {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
};

type Props = {
  open: boolean;
  signal: Signal | null;
  userId: string;
  risk: RiskSettingsLike;
  openTradesCount: number;
  todayRealizedPL: number;
  cashBalance: number;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  onFallbackApprove: (s: Signal) => void;
};

function fmtMoney(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `$${Number(n).toFixed(digits)}`;
}
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function BuyOptionDialog(props: Props) {
  const { open, signal, onOpenChange, onSuccess, onFallbackApprove } = props;
  const [loading, setLoading] = useState(false);
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [side, setSide] = useState<"call" | "put">("call");
  const [expiry, setExpiry] = useState<string>("");
  const [availableExpiries, setAvailableExpiries] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  const [chainTried, setChainTried] = useState(false);
  const [uwSpot, setUwSpot] = useState<number | null>(null);

  const [chainStale, setChainStale] = useState(false);
  const [chainLastUpdated, setChainLastUpdated] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<BuyOptionReceipt | null>(null);
  const [restoredStrike, setRestoredStrike] = useState<number | null>(null);
  const [marketStatus, setMarketStatus] = useState(() => getUsMarketStatus());
  useEffect(() => {
    if (!open) return;
    setMarketStatus(getUsMarketStatus());
    const id = setInterval(() => setMarketStatus(getUsMarketStatus()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  const signalSpot = useMemo(() => Number(signal?.price ?? 0) || 0, [signal]);

  // `spot` is the LIVE price used everywhere (ATM picker, projections, divider).
  // Sourced from Unusual Whales (uw-chain returns it); falls back to signal snapshot.
  const liveSpot = uwSpot != null && Number.isFinite(uwSpot) && uwSpot > 0 ? uwSpot : signalSpot;
  const spot = liveSpot;
  const spotDeltaPct = signalSpot > 0 ? ((liveSpot - signalSpot) / signalSpot) * 100 : 0;

  // Reset state when dialog opens for a new signal — and restore any saved selection.
  useEffect(() => {
    if (!open || !signal) return;
    setChainTried(false);
    setSelectedSymbol(null);
    setChain([]);
    setAvailableExpiries([]);
    setUwSpot(null);
    setChainStale(false);
    setChainLastUpdated(null);
    setReceipt(null);

    const saved = loadSavedSelection(String(signal.id));
    const initialSide = saved?.side ?? (String(signal.direction).toUpperCase() === "PUT" ? "put" : "call");
    setSide(initialSide);
    setQty(saved?.qty ?? 1);
    setRestoredStrike(saved?.strike ?? null);
    const sigExp = (signal as any).expiry as string | null;
    setExpiry(saved?.expiry || sigExp || "");
  }, [open, signal]);

  // Poll the live UW chain every 10s while open. Refetch immediately when expiry changes.
  // On error or empty response we KEEP the last-good rows and flag the chain as stale.
  useEffect(() => {
    if (!open || !signal) return;
    let cancelled = false;
    let firstLoad = true;

    const fetchChain = async () => {
      if (firstLoad) setLoading(true);
      try {
        const { data, error } = await supabase.functions.invoke("uw-chain", {
          body: { ticker: signal.ticker, expiry: expiry || (signal as any).expiry || null },
        });
        if (cancelled) return;
        if (error) {
          setChainStale(true);
          if (firstLoad) toast.error(`Live chain failed: ${error.message}`);
          return;
        }
        const payload = data as {
          spot: number | null; expiries: string[]; expiry: string; rows: ChainRow[];
          contracts_error?: string | null;
        };
        if (payload.spot != null) setUwSpot(payload.spot);
        if (payload.expiries?.length) setAvailableExpiries(payload.expiries);
        if (payload.rows && payload.rows.length > 0) {
          setChain(payload.rows);
          setChainStale(false);
          setChainLastUpdated(Date.now());
        } else {
          // Empty (likely rate-limited or no contracts) — preserve last-good rows.
          setChainStale(true);
        }
        if (!expiry && payload.expiry) setExpiry(payload.expiry);
      } catch (e) {
        if (!cancelled) setChainStale(true);
        if (firstLoad) toast.error(`Live chain error: ${(e as Error).message}`);
      } finally {
        if (firstLoad && !cancelled) {
          setLoading(false);
          setChainTried(true);
          firstLoad = false;
        }
      }
    };

    void fetchChain();
    const id = setInterval(fetchChain, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [open, signal, expiry]);

  // If chain came back empty after first load AND we still have nothing, surface an error.
  useEffect(() => {
    if (!chainTried || loading) return;
    if (chain.length === 0 && signal) {
      toast.error(`No live option chain available for ${signal.ticker}.`);
    }
  }, [chainTried, loading, chain.length, signal]);

  const expiries = useMemo(() => {
    if (availableExpiries.length) return availableExpiries;
    return Array.from(new Set(chain.map((r) => r.expiry))).sort();
  }, [availableExpiries, chain]);

  const rows = useMemo(() => {
    return chain
      .filter((r) => r.type === side && r.expiry === expiry)
      .sort((a, b) => a.strike - b.strike);
  }, [chain, side, expiry]);

  // Auto-pick a sensible default strike when expiry/side changes or on first load.
  // Priority: restored-from-localStorage strike > signal's exact strike > ATM-ish.
  // IMPORTANT: do NOT re-pick if the user already has a valid selection in `rows`
  // — otherwise a 10s chain refresh would silently revert a manual choice.
  useEffect(() => {
    if (!rows.length || !spot) return;
    if (selectedSymbol && rows.some((r) => r.symbol === selectedSymbol)) return;
    if (restoredStrike != null) {
      const exact = rows.find((r) => Number(r.strike) === Number(restoredStrike));
      if (exact) {
        setSelectedSymbol(exact.symbol);
        setRestoredStrike(null); // consume once so later side/expiry changes use defaults
        return;
      }
    }
    const sigStrike = signal?.strike != null ? Number(signal.strike) : null;
    const sigSide = String(signal?.direction ?? "").toUpperCase() === "PUT" ? "put" : "call";
    if (sigStrike != null && side === sigSide) {
      const exact = rows.find((r) => Number(r.strike) === sigStrike);
      if (exact) { setSelectedSymbol(exact.symbol); return; }
    }
    // Fallback: ATM-ish (smallest |strike - spot|)
    const best = [...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    setSelectedSymbol(best.symbol);
  }, [rows, spot, signal, side, restoredStrike, selectedSymbol]);


  // Scroll the selected row into view when it changes.
  useEffect(() => {
    if (!selectedSymbol) return;
    const el = document.querySelector(`[data-contract-symbol="${selectedSymbol}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedSymbol]);

  const selected = useMemo(() => rows.find((r) => r.symbol === selectedSymbol) ?? null, [rows, selectedSymbol]);

  // Persist the current selection per signal so reopening restores it.
  useEffect(() => {
    if (!open || !signal || !selected) return;
    saveSelection(String(signal.id), {
      side, expiry, strike: Number(selected.strike), qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    });
  }, [open, signal, side, expiry, selected, qty]);

  // Find the share-price divider index (strike just above spot)
  const dividerIndex = useMemo(() => {
    if (!spot) return -1;
    return rows.findIndex((r) => r.strike >= spot);
  }, [rows, spot]);

  const selectedMid = useMemo(() => {
    if (!selected) return 0;
    if (selected.bid != null && selected.ask != null && selected.bid > 0 && selected.ask > 0) {
      return (selected.bid + selected.ask) / 2;
    }
    return Number(selected.ask ?? selected.last ?? selected.bid ?? 0);
  }, [selected]);

  const tYears = useMemo(() => Math.max(0, daysToExpiry(selected?.expiry) / 365), [selected]);

  const projection = useMemo(() => {
    if (!selected || !selectedMid) return { rows: [], method: "none" as const };
    return buildProjection({
      spot,
      strike: selected.strike,
      tYears,
      iv: selected.iv ?? null,
      entryPremium: selectedMid,
      type: selected.type,
      delta: selected.delta,
      gamma: selected.gamma,
      theta: selected.theta,
    });
  }, [selected, selectedMid, spot, tYears]);

  const totalCost = selectedMid * 100 * qty;
  const buyingPowerOk = totalCost <= props.cashBalance + 1e-6;
  const breakevenPrice = selected ? breakeven(selected.strike, selectedMid, selected.type) : null;

  async function handleBuy() {
    if (!signal || !selected) return;
    setSubmitting(true);
    const contract: SelectedContract = {
      symbol: selected.symbol,
      strike: Number(selected.strike),
      expiry: selected.expiry,
      type: selected.type,
      bid: selected.bid,
      ask: selected.ask,
      mid: selectedMid,
      delta: selected.delta,
      gamma: selected.gamma,
      theta: selected.theta,
      vega: selected.vega,
      iv: selected.iv,
      open_interest: selected.open_interest,
      volume: selected.volume,
    };
    const res = await buyOptionAsPaperTrade({
      userId: props.userId,
      signal,
      risk: props.risk,
      openTradesCount: props.openTradesCount,
      todayRealizedPL: props.todayRealizedPL,
      contract,
      contracts: qty,
      cashBalance: props.cashBalance,
    });
    setSubmitting(false);
    if (!res.ok) return toast.error((res as { reason: string }).reason);
    toast.success(`Bought ${qty}× ${signal.ticker} ${selected.strike} ${selected.type.toUpperCase()} ${selected.expiry}`);
    setReceipt(res.receipt);
    onSuccess();
    onOpenChange(false);
  }

  if (!signal) return null;
  const sideUpper = side.toUpperCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="text-xl font-semibold flex items-center gap-3">
            <span>{signal.ticker}</span>
            <span className="text-base font-normal text-muted-foreground">
              Buy {sideUpper === "PUT" ? "Put" : "Call"}
            </span>
          </DialogTitle>
          {/* Signal vs Live banner */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Badge
              className={cn(
                "border-0 uppercase tracking-wider",
                String(signal.direction).toUpperCase() === "PUT"
                  ? "bg-bear/15 text-bear"
                  : "bg-bull/15 text-bull",
              )}
            >
              Signal · {String(signal.direction).toUpperCase()} @ {fmtMoney(signalSpot)}
            </Badge>
            <span className="text-muted-foreground">
              Live spot{" "}
              <span className="ticker-mono text-foreground">{fmtMoney(liveSpot)}</span>
              {uwSpot != null && (
                <span className="ml-1 text-[10px] text-bull">● UW live</span>
              )}
              {signalSpot > 0 && liveSpot > 0 && (
                <span
                  className={cn(
                    "ml-1.5 ticker-mono",
                    spotDeltaPct > 0 ? "text-bull" : spotDeltaPct < 0 ? "text-bear" : "text-muted-foreground",
                  )}
                >
                  ({spotDeltaPct >= 0 ? "+" : ""}{spotDeltaPct.toFixed(2)}%)
                </span>
              )}
            </span>
            {signal.confidence != null && (
              <span className="text-muted-foreground">· Confidence {signal.confidence}</span>
            )}
          </div>
        </DialogHeader>


        <ScrollArea className="max-h-[80vh]">
          <div className="px-6 pb-6 space-y-4">

            {receipt && (
              <div className="rounded-md border border-bull/40 bg-bull/5 p-4 space-y-3 mt-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-bull" />
                    Paper trade filled
                  </div>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                    {receipt.status}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <Stat label="Ticker" value={receipt.ticker} />
                  <Stat label="Type" value={receipt.optionType} />
                  <Stat label="Strike" value={fmtMoney(receipt.strike)} />
                  <Stat label="Expiration" value={receipt.expiry} />
                  <Stat label="Quantity" value={`${receipt.contracts}× contract${receipt.contracts > 1 ? "s" : ""}`} />
                  <Stat label="Fill premium" value={fmtMoney(receipt.fillPremium)} />
                  <Stat label="Total cost" value={fmtMoney(receipt.totalCost)} />
                  <Stat label="Remaining cash" value={fmtMoney(receipt.remainingCash)} />
                </div>
                <div className="flex justify-end gap-2 pt-1 border-t">
                  <Button
                    variant="outline"
                    onClick={() => {
                      // Reset to ATM near current spot + clear qty default.
                      setReceipt(null);
                      setRestoredStrike(null);
                      setSelectedSymbol(null);
                      setQty(NaN);
                      if (rows.length && spot) {
                        const atm = [...rows].sort(
                          (a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot),
                        )[0];
                        if (atm) setSelectedSymbol(atm.symbol);
                      }
                    }}
                  >
                    Buy another
                  </Button>
                  <Button onClick={() => onOpenChange(false)}>Done</Button>
                </div>
              </div>
            )}


            {/* Side + expiry controls */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <div className="inline-flex rounded-md border bg-muted/30 p-0.5">
                <button
                  className={cn(
                    "px-4 py-1.5 text-sm font-medium rounded-sm transition",
                    side === "call" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setSide("call")}
                >Call</button>
                <button
                  className={cn(
                    "px-4 py-1.5 text-sm font-medium rounded-sm transition",
                    side === "put" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setSide("put")}
                >Put</button>
              </div>

              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select expiry" />
                </SelectTrigger>
                <SelectContent>
                  {expiries.map((e) => {
                    const dte = daysToExpiry(e);
                    return (
                      <SelectItem key={e} value={e}>
                        {e} ({dte}d)
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>

              {loading && <span className="text-xs text-muted-foreground">Loading chain…</span>}
              {!loading && chainStale && chain.length > 0 && (
                <span className="text-xs text-amber-500">
                  Using last updated chain data
                  {chainLastUpdated && ` · ${Math.max(1, Math.round((Date.now() - chainLastUpdated) / 1000))}s ago`}
                </span>
              )}
            </div>


            {/* Chain table */}
            <div className="rounded-md border overflow-hidden">
              <div className="grid grid-cols-7 gap-2 px-3 py-2 text-xs font-semibold bg-muted/40 text-muted-foreground">
                <div>Strike</div>
                <div>Breakeven</div>
                <div>To breakeven</div>
                <div>Mark</div>
                <div>Bid × Ask</div>
                <div className="text-right">Ask</div>
                <div className="text-right">Entry</div>
              </div>
              <div className="max-h-[260px] overflow-y-auto">
                {rows.length === 0 && !loading && (
                  <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                    No contracts for this expiry.
                  </div>
                )}
                {rows.map((r, idx) => {
                  const mid = r.bid != null && r.ask != null && r.bid > 0 && r.ask > 0
                    ? (r.bid + r.ask) / 2
                    : Number(r.ask ?? r.last ?? r.bid ?? 0);
                  const be = breakeven(r.strike, mid, r.type);
                  const toBe = spot ? ((be - spot) / spot) * 100 : null;
                  const isSelected = r.symbol === selectedSymbol;
                  const showDivider = idx === dividerIndex && dividerIndex > 0;
                  return (
                    <div key={r.symbol}>
                      {showDivider && (
                        <div className="relative h-6 my-1">
                          <div className="absolute inset-x-3 top-1/2 h-px bg-border" />
                          <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2
                                          rounded-full bg-primary text-primary-foreground text-[11px]
                                          font-semibold px-3 py-0.5 shadow-sm">
                            Share price: {fmtMoney(spot)}
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        data-contract-symbol={r.symbol}
                        onClick={() => setSelectedSymbol(r.symbol)}
                        className={cn(
                          "w-full grid grid-cols-7 gap-2 px-3 py-2 text-sm border-t text-left transition",
                          isSelected ? "bg-primary/10 border-primary/30" : "hover:bg-muted/30"
                        )}
                      >
                        <div className="font-semibold">{fmtMoney(r.strike)}</div>
                        <div>{fmtMoney(be)}</div>
                        <div className={cn(
                          toBe == null ? "" : toBe >= 0 ? "text-emerald-500" : "text-rose-500"
                        )}>{fmtPct(toBe)}</div>
                        <div>{fmtMoney(mid)}</div>
                        <div className="text-xs text-muted-foreground">
                          {fmtMoney(r.bid)} × {fmtMoney(r.ask)}
                        </div>
                        <div className="text-right">
                          <span className={cn(
                            "inline-block rounded border px-2 py-0.5 text-xs font-semibold",
                            isSelected ? "border-primary text-primary" : "border-border"
                          )}>{fmtMoney(r.ask)}</span>
                        </div>
                        <div className="text-right flex items-center justify-end">
                          {(() => {
                            const q = computeEntryQuality(r);
                            const color =
                              q.band === "excellent" ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" :
                              q.band === "good" ? "bg-bull/15 text-bull border-bull/30" :
                              q.band === "fair" ? "bg-amber-500/15 text-amber-500 border-amber-500/30" :
                              "bg-muted text-muted-foreground border-border";
                            return (
                              <span className={cn("inline-block rounded border px-2 py-0.5 text-[11px] font-semibold", color)}>
                                {q.score}
                              </span>
                            );
                          })()}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Selected contract detail */}
            {selected && (
              <div className="rounded-md border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    {signal.ticker} {fmtMoney(selected.strike)} {selected.type === "call" ? "Call" : "Put"} {selected.expiry}
                  </div>
                  <Badge variant="outline" className="text-xs">{daysToExpiry(selected.expiry)} DTE</Badge>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                  <Stat label="Bid" value={fmtMoney(selected.bid)} sub={selected.volume != null ? `vol ${selected.volume.toLocaleString()}` : undefined} />
                  <Stat label="Mark" value={fmtMoney(selectedMid)} />
                  <Stat label="Ask" value={fmtMoney(selected.ask)} />
                  <Stat label="Last" value={fmtMoney(selected.last)} />
                  <Stat label="Open interest" value={selected.open_interest != null ? selected.open_interest.toLocaleString() : "—"} />
                  <Stat label="Implied vol" value={selected.iv != null ? `${(selected.iv * 100).toFixed(2)}%` : "—"} />
                  <Stat label="Delta" value={selected.delta != null ? selected.delta.toFixed(4) : "—"} />
                  <Stat label="Gamma" value={selected.gamma != null ? selected.gamma.toFixed(4) : "—"} />
                  <Stat label="Theta" value={selected.theta != null ? selected.theta.toFixed(4) : "—"} />
                  <Stat label="Vega" value={selected.vega != null ? selected.vega.toFixed(4) : "—"} />
                </div>

                {/* Qty + cost */}
                <div className="flex flex-wrap items-end gap-4 pt-2 border-t">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Contracts</div>
                    <Input
                      type="number"
                      min={1}
                      max={999}
                      placeholder="Qty"
                      value={Number.isFinite(qty) && qty > 0 ? qty : ""}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") { setQty(NaN); return; }
                        const n = Math.floor(Number(raw));
                        setQty(Number.isFinite(n) && n > 0 ? Math.min(999, n) : NaN);
                      }}
                      className="w-24"
                    />
                  </div>
                  <Stat label="Breakeven" value={fmtMoney(breakevenPrice)} />
                  <Stat label="Total cost" value={fmtMoney(totalCost)} accent={!buyingPowerOk ? "danger" : undefined} />
                  <Stat label="Buying power" value={fmtMoney(props.cashBalance)} />
                  <Stat label="Max loss" value={fmtMoney(totalCost)} />
                </div>

                {/* Projection */}
                <div className="pt-3 border-t">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-semibold">Profit projection ({qty}× contract{qty > 1 ? "s" : ""})</div>
                    <Badge variant="outline" className="text-[10px]">
                      {projection.method === "black_scholes" ? "Black-Scholes" :
                        projection.method === "greeks_approx" ? "Greeks estimate" : "n/a"}
                    </Badge>
                  </div>
                  {projection.rows.length === 0 ? (
                    <div className="text-xs text-muted-foreground">Projection unavailable.</div>
                  ) : (
                    <div className="rounded-md border overflow-hidden">
                      <div className="grid grid-cols-5 gap-2 px-3 py-1.5 text-[11px] font-semibold bg-muted/40 text-muted-foreground">
                        <div>Move</div>
                        <div>{signal.ticker} price</div>
                        <div>Option (today)</div>
                        <div>P/L today</div>
                        <div>P/L at expiry</div>
                      </div>
                      {projection.rows.map((row) => {
                        const plToday = row.plNowPerContract * qty;
                        const plExp = row.plExpiryPerContract * qty;
                        return (
                          <div key={row.pctMove} className="grid grid-cols-5 gap-2 px-3 py-1.5 text-xs border-t items-center">
                            <div className={cn("font-medium",
                              row.pctMove > 0 ? "text-emerald-500" : row.pctMove < 0 ? "text-rose-500" : ""
                            )}>{fmtPct(row.pctMove * 100, 0)}</div>
                            <div>{fmtMoney(row.underlying)}</div>
                            <div>{fmtMoney(row.optionPriceNow)}</div>
                            <div className={cn(plToday > 0 ? "text-emerald-500" : plToday < 0 ? "text-rose-500" : "")}>
                              {plToday >= 0 ? "+" : ""}{fmtMoney(plToday).replace("$", "$")}
                            </div>
                            <div className={cn(plExp > 0 ? "text-emerald-500" : plExp < 0 ? "text-rose-500" : "")}>
                              {plExp >= 0 ? "+" : ""}{fmtMoney(plExp)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {Number.isFinite(qty) && qty >= 1 && !buyingPowerOk && (
                  <div className="text-xs text-rose-500">
                    Not enough buying power. Need {fmtMoney(totalCost)}, have {fmtMoney(props.cashBalance)}.
                  </div>
                )}

                {!marketStatus.open && (
                  <div className="text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 px-3 py-2">
                    🔒 {marketStatus.reason}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button onClick={handleBuy} disabled={submitting || !buyingPowerOk || selectedMid <= 0 || !Number.isFinite(qty) || qty < 1 || !marketStatus.open}>
                    {submitting ? "Submitting…" : !marketStatus.open ? "Market closed" : !Number.isFinite(qty) || qty < 1 ? "Enter quantity" : `Buy for ${fmtMoney(totalCost)}`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: "danger" }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={cn("text-sm font-semibold", accent === "danger" ? "text-rose-500" : "")}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
