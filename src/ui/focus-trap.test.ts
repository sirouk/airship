import { describe, expect, it } from "vitest";
import { FOCUSABLE_LIMIT, FOCUSABLE_SELECTOR, focusStopIncluded, focusTrapTarget } from "./focus-trap";

describe("FOCUSABLE_SELECTOR", () => {
  // This asserts only that the selector string still lists these element
  // types. Whether the browser then hands them back in document order is the
  // DOM's contract, not this module's, and is not proven here.
  it("still lists the element types the approval dialog contains", () => {
    // The approval panel's arguments disclosure is a <summary> that sits above
    // the Deny/Allow footer; omitting it would make it unreachable by Tab.
    expect(FOCUSABLE_SELECTOR).toContain("summary");
    expect(FOCUSABLE_SELECTOR).toContain("textarea:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
  });

  it("bounds the walk so a runaway dialog cannot be scanned without end", () => {
    expect(Number.isSafeInteger(FOCUSABLE_LIMIT)).toBe(true);
    expect(FOCUSABLE_LIMIT).toBeGreaterThan(0);
  });
});

describe("focusStopIncluded", () => {
  const plain = {
    hidden: false,
    ariaHidden: false,
    insideCollapsedDetails: false,
    ownSummaryOfCollapsedDetails: false,
  };

  it("accepts an ordinary visible control", () => {
    expect(focusStopIncluded(plain)).toBe(true);
  });

  it("rejects a control the author hid from sight or from assistive tech", () => {
    expect(focusStopIncluded({ ...plain, hidden: true })).toBe(false);
    expect(focusStopIncluded({ ...plain, ariaHidden: true })).toBe(false);
  });

  // The approval dialog's arguments live in a <details>. While it is shut the
  // buttons inside it are not rendered, so wrapping onto one would move focus
  // to a control the user cannot see.
  it("rejects a control buried in a collapsed disclosure", () => {
    expect(focusStopIncluded({ ...plain, insideCollapsedDetails: true })).toBe(false);
  });

  it("keeps the collapsed disclosure's own summary reachable", () => {
    expect(focusStopIncluded({
      ...plain,
      insideCollapsedDetails: true,
      ownSummaryOfCollapsedDetails: true,
    })).toBe(true);
  });

  it("still rejects a hidden summary of a collapsed disclosure", () => {
    expect(focusStopIncluded({
      ...plain,
      hidden: true,
      insideCollapsedDetails: true,
      ownSummaryOfCollapsedDetails: true,
    })).toBe(false);
  });
});

describe("focusTrapTarget", () => {
  const dialog = { focusableCount: 3, insideContainer: true };

  it("lets the browser move focus in the interior of the ring", () => {
    expect(focusTrapTarget({ ...dialog, activeIndex: 1, shiftKey: false })).toBeUndefined();
    expect(focusTrapTarget({ ...dialog, activeIndex: 1, shiftKey: true })).toBeUndefined();
    expect(focusTrapTarget({ ...dialog, activeIndex: 2, shiftKey: true })).toBeUndefined();
    expect(focusTrapTarget({ ...dialog, activeIndex: 0, shiftKey: false })).toBeUndefined();
  });

  it("wraps forward off the last stop and backward off the first", () => {
    expect(focusTrapTarget({ ...dialog, activeIndex: 2, shiftKey: false })).toBe("first");
    expect(focusTrapTarget({ ...dialog, activeIndex: 0, shiftKey: true })).toBe("last");
  });

  it("wraps backward from the container itself, which holds focus on open", () => {
    expect(focusTrapTarget({ ...dialog, activeIndex: -1, shiftKey: true })).toBe("last");
    expect(focusTrapTarget({ ...dialog, activeIndex: -1, shiftKey: false })).toBeUndefined();
  });

  it("re-enters the dialog when focus has already escaped it", () => {
    expect(focusTrapTarget({ focusableCount: 3, activeIndex: -1, insideContainer: false, shiftKey: false })).toBe("first");
    expect(focusTrapTarget({ focusableCount: 3, activeIndex: -1, insideContainer: false, shiftKey: true })).toBe("last");
  });

  it("parks focus on the container when the dialog has no focusable stop", () => {
    expect(focusTrapTarget({ focusableCount: 0, activeIndex: -1, insideContainer: true, shiftKey: false })).toBe("container");
    expect(focusTrapTarget({ focusableCount: 0, activeIndex: -1, insideContainer: false, shiftKey: true })).toBe("container");
  });

  it("never releases focus from a single-stop dialog", () => {
    expect(focusTrapTarget({ focusableCount: 1, activeIndex: 0, insideContainer: true, shiftKey: false })).toBe("first");
    expect(focusTrapTarget({ focusableCount: 1, activeIndex: 0, insideContainer: true, shiftKey: true })).toBe("last");
  });
});
