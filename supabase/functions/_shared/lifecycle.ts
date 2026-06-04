// Signal Lifecycle Engine — pure evaluator.
// Decides whether an existing signal is still fresh/active, weakening,
// expired, or invalidated based on the latest scoring snapshot vs its
// birth snapshot. Never deletes signals; only transitions state.
//
// States (terminal: expired, invalidated):
//   fresh        — age < 2h, thesis intact
//   active       — thesis intact, within tier TTL
//   weakening    — confidence/flow softening but not broken
//   expired      — past tier TTL with no fresh confirmations
//   invalidated  — thesis broken (large conf drop, flow flip, level lost)

export type LifecycleState = "fresh" | "active" | "weakening" | "expired" | "invalidated";

export type FlowSnapshot = {
  score?: number | null;
  net_premium_bias?: number | null;
  call_put_bias?: number | null;
  sweep_count?: number | null;
  bullish_premium?: number | null;
  bearish_premium?: number | null;
  [k: string]: unknown;
};

export type TechnicalSnapshot = {
  score?: number | null;
  [k: string]: unknown;
};

export type LifecycleSignal = {
  id: string;
  direction: "CALL" | "PUT" | string;
  confidence: number;
  confidence_at_birth: number | null;
  created_at: string;
  lifecycle_state: LifecycleState | string;
  lifecycle_history?: unknown;
  flow_at_birth?: FlowSnapshot | null;
  technical_at_birth?: TechnicalSnapshot | null;
};

export type LifecycleInputs = {
  currentConfidence: number;
  currentFlow?: FlowSnapshot | null;
  currentTechnical?: TechnicalSnapshot | null;
  nowMs?: number;
};

export type LifecycleDecision = {
  state: LifecycleState;
  reason: string;
  transitioned: boolean;
};

const TERMINAL: ReadonlySet<string> = new Set(["expired", "invalidated"]);

export function tierTtlHours(confidenceAtBirth: number | null | undefined): number {
  const c = confidenceAtBirth ?? 0;
  if (c >= 90) return 48;
  if (c >= 80) return 36;
  if (c >= 70) return 24;
  if (c >= 65) return 12;
  return 6;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sign(v: number | null): -1 | 0 | 1 {
  if (v === null) return 0;
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

export function evaluateLifecycle(
  signal: LifecycleSignal,
  inputs: LifecycleInputs,
): LifecycleDecision {
  const prev = (signal.lifecycle_state as LifecycleState) ?? "active";

  // Terminal states never transition.
  if (TERMINAL.has(prev)) {
    return { state: prev as LifecycleState, reason: "terminal", transitioned: false };
  }

  const now = inputs.nowMs ?? Date.now();
  const ageH = (now - new Date(signal.created_at).getTime()) / 3_600_000;
  const ttlH = tierTtlHours(signal.confidence_at_birth);
  const birthConf = signal.confidence_at_birth ?? signal.confidence;
  const drop = birthConf - inputs.currentConfidence;

  // ---- Invalidated checks (strongest first) ----
  if (drop >= 15) {
    return decide(prev, "invalidated", `confidence_drop_${Math.round(drop)}`);
  }

  const birthFlow = signal.flow_at_birth ?? {};
  const curFlow = inputs.currentFlow ?? {};
  const birthNet = num(birthFlow.net_premium_bias);
  const curNet = num(curFlow.net_premium_bias);
  const birthCP = num(birthFlow.call_put_bias);
  const curCP = num(curFlow.call_put_bias);
  // Flow flip: net-premium sign reversed AND was non-trivial at birth.
  if (birthNet !== null && curNet !== null && Math.abs(birthNet) >= 0.1 && sign(birthNet) !== 0 && sign(curNet) !== 0 && sign(birthNet) !== sign(curNet)) {
    return decide(prev, "invalidated", "flow_net_premium_flip");
  }
  // Call/put bias flip (same idea, different metric).
  if (birthCP !== null && curCP !== null && Math.abs(birthCP) >= 0.1 && sign(birthCP) !== 0 && sign(curCP) !== 0 && sign(birthCP) !== sign(curCP)) {
    return decide(prev, "invalidated", "flow_call_put_flip");
  }

  // Technical thesis break: signed technical score reversed beyond a margin.
  // Technical component is direction-aware 0..100 (higher = thesis intact).
  // Treat <= 35 as a broken thesis when birth was >= 55.
  const birthTech = num(signal.technical_at_birth?.score);
  const curTech = num(inputs.currentTechnical?.score);
  if (birthTech !== null && curTech !== null && birthTech >= 55 && curTech <= 35) {
    return decide(prev, "invalidated", "technical_thesis_broken");
  }

  // ---- Weakening checks ----
  if (drop >= 5) {
    return decide(prev, "weakening", `confidence_drop_${Math.round(drop)}`);
  }
  // Sweep activity disappeared (birth had sweeps, now zero).
  const birthSweeps = num(birthFlow.sweep_count);
  const curSweeps = num(curFlow.sweep_count);
  if (birthSweeps !== null && birthSweeps >= 3 && curSweeps !== null && curSweeps === 0) {
    return decide(prev, "weakening", "flow_sweeps_disappeared");
  }
  // Premium magnitude halved on the aligned side.
  if (birthNet !== null && curNet !== null && Math.abs(birthNet) >= 0.2 && Math.abs(curNet) <= Math.abs(birthNet) / 2) {
    return decide(prev, "weakening", "flow_premium_halved");
  }
  // Technical softening below neutral when birth was confident.
  if (birthTech !== null && curTech !== null && birthTech >= 60 && curTech < 50) {
    return decide(prev, "weakening", "technical_softening");
  }

  // ---- Expiration (time) ----
  if (ageH >= ttlH) {
    // Time alone does NOT expire if confirmations remain strong.
    const stableConf = Math.abs(drop) <= 4;
    const flowIntact =
      (birthNet === null || curNet === null) ||
      (Math.abs(curNet) >= Math.abs(birthNet) * 0.75 && sign(curNet) === sign(birthNet || 1));
    if (stableConf && flowIntact) {
      return decide(prev, "active", "time_exceeded_but_intact");
    }
    return decide(prev, "expired", "time_exceeded");
  }

  // ---- Fresh / Active ----
  if (ageH < 2) return decide(prev, "fresh", "age_under_2h");
  return decide(prev, "active", "thesis_intact");
}

function decide(prev: string, next: LifecycleState, reason: string): LifecycleDecision {
  return { state: next, reason, transitioned: prev !== next };
}

export function appendHistory(
  history: unknown,
  entry: { state: LifecycleState; reason: string; confidence: number; at: string },
): unknown[] {
  const arr = Array.isArray(history) ? history.slice() : [];
  arr.push(entry);
  // Cap at 20 to keep row size bounded.
  return arr.slice(-20);
}
