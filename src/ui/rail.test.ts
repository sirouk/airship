import { describe, expect, it } from "vitest";
import { RAIL_RECENT_LIMIT, RAIL_RECENTS_MAX_HEIGHT, RAIL_RECENTS_WIDTH, recentsPanelAnchor } from "./rail";

/**
 * The conversation panel's placement is the whole correctness question for the
 * disclosure that took the list out of the rail: a 320px panel that runs off
 * the screen is a list of conversations nobody can reach, and it hangs off a
 * scroll container whose block-axis overflow clips the inline axis too. So the
 * geometry is computed here rather than left to the stylesheet, and asserted
 * without a browser.
 */
describe("the recent-conversations panel anchor", () => {
  const desktop = { viewportWidth: 1_440, viewportHeight: 900 };

  it("hangs off the right edge of the trigger", () => {
    expect(recentsPanelAnchor({ trigger: { top: 120, right: 220 }, ...desktop })).toEqual({ top: 120, left: 228 });
  });

  it("clears a 60px rail by the same gutter", () => {
    expect(recentsPanelAnchor({ trigger: { top: 80, right: 52 }, ...desktop }).left).toBe(60);
  });

  it("lifts a panel that would open past the bottom of the viewport", () => {
    // A trigger near the bottom of a short window: the panel's *whole* height
    // has to fit, or the ledger row pinned to its last line is unreachable.
    const anchor = recentsPanelAnchor({ trigger: { top: 700, right: 220 }, viewportWidth: 1_440, viewportHeight: 760 });
    expect(anchor.top + Math.min(RAIL_RECENTS_MAX_HEIGHT, 760 * 0.6)).toBeLessThanOrEqual(760 - 8);
  });

  it("never places the panel off the top or the left, however small the window", () => {
    const anchor = recentsPanelAnchor({ trigger: { top: 4, right: 10 }, viewportWidth: 320, viewportHeight: 300 });
    expect(anchor.top).toBeGreaterThanOrEqual(8);
    expect(anchor.left).toBeGreaterThanOrEqual(8);
  });

  it("keeps a full-width panel inside a window narrower than the panel plus its gutters", () => {
    const viewportWidth = RAIL_RECENTS_WIDTH + 8;
    const anchor = recentsPanelAnchor({ trigger: { top: 60, right: 60 }, viewportWidth, viewportHeight: 900 });
    expect(anchor.left).toBe(8);
  });
});

describe("the shortcut's size", () => {
  it("lists the same ten conversations the rail list did", () => {
    // The ledger is `All conversations`; this is the shortcut. A larger number
    // here would rebuild the 250px scroller that was the defect.
    expect(RAIL_RECENT_LIMIT).toBe(10);
  });
});
