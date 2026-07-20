import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "./contracts";
import { buildWorkspaceTree, visibleWorkspaceTree, workspaceDirectories } from "./tree";

function entry(path: string): WorkspaceEntry {
  return { path, revision: path, updatedAt: "2026-07-19T00:00:00.000Z", size: path.length };
}

describe("workspace tree projection", () => {
  it("sorts directories before files and reveals only expanded branches", () => {
    const root = buildWorkspaceTree([
      entry("/workspace/z.txt"),
      entry("/workspace/src/z.ts"),
      entry("/workspace/src/a.ts"),
      entry("/workspace/README.md"),
    ]);
    expect(root.children.map(({ kind, name }) => [kind, name])).toEqual([
      ["directory", "src"],
      ["file", "README.md"],
      ["file", "z.txt"],
    ]);
    expect(visibleWorkspaceTree(root, new Set()).map(({ path }) => path)).toEqual([
      "/workspace/src",
      "/workspace/README.md",
      "/workspace/z.txt",
    ]);
    expect(visibleWorkspaceTree(root, new Set(["/workspace/src"])).map(({ path }) => path)).toContain("/workspace/src/a.ts");
  });

  it("collects deterministic move targets", () => {
    const root = buildWorkspaceTree([entry("/workspace/a/b/c.ts"), entry("/workspace/d/e.ts")]);
    expect(workspaceDirectories(root).map(({ path }) => path)).toEqual([
      "/workspace",
      "/workspace/a",
      "/workspace/a/b",
      "/workspace/d",
    ]);
  });
});
