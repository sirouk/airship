import { describe, expect, it } from "vitest";
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER_NARROW,
  COMPOSER_VIEWPORT_SHARE,
  composerGrowthCap,
  composerKeyhints,
  composerPlaceholder,
  composerPosture,
} from "./composer";
import { OFFLINE_INLINE_REASON } from "../connectivity";

describe("composer placeholder", () => {
  it("shortens below 480px and never restates the slash menu at either width", () => {
    expect(composerPlaceholder(false)).toBe(COMPOSER_PLACEHOLDER);
    expect(composerPlaceholder(true)).toBe(COMPOSER_PLACEHOLDER_NARROW);
    // The measured defect was a 396px string in a 175px box. Both forms have to
    // fit the narrowest content box the design direction measures (382px on a
    // 430px phone), at the 16px iOS-zoom-guard size where ~0.55em per character
    // is a conservative estimate.
    for (const value of [COMPOSER_PLACEHOLDER, COMPOSER_PLACEHOLDER_NARROW]) {
      expect(value.length * 16 * 0.55).toBeLessThan(382);
    }
  });
});

describe("composer growth cap", () => {
  it("leaves a tall viewport at the declared 180px ceiling", () => {
    expect(composerGrowthCap(COMPOSER_MAX_HEIGHT, 900, 44)).toBe(COMPOSER_MAX_HEIGHT);
  });

  it("keeps the composer under half of a keyboard-shrunk visual viewport", () => {
    const keyboardOpen = 404;
    const cap = composerGrowthCap(COMPOSER_MAX_HEIGHT, keyboardOpen, 44);
    expect(cap).toBe(Math.round(keyboardOpen * COMPOSER_VIEWPORT_SHARE));
    // 44px footer + 2px border on top of the textarea cap, against the 0.46
    // share the amended e2e assertion holds the whole region to.
    expect((cap + 46) / keyboardOpen).toBeLessThan(0.46);
  });

  it("never caps below the resting height, however short the viewport claims to be", () => {
    expect(composerGrowthCap(COMPOSER_MAX_HEIGHT, 60, 44)).toBe(44);
  });

  it("falls back to the declared ceiling when no viewport height is reported", () => {
    expect(composerGrowthCap(COMPOSER_MAX_HEIGHT, Number.NaN, 44)).toBe(COMPOSER_MAX_HEIGHT);
    expect(composerGrowthCap(Number.NaN, 900, 44)).toBe(COMPOSER_MAX_HEIGHT);
  });
});

describe("composer credential posture", () => {
  const base = { online: true, offlineReason: OFFLINE_INLINE_REASON, inferenceConnected: false } as const;

  it("names the demo, the local endpoint and the in-memory key distinctly", () => {
    expect(composerPosture(base).label).toBe("Local demo");
    expect(composerPosture({ ...base, inferenceConnected: true, authMethod: "local-none" }).label)
      .toBe("Local endpoint");
    expect(composerPosture({ ...base, inferenceConnected: true, authMethod: "oauth-pkce" }).label)
      .toBe("Key in memory");
  });

  it("carries the offline reason verbatim and outranks every connected posture", () => {
    const offline = composerPosture({ ...base, online: false, inferenceConnected: true, authMethod: "api-key" });
    expect(offline.label).toBe("Offline");
    expect(offline.detail).toBe(OFFLINE_INLINE_REASON);
    expect(offline.state).toBe("attention");
  });

  it("states page memory in plain words wherever a credential is held", () => {
    expect(composerPosture(base).detail).toContain("page memory");
    expect(composerPosture({ ...base, inferenceConnected: true, authMethod: "api-key" }).detail)
      .toContain("page memory");
  });

  it("keeps every resting label short enough that the chip cannot truncate it", () => {
    for (const authMethod of [undefined, "local-none", "api-key"]) {
      expect(composerPosture({ ...base, inferenceConnected: true, authMethod }).label.length)
        .toBeLessThanOrEqual(16);
    }
  });
});

describe("composer keyhint", () => {
  it("states send at rest and queue while a turn is running", () => {
    expect(composerKeyhints(false).map((hint) => hint.action)).toEqual(["send", "newline"]);
    expect(composerKeyhints(true).map((hint) => hint.action)).toEqual(["queue", "newline"]);
  });

  it("uses the same modifier glyph in both states so only the verb moves", () => {
    expect(composerKeyhints(false)[1]).toEqual(composerKeyhints(true)[1]);
  });
});
