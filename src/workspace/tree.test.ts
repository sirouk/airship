import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "./contracts";
import { buildWorkspaceTree, visibleWorkspaceTree, workspaceDirectories, workspaceFilesUnder, workspaceFolderRenamePlan } from "./tree";

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

describe("folder operations, which are really file operations", () => {
  const files = [
    entry("/workspace/notes/a.md"),
    entry("/workspace/notes/deep/b.md"),
    entry("/workspace/notes-archive/c.md"),
    entry("/workspace/other.md"),
  ];

  it("takes only files genuinely inside the folder, not prefix neighbours", () => {
    // `/workspace/notes-archive` starts with `/workspace/notes`, so a naive
    // prefix test would delete a sibling folder along with the one asked for.
    expect(workspaceFilesUnder(files, "/workspace/notes").map(({ path }) => path)).toEqual([
      "/workspace/notes/a.md",
      "/workspace/notes/deep/b.md",
    ]);
  });

  it("expands a rename into one move per file, nested paths preserved", () => {
    expect(workspaceFolderRenamePlan(files, "/workspace/notes", "journal")).toEqual([
      { source: "/workspace/notes/a.md", target: "/workspace/journal/a.md" },
      { source: "/workspace/notes/deep/b.md", target: "/workspace/journal/deep/b.md" },
    ]);
  });

  it("refuses names the workspace cannot address, and the root itself", () => {
    expect(() => workspaceFolderRenamePlan(files, "/workspace", "anything")).toThrow(/root/u);
    expect(() => workspaceFolderRenamePlan(files, "/workspace/notes", "a/b")).toThrow(/one path segment/u);
    expect(() => workspaceFolderRenamePlan(files, "/workspace/notes", "")).toThrow(/one path segment/u);
  });
});
