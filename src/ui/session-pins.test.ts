import { describe, expect, it } from "vitest";
import { favoriteDirectionalMove, favoriteDropMove, groupPinnedSessions } from "./session-pins";

describe("authoritative session favorites", () => {
  it("groups the supplied journal-backed favorite set without global state", () => {
    expect(groupPinnedSessions([{ id: "s1" }, { id: "s2" }], new Set(["s2"])))
      .toEqual({ pinned: [{ id: "s2" }], other: [{ id: "s1" }] });
  });

  it("renders favorites in their authoritative order without disturbing recents", () => {
    expect(groupPinnedSessions(
      [{ id: "recent-1" }, { id: "favorite-1" }, { id: "favorite-2" }, { id: "recent-2" }],
      ["favorite-2", "favorite-1"],
    )).toEqual({
      pinned: [{ id: "favorite-2" }, { id: "favorite-1" }],
      other: [{ id: "recent-1" }, { id: "recent-2" }],
    });
  });

  it("maps pointer and keyboard moves to stable before-anchors", () => {
    const order = ["a", "b", "c"];
    expect(favoriteDirectionalMove(order, "b", -1)).toEqual({ changed: true, beforeSessionId: "a" });
    expect(favoriteDirectionalMove(order, "b", 1)).toEqual({ changed: true });
    expect(favoriteDirectionalMove(order, "a", -1)).toEqual({ changed: false });
    expect(favoriteDropMove(order, "a", "b")).toEqual({ changed: true, beforeSessionId: "c" });
    expect(favoriteDropMove(order, "c", "a")).toEqual({ changed: true, beforeSessionId: "a" });
  });
});
