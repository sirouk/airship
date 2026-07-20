import { describe, expect, it } from "vitest";
import { buildStatusTree, deltaLetter, diffLineKind } from "./sources-view";

describe("Sources presentation", () => {
  it("uses letters for all five change kinds", () => {
    expect(["added", "modified", "deleted", "renamed", "conflicted"].map((kind) => deltaLetter(kind as never))).toEqual(["A", "M", "D", "R", "C"]);
  });
  it("does not color diff headers as file additions/removals", () => {
    expect(diffLineKind("+added")).toBe("added");
    expect(diffLineKind("-removed")).toBe("removed");
    expect(diffLineKind("+++ b/file")).toBe("context");
    expect(diffLineKind("--- a/file")).toBe("context");
  });
  it("projects changed paths into a deterministic folder-first tree", () => {
    const entry = (path: string) => ({ path, index: null, worktree: { kind: "modified" as const } });
    const tree = buildStatusTree([entry("README.md"), entry("src/z.ts"), entry("src/lib/a.ts")]);
    expect(tree.map((node) => [node.kind, node.name])).toEqual([["folder", "src"], ["file", "README.md"]]);
    expect(tree[0]?.children.map((node) => [node.kind, node.name])).toEqual([["folder", "lib"], ["file", "z.ts"]]);
    expect(tree[0]?.children[0]?.children[0]?.entry?.path).toBe("src/lib/a.ts");
  });
});
