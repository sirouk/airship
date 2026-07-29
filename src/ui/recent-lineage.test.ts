import { describe, expect, it } from "vitest";
import { collapseLineageBranches, lineageRootId, type LineageRow } from "./recent-lineage";

function row(id: string, minute: number, sourceSessionId?: string): LineageRow {
  return {
    id,
    updatedAt: `2026-07-18T00:${String(minute).padStart(2, "0")}:00.000Z`,
    ...(sourceSessionId ? { sourceSessionId } : {}),
  };
}

function sourceIndex(rows: readonly LineageRow[]): ReadonlyMap<string, string | undefined> {
  return new Map(rows.map((item) => [item.id, item.sourceSessionId] as const));
}

/** One source, three retries, eight unrelated conversations. */
const lineage = [row("source", 1), row("retry-a", 2, "source"), row("retry-b", 3, "source"), row("retry-c", 4, "source")];
const unrelated = Array.from({ length: 8 }, (_, index) => row(`other-${String(index)}`, 10 + index));

describe("lineage roots", () => {
  it("walks a chain of branches to the conversation it started from", () => {
    const rows = [row("a", 1), row("b", 2, "a"), row("c", 3, "b")];
    expect(lineageRootId("c", sourceIndex(rows))).toBe("a");
  });

  it("stops at a source outside the loaded page rather than merging lineages", () => {
    const rows = [row("b", 2, "gone"), row("c", 3, "vanished")];
    const index = sourceIndex(rows);
    expect(lineageRootId("b", index)).toBe("b");
    expect(lineageRootId("c", index)).toBe("c");
  });

  it("gives a cyclic manifest one root every member agrees on, instead of looping", () => {
    const index = new Map([["a", "b"], ["b", "a"]] as const);
    expect(lineageRootId("a", index)).toBe("a");
    expect(lineageRootId("b", index)).toBe("a");
  });
});

describe("the Recent group collapses a lineage to one row", () => {
  const candidates = [...lineage, ...unrelated].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const index = sourceIndex(candidates);

  it("keeps the most recently updated member and counts the rest", () => {
    const collapsed = collapseLineageBranches(candidates, index);
    const fromLineage = collapsed.filter((entry) => lineage.some((item) => item.id === entry.item.id));
    expect(fromLineage).toHaveLength(1);
    expect(fromLineage[0]!.item.id).toBe("retry-c");
    expect(fromLineage[0]!.branchCount).toBe(4);
    expect(fromLineage[0]!.hiddenBranchCount).toBe(3);
  });

  it("does not displace a single unrelated conversation from the ten-row budget", () => {
    const collapsed = collapseLineageBranches(candidates, index).slice(0, 10);
    for (const item of unrelated) {
      expect(collapsed.some((entry) => entry.item.id === item.id), item.id).toBe(true);
    }
  });

  it("preserves the recency order it was given", () => {
    const collapsed = collapseLineageBranches(candidates, index);
    const order = collapsed.map((entry) => entry.item.id);
    expect(order).toEqual(candidates.filter((item) => order.includes(item.id)).map((item) => item.id));
  });

  it("never withdraws the conversation the reader is currently in", () => {
    const collapsed = collapseLineageBranches(candidates, index, new Set(["source"]));
    const ids = collapsed.map((entry) => entry.item.id);
    expect(ids).toContain("source");
    // The pinned member *is* the lineage's row — still one row, and it is the
    // one the reader is in rather than the one that happens to be newest.
    expect(ids).not.toContain("retry-c");
    const active = collapsed.find((entry) => entry.item.id === "source")!;
    expect(active.branchCount).toBe(4);
    expect(active.hiddenBranchCount).toBe(3);
  });

  it("never withdraws a favorite the reader explicitly starred", () => {
    const ids = collapseLineageBranches(candidates, index, new Set(["retry-a", "retry-b"]))
      .map((entry) => entry.item.id);
    expect(ids).toContain("retry-a");
    expect(ids).toContain("retry-b");
    // Pinned members satisfy the group, so no extra representative is added.
    expect(ids).not.toContain("retry-c");
    expect(ids).not.toContain("source");
  });

  it("leaves a list with no branches exactly as it found it", () => {
    const collapsed = collapseLineageBranches(unrelated, sourceIndex(unrelated));
    expect(collapsed.map((entry) => entry.item.id)).toEqual(unrelated.map((item) => item.id));
    for (const entry of collapsed) {
      expect(entry.branchCount).toBe(1);
      expect(entry.hiddenBranchCount).toBe(0);
    }
  });
});
