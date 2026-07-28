import { describe, expect, it } from "vitest";
import { encodeWorkspaceBytes } from "../workspace/content-codec";
import { boundedWorkspaceContent, resolveGitBinding, workspaceEditorProjection, workspaceFileWindow, workspaceGutterLines, WORKSPACE_EDITOR_BYTE_LIMIT, WORKSPACE_GUTTER_LINE_LIMIT } from "./workspace-view";

describe("bounded workspace presentation", () => {
  it("mounts a constant metadata window for a 100k-file workspace", () => {
    const first = workspaceFileWindow(100_000, 0, 432);
    const middle = workspaceFileWindow(100_000, 1_800_000, 432);
    expect(first.end - first.start).toBeLessThanOrEqual(28);
    expect(middle.end - middle.start).toBeLessThanOrEqual(28);
    expect(middle.start).toBeGreaterThan(49_000);
  });

  it("caps editor bytes without splitting into an unbounded text node", () => {
    const result = boundedWorkspaceContent("é".repeat(WORKSPACE_EDITOR_BYTE_LIMIT), WORKSPACE_EDITOR_BYTE_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.shownBytes).toBeLessThanOrEqual(WORKSPACE_EDITOR_BYTE_LIMIT);
    expect(result.totalBytes).toBe(WORKSPACE_EDITOR_BYTE_LIMIT * 2);
  });

  it("preserves full object size from a bounded range read", () => {
    expect(boundedWorkspaceContent("preview", WORKSPACE_EDITOR_BYTE_LIMIT, 9_000_000)).toMatchObject({ content: "preview", totalBytes: 9_000_000, truncated: true });
  });

  it("never exposes an opaque workspace envelope as editable text", () => {
    const envelope = encodeWorkspaceBytes(Uint8Array.from([0, 255, 1, 2]));
    const projection = workspaceEditorProjection({ path: "/workspace/image.png", content: envelope, revision: "r1", updatedAt: new Date(0).toISOString(), size: envelope.length });
    expect(projection).toMatchObject({ content: "", binary: true, truncated: true, shownBytes: 0 });
  });

  it("maps an admitted repository root to one relative Git path", () => {
    const repository = {
      id: "snapshot-repo", name: "owner/repo", defaultBranch: "main", version: "1", storage: { backend: "memory", durable: false, detail: "test" }, remotes: [], branches: [], capabilities: {} as never,
      worktrees: [{ id: "main", path: "/workspace/sources/repo", branch: "main", head: "sha256:x", version: "2", status: [] }],
    } as const;
    expect(resolveGitBinding("/workspace/sources/repo/src/index.ts", [repository])).toMatchObject({ relativePath: "src/index.ts" });
    expect(resolveGitBinding("/workspace/notes/private.md", [repository])).toBeUndefined();
  });
});

describe("editor line gutter", () => {
  it("numbers every line of an ordinary buffer", () => {
    expect(workspaceGutterLines("a\nb\nc")).toBe("1\n2\n3");
    expect(workspaceGutterLines("")).toBe("1");
    // A trailing newline opens a real, editable final line.
    expect(workspaceGutterLines("a\n")).toBe("1\n2");
  });

  it("withholds the gutter entirely past its declared line cap", () => {
    const atLimit = "x\n".repeat(WORKSPACE_GUTTER_LINE_LIMIT - 1) + "x";
    expect(workspaceGutterLines(atLimit)?.split("\n").length).toBe(WORKSPACE_GUTTER_LINE_LIMIT);
    expect(workspaceGutterLines("x\n".repeat(WORKSPACE_GUTTER_LINE_LIMIT + 5))).toBeUndefined();
  });

  it("rejects a nonsensical cap instead of rendering an unbounded gutter", () => {
    expect(() => workspaceGutterLines("a", 0)).toThrow();
    expect(() => workspaceGutterLines("a", 1.5)).toThrow();
  });
});
