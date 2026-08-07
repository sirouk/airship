import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOTTOM_BAR_BLOCKERS } from "./bottom-floor";

/**
 * The bottom-right corner holds two persistent notices and one send button.
 *
 * J152 was the runtime-update banner anchored to that corner with a constant
 * offset, landing on top of the composer's send button — a `role="status"` div
 * eating the click, measured as 58 refused Playwright retries. The capability
 * dock had already met and solved this, and its own comment predicted the bug
 * in so many words: "a constant would cover the send button". The banner was
 * written anyway.
 *
 * So the rule is asserted rather than commented. Anything anchored to the
 * bottom-right offsets by a measurement, and the measurement covers every
 * element that can hold the bottom edge.
 */
const CSS = readFileSync(new URL("./platform-shell.css", import.meta.url), "utf8");
const DOCK_CSS = readFileSync(new URL("./approval-dock.css", import.meta.url), "utf8");

describe("notices anchored to the bottom edge", () => {
  it("offsets the update banner by a measurement, never by a constant", () => {
    const rules = CSS.split("\n").filter((line) => line.includes(".pwa-update") && line.includes("bottom:"));
    // Two: the base rule and the phone media query. A future third inherits
    // this assertion rather than the bug.
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) expect(rule).toContain("--pwa-update-floor");
  });

  it("offsets the deferred capability bar the same way", () => {
    const rules = DOCK_CSS.split("\n").filter((line) => line.includes("bottom:"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).toContain("--approval-deferred-floor");
  });

  it("measures every element that can hold the bottom edge", () => {
    // The composer on desktop, the navigation bar on a phone. Missing either
    // reintroduces the overlap on exactly one form factor, which is how a fix
    // ships looking complete.
    expect([...BOTTOM_BAR_BLOCKERS]).toEqual([".composer-wrap", ".mobile-nav"]);
  });

  it("keeps one implementation of the measurement, not one per notice", () => {
    // The dock's private copy is what let the banner ship without it. Both
    // read `bottom-floor.ts` now, so the next notice inherits the fix.
    const dock = readFileSync(new URL("./approval-dock.tsx", import.meta.url), "utf8");
    const shell = readFileSync(new URL("./platform-shell.tsx", import.meta.url), "utf8");
    for (const source of [dock, shell]) {
      expect(source).toContain('from "./bottom-floor"');
      expect(source).not.toContain("DEFERRED_BAR_BLOCKERS");
    }
  });

  it("locates the composer by its real element, not a name it no longer answers to", () => {
    // The phone measure this guards: a floor computed from a selector that
    // matches nothing lets the deferred approval strip rest on the nav band
    // alone, laying itself across the composer's input row at phone width.
    expect(BOTTOM_BAR_BLOCKERS).toContain(".composer-wrap");
    const sources = ["./app.tsx", "./mobile-navigation.tsx"].map((path) =>
      readFileSync(new URL(path, import.meta.url), "utf8"),
    );
    for (const selector of BOTTOM_BAR_BLOCKERS) {
      const exists = sources.some((source) => source.includes(`class="${selector.slice(1)}"`))
        || sources.some((source) => source.includes(`class="${selector.slice(1)} `));
      expect(exists, `${selector} must name an element that exists`).toBe(true);
    }
  });
});
