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
import { buyOptionAsPaperTrade, type SelectedContract } from "@/lib/buyOption";
import { buildProjection, breakeven, daysToExpiry } from "@/lib/blackScholes";

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
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  const [chainTried, setChainTried] = useState(false);

  const signalSpot = useMemo(() => Number(signal?.price ?? 0) || 0, [signal]);

  // Derive live underlying price from the loaded chain using put-call parity:
  //   S ≈ K + (Call_mid - Put_mid)   (ignoring r, q for short-dated options)
  // We use the median across strikes near the signal price for robustness.
  const liveSpot = useMemo(() => {
    if (!chain.length) return signalSpot;
    // Use the nearest expiry only — most liquid and least parity drift.
    const expiries = Array.from(new Set(chain.map((r) => r.expiry))).sort();
    const targetExp = expiries[0];
    if (!targetExp) return signalSpot;
    const callsByStrike = new Map<number, ChainRow>();
    const putsByStrike = new Map<number, ChainRow>();
    for (const r of chain) {
      if (r.expiry !== targetExp) continue;
      const mid =
        r.bid != null && r.ask != null && r.bid > 0 && r.ask > 0
          ? (Number(r.bid) + Number(r.ask)) / 2
          : Number(r.ask ?? r.last ?? r.bid ?? 0);
      if (!mid || !Number.isFinite(mid)) continue;
      const slot = r.type === "call" ? callsByStrike : putsByStrike;
      slot.set(Number(r.strike), { ...r, bid: mid, ask: mid } as ChainRow);
    }
    const estimates: number[] = [];
    for (const [strike, call] of callsByStrike) {
      const put = putsByStrike.get(strike);
      if (!put) continue;
      const cMid = Number(call.bid);
      const pMid = Number(put.bid);
      const s = strike + cMid - pMid;
      if (Number.isFinite(s) && s > 0) estimates.push(s);
    }
    if (!estimates.length) return signalSpot;
    estimates.sort((a, b) => a - b);
    return estimates[Math.floor(estimates.length / 2)];
  }, [chain, signalSpot]);

  // `spot` is the LIVE price used everywhere (ATM picker, projections, divider).
  const spot = liveSpot;
  const spotDeltaPct = signalSpot > 0 ? ((liveSpot - signalSpot) / signalSpot) * 100 : 0;

  // Load chain when dialog opens
  useEffect(() => {
    if (!open || !signal) return;
    let cancelled = false;
    setLoading(true);
    setChainTried(false);
    setSelectedSymbol(null);
    setQty(1);
    const initialSide = String(signal.direction).toUpperCase() === "PUT" ? "put" : "call";
    setSide(initialSide);

    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("options_contracts")
        .select("symbol, underlying, expiry, strike, type, bid, ask, last, volume, open_interest, delta, gamma, theta, vega, iv")
        .eq("underlying", signal.ticker)
        .gte("expiry", today)
        .order("expiry", { ascending: true })
        .order("strike", { ascending: true })
        .limit(1000);
      if (cancelled) return;
      setLoading(false);
      setChainTried(true);
      if (error) {
        toast.error(`Chain load failed: ${error.message}`);
        return;
      }
      const rows = (data ?? []) as ChainRow[];
      setChain(rows);
      // Pick initial expiry: signal.expiry if present in chain, else earliest
      const expiries = Array.from(new Set(rows.map((r) => r.expiry))).sort();
      const sigExp = (signal as any).expiry as string | null;
      const initialExp = sigExp && expiries.includes(sigExp) ? sigExp : expiries[0] ?? "";
      setExpiry(initialExp);
    })();
    return () => { cancelled = true; };
  }, [open, signal]);

  // If chain came back empty, fall back to old approve flow and close.
  useEffect(() => {
    if (!chainTried || loading) return;
    if (chain.length === 0 && signal) {
      toast.message("Option chain unavailable — using quick-approve fallback.");
      onFallbackApprove(signal);
      onOpenChange(false);
    }
  }, [chainTried, loading, chain.length, signal, onFallbackApprove, onOpenChange]);

  const expiries = useMemo(() => Array.from(new Set(chain.map((r) => r.expiry))).sort(), [chain]);

  const rows = useMemo(() => {
    return chain
      .filter((r) => r.type === side && r.expiry === expiry)
      .sort((a, b) => a.strike - b.strike);
  }, [chain, side, expiry]);

  // Auto-pick a sensible default strike when expiry/side changes.
  useEffect(() => {
    if (!rows.length || !spot) { setSelectedSymbol(null); return; }
    // Prefer ATM-ish: smallest |strike - spot|
    const best = [...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    setSelectedSymbol(best.symbol);
  }, [rows, spot]);

  const selected = useMemo(() => rows.find((r) => r.symbol === selectedSymbol) ?? null, [rows, selectedSymbol]);

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
            </div>

            {/* Chain table */}
            <div className="rounded-md border overflow-hidden">
              <div className="grid grid-cols-6 gap-2 px-3 py-2 text-xs font-semibold bg-muted/40 text-muted-foreground">
                <div>Strike</div>
                <div>Breakeven</div>
                <div>To breakeven</div>
                <div>Mark</div>
                <div>Bid × Ask</div>
                <div className="text-right">Ask</div>
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
                        onClick={() => setSelectedSymbol(r.symbol)}
                        className={cn(
                          "w-full grid grid-cols-6 gap-2 px-3 py-2 text-sm border-t text-left transition",
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
                      value={qty}
                      onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
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

                {!buyingPowerOk && (
                  <div className="text-xs text-rose-500">
                    Not enough buying power. Need {fmtMoney(totalCost)}, have {fmtMoney(props.cashBalance)}.
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button onClick={handleBuy} disabled={submitting || !buyingPowerOk || selectedMid <= 0}>
                    {submitting ? "Submitting…" : `Buy for ${fmtMoney(totalCost)}`}
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
