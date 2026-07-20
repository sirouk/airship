import { afterEach, describe, expect, it } from "vitest";
import { clearPageSessionPinsForTest, groupPinnedSessions, pagePinnedSessionIds, setPageSessionPinned } from "./session-pins";

describe("page-memory session pins", () => {
  afterEach(clearPageSessionPinsForTest);
  it("survives consumers remounting without implying durable storage", () => {
    setPageSessionPinned("s2", true);
    expect([...pagePinnedSessionIds()]).toEqual(["s2"]);
    expect(groupPinnedSessions([{ id: "s1" }, { id: "s2" }], pagePinnedSessionIds())).toEqual({ pinned: [{ id: "s2" }], other: [{ id: "s1" }] });
  });
  it("unpins idempotently", () => {
    setPageSessionPinned("s1", true);
    setPageSessionPinned("s1", false);
    expect(pagePinnedSessionIds().size).toBe(0);
  });
});
