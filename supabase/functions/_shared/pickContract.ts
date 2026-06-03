// Shared options contract picker.
// Selects a ~0.35-delta, liquid, 14–30 DTE contract from cached options_contracts.

export type ContractRow = {
  symbol: string;
  underlying: string;
  expiry: string;        // YYYY-MM-DD
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  delta: number | null;
  iv: number | null;
};

export type PickedContract = {
  contract: ContractRow;
  mid: number;
  dte: number;
  spread_pct: number;
  liquidity_score: number;
  reason: string;
};

export type PickOptions = {
  targetDelta?: number;
  dteMin?: number;
  dteMax?: number;
  dteIdeal?: number;
};

function daysBetween(a: Date, b: Date) {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function scoreRow(
  r: ContractRow,
  opts: Required<PickOptions>,
  today: Date,
): PickedContract | null {
  if (r.delta == null || r.bid == null || r.ask == null) return null;
  if (r.bid <= 0 || r.ask <= 0) return null;
  const mid = (r.bid + r.ask) / 2;
  if (mid <= 0) return null;
  const spreadPct = (r.ask - r.bid) / mid;
  const dte = daysBetween(today, new Date(r.expiry + "T00:00:00Z"));
  if (dte < opts.dteMin || dte > opts.dteMax) return null;

  const absDelta = Math.abs(r.delta);
  const oi = r.open_interest ?? 0;
  const vol = r.volume ?? 0;

  // composite score (lower = better)
  const deltaDist = Math.abs(absDelta - opts.targetDelta) * 100;
  const dteDist = Math.abs(dte - opts.dteIdeal) * 0.3;
  const spreadPart = spreadPct * 100 * 0.5;
  const liquidityPenalty = 1 / Math.log10(oi + 10) + 1 / Math.log10(vol + 10);
  const score = deltaDist * 2 + dteDist + spreadPart + liquidityPenalty;

  const liquidity_score = Math.max(
    0,
    Math.min(100, Math.round(100 - score)),
  );

  const reason =
    `Δ ${absDelta.toFixed(2)} · ${dte}d · spread ${(spreadPct * 100).toFixed(1)}% · OI ${oi.toLocaleString()}`;

  return {
    contract: r,
    mid: +mid.toFixed(2),
    dte,
    spread_pct: +(spreadPct * 100).toFixed(2),
    liquidity_score,
    reason,
  };
}

export async function pickBestContract(
  admin: any,
  underlying: string,
  direction: "CALL" | "PUT",
  options: PickOptions = {},
): Promise<PickedContract | null> {
  const opts: Required<PickOptions> = {
    targetDelta: options.targetDelta ?? 0.35,
    dteMin: options.dteMin ?? 14,
    dteMax: options.dteMax ?? 30,
    dteIdeal: options.dteIdeal ?? 21,
  };

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const max = new Date(today.getTime() + (opts.dteMax + 2) * 86400000)
    .toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("options_contracts")
    .select(
      "symbol, underlying, expiry, strike, type, bid, ask, last, volume, open_interest, delta, iv",
    )
    .eq("underlying", underlying)
    .eq("type", direction === "CALL" ? "call" : "put")
    .gte("expiry", todayStr)
    .lte("expiry", max)
    .limit(2000);

  if (error || !Array.isArray(data) || data.length === 0) return null;

  const rows = data as ContractRow[];

  // Some feeds (e.g. Alpaca IEX) don't expose open_interest; detect that case
  // and lean on volume as the primary liquidity proxy instead.
  const hasOI = rows.some((r) => (r.open_interest ?? 0) > 0);

  // Pass 1 — strict liquidity
  const strict = rows.filter((r) => {
    if (r.delta == null || r.bid == null || r.ask == null) return false;
    if (r.bid <= 0 || r.ask <= 0) return false;
    const mid = (r.bid + r.ask) / 2;
    if ((r.ask - r.bid) / (mid || 1) > 0.25) return false;
    if (hasOI) {
      if ((r.open_interest ?? 0) < 100) return false;
      if ((r.volume ?? 0) < 10) return false;
    } else {
      if ((r.volume ?? 0) < 50) return false;
    }
    return true;
  });

  let candidates = strict
    .map((r) => scoreRow(r, opts, today))
    .filter((x): x is PickedContract => x !== null);

  // Pass 2 — relaxed
  if (candidates.length === 0) {
    const relaxed = rows.filter((r) => {
      if (r.delta == null || r.bid == null || r.ask == null) return false;
      if (r.bid <= 0 || r.ask <= 0) return false;
      if (hasOI) {
        if ((r.open_interest ?? 0) < 10) return false;
      } else {
        if ((r.volume ?? 0) < 1) return false;
      }
      return true;
    });
    candidates = relaxed
      .map((r) => scoreRow(r, opts, today))
      .filter((x): x is PickedContract => x !== null);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Re-derive composite to compare (same formula as scoreRow)
    const sa =
      Math.abs(Math.abs(a.contract.delta!) - opts.targetDelta) * 200 +
      Math.abs(a.dte - opts.dteIdeal) * 0.3 +
      a.spread_pct * 0.5;
    const sb =
      Math.abs(Math.abs(b.contract.delta!) - opts.targetDelta) * 200 +
      Math.abs(b.dte - opts.dteIdeal) * 0.3 +
      b.spread_pct * 0.5;
    return sa - sb;
  });

  return candidates[0];
}
