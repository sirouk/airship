import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESENTATION_DENSITY,
  PRESENTATION_DENSITIES,
  densityAllows,
  parsePresentationDensity,
  presentationDensity,
  setPresentationDensity,
  subscribePresentationDensity,
} from "./density";

describe("presentation density authority", () => {
  it("offers the three modes the visibility gradient names", () => {
    expect(PRESENTATION_DENSITIES).toEqual(["minimal", "balanced", "instrumented"]);
  });

  it("treats every unreadable or stored default as minimal — the quiet screen is the house default", () => {
    expect(DEFAULT_PRESENTATION_DENSITY).toBe("minimal");
    expect(parsePresentationDensity(undefined)).toBe("minimal");
    expect(parsePresentationDensity("minimal")).toBe("minimal");
    expect(parsePresentationDensity("balanced")).toBe("balanced");
    expect(parsePresentationDensity("instrumented")).toBe("instrumented");
    expect(parsePresentationDensity("loud")).toBe("minimal");
  });

  it("retires commentary, telemetry, proof echo, suggestion, chatter, and raw detail at minimal", () => {
    for (const tag of ["telemetry", "proof", "suggestion", "commentary", "chatter", "raw"] as const) {
      expect(densityAllows(tag, "minimal")).toBe(false);
    }
  });

  it("keeps raw detail instrumented-only; balanced renders the relevant surface", () => {
    for (const tag of ["telemetry", "proof", "suggestion", "commentary", "chatter"] as const) {
      expect(densityAllows(tag, "balanced")).toBe(true);
      expect(densityAllows(tag, "instrumented")).toBe(true);
    }
    expect(densityAllows("raw", "balanced")).toBe(false);
    expect(densityAllows("raw", "instrumented")).toBe(true);
  });

  it("publishes mode changes to listeners exactly once", () => {
    const events: string[] = [];
    const unsubscribe = subscribePresentationDensity(() => events.push(presentationDensity()));
    const before = presentationDensity();
    setPresentationDensity(before);
    expect(events).toEqual([]);
    const next = before === "minimal" ? "instrumented" : "minimal";
    setPresentationDensity(next);
    expect(events).toEqual([next]);
    unsubscribe();
    setPresentationDensity(before);
  });

  it("survives a document-free environment (unit lanes run without one)", () => {
    setPresentationDensity("balanced");
    expect(presentationDensity()).toBe("balanced");
    setPresentationDensity(DEFAULT_PRESENTATION_DENSITY);
    expect(presentationDensity()).toBe(DEFAULT_PRESENTATION_DENSITY);
  });});
