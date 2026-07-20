import { describe, expect, it } from "vitest";
import { lastRealCardEntryScrollTop, lastRealCardScrollTop, preferredJumpBehavior } from "./transcript-anchor";

describe("last real transcript card anchoring", () => {
  it("targets measured card bottom independent of virtual scroll height", () => {
    expect(lastRealCardScrollTop(1_000, 700, 760)).toBe(1_060);
    expect(lastRealCardScrollTop(20, 700, 400)).toBe(0);
  });

  it("jumps instantly while streaming or under reduced motion", () => {
    expect(preferredJumpBehavior(false, false)).toBe("smooth");
    expect(preferredJumpBehavior(false, true)).toBe("auto");
    expect(preferredJumpBehavior(true, false)).toBe("auto");
  });

  it("aligns an oversized entry card to its beginning instead of clipping it", () => {
    expect(lastRealCardEntryScrollTop(600, 100, 500, 180, 780)).toBe(680);
    expect(lastRealCardEntryScrollTop(600, 100, 500, 180, 420)).toBe(520);
  });
});
