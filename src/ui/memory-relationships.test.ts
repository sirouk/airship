import { describe, expect, it } from "vitest";
import type { MemoryGraphEdge } from "../memory-graph";
import { groupMemoryRelationships } from "./memory-relationships";

const edge = (id: string, kind: MemoryGraphEdge["kind"]): MemoryGraphEdge => ({ id, kind, source: "a", target: id, directed: true, weight: 1, label: kind, metadata: {} });

describe("memory relationship groups", () => {
  it("groups the bounded visible prefix while retaining kind totals", () => {
    const groups = groupMemoryRelationships([edge("1", "mentions"), edge("2", "uses-skill"), edge("3", "mentions")], 2);
    expect(groups.map((group) => group.label)).toEqual(["Skills used", "Ideas mentioned"]);
    expect(groups.find((group) => group.kind === "mentions")).toEqual(expect.objectContaining({ total: 2, edges: [expect.objectContaining({ id: "1" })] }));
  });
});
