import { describe, expect, it } from "vitest";
import { encodeWorkspaceBytes } from "../workspace/content-codec";
import { MemoryWorkspace } from "../workspace/memory";
import {
  ProfileScopedWorkspacePageStore,
  WorkbenchProfileSelectionFence,
  assertMutableWorkspacePath,
  boundedWorkspaceContent,
  readWorkspaceTabState,
  resolveWorkspaceSourceSelection,
  resolveGitBinding,
  resolveWorkspacePathFromGit,
  workspaceEditorProjection,
  workspaceFileWindow,
  workspaceGutterLines,
  workspaceHistoryPatch,
  workspacePersistedWorktreeId,
  workbenchDiffRevealPaths,
  workspaceRevealAncestors,
  workspaceTabStorageKey,
  writeWorkspaceTabState,
  WORKSPACE_EDITOR_BYTE_LIMIT,
  WORKSPACE_GUTTER_LINE_LIMIT,
  type WorkspaceTabState,
} from "./workspace-view";

describe("profile-scoped workbench view state", () => {
  it("restores A after B without sharing tabs, preview, rail, or wrapping", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const alpha: WorkspaceTabState = {
      tabs: ["/workspace/alpha.md", "/workspace/shared.md"],
      activeId: "/workspace/shared.md",
      previewId: "/workspace/shared.md",
      rail: 31,
      wrap: false,
      repositoryId: "repository-alpha",
      worktreeId: "worktree-alpha",
    };
    const beta: WorkspaceTabState = {
      tabs: ["/workspace/beta.md"],
      activeId: "/workspace/beta.md",
      previewId: "/workspace/beta.md",
      rail: 47,
      wrap: true,
      repositoryId: "repository-beta",
      worktreeId: "worktree-beta",
    };

    writeWorkspaceTabState(storage, "shared-workspace", "profile-alpha", alpha);
    writeWorkspaceTabState(storage, "shared-workspace", "profile-beta", beta);

    expect(workspaceTabStorageKey("shared-workspace", "profile-alpha"))
      .not.toBe(workspaceTabStorageKey("shared-workspace", "profile-beta"));
    expect(readWorkspaceTabState(storage, "shared-workspace", "profile-beta", 1_200)).toEqual(beta);
    expect(readWorkspaceTabState(storage, "shared-workspace", "profile-alpha", 1_200)).toEqual(alpha);
  });

  it("keeps unsaved buffers isolated for A/B/A on the same authoritative WorkspacePort", () => {
    const workspace = new MemoryWorkspace();
    const drafts = new ProfileScopedWorkspacePageStore<Readonly<Record<string, string>>>();
    drafts.write(workspace, "shared-workspace", "profile-alpha", {
      "/workspace/shared.md": "alpha unsaved draft",
    });
    drafts.write(workspace, "shared-workspace", "profile-beta", {
      "/workspace/shared.md": "beta unsaved draft",
    });

    expect(drafts.read(workspace, "shared-workspace", "profile-beta")).toEqual({
      "/workspace/shared.md": "beta unsaved draft",
    });
    expect(drafts.read(workspace, "shared-workspace", "profile-alpha")).toEqual({
      "/workspace/shared.md": "alpha unsaved draft",
    });
    expect(drafts.read(new MemoryWorkspace(), "shared-workspace", "profile-alpha")).toBeUndefined();
  });

  it("does not reinterpret the prior profile's selected-file object as a new tab", () => {
    const fence = new WorkbenchProfileSelectionFence();
    const alphaSelection = {
      path: "/workspace/shared.md",
      content: "durable content",
      revision: "revision-1",
      updatedAt: "2026-07-28T00:00:00.000Z",
      size: 15,
    };
    const betaSelection = { ...alphaSelection };
    const alphaReselection = { ...alphaSelection };

    expect(fence.resolve("profile-alpha", alphaSelection)).toBe(alphaSelection);
    expect(fence.resolve("profile-beta", alphaSelection)).toBeUndefined();
    expect(fence.resolve("profile-beta", betaSelection)).toBe(betaSelection);
    expect(fence.resolve("profile-alpha", betaSelection)).toBeUndefined();
    expect(fence.resolve("profile-alpha", alphaReselection)).toBe(alphaReselection);
  });

  it("revalidates saved repository and worktree ids against the live inventory", () => {
    const repositories = [
      { id: "repository-main", worktrees: [{ id: "main" }, { id: "feature" }] },
      { id: "repository-tools", worktrees: [{ id: "tools-main" }] },
    ] as const;

    expect(resolveWorkspaceSourceSelection(repositories, "repository-main", "feature"))
      .toEqual({ repository: repositories[0], worktree: repositories[0].worktrees[1] });
    expect(resolveWorkspaceSourceSelection(repositories, "deleted-repository", "deleted-worktree", "repository-tools"))
      .toEqual({ repository: repositories[1], worktree: repositories[1].worktrees[0] });
  });

  it("does not erase a restored worktree candidate before async inventory validation", () => {
    expect(workspacePersistedWorktreeId("restored-worktree", undefined, false)).toBe("restored-worktree");
    expect(workspacePersistedWorktreeId("restored-worktree", "validated-worktree", true)).toBe("validated-worktree");
    expect(workspacePersistedWorktreeId("deleted-worktree", undefined, true)).toBeUndefined();
  });
});

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

  it("resolves reveal paths through the diff's exact repository and worktree", () => {
    const repositories = [{
      id: "snapshot-repo", name: "owner/repo", defaultBranch: "main", version: "1", storage: { backend: "memory", durable: false, detail: "test" }, remotes: [], branches: [], capabilities: {} as never,
      worktrees: [{ id: "main", path: "/workspace/sources/repo", branch: "main", head: "sha256:x", version: "2", status: [] }],
    }] as const;

    expect(resolveWorkspacePathFromGit(repositories, "snapshot-repo", "main", "src/index.ts"))
      .toEqual({ state: "resolved", path: "/workspace/sources/repo/src/index.ts" });
    expect(resolveWorkspacePathFromGit(repositories, "other-repo", "main", "src/index.ts"))
      .toMatchObject({ state: "unavailable", reason: expect.stringContaining("repository") });
    expect(resolveWorkspacePathFromGit(repositories, "snapshot-repo", "other-tree", "src/index.ts"))
      .toMatchObject({ state: "unavailable", reason: expect.stringContaining("worktree") });
    expect(resolveWorkspacePathFromGit(repositories, "snapshot-repo", "main", "../private.md"))
      .toMatchObject({ state: "unavailable", reason: expect.stringContaining("inside") });
    expect(resolveWorkspacePathFromGit(repositories, "snapshot-repo", "main", "/workspace/private.md"))
      .toMatchObject({ state: "unavailable", reason: expect.stringContaining("inside") });
  });

  it("lists every Explorer ancestor needed to reveal an exact path", () => {
    expect(workspaceRevealAncestors("/workspace/sources/repo/src/index.ts"))
      .toEqual(["/workspace", "/workspace/sources", "/workspace/sources/repo", "/workspace/sources/repo/src"]);
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

describe("history diff documents", () => {
  it("renders only bounded git.show truth, including omitted-path disclosure", () => {
    const patch = workspaceHistoryPatch({
      commit: {
        oid: "0123456789abcdef",
        parents: ["parent"],
        message: "Keep the real patch\n",
        author: { name: "Local User", email: "local@example.invalid" },
        committedAt: "2026-07-28T12:00:00.000Z",
      },
      files: [
        { path: "README.md", kind: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n", binary: false, truncated: false },
        { path: "asset.bin", kind: "added", patch: "", binary: true, truncated: false },
      ],
      truncated: true,
    });

    expect(patch).toContain("commit 0123456789abcdef");
    expect(patch).toContain("Keep the real patch");
    expect(patch).toContain("@@ -1 +1 @@");
    expect(patch).toContain("added asset.bin (binary)");
    expect(patch).toContain("Additional changed paths were omitted");
  });

  it("offers one status path directly and de-duplicates a commit path menu", () => {
    expect(workbenchDiffRevealPaths({
      kind: "diff",
      source: "status",
      repositoryId: "repo",
      worktreeId: "main",
      worktreeVersion: "v1",
      path: "src/index.ts",
      scope: "worktree",
    })).toEqual(["src/index.ts"]);
    expect(workbenchDiffRevealPaths({
      kind: "diff",
      source: "history",
      repositoryId: "repo",
      worktreeId: "main",
      revision: "0123456789abcdef",
    }, [{ path: "README.md" }, { path: "src/index.ts" }, { path: "README.md" }]))
      .toEqual(["README.md", "src/index.ts"]);
  });
});

describe("control-plane write fence", () => {
  /*
   * Explorer already filters `.airship` and `.git` out of the tree, and that is
   * exactly why this needs its own test: a filtered view proves nothing about a
   * write. Every mutation in the workbench — save, create file, create folder,
   * rename, move, delete, and the folder plans that expand into N of those —
   * funnels through `writeWorkspaceAndGit`, `removeWorkspaceAndGit` or
   * `moveOne`, and all three now call this before touching storage or Git.
   *
   * The concrete report: a create dialog accepts a slash-delimited name, so
   * `.airship/evidence-acquisition/profiles/general/queue.v1.json` was writable.
   * The file then vanished from the tree while evidence recovery read it back as
   * malformed private state.
   */
  const reserved = [
    "/workspace/.airship",
    "/workspace/.airship/evidence-acquisition/profiles/general/queue.v1.json",
    "/workspace/.airship/endpoint-evidence/general/receipt.json",
    "/workspace/.airship/browser-git-repositories.v1.json",
    "/workspace/.git/config",
    "/workspace/sources/demo/.git/HEAD",
  ];

  for (const path of reserved) {
    it(`refuses ${path}`, () => {
      expect(() => assertMutableWorkspacePath(path))
        .toThrow(/private control plane/u);
    });
  }

  it("accepts ordinary user paths, including a repository's own nested .airship", () => {
    // The reserved namespace is the *root* `.airship` tree. A cloned repository
    // that happens to carry its own `.airship` directory is user content, and
    // refusing to edit it would break the repository rather than protect Airship.
    for (const path of [
      "/workspace/README.md",
      "/workspace/src/index.ts",
      "/workspace/sources/demo/.airship/tasks.json",
      "/workspace/airship-notes/.airshiprc",
    ]) {
      expect(assertMutableWorkspacePath(path)).toBe(path);
    }
  });

  it("normalizes before deciding, so a relative name cannot slip past the prefix test", () => {
    expect(() => assertMutableWorkspacePath(".airship/evidence-acquisition/queue.v1.json"))
      .toThrow(/private control plane/u);
    expect(assertMutableWorkspacePath("notes/todo.md")).toBe("/workspace/notes/todo.md");
  });
});
