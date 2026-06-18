import { describe, it, expect } from "vitest";
import {
  computeFrequency,
  FREQUENCY_THRESHOLDS,
  type FrequencyObservation,
} from "./frequencyScore";

const call = (strength: number): FrequencyObservation => ({ strength, direction: "CALL" });
const put = (strength: number): FrequencyObservation => ({ strength, direction: "PUT" });

describe("computeFrequency", () => {
  it("treats a single observation as one-off with no boost", () => {
    const r = computeFrequency(call(68), []);
    expect(r.label).toBe("one-off");
    expect(r.frequencyScore).toBe(0);
    expect(r.consideration).toBe(68);
  });

  it("labels a tight, same-direction cluster as persistent with bounded boost", () => {
    const history = [call(64), call(61), call(65), call(63), call(62)];
    const r = computeFrequency(call(62), history);
    expect(r.label).toBe("persistent");
    expect(r.consideration).toBeGreaterThan(62);
    expect(r.consideration).toBeLessThanOrEqual(62 * (1 + FREQUENCY_THRESHOLDS.MAX_BOOST));
  });

  it("lowers frequencyScore when recent direction is mixed vs a clean cluster", () => {
    const clean = computeFrequency(call(62), [call(64), call(61), call(65), call(63), call(62)]);
    const mixed = computeFrequency(call(62), [put(64), call(61), put(65), call(63), put(62)]);
    expect(mixed.agreement).toBeLessThan(clean.agreement);
    expect(mixed.frequencyScore).toBeLessThan(clean.frequencyScore);
  });

  it("lowers consistency when strengths are widely dispersed", () => {
    const tight = computeFrequency(call(62), [call(64), call(61), call(65)]);
    const wide = computeFrequency(call(50), [call(90), call(55), call(88)]);
    expect(wide.consistency).toBeLessThan(tight.consistency);
  });

  it("ranks a persistent cluster's consideration above a lone higher-strength one-off", () => {
    const persistent = computeFrequency(
      call(62),
      [call(64), call(61), call(65), call(63), call(62)],
    );
    const lone = computeFrequency(call(68), []);
    expect(persistent.consideration).toBeGreaterThan(lone.consideration);
  });
});
