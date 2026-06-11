// POST /functions/v1/fetch-macro-quotes
// Pulls QQQ/SPY/SMH/XLK quotes + VIX + DXY-proxy (UUP), computes a
// macro_tailwind_score (0-100), and writes one row to macro_regime_snapshots.
//
// Run every 60s via pg_cron. Partial snapshots (with nulls for missing fields)
// are still written so auto-exit-engine can renormalize gracefully.
//
// Sources:
//   - Alpaca for SPY/QQQ/SMH/XLK/UUP (5-min bars + latest trade)
//   - Alpha Vantage for ^VIX (GLOBAL_QUOTE)
//
// No auth required; service-role-only callable via cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EtfQuote = {
  price: number | null;
  ret5m: number | null;          // (last - 5m-ago close) / 5m-ago close
  aboveVwap: boolean | null;     // last > today's session VWAP
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole);

  const alpacaKey = Deno.env.get("ALPACA_API_KEY_ID") ?? "";
  const alpacaSec = Deno.env.get("ALPACA_API_SECRET_KEY") ?? "";
  const avKey = Deno.env.get("ALPHAVANTAGE_API_KEY") ?? "";

  const errors: Record<string, string> = {};

  // Fetch ETFs in parallel
  const etfTickers = ["SPY", "QQQ", "SMH", "XLK", "UUP"] as const;
  const etfResults: Record<string, EtfQuote> = {};
  await Promise.all(etfTickers.map(async (sym) => {
    try {
      etfResults[sym] = await fetchEtfQuote(sym, alpacaKey, alpacaSec);
    } catch (e) {
      errors[sym] = e instanceof Error ? e.message : String(e);
      etfResults[sym] = { price: null, ret5m: null, aboveVwap: null };
    }
  }));

  // Fetch VIX (Alpha Vantage)
  let vixSpot: number | null = null;
  try {
    vixSpot = await fetchVixSpot(avKey);
  } catch (e) {
    errors["VIX"] = e instanceof Error ? e.message : String(e);
  }

  // DXY proxy: UUP 1-day return
  const dxy1dRet = etfResults["UUP"]?.ret5m ?? null; // best-effort; UUP intraday only here

  const spy = etfResults["SPY"];
  const qqq = etfResults["QQQ"];
  const smh = etfResults["SMH"];
  const xlk = etfResults["XLK"];

  const { score, components } = computeMacroTailwindScore({
    spy, qqq, smh, xlk, vixSpot, dxy1dRet,
  });

  const row = {
    spy_price: spy?.price, spy_5m_ret: spy?.ret5m, spy_above_5m_vwap: spy?.aboveVwap,
    qqq_price: qqq?.price, qqq_5m_ret: qqq?.ret5m, qqq_above_5m_vwap: qqq?.aboveVwap,
    smh_price: smh?.price, smh_5m_ret: smh?.ret5m, smh_above_5m_vwap: smh?.aboveVwap,
    xlk_price: xlk?.price, xlk_5m_ret: xlk?.ret5m,
    vix_spot: vixSpot,
    dxy_1d_ret: dxy1dRet,
    macro_tailwind_score: score,
    components,
    source_errors: Object.keys(errors).length ? errors : null,
  };

  const { data, error } = await admin
    .from("macro_regime_snapshots")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("macro snapshot insert failed", error);
    return json({ ok: false, error: error.message, duration_ms: Date.now() - t0 }, 500);
  }
  return json({ ok: true, id: data?.id, score, errors, duration_ms: Date.now() - t0 });
});

