import { describe, expect, it } from "vitest";
import {
  POPOVER_EDGE_GUTTER,
  POPOVER_HOVER_INTENT_MS,
  POPOVER_SHEET_MAX_WIDTH,
  popoverPlacement,
} from "./popover";

describe("the one anchored disclosure", () => {
  it("anchors from the left while the panel clears the viewport gutter", () => {
    expect(popoverPlacement({ anchorLeft: 40, popoverWidth: 320, viewportWidth: 1440 }))
      .toEqual({ mode: "anchored", align: "start" });
  });

  it("flips to the right edge exactly when the panel would cross the gutter", () => {
    // The last chip in a right-hand cluster is the case that matters: one pixel
    // either side of the boundary has to pick a different edge, or the flip is
    // decorative rather than load bearing.
    const justInside = 1440 - POPOVER_EDGE_GUTTER - 320;
    expect(popoverPlacement({ anchorLeft: justInside, popoverWidth: 320, viewportWidth: 1440 }).align).toBe("start");
    expect(popoverPlacement({ anchorLeft: justInside + 1, popoverWidth: 320, viewportWidth: 1440 }).align).toBe("end");
  });

  it("becomes a bottom sheet at and below the phone breakpoint, whatever the anchor", () => {
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 300, popoverWidth: 320, viewportWidth: 430 }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH + 1 }).mode).toBe("anchored");
  });

  it("returns a frozen placement so a caller cannot mutate the shared result", () => {
    const placement = popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: 1440 });
    expect(Object.isFrozen(placement)).toBe(true);
  });

  it("keeps hover intent short enough to feel like a hover and long enough not to fire in transit", () => {
    expect(POPOVER_HOVER_INTENT_MS).toBeGreaterThanOrEqual(120);
    expect(POPOVER_HOVER_INTENT_MS).toBeLessThanOrEqual(200);
  });
});
