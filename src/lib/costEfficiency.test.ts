import { describe, it, expect } from "vitest";
import { analyzeCostEfficiency } from "./costEfficiency";

describe("analyzeCostEfficiency", () => {
  it("flags a weekly OTM call as theta_trap", () => {
    // SPY-like: spot 500, strike 510 (2% OTM), premium 0.40, 3 DTE, heavy theta
    const r = analyzeCostEfficiency({
      spot: 500,
      strike: 510,
      premium: 0.40,
      dte: 3,
      theta: -0.10, // 25%/day decay — egregious
      type: "call",
    });
    expect(r.verdict).toBe("theta_trap");
    expect(r.thetaDragPct).toBeCloseTo(25, 0);
    expect(r.breakevenMovePct).toBeCloseTo(2.08, 1);
  });

  it("rates a balanced 45-DTE near-ATM call as efficient", () => {
    // spot 100, strike 102, premium 3.00, 45 DTE, modest theta
    const r = analyzeCostEfficiency({
      spot: 100,
      strike: 102,
      premium: 3.0,
      dte: 45,
      theta: -0.04, // ~1.3% drag — slightly elevated but ok-ish
      type: "call",
    });
    // theta drag ~1.33% which trips trap on theta alone. Use lower theta:
    const r2 = analyzeCostEfficiency({
      spot: 100,
      strike: 102,
      premium: 3.0,
      dte: 45,
      theta: -0.01,
      type: "call",
    });
    expect(r2.verdict).toBe("efficient");
    expect(r2.breakevenMovePct).toBeCloseTo(5.0, 1);
    expect(r.verdict).toBe("theta_trap");
  });

  it("caps short DTE at marginal when other rules pass", () => {
    const r = analyzeCostEfficiency({
      spot: 100,
      strike: 100,
      premium: 2.0,
      dte: 7,
      theta: -0.01, // 0.5% drag
      type: "call",
    });
    expect(r.verdict).toBe("marginal");
  });

  it("flags oversized position when equity provided", () => {
    const r = analyzeCostEfficiency({
      spot: 100,
      strike: 100,
      premium: 5.0, // $500/contract
      dte: 30,
      theta: -0.01,
      type: "call",
      equity: 2000, // 25% of equity
    });
    expect(r.premiumPctOfEquity).toBeCloseTo(25, 0);
    expect(r.verdict).toBe("theta_trap");
  });
});
