// Cross-source confirmation matcher.
// Pairs unconfirmed signals on the same (ticker, direction) when both an
// Alpaca-class source AND an Unusual-Whales-class source have fired within
// the last `windowMinutes`. Tags BOTH rows: confirmed_by_both=true,
// confirmed_with_signal_id, and prepends a human reason.
//
// Safe-by-design: read-only failure path. Never throws into the scanner.
// Only updates rows where confirmed_by_both is still false, so it is idempotent.

type AnyClient = {
  from: (t: string) => any;
};

export type SourceClass = "alpaca" | "unusual_whales" | "other";

export function classifySource(source: string | null | undefined): SourceClass {
  const s = (source ?? "").toLowerCase();
  if (s.includes("unusual") && s.includes("whales")) return "unusual_whales";
  if (s.includes("uw_flow") || s === "unusual_whales") return "unusual_whales";
  if (s.includes("alpaca")) return "alpaca";
  return "other";
}

const CONFIRM_PREAMBLE = "Confirmed by both Alpaca scanner and Unusual Whales flow.";

export type MatcherResult = {
  pairs_made: number;
  rows_updated: number;
  error?: string;
};

/**
 * Sweep matcher. Call this at the end of any scanner pass. Idempotent.
 */
export async function runConfirmationSweep(
  admin: AnyClient,
  opts: { windowMinutes?: number } = {},
): Promise<MatcherResult> {
  const windowMinutes = opts.windowMinutes ?? 2;
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  try {
    const { data, error } = await admin
      .from("signals")
      .select("id, ticker, direction, source, reasons, created_at, confirmed_by_both")
      .eq("confirmed_by_both", false)
      .eq("is_demo", false)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) return { pairs_made: 0, rows_updated: 0, error: error.message };
    const rows = data ?? [];
    if (rows.length < 2) return { pairs_made: 0, rows_updated: 0 };

    // Bucket by (ticker, direction); within each bucket find the first
    // alpaca row and the first uw row and pair them.
    type Row = typeof rows[number];
    const buckets = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.ticker}|${r.direction}`;
      const arr = buckets.get(k) ?? [];
      arr.push(r);
      buckets.set(k, arr);
    }

    let pairs = 0;
    let updates = 0;
    for (const [, arr] of buckets) {
      const alpaca = arr.find((r) => classifySource(r.source) === "alpaca");
      const uw = arr.find((r) => classifySource(r.source) === "unusual_whales");
      if (!alpaca || !uw) continue;

      const aReasons = Array.isArray(alpaca.reasons) ? alpaca.reasons : [];
      const uReasons = Array.isArray(uw.reasons) ? uw.reasons : [];
      const aNew = aReasons.includes(CONFIRM_PREAMBLE) ? aReasons : [CONFIRM_PREAMBLE, ...aReasons];
      const uNew = uReasons.includes(CONFIRM_PREAMBLE) ? uReasons : [CONFIRM_PREAMBLE, ...uReasons];

      const [a1, u1] = await Promise.all([
        admin.from("signals").update({
          confirmed_by_both: true,
          confirmed_with_signal_id: uw.id,
          reasons: aNew,
        }).eq("id", alpaca.id).eq("confirmed_by_both", false),
        admin.from("signals").update({
          confirmed_by_both: true,
          confirmed_with_signal_id: alpaca.id,
          reasons: uNew,
        }).eq("id", uw.id).eq("confirmed_by_both", false),
      ]);
      if (!a1.error) updates++;
      if (!u1.error) updates++;
      pairs++;
    }

    return { pairs_made: pairs, rows_updated: updates };
  } catch (e) {
    return { pairs_made: 0, rows_updated: 0, error: (e as Error).message.slice(0, 200) };
  }
}
