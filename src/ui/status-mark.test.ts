import { describe, expect, it } from "vitest";
import {
  STATUS_MARK_DENSITIES,
  STATUS_MARK_LABELS,
  STATUS_MARK_STATES,
  statusMarkDensitySize,
  statusMarkRenderedSize,
  statusMarkStateForRuntimeStatus,
} from "./status-mark";

describe("canonical status-mark grammar", () => {
  it("defines seven named states", () => {
    expect(STATUS_MARK_STATES).toEqual([
      "none",
      "checking",
      "stale",
      "verified",
      "asserted",
      "attention",
      "failed",
    ]);
    expect(STATUS_MARK_LABELS.none).toBe("Not checked");
    expect(new Set(Object.values(STATUS_MARK_LABELS)).size).toBe(7);
  });

  it("normalizes runtime states without inventing new visual states", () => {
    expect(statusMarkStateForRuntimeStatus("checking")).toBe("checking");
    expect(statusMarkStateForRuntimeStatus("loading")).toBe("checking");
    expect(statusMarkStateForRuntimeStatus("stale")).toBe("stale");
    expect(statusMarkStateForRuntimeStatus("degraded")).toBe("attention");
    expect(statusMarkStateForRuntimeStatus("conflicted")).toBe("attention");
    expect(statusMarkStateForRuntimeStatus(undefined)).toBe("none");
  });

  it("never renders a status mark below the 16px legibility floor", () => {
    expect(statusMarkRenderedSize(8)).toBe(16);
    expect(statusMarkRenderedSize(16)).toBe(16);
    expect(statusMarkRenderedSize(44)).toBe(44);
  });

  it("offers exactly three densities", () => {
    expect(STATUS_MARK_DENSITIES).toEqual(["dot", "chip", "hero"]);
  });

  it("renders every density in a well of at least 16px", () => {
    for (const density of STATUS_MARK_DENSITIES) {
      expect(statusMarkDensitySize(density)).toBeGreaterThanOrEqual(16);
    }
    expect(statusMarkDensitySize("dot")).toBe(16);
    expect(statusMarkDensitySize("chip")).toBe(16);
    expect(statusMarkDensitySize("hero")).toBe(28);
  });

  it("floors an explicit size override rather than trusting the call site", () => {
    expect(statusMarkDensitySize("dot", 10)).toBe(16);
    expect(statusMarkDensitySize("hero", 13)).toBe(16);
    expect(statusMarkDensitySize("chip", 44)).toBe(44);
  });
});