// ─── Alpaca ETF quotes ───────────────────────────────────────────────────
async function fetchEtfQuote(sym: string, key: string, sec: string): Promise<EtfQuote> {
  if (!key || !sec) throw new Error("alpaca creds missing");
  const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec };

  // Last trade
  const tradeUrl = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/trades/latest`;
  const tradeRes = await fetch(tradeUrl, { headers });
  if (!tradeRes.ok) throw new Error(`alpaca trade ${sym} ${tradeRes.status}`);
  const tradeJson = await tradeRes.json();
  const price = numOrNull(tradeJson?.trade?.p);

  // 5-min bars for today (use last + 5-ago close for ret5m, all bars for VWAP)
  // Pull last ~30 minutes of 1-min bars to be safe.
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000); // last 60min
  const barsUrl = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/bars`
    + `?timeframe=1Min&limit=120&adjustment=raw`
    + `&start=${encodeURIComponent(start.toISOString())}`
    + `&end=${encodeURIComponent(end.toISOString())}`;
  const barsRes = await fetch(barsUrl, { headers });
  if (!barsRes.ok) {
    return { price, ret5m: null, aboveVwap: null };
  }
  const barsJson = await barsRes.json();
  const bars: Array<{ c: number; v: number; vw?: number; h: number; l: number }> = barsJson?.bars ?? [];
  if (bars.length === 0) return { price, ret5m: null, aboveVwap: null };

  // 5-min return: latest close vs 5 bars ago close
  let ret5m: number | null = null;
  if (bars.length >= 6) {
    const last = bars[bars.length - 1].c;
    const ago = bars[bars.length - 6].c;
    if (ago > 0) ret5m = (last - ago) / ago;
  }

  // Session VWAP from the bars we have (rough — only spans up to 60min)
  let pv = 0, vol = 0;
  for (const b of bars) {
    const typical = b.vw ?? (b.h + b.l + b.c) / 3;
    pv += typical * (b.v || 0);
    vol += (b.v || 0);
  }
  const vwap = vol > 0 ? pv / vol : null;
  const aboveVwap = price != null && vwap != null ? price > vwap : null;

  return { price, ret5m, aboveVwap };
}

// ─── VIX via Alpha Vantage ───────────────────────────────────────────────
async function fetchVixSpot(avKey: string): Promise<number | null> {
  if (!avKey) return null;
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=VIX&apikey=${avKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`av vix ${res.status}`);
  const j = await res.json();
  const p = numOrNull(j?.["Global Quote"]?.["05. price"]);
  return p;
}

// ─── Macro tailwind score (0-100, null-skip with renormalize) ───────────
function computeMacroTailwindScore(args: {
  spy: EtfQuote; qqq: EtfQuote; smh: EtfQuote; xlk: EtfQuote;
  vixSpot: number | null; dxy1dRet: number | null;
}): { score: number | null; components: Record<string, number | null> } {
  const { spy, qqq, smh, xlk, vixSpot, dxy1dRet } = args;

  // Component 1: SPY VWAP+trend (weight 30)
  let cSpy: number | null = null;
  if (spy?.aboveVwap != null || spy?.ret5m != null) {
    cSpy = (spy?.aboveVwap ? 20 : 0) + clamp(((spy?.ret5m ?? 0) + 0.005) / 0.01 * 10, 0, 10);
  }

  // Component 2: Sector ETF strength (weight 30) — avg of SMH + XLK
  let cSector: number | null = null;
  const parts: number[] = [];
  for (const e of [smh, xlk]) {
    if (e?.aboveVwap != null || e?.ret5m != null) {
      parts.push((e?.aboveVwap ? 20 : 0) + clamp(((e?.ret5m ?? 0) + 0.005) / 0.01 * 10, 0, 10));
    }
  }
  if (parts.length > 0) cSector = parts.reduce((a, b) => a + b, 0) / parts.length;

  // Component 3: QQQ alignment (weight 15)
  let cQqq: number | null = null;
  if (qqq?.aboveVwap != null || qqq?.ret5m != null) {
    cQqq = (qqq?.aboveVwap ? 10 : 0) + clamp(((qqq?.ret5m ?? 0) + 0.005) / 0.01 * 5, 0, 5);
  }

  // Component 4: VIX (weight 15) — <15 = full, 15-25 linear, >35 = 0
  let cVix: number | null = null;
  if (vixSpot != null) {
    if (vixSpot <= 15) cVix = 15;
    else if (vixSpot >= 35) cVix = 0;
    else cVix = 15 * (1 - (vixSpot - 15) / 20);
  }

  // Component 5: DXY (weight 10) — falling dollar = tailwind for tech
  let cDxy: number | null = null;
  if (dxy1dRet != null) {
    cDxy = clamp(10 - (dxy1dRet * 1000), 0, 10); // +0.5% UUP → 5pts; -0.5% → 10pts
  }

  // Renormalize across present components
  const weights = { spy: 30, sector: 30, qqq: 15, vix: 15, dxy: 10 };
  const vals: Array<[number | null, number]> = [
    [cSpy, weights.spy], [cSector, weights.sector], [cQqq, weights.qqq],
    [cVix, weights.vix], [cDxy, weights.dxy],
  ];
  let present = 0, sum = 0, raw = 0;
  for (const [v, w] of vals) {
    if (v != null) { sum += v; present += w; }
    raw += w;
  }
  const score = present > 0 ? Math.round((sum / present) * 100) : null;

  return {
    score,
    components: {
      spy_vwap_trend: cSpy, sector_strength: cSector, qqq_alignment: cQqq,
      vix_score: cVix, dxy_score: cDxy,
    },
  };
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
