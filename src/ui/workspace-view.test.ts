import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatBytes } from "../core/bytes";
import type { GitDeltaKind, GitStatusEntry } from "../git/types";
import { encodeWorkspaceBytes } from "../workspace/content-codec";
import type { WorkspaceEntry, WorkspaceFile } from "../workspace/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import { retainWorkbenchDocuments } from "./workbench-model";
import {
  ProfileScopedWorkspacePageStore,
  WorkbenchProfileSelectionFence,
  assertMutableWorkspacePath,
  boundedWorkspaceContent,
  readWorkspaceTabState,
  resolveWorkspaceSourceSelection,
  resolveGitBinding,
  resolveWorkspacePathFromGit,
  runSourceMutation,
  workspaceDownloadPayload,
  workspaceRowMenuKey,
  workspaceEditorProjection,
  workspaceFileWindow,
  explorerRows,
  explorerSearchNodes,
  workspaceSearchFolder,
  workspaceFilterEmptyCopy,
  workspaceGutterLines,
  workspaceHistoryPatch,
  workspacePersistedWorktreeId,
  workbenchBranchDivergence,
  workbenchDivergenceSentence,
  workbenchUpstreamRef,
  workbenchDiffRevealPaths,
  workbenchDirtyDraftsUnderFolder,
  workbenchExternalRevisionBuffer,
  workbenchExternalRevisionPaths,
  workbenchHistoryCount,
  workbenchMenuFocusIndex,
  workbenchMoveTargetFocusIndex,
  workbenchSourceLanes,
  workbenchVanishedFilePaths,
  workbenchVisibleStagePaths,
  workbenchSourceTruncationNote,
  workbenchStatusDiffHint,
  workbenchSupersededStatusDiff,
  workspaceRevealAncestors,
  workspaceTabStorageKey,
  writeWorkspaceTabState,
  SCM_LANE_LIMIT,
  WORKBENCH_DIVERGENCE_DEPTH,
  WORKBENCH_HISTORY_DEPTH,
  WORKSPACE_FILE_ROW_HEIGHT,
  WORKSPACE_EDITOR_BYTE_LIMIT,
  WORKSPACE_GUTTER_LINE_LIMIT,
  type WorkspaceTabState,
} from "./workspace-view";

describe("profile-scoped workbench view state", () => {
  it("defaults wrapping on and restores an explicit toggle across reads", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readWorkspaceTabState(storage, "shared-workspace", "profile-alpha", 1_440).wrap).toBe(true);
    writeWorkspaceTabState(storage, "shared-workspace", "profile-alpha", {
      tabs: [], activeId: "", rail: 31, wrap: false,
    });
    expect(readWorkspaceTabState(storage, "shared-workspace", "profile-alpha", 390).wrap).toBe(false);
  });

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
    // 30, not 28: the rail's default pitch fell from 34px to 28px, so the same
    // 432px of viewport now holds 16 rows plus the 7-row overscan on each side.
    // What the claim is about is that the number is a constant of the viewport
    // and never of the workspace — the ceiling moves with the row height, the
    // 100,000 files do not move it.
    const first = workspaceFileWindow(100_000, 0, 432);
    const middle = workspaceFileWindow(100_000, 1_800_000, 432);
    expect(first.end - first.start).toBeLessThanOrEqual(30);
    expect(middle.end - middle.start).toBeLessThanOrEqual(30);
    expect(middle.start).toBeGreaterThan(49_000);
  });

  it("numbers a scrolled window by its place in the whole tree, not in the window", () => {
    // What virtualization deleted and `aria-posinset`/`aria-setsize` restate:
    // the row rendered first in a window 3,880 rows down is row 3,881 of
    // 40,000, and without these it announced as "1 of 24".
    const total = 40_000;
    const window_ = workspaceFileWindow(total, 3_880 * WORKSPACE_FILE_ROW_HEIGHT, 432);
    const positions = Array.from({ length: window_.end - window_.start }, (_value, offset) => window_.start + offset + 1);

    expect(positions[0]).toBe(window_.start + 1);
    expect(positions[0]).toBeGreaterThan(3_800);
    expect(positions.at(-1)).toBeLessThanOrEqual(total);
    // Scrolling moves the positions and never the declared size.
    expect(workspaceFileWindow(total, 0, 432).start + 1).toBe(1);
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

  it("never prints the storage envelope as a file's size", () => {
    // The Explorer row, the editor strip, and the empty-state suggestions all
    // rendered `entry.size` — the base64 envelope for a binary — so an image
    // read a third larger here than `read_file` reported for the same path.
    // These call sites cannot be exercised without a DOM, so hold them at the
    // source: every rendered byte count goes through the decoded length.
    const source = readFileSync("src/ui/workspace-view.tsx", "utf8");
    const arguments_ = [...source.matchAll(/formatBytes\(([^)]*)\)/gu)].map((match) => match[1] ?? "");
    expect(arguments_.filter((argument) => /\.size\b/u.test(argument))).toEqual([]);
    expect(arguments_.filter((argument) => argument.includes("workspaceEntryByteLength")).length).toBeGreaterThanOrEqual(3);
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

describe("status diff supersession", () => {
  /*
   * A status diff is a patch of one exact worktree version. Staging a path
   * moves that version, so the pinned tab is now a snapshot of a state the
   * repository has left — and reopening the same path produced a second tab the
   * strip drew identically to the first. Version was part of identity and no
   * part of presentation.
   */
  const document = {
    kind: "diff",
    source: "status",
    repositoryId: "repo",
    worktreeId: "main",
    worktreeVersion: "0123456789abcdef",
    path: "/workspace/README.md",
    scope: "worktree",
  } as const;

  it("qualifies a stale tab with its snapshot and leaves a live one alone", () => {
    expect(workbenchSupersededStatusDiff(document.worktreeVersion, "0123456789abcdef")).toBe(false);
    expect(workbenchSupersededStatusDiff(document.worktreeVersion, "fedcba9876543210")).toBe(true);
    expect(workbenchStatusDiffHint("worktree", document.worktreeVersion, "0123456789abcdef")).toBe("Working diff");
    expect(workbenchStatusDiffHint("staged", document.worktreeVersion, "0123456789abcdef")).toBe("Staged diff");

    const stale = workbenchStatusDiffHint("worktree", document.worktreeVersion, "fedcba9876543210");
    expect(stale).toContain("snapshot 01234567");
    expect(stale).not.toBe(workbenchStatusDiffHint("worktree", "fedcba9876543210", "fedcba9876543210"));
  });

  it("never calls a tab stale on an unresolved worktree", () => {
    // Source Control has not answered yet. An unknown version is not evidence
    // that the open patch is out of date.
    expect(workbenchSupersededStatusDiff(document.worktreeVersion, undefined)).toBe(false);
    expect(workbenchStatusDiffHint("worktree", document.worktreeVersion, undefined)).toBe("Working diff");
  });
});

describe("bounded source control lanes", () => {
  const entries = (count: number, lane: "index" | "worktree") => Array.from({ length: count }, (_, index) => ({
    path: `/workspace/file-${String(index)}.ts`,
    ...(lane === "index" ? { index: { kind: "modified" } } : { worktree: { kind: "modified" } }),
  }));

  it("does not claim a truncation when neither lane was cut", () => {
    // The shipped predicate was `status.length > 250`, so 200 staged plus 100
    // unstaged paths — 300 entries, nothing clipped — printed the banner.
    const lanes = workbenchSourceLanes([...entries(200, "index"), ...entries(100, "worktree")]);
    expect(lanes.staged).toHaveLength(200);
    expect(lanes.unstaged).toHaveLength(100);
    expect(lanes.clipped).toEqual([]);
    expect(workbenchSourceTruncationNote(lanes)).toBeUndefined();
  });

  it("names the lane it actually clipped, and its real total", () => {
    const staged = workbenchSourceLanes(entries(SCM_LANE_LIMIT + 10, "index"));
    expect(staged.staged).toHaveLength(SCM_LANE_LIMIT);
    expect(staged.clipped).toEqual(["staged"]);
    expect(workbenchSourceTruncationNote(staged)).toContain(`Staged (${String(SCM_LANE_LIMIT + 10)} paths)`);

    const unstaged = workbenchSourceLanes(entries(SCM_LANE_LIMIT + 10, "worktree"));
    expect(unstaged.clipped).toEqual(["unstaged"]);
    const note = workbenchSourceTruncationNote(unstaged);
    expect(note).toContain(`Changes (${String(SCM_LANE_LIMIT + 10)} paths)`);
    expect(note).not.toContain("Staged");
    expect(note).toContain(String(SCM_LANE_LIMIT));
  });
});

describe("bounded commit history", () => {
  it("prints a saturated fixed-depth read as a bound, not as a total", () => {
    expect(workbenchHistoryCount(7)).toBe("7");
    expect(workbenchHistoryCount(0)).toBe("0");
    expect(workbenchHistoryCount(WORKBENCH_HISTORY_DEPTH)).toBe(`${String(WORKBENCH_HISTORY_DEPTH)}+`);
  });
});

describe("branch divergence from two bounded logs", () => {
  it("counts each side's exclusive commits once the windows overlap", () => {
    const divergence = workbenchBranchDivergence(["e", "d", "c", "b", "a"], ["z", "y", "c", "b", "a"]);
    expect(divergence).toEqual({ ahead: 2, behind: 2, bounded: false });
  });

  it("does not call an already-merged history divergent", () => {
    /*
     * The cheap implementation is "index of the first shared oid", and a
     * branch that merged its upstream shares its tip with nothing while
     * sharing everything below — so that version would have reported this
     * fast-forwarded branch as 1 ahead of a remote it is exactly level with.
     */
    expect(workbenchBranchDivergence(["c", "b", "a"], ["c", "b", "a"])).toEqual({ ahead: 0, behind: 0, bounded: false });
    expect(workbenchBranchDivergence(["m", "c", "b", "a"], ["c", "b", "a"])).toEqual({ ahead: 1, behind: 0, bounded: false });
  });

  it("says when the windows never reached common ground", () => {
    // Two full reads that share nothing are not evidence of 20 and 20. They
    // are evidence that 20 was not deep enough, and the row prints `20+`.
    const local = Array.from({ length: WORKBENCH_DIVERGENCE_DEPTH }, (_, index) => `local-${String(index)}`);
    const remote = Array.from({ length: WORKBENCH_DIVERGENCE_DEPTH }, (_, index) => `remote-${String(index)}`);
    const divergence = workbenchBranchDivergence(local, remote);
    expect(divergence.bounded).toBe(true);
    expect(divergence.ahead).toBe(WORKBENCH_DIVERGENCE_DEPTH);
    expect(divergence.behind).toBe(WORKBENCH_DIVERGENCE_DEPTH);
  });

  it("treats an empty pair as settled rather than as an unmeasured fork", () => {
    expect(workbenchBranchDivergence([], [])).toEqual({ ahead: 0, behind: 0, bounded: false });
  });

  it("claims an upstream only where a remote-tracking ref could exist", () => {
    const origin = { name: "origin", url: "https://example.invalid/a.git", transport: "direct-git-http" } as const;
    const mirror = { name: "mirror", url: "https://example.invalid/b.git", transport: "direct-git-http" } as const;
    expect(workbenchUpstreamRef([], "main")).toBeUndefined();
    expect(workbenchUpstreamRef([origin], "")).toBeUndefined();
    // Two remotes and no configured upstream is a guess, not a fact.
    expect(workbenchUpstreamRef([mirror, { ...origin, name: "backup" }], "main")).toBeUndefined();
    expect(workbenchUpstreamRef([mirror], "main")).toEqual({ ref: "refs/remotes/mirror/main", label: "mirror/main" });
    expect(workbenchUpstreamRef([mirror, origin], "main")).toEqual({ ref: "refs/remotes/origin/main", label: "origin/main" });
  });

  it("gives the arrow pair a sentence that survives being read alone", () => {
    const sentence = (ahead: number, behind: number, bounded = false) =>
      workbenchDivergenceSentence({ ahead, behind, bounded }, "origin/main");
    expect(sentence(0, 0)).toBe("Up to date with origin/main");
    expect(sentence(1, 0)).toBe("1 commit to push to origin/main");
    expect(sentence(0, 3)).toBe("3 commits to pull from origin/main");
    expect(sentence(2, 1)).toBe("2 commits to push, 1 to pull, against origin/main");
    // The bound reaches the listener too, or the arrows lie only to them.
    expect(sentence(20, 20, true)).toContain("at least");
  });
});

describe("row menu keyboard movement", () => {
  it("cycles with the arrows, jumps with Home/End, and owns no other key", () => {
    expect(workbenchMenuFocusIndex(4, 0, "ArrowDown")).toBe(1);
    expect(workbenchMenuFocusIndex(4, 3, "ArrowDown")).toBe(0);
    expect(workbenchMenuFocusIndex(4, 0, "ArrowUp")).toBe(3);
    expect(workbenchMenuFocusIndex(4, 2, "Home")).toBe(0);
    expect(workbenchMenuFocusIndex(4, 2, "End")).toBe(3);
    // Focus that is not on an item yet enters from the pressed end.
    expect(workbenchMenuFocusIndex(4, -1, "ArrowDown")).toBe(0);
    expect(workbenchMenuFocusIndex(4, -1, "ArrowUp")).toBe(3);
    // Everything else is left alone: a menu that swallowed Tab or Enter would
    // be the keyboard trap this pattern exists to prevent.
    expect(workbenchMenuFocusIndex(4, 0, "Tab")).toBeUndefined();
    expect(workbenchMenuFocusIndex(4, 0, "Enter")).toBeUndefined();
    expect(workbenchMenuFocusIndex(0, -1, "ArrowDown")).toBeUndefined();
  });

  it("opens the row menu from a Mac keyboard, and does not steal plain Enter", () => {
    const press = (key: string, modifiers: Partial<Readonly<{ shiftKey: boolean; ctrlKey: boolean }>> = {}) =>
      workspaceRowMenuKey({ key, shiftKey: false, ctrlKey: false, ...modifiers });

    expect(press("ContextMenu")).toBe(true);
    expect(press("F10", { shiftKey: true })).toBe(true);
    // The regression this guards: with only the two conventions above, Rename,
    // Move, Delete and Download were unreachable from an Apple keyboard, which
    // has no ContextMenu key and answers F10 with a system media action.
    expect(press("Enter", { ctrlKey: true })).toBe(true);

    // Everything the row already owns keeps its meaning: Enter previews,
    // Shift+Enter keeps the file open, bare F10 belongs to the platform.
    expect(press("Enter")).toBe(false);
    expect(press("Enter", { shiftKey: true })).toBe(false);
    expect(press("F10")).toBe(false);
    expect(press(" ")).toBe(false);
    expect(press("ArrowDown")).toBe(false);
  });
});

describe("composed commit message", () => {
  /*
   * The box is the user's only copy of that message. Clearing it on the click
   * loses it whenever the adapter refuses; never clearing it hands the next
   * "Commit staged" a message describing the previous commit. So the clear is
   * a consequence of the adapter returning, and nothing else.
   */
  function recordingGit(commit: () => Promise<unknown>) {
    const calls: string[] = [];
    return {
      calls,
      stage: async (request: { paths: readonly string[] }) => { calls.push(`stage ${request.paths.join(",")}`); },
      unstage: async (request: { paths: readonly string[] }) => { calls.push(`unstage ${request.paths.join(",")}`); },
      commit: async (request: { message: string }) => { calls.push(`commit ${request.message}`); return commit(); },
      restore: async (request: { paths: readonly string[]; source: string }) => { calls.push(`restore ${request.paths.join(",")} from ${request.source}`); },
    };
  }

  const commitRequest = {
    repositoryId: "repo",
    worktreeId: "main",
    message: "Land the workbench",
    author: { name: "A", email: "a@example.com" },
    expectedWorktreeVersion: "2",
  } as const;

  it("consumes the message only after the adapter accepts the commit", async () => {
    const git = recordingGit(() => Promise.resolve({ ok: true }));
    await expect(runSourceMutation(git, { kind: "commit", request: commitRequest })).resolves.toBe(true);
    expect(git.calls).toEqual(["commit Land the workbench"]);
  });

  it("leaves the typed message intact when the commit is refused", async () => {
    const git = recordingGit(() => Promise.reject(new Error("Worktree version moved.")));
    // The throw propagates, so the caller never reaches its `setCommitMessage("")`
    // and the transaction reports the refusal instead of a silent success.
    await expect(runSourceMutation(git, { kind: "commit", request: commitRequest }))
      .rejects.toThrow("Worktree version moved.");
  });

  it("never consumes the message for a staging verb", async () => {
    const git = recordingGit(() => Promise.resolve(undefined));
    const request = { repositoryId: "repo", worktreeId: "main", paths: ["docs/a.md"], expectedWorktreeVersion: "2" } as const;
    await expect(runSourceMutation(git, { kind: "stage", request })).resolves.toBe(false);
    await expect(runSourceMutation(git, { kind: "unstage", request })).resolves.toBe(false);
    expect(git.calls).toEqual(["stage docs/a.md", "unstage docs/a.md"]);
  });

  it("dispatches the discard verb the Workspace surface had no control for", async () => {
    // Measured before this: a scan of every button, summary and menu item in
    // Explorer, the Editor, Source Control and the file `•••` menu for
    // /discard|revert|restore|undo|reset|checkout|clean/ returned [] — while
    // `git restore README.md` submitted in Terminal and answered by Airship
    // Browser Git returned "Discarded changes in 1 path."
    const git = recordingGit(() => Promise.resolve(undefined));
    const request = { repositoryId: "repo", worktreeId: "main", paths: ["docs/a.md"], source: "head", expectedWorktreeVersion: "2" } as const;
    await expect(runSourceMutation(git, { kind: "restore", request })).resolves.toBe(false);
    expect(git.calls).toEqual(["restore docs/a.md from head"]);
  });
});

describe("Explorer file download", () => {
  it("carries the whole stored object, never the editor's bounded preview", async () => {
    const workspace = new MemoryWorkspace();
    const content = "x".repeat(WORKSPACE_EDITOR_BYTE_LIMIT + 4_096);
    await workspace.write("/workspace/docs/report.csv", content);

    const payload = await workspaceDownloadPayload(workspace, "/workspace/docs/report.csv");
    expect(payload.bytes.byteLength).toBe(content.length);
    expect(payload.filename).toBe("report.csv");
    // The buffer the editor is holding for the same file comes from the bounded
    // read, and it is a preview. A download served from that buffer would ship
    // a truncated file under the real file's name — the one failure this path
    // may never have.
    const bounded = (await workspace.readBounded("/workspace/docs/report.csv", WORKSPACE_EDITOR_BYTE_LIMIT))!;
    expect(workspaceEditorProjection(bounded).truncated).toBe(true);
    expect(payload.bytes.byteLength).toBeGreaterThan(new TextEncoder().encode(bounded.content).byteLength);
    expect(payload.revision).toBe(bounded.revision);
  });

  it("hands opaque bytes over exactly, envelope removed", async () => {
    const workspace = new MemoryWorkspace();
    const bytes = Uint8Array.from([0, 255, 13, 10, 127, 1]);
    await workspace.write("/workspace/img/logo.png", encodeWorkspaceBytes(bytes));

    const payload = await workspaceDownloadPayload(workspace, "/workspace/img/logo.png");
    expect([...payload.bytes]).toEqual([...bytes]);
    // `anchor.download` is a filename, not a path: the basename is all that
    // survives, so a nested path cannot steer where the browser writes.
    expect(payload.filename).toBe("logo.png");
  });

  it("refuses a file that has gone, with the reason rather than an empty download", async () => {
    const workspace = new MemoryWorkspace();
    await expect(workspaceDownloadPayload(workspace, "/workspace/docs/ghost.md"))
      .rejects.toThrow(/no longer present/u);
  });

  it("offers Download for a file and never for a folder", () => {
    // The item's own guard cannot be exercised without a DOM, so it is held at
    // the source: folder archiving does not exist, and a "Download" on a folder
    // would promise a build that was explicitly not made.
    const source = readFileSync("src/ui/workspace-view.tsx", "utf8");
    const item = source.split("\n").find((line) => line.includes(">Download<"));
    expect(item).toBeDefined();
    expect(item).toContain("contextIsFile ?");
    // Nor may any workbench string claim the repository export the Git adapter
    // still refuses.
    expect(source).not.toMatch(/Export repository|Download repository|Export checkpoint/u);
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

describe("external deletion of an open document", () => {
  const buffersFor = (entries: ReadonlyArray<readonly [string, string, string]>) =>
    Object.fromEntries(entries.map(([path, content, draft]) => [path, Object.freeze({
      path,
      content,
      draft,
      revision: `revision:${content}`,
      size: content.length,
      updatedAt: "2026-07-29T00:00:00.000Z",
      truncated: false,
      binary: false,
    })] as const));

  it("drops the buffer with the tab, so no invisible dirty draft keeps beforeunload armed", () => {
    const tabs = ["/workspace/gone.md", "/workspace/stay.md"];
    const files: readonly WorkspaceEntry[] = [{ path: "/workspace/stay.md", revision: "revision-1", updatedAt: "2026-07-29T00:00:00.000Z", size: 4 }];
    const buffers = buffersFor([
      ["/workspace/gone.md", "durable", "unsaved work the user typed"],
      ["/workspace/stay.md", "clean", "clean"],
    ]);

    const vanished = workbenchVanishedFilePaths(tabs, new Set(files.map((entry) => entry.path)));
    expect(vanished).toEqual(["/workspace/gone.md"]);

    // The refresh effect's two halves, applied to this fixture: the strip loses
    // the tab through retainWorkbenchDocuments and the buffer map loses the draft.
    const documents = retainWorkbenchDocuments(
      { tabs, activeId: "/workspace/gone.md" },
      new Set(tabs.filter((tab) => !vanished.includes(tab))),
    );
    const remaining = Object.fromEntries(Object.entries(buffers).filter(([path]) => !vanished.includes(path)));

    expect(documents.tabs).toEqual(["/workspace/stay.md"]);
    expect(Object.keys(remaining)).toEqual(["/workspace/stay.md"]);
    // The orphan dirty draft was the defect: it survived with no tab, kept the
    // beforeunload guard armed, and resurrected as a stale draft if the path was
    // ever recreated. After the purge nothing reports dirty at all.
    expect(Object.values(remaining).some((candidate) => candidate.draft !== candidate.content)).toBe(false);
  });

  it("never treats diff documents or still-listed files as vanished", () => {
    const diffId = `airship-diff:${encodeURIComponent(JSON.stringify({ kind: "diff", source: "history", repositoryId: "repo", worktreeId: "wt", revision: "deadbeef" }))}`;
    const filePaths = new Set(["/workspace/kept.md"]);
    expect(workbenchVanishedFilePaths([diffId, "/workspace/kept.md"], filePaths)).toEqual([]);
  });

  /*
   * The purge above is correct about the fixture and was still wrong in place,
   * because it was reached from an effect that also depended on `activeId`.
   * A move publishes its remapped tab strip and the draft it carried across
   * synchronously and only then awaits the refresh, so the `activeId` rerun
   * ran this eviction against the *pre-move* listing, called the path it had
   * just created externally deleted, and threw the unsaved draft away —
   * "Unsaved edits moved with the tab" printed over a reverted buffer.
   *
   * Existence is a fact about the listing, so the effect that decides it may
   * depend on the listing and nothing else. Asserted on the source because the
   * defect is entirely in the dependency array: every pure helper it calls
   * passes its own tests either way.
   */
  it("decides existence only when the listing changes, never on an active-tab rerun", () => {
    const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");
    const eviction = source.slice(source.indexOf("Evict what the tree no longer lists"));
    const body = eviction.slice(0, eviction.indexOf("}, ["));
    const deps = eviction.slice(eviction.indexOf("}, ["), eviction.indexOf("}, [") + 40);

    // The eviction really is the block being pinned: both purges live in it.
    expect(body).toContain("workbenchVanishedFilePaths(");
    expect(body).toContain("retainWorkbenchDocuments(");
    expect(deps).toContain("}, [files]);");
    expect(deps).not.toContain("activeId");
  });
});

describe("external writes under an open document", () => {
  const bufferFor = (path: string, content: string, draft: string, revision = "revision-1") => Object.freeze({
    path,
    content,
    draft,
    revision,
    size: content.length,
    updatedAt: "2026-07-29T00:00:00.000Z",
    truncated: false,
    binary: false,
  });
  const entryFor = (path: string, revision: string): WorkspaceEntry => Object.freeze({
    path,
    revision,
    updatedAt: "2026-07-29T01:00:00.000Z",
    size: 3,
  });
  const externalWrite: WorkspaceFile = Object.freeze({
    path: "/workspace/notes.md",
    content: "written by an agent turn",
    revision: "revision-2",
    updatedAt: "2026-07-29T01:00:00.000Z",
    size: 24,
  });

  it("follows an external write into a clean buffer, content and revision together", () => {
    const buffers = { "/workspace/notes.md": bufferFor("/workspace/notes.md", "old bytes", "old bytes") };
    const files = [entryFor("/workspace/notes.md", "revision-2")];
    expect(workbenchExternalRevisionPaths(buffers, files)).toEqual(["/workspace/notes.md"]);

    const adopted = workbenchExternalRevisionBuffer(buffers["/workspace/notes.md"], "revision-1", externalWrite);
    expect(adopted).toMatchObject({
      path: "/workspace/notes.md",
      revision: "revision-2",
      content: "written by an agent turn",
      draft: "written by an agent turn",
      truncated: false,
      binary: false,
    });
    // Clean and current after adoption, so the same refresh cannot loop.
    expect(workbenchExternalRevisionPaths({ "/workspace/notes.md": adopted! }, files)).toEqual([]);
  });

  it("leaves a dirty buffer alone — the compare-and-swapped save is the fence", () => {
    const dirty = bufferFor("/workspace/notes.md", "old bytes", "the user's unsaved paragraph");
    const files = [entryFor("/workspace/notes.md", "revision-2")];
    // Never queued for reconciliation in the first place.
    expect(workbenchExternalRevisionPaths({ "/workspace/notes.md": dirty }, files)).toEqual([]);
    // And the adoption guard declines even if it is reached anyway.
    expect(workbenchExternalRevisionBuffer(dirty, "revision-1", externalWrite)).toBeUndefined();
    // A save that landed during the re-read moved the revision itself.
    const saved = bufferFor("/workspace/notes.md", "saved meanwhile", "saved meanwhile", "revision-3");
    expect(workbenchExternalRevisionBuffer(saved, "revision-1", externalWrite)).toBeUndefined();
  });
});

describe("folder delete draft disclosure", () => {
  it("counts exactly the unsaved drafts of documents under the folder", () => {
    const buffers = {
      "/workspace/docs/a.md": { draft: "typed", content: "stored" },
      "/workspace/docs/nested/b.md": { draft: "typed", content: "stored" },
      "/workspace/docs/clean.md": { draft: "same", content: "same" },
      "/workspace/other/c.md": { draft: "typed", content: "stored" },
      // Sibling of the prefix, not a child: `/workspace/docs` must not swallow `/workspace/docsx`.
      "/workspace/docsx/sibling.md": { draft: "typed", content: "stored" },
    };
    expect(workbenchDirtyDraftsUnderFolder(buffers, "/workspace/docs")).toBe(2);
    expect(workbenchDirtyDraftsUnderFolder(buffers, "/workspace/other")).toBe(1);
  });
});

describe("merge conflicts and the workbench stage fence", () => {
  const entry = (path: string, index: GitDeltaKind | null, worktree: GitDeltaKind | null): GitStatusEntry => Object.freeze({
    path,
    index: index ? { kind: index } : null,
    worktree: worktree ? { kind: worktree } : null,
  });

  it("excludes conflicted paths from Stage all visible, on either delta side — as the advanced controls do", () => {
    const entries = [
      entry("/workspace/modified.ts", null, "modified"),
      entry("/workspace/conflicted.ts", null, "conflicted"),
      entry("/workspace/staged-conflict.ts", "conflicted", "modified"),
    ];
    expect(workbenchVisibleStagePaths(entries)).toEqual(["/workspace/modified.ts"]);
  });

  it("gates the per-row stage button on the same predicate the Advanced controls use", () => {
    // One predicate or the two surfaces drift: the rail was replicating the
    // delta check and the checkbox panel's `isConflicted` — this test pins the
    // shared import so the fence cannot be silently weakened on one side.
    const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");
    // `UnifiedPatch` now arrives on the same import, for the same reason: the
    // workbench diff pane used to render its own patch instead of the one
    // Source Control renders. `deltaLetter` joined them when the rail started
    // drawing status letters: it was spelling A/D/R/M/C out of an inline
    // ternary chain while `sources-view` held the vocabulary.
    expect(source).toContain('import { deltaLetter, isConflicted, UnifiedPatch } from "./sources-view";');
    expect(source).toContain("isConflicted(entry)");
    expect(source).toContain("Merge conflict — resolve it in Advanced source controls before staging.");
  });
});

/*
 * The Move dialog's `.move-targets` listbox rendered one native Tab stop per
 * folder inside a focus trap — Tab walked the whole folder tree before the
 * Cancel button, and the arrow keys the `listbox` role promises did nothing.
 * The contract: a single roving stop that the selection owns (falling past
 * the pre-selected, disabled current folder), arrow/Home/End handled by the
 * shared menu-movement helper, focus following selection, and Escape/Tab left
 * to the dialog.
 */
describe("move dialog listbox keyboard contract", () => {
  it("puts the one Tab stop on the selection, or the first choosable folder past a disabled one", () => {
    const candidates = [{ disabled: true }, { disabled: false }, { disabled: false }];
    // The file's current folder is pre-selected and disabled: the stop must
    // not sit on a button that cannot be tabbed to at all.
    expect(workbenchMoveTargetFocusIndex(candidates, 0)).toBe(1);
    expect(workbenchMoveTargetFocusIndex(candidates, 2)).toBe(2);
    expect(workbenchMoveTargetFocusIndex(candidates, -1)).toBe(1);
  });

  it("wires the listbox for roving tabindex with arrow keys that move selection and focus", () => {
    const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");
    // The listbox carries the handler the option buttons rely on…
    expect(source).toContain('role="listbox" aria-label="Destination folder" onKeyDown={handleMoveTargetKey}');
    // …each option roves instead of being its own Tab stop…
    expect(source).toContain("tabIndex={index === moveTargetFocus ? 0 : -1}");
    // …and the handler walks the folders with the shared menu-movement helper
    // — arrows, Home and End, skipping the disabled current folder — then both
    // selects and focuses the landing folder, because selection follows focus.
    const handler = source.match(/function handleMoveTargetKey[\s\S]*?\n  \}/u);
    expect(handler?.[0]).toContain("moveMenuSelection(current, event.key");
    expect(handler?.[0]).toContain("setDialogValue(directory.path)");
    expect(handler?.[0]).toContain("items[next]?.focus()");
    // Escape and Tab still belong to the dialog: the handler owns arrows only.
    expect(handler?.[0]).not.toContain('"Escape"');
    expect(handler?.[0]).not.toContain('"Tab"');
  });
});

/*
 * Filtering to zero matches rendered a blank `role="tree"`: the only signal was
 * the 12px "0 of 412 files" counter, and on a phone — where the Explorer is a
 * full-screen pane — a mistyped filter was a blank screen with no way back
 * except deleting text the reader could not see was the cause.
 */
describe("Explorer empty-after-filter state", () => {
  it("names the term it failed to match and the workspace it searched", () => {
    const copy = workspaceFilterEmptyCopy("  reciept  ", 412);
    expect(copy.title).toContain("reciept");
    expect(copy.detail).toContain("412 files");
    expect(copy.action).toBe("Clear filter");
  });

  it("counts one file without claiming plural", () => {
    expect(workspaceFilterEmptyCopy("x", 1).detail).toContain("1 file is in this workspace");
  });

  /*
   * One search, so one empty sentence. The two it replaces — "No path matches"
   * and "No file contains" — each existed to send the reader to the other mode,
   * and the modes are gone. What may not go with them is the bound: a scan that
   * stopped early must say so in the same breath as "nothing matched", or the
   * reader concludes the workspace does not contain the term when the truth is
   * that the scan never reached the file that does.
   */
  it("accounts for both halves of the one search, and for the bound the scan hit", () => {
    const copy = workspaceFilterEmptyCopy("x", 3, {
      matches: [],
      scannedFiles: 2,
      skippedFiles: 1,
      truncated: true,
      unsearchedFiles: 7,
      candidateFiles: 10,
      filteredOutFiles: 0,
    });
    expect(copy.title).toBe("Nothing matches “x”");
    expect(copy.detail).toContain("3 files are in this workspace, and no path contains it");
    expect(copy.detail).toContain("2 of them were read for text");
    // Verbatim from the sentence the model's own `search_text` is given.
    expect(copy.detail).toContain("7 files not reached");
    expect(copy.detail).toContain("bounded scan");
  });

  it("renders the block with its clear action instead of an empty tree", () => {
    const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");
    // The tree keeps its element — the ResizeObserver measures it — and yields
    // the rail to a named block whenever it has no row to draw.
    expect(source).toContain("hidden={treeHidden}");
    expect(source).toContain("workspaceFilterEmptyCopy(filter, filtered.total, search)");
    expect(source).toContain("onClick={clearFilter}");
    // Escape and the button are the same two acts, so neither can drift.
    const clear = source.match(/function clearFilter\(\): void \{[\s\S]*?\n  \}/u);
    expect(clear?.[0]).toContain("setFilter(\"\")");
    expect(clear?.[0]).toContain("pendingTreeFocus.current = true");
  });
});

/*
 * `search_text` — "Search bounded UTF-8 workspace content for a literal string"
 * — had no button, menu item or field anywhere on the route that owns files.
 * The one search-shaped box was a path filter, so the capability was reachable
 * only by typing `/search-text` into the composer. It then arrived as a *mode*,
 * which is the state the owner met: a filled segmented control asking the
 * reader to decide whether the thing they are looking for is a filename or a
 * line of text before they have found it.
 */
describe("Explorer search: one field, both questions", () => {
  const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");

  it("keeps one field and no mode switch anywhere near it", () => {
    expect([...source.matchAll(/class="workspace-filter"/gu)]).toHaveLength(1);
    expect(source).toContain('aria-label="Search workspace files by path and contents"');
    // The segmented control, its group label and the state behind it are gone
    // rather than hidden — a mode nobody can see is still a mode.
    expect(source).not.toContain("git-view-toggle");
    expect(source).not.toContain("filterMode");
  });

  it("runs the path matcher and the bounded scan against the same query", () => {
    expect(source).toContain("workbenchFilterMatches(files, filter)");
    expect(source).toContain("searchWorkspaceContent(workspace, files, query");
    // The debounce is what makes running both on every keystroke affordable:
    // the path half is synchronous, the 8 MiB half waits to see if the reader
    // has finished the word.
    const scan = source.match(/const timer = setTimeout\([\s\S]*?WORKSPACE_SEARCH_DEBOUNCE_MS\);/u);
    expect(scan?.[0]).toContain("searchWorkspaceContent");
  });

  it("draws one tree out of both answers rather than swapping the tree for a list", () => {
    // Union in inventory order, so the tree does not reshuffle under the reader.
    expect(source).toContain("byPath.has(entry.path) || hitsByPath.has(entry.path)");
    expect(source).toContain("explorerRows(visible, hitsByPath)");
    // And the rail says which of the two matched: hits are child rows under
    // their file, and the file states how many it holds beside its size.
    expect(source).toContain('{row.hits ? `${String(row.hits)} in text · ` : ""}');
  });

  it("never lets a path match stand in front of a bounded scan", () => {
    // The scan's own sentence — truncated, unsearched, capReachedIn — reaches
    // the reader in the same line as the file count.
    expect(source).toContain("workspaceSearchSummary(search)");
    expect(source).toContain('scanning ? "reading contents…"');
  });

  it("settles the rail when the scan comes back as a rejection", () => {
    /*
     * Shipped: `search` was written only in `.then`, and the rail's whole
     * settled/scanning decision was `search !== undefined`. So a scan that threw
     * — an object whose key rotated, a transient IndexedDB failure — left
     * `scanning` true for as long as the query stayed in the field: the count
     * line said "reading contents…" and the tree stayed hidden behind
     * "Searching file contents…" with nothing reading. The error notice at the
     * bottom of the route was the only sign anything had happened.
     */
    const failure = source.match(/\.catch\(\(cause: unknown\) => \{[\s\S]*?\}\)/u)?.[0] ?? "";
    expect(failure).toContain("setScanFailed(true)");
    // And the previous query's result goes with it: the count line prints that
    // result verbatim, so a stale one describes a term the reader has left.
    expect(failure).toContain("setSearch(undefined)");
    expect(source).toContain("const scanSettled = Boolean(query) && !searching && (search !== undefined || scanFailed);");
    // Reset per query, in both places a query begins — the emptied field and
    // the new term — or one failure would poison every later search.
    expect([...source.matchAll(/setScanFailed\(false\)/gu)]).toHaveLength(2);
    // A settled failure has no summary to print, and must not claim to be reading.
    expect(source).toContain('"file contents could not be read"');
  });
});

/*
 * The rail's verbs and the workbench's transaction are one thing.
 *
 * `mutateSource` drops every request while `busy`, without a notice and without
 * a throw, so a Source Control control that stays pressable through a save or a
 * forty-file folder rename is a control that lies: it depresses, nothing
 * stages, and the only feedback on screen is a progress notice about an
 * unrelated operation. `Save` in the same component has always been gated on
 * exactly this state.
 */
describe("Source Control during a workbench transaction", () => {
  const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");

  it("hands the transaction state to the rail that shares it", () => {
    const rail = source.match(/<SourceControlRail[\s\S]*?\/>/u)?.[0] ?? "";
    expect(rail).toContain("busy={busy}");
    // Forwarded to both lanes, because staging and unstaging are the same
    // transaction from opposite sides.
    expect([...source.matchAll(/<ScmGroup[\s\S]*?\/>/gu)].filter((group) => group[0].includes("busy={busy}"))).toHaveLength(2);
  });

  it("disables every verb that a busy workbench would silently drop", () => {
    const group = source.slice(source.indexOf("function ScmGroup("));
    // The per-row stage/unstage toggle, the group's bulk verb, and the row's
    // discard — the three controls that reach `mutate` from a row.
    expect(group).toContain('aria-label={`${lane === "staged" ? "Unstage" : "Stage"} ${entry.path}`} disabled={busy}');
    expect(group).toContain('class="scm-group__bulk" type="button" aria-label={bulk.label} title={bulk.label} disabled={busy}');
    expect(group).toContain("disabled={busy || !repository || !worktree || conflicted}");
    // Commit is the fourth, and the discard confirmation is the one that has
    // already been armed — it must not commit a decision the workbench drops.
    expect(source).toContain("disabled={busy || !commitMessage.trim()}");
    expect(source).toContain("confirmDisabled={busy}");
  });
});

/*
 * The row model the one search needs: a text hit is a place inside a file, so
 * it is a row of the same tree one level deeper — not a second list in a second
 * mode. `id` is the field that makes it work, because a hit and its file share
 * a path and every keyboard lookup in the tree is a lookup by row identity.
 */
describe("Explorer rows", () => {
  const node = (path: string, kind: "directory" | "file", depth: number) =>
    Object.freeze({ kind, name: path.slice(path.lastIndexOf("/") + 1), path, depth, children: [] });
  const hit = (path: string, line: number, column: number, snippet: string) =>
    Object.freeze({ path, line, column, snippet });

  it("nests each hit under the file that holds it, one level deeper", () => {
    const rows = explorerRows(
      [node("/workspace/docs", "directory", 1), node("/workspace/docs/a.ts", "file", 2)],
      new Map([["/workspace/docs/a.ts", [hit("/workspace/docs/a.ts", 4, 2, "const a = 1")]]]),
    );
    expect(rows.map((row) => row.id)).toEqual([
      "/workspace/docs",
      "/workspace/docs/a.ts",
      "/workspace/docs/a.ts#4:2",
    ]);
    expect(rows[1]?.hits).toBe(1);
    expect(rows[2]?.depth).toBe(3);
    // A hit acts on its file: opening, revealing and the row menu all need the
    // path, and none of them needs a second code path for the deeper row.
    expect(rows[2]?.path).toBe("/workspace/docs/a.ts");
    expect(rows[2]?.node).toBeUndefined();
  });

  it("gives two hits on the same line different identities", () => {
    const rows = explorerRows(
      [node("/workspace/a.ts", "file", 1)],
      new Map([["/workspace/a.ts", [hit("/workspace/a.ts", 4, 2, "x"), hit("/workspace/a.ts", 4, 9, "x")]]]),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows[0]?.hits).toBe(2);
  });

  /*
   * A search answers with files, not with the folders that happen to hold them.
   * Measured in the browser before this pass: searching `src` in a 13-file
   * workspace drew 7 rows, of which `src` and `lib` were folder rows the reader
   * cannot act on and did not ask for. A six-match search across six folders
   * cost six of them. VS Code flattens to file → matches, and so does this.
   */
  it("draws one row per matched file, and no folder rows at all", () => {
    const entry = (path: string) => ({ path, revision: "r1", updatedAt: "2026-08-04T00:00:00.000Z", size: 0 });
    const nodes = explorerSearchNodes([
      entry("/workspace/src/app.ts"),
      entry("/workspace/src/lib/util.js"),
      entry("/workspace/README.md"),
    ]);
    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => node.kind === "file")).toBe(true);
    // Depth 1 for every row: the indent a tree spends on ancestry is what a
    // result list has no ancestry to spend it on.
    expect(new Set(nodes.map((node) => node.depth))).toEqual(new Set([1]));
    expect(nodes.map((node) => node.name)).toEqual(["app.ts", "util.js", "README.md"]);
    // Each row still carries its own entry, so the byte size, the file icon and
    // every row action read exactly what a tree row reads.
    expect(nodes[1]?.entry?.path).toBe("/workspace/src/lib/util.js");
  });

  it("states the folder a result came from, and nothing for the root", () => {
    expect(workspaceSearchFolder("/workspace/src/lib/util.js")).toBe("src/lib");
    expect(workspaceSearchFolder("/workspace/src/app.ts")).toBe("src");
    // A bare `/` beside every top-level filename is noise standing in for
    // "no folder"; VS Code prints nothing there either.
    expect(workspaceSearchFolder("/workspace/README.md")).toBe("");
  });

  it("leaves a tree with no hits exactly as the tree", () => {
    const nodes = [node("/workspace/docs", "directory", 1), node("/workspace/docs/a.ts", "file", 2)];
    const rows = explorerRows(nodes, new Map());
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.node !== undefined)).toBe(true);
    expect(rows.every((row) => row.hits === undefined)).toBe(true);
  });
});

/*
 * What stands between the search field and the first file.
 *
 * Measured at 1440x900, 13 files, default density: 56px before this pass — a
 * file count on one line and two full-word bordered buttons on another — and
 * 4px after, which is the heading row's own bottom padding. VS Code has none.
 * The owner had already called this exact pattern "horrible UI/UX" when it was
 * Refresh/Advanced in Source Control; that panel deleted it and the Explorer
 * kept it.
 *
 * These assertions are on the chrome's *shape*, not on any string it renders,
 * so they can still fail if the row grows a third line or the verbs come back
 * as words.
 */
describe("Explorer chrome above the tree", () => {
  const styles = readFileSync(new URL("./workspace-view.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");

  it("puts both creation verbs on the search field's own row", () => {
    // The same three-column grid Source Control's bar uses, because it is the
    // same problem: a field that takes the width and controls that take a glyph.
    const heading = styles.match(/\.workbench-section-heading \{([^}]+)\}/u)?.[1] ?? "";
    expect(heading).toContain("grid-template-columns: minmax(0, 1fr) auto auto;");
    // No second row survives to hold them.
    expect(styles).not.toContain(".workspace-actions");
    expect(source).not.toContain("workspace-actions");
  });

  it("names the glyph controls without printing the name", () => {
    const row = source.match(/<div class="workbench-section-heading">[\s\S]*?<\/div>/u)?.[0] ?? "";
    expect(row).toContain('aria-label="New file"');
    expect(row).toContain('aria-label="New folder"');
    // A word inside the button is what made them chrome. `CreationGlyph` is
    // the whole of each button's content.
    expect([...row.matchAll(/<button class="workspace-new"[\s\S]*?<\/button>/gu)].map((match) => match[0]))
      .toHaveLength(2);
    for (const button of row.matchAll(/<button class="workspace-new"[\s\S]*?<\/button>/gu)) {
      expect(button[0]).toMatch(/>\s*<CreationGlyph name="(?:file|workspace)" \/>\s*<\/button>$/u);
    }
    // The path that survived: a folder-scoped create has always lived in the
    // row menu, and both entries are still there.
    expect(source).toContain(">New file…</button>");
    expect(source).toContain(">New folder…</button>");
  });

  it("keeps the finger floor on both axes now that the verbs are square", () => {
    const coarse = coarseBlock(styles);
    expect(coarse).toContain(".workspace-new");
    // `min-width` outranks the resting `width`, so one declaration lifts both.
    expect(coarse).toMatch(/\.workspace-new \{ min-width: 44px; \}/u);
    expect(coarse).toMatch(/\.workspace-new,[\s\S]{0,400}?min-height: 44px;/u);
  });

  it("says nothing at rest, without the live region ceasing to exist", () => {
    // A `role="status"` that appears already carrying its text is a live region
    // most screen readers never announce, so the element outlives the query and
    // `:empty` is what stops it costing a line.
    expect(source).toMatch(/<p class="workspace-filter-count" role="status">\s*\{query\s*\?/u);
    expect(styles).toContain(".workspace-filter-count:empty { display: none; }");
  });

  it("gives the editor strip's widest control a glyph and keeps its name", () => {
    // "Reveal in Explorer" was three words in a status bar. Both call sites —
    // the file strip and the diff strip — are the icon now, and the accessible
    // name is unchanged, which is what keeps the keyboard path and the e2e
    // that drives it by name working.
    expect(source).not.toContain(">Reveal in Explorer</button>");
    expect([...source.matchAll(/aria-label="Reveal in Explorer"/gu)]).toHaveLength(2);
  });
});

/*
 * The file strip is chrome about the sheet, and chrome the sheet can paint
 * through costs the reader both things at once: the file state is unreadable
 * and so is the line of the file that covered it.
 *
 * Nothing about the failure shows in a diff. The strip has an opaque
 * background and reads correctly in its own rule; what breaks it is a
 * paint-order fact held between two rules ninety lines apart, where the
 * positioned code layers outrank an unpositioned sibling that comes after them
 * in the document. Seen at 320x568 with the editor pane open: the wrapped
 * continuation of line 1 of `notes/retrieval.md` painted in code ink at
 * y=337–341, on the strip's own background, across the "Saved" chip and the
 * file path, with no scroll position that clears it.
 */
describe("the file strip and the sheet it describes", () => {
  const styles = readFileSync(new URL("./workspace-view.css", import.meta.url), "utf8");
  const rule = (selector: string) => styles.match(new RegExp(`\\n${selector} \\{([^}]+)\\}`, "u"))?.[1] ?? "";

  it("puts the strip in a layer above the code surface it describes", () => {
    const strip = rule("\\.editor-strip");
    expect(strip).toContain("position: relative;");
    expect(strip).toContain("z-index: 2;");
  });

  it("keeps the code layers the strip has to outrank below it", () => {
    // The assertion above only means anything while these are the numbers it
    // beats: the textarea paints at 1, the highlight twin behind it at 0. If a
    // later change raises either, the strip stops winning and says nothing.
    expect(rule("\\.code-editor")).toContain("z-index: 1;");
    expect(styles).toMatch(/:is\(\.code-highlight, \.code-wrap-measure\) \{[^}]*z-index: 0;/u);
  });
});

/*
 * Two labels, one rail, and only one of them can be shortened.
 *
 * `flex: 1 1 0` splits the strip into halves, which spends width on the label
 * that already fits: measured at 1024, "Explorer" left 12px of its cell unused
 * while "Source Control 0" was cut to five characters in the cell beside it.
 * `max-width: max-content` is what lets the flex algorithm freeze the short
 * cell at its own content width and give the rest to its neighbour, and it has
 * to sit with `min-width: 0` — the declaration that allows any of this to
 * ellipsise rather than overflow the rail.
 */
describe("the workbench's two-way activity switch", () => {
  const styles = readFileSync(new URL("./workspace-view.css", import.meta.url), "utf8");

  it("caps a cell at the label it holds instead of at half the rail", () => {
    const tab = styles.match(/\n\.tabs\.workbench-mode-tabs \.tabs__tab \{([^}]+)\}/u)?.[1] ?? "";
    expect(tab).toContain("flex: 1 1 0;");
    expect(tab).toContain("min-width: 0;");
    expect(tab).toContain("max-width: max-content;");
  });
});

describe("one byte vocabulary", () => {
  it("formats workspace sizes through the shared module, not a local copy", () => {
    const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");
    expect(source).toContain('import { formatBytes } from "../core/bytes";');
    expect(source).not.toMatch(/function formatBytes/u);
    // The Explorer's own copy stopped at MiB, so a 2 GB file read
    // "1907.3 MiB" here while #vault printed "1.9 GiB" for the same bytes.
    expect(formatBytes(2_000_000_000)).toContain("GiB");
    expect(formatBytes(12_000_000)).toBe("11 MiB");
  });
});

/*
 * A reload destroyed committed Git history and the route that lost it said
 * nothing, while Chat and Memory have had a sentence for exactly this event for
 * as long as they have had page-memory state. Measured: commit "docs: persist
 * marker", confirm it in History, reload — History is back to a freshly-seeded
 * "Initial browser workspace" under a new hash, README.md is 845 B again, and a
 * scan for any line containing "did not survive" returned nothing.
 */
describe("work that did not survive the reload", () => {
  const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");

  it("witnesses a commit when the adapter accepts it, and a save at the one write chokepoint", () => {
    expect(source).toContain('if (operation.kind === "commit") witness({ commit: commitSubject(operation.request.message) });');
    expect(source).toContain("witness({ savedPath: written.path });");
  });

  it("records only what page memory can actually lose, and stops the moment a Vault is adopted", () => {
    expect(source).toContain('const ephemeral = durability?.state === "ephemeral";');
    expect(source).toContain("if (ephemeral) recordWorkspaceWork(browserSessionStorage(), witnessScope, work);");
    expect(source).toContain("if (!ephemeral) clearWorkspaceWitness(browserSessionStorage(), witnessScope);");
  });

  it("states the loss in a row of the workbench, not in the expiring toast", () => {
    // A sentence about destroyed history is the first thing to read on arrival
    // and belongs above the panes, not in the notice slot that expires.
    expect(source).toContain('<div class="notice workbench-lost-work" data-state="attention" role="alert">');
    expect(source).not.toContain('class="notice workbench-lost-work workbench-notice"');
    const styles = readFileSync(new URL("./workspace-view.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.workbench-lost-work\.notice \{[^}]*flex: 0 0 auto;/u);
    expect(styles).not.toMatch(/\.workbench-lost-work\.notice \{[^}]*position: absolute/u);
  });

  it("keeps the completion notice out of the strip whose verdict it repeats", () => {
    // Measured overlap before this rule: 3,632px² over `.editor-strip` at
    // 1440×900 and 21,279px² at 390×844 — the toast covered the "Saved" chip,
    // the revision hash and the Save/Wrap/Reveal controls it was announcing.
    const styles = readFileSync(new URL("./workspace-view.css", import.meta.url), "utf8");
    const notice = styles.match(/\.workbench-notice\.notice \{([^}]+)\}/u)?.[1] ?? "";
    expect(notice).toContain("flex: 0 0 auto;");
    expect(notice).not.toContain("position: absolute");
    expect(notice).not.toContain("pointer-events: none");
  });

  it("feeds the advanced dialog's second commit surface into the same witness", () => {
    // "Commit locally" writes the same repository the rail's "Commit staged"
    // writes; a commit made there and dropped by a reload has to be named too.
    const advanced = readFileSync(new URL("./sources-view.tsx", import.meta.url), "utf8");
    expect(advanced).toContain("recordWorkspaceWork(browserSessionStorage(), witnessScope, { commit:");
    const host = readFileSync(new URL("./editor-view.tsx", import.meta.url), "utf8");
    expect(host).toContain("witnessScope={sourceToolsAuthority}");
    expect(host).toContain("durability={props.durability}");
  });
});

/*
 * The rail's own density, and the two places it is written down.
 *
 * The workbench opted out of the systemic density block entirely: 34px rows in
 * CSS that measured a 42px pitch at the shipped default, a 30px field, a 36px
 * heading. The row height in particular is written twice on purpose — CSS draws
 * the box, JS sizes the virtualization window — and the failure mode when they
 * disagree is silent: the window scrolls at one pitch while the rows are drawn
 * at another, and rows go missing at the bottom of a long tree.
 */
describe("Explorer density", () => {
  const styles = readFileSync(new URL("./workspace-view.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("./workspace-view.tsx", import.meta.url), "utf8");
  const treeRow = (selector: string) => styles.match(new RegExp(`${selector} \\{ --tree-row: ([^;]+);`, "u"))?.[1];

  it("draws the row at the height the virtualization window measures", () => {
    expect(treeRow("\\.workspace-workbench")).toBe(`${String(WORKSPACE_FILE_ROW_HEIGHT)}px`);
    expect(treeRow(':root\\[data-density="compact"\\] \\.workspace-workbench')).toBe("24px");
    expect(treeRow(':root\\[data-density="comfortable"\\] \\.workspace-workbench')).toBe("32px");
    // The same three numbers, in the function that drives the window.
    const height = source.match(/function workspaceRowHeight\(\): number \{[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(height).toContain('=== "comfortable" ? 32');
    expect(height).toContain('=== "compact" ? 24');
    expect(height).toContain("return WORKSPACE_FILE_ROW_HEIGHT");
    // A finger gets the floor from both sides.
    expect(height).toContain('matchMedia("(pointer: coarse)").matches) return 44');
    // Written at the specificity of the density overrides it has to beat: a
    // bare `.workspace-workbench` here loses to `:root[data-density=
    // "comfortable"] .workspace-workbench` and quietly exempts every
    // comfortable-density tablet from the touch floor.
    expect(coarseBlock(styles)).toContain(":root[data-density] .workspace-workbench { --tree-row: var(--touch-target); }");
  });

  it("stops spending 12% of every filename on a button nobody asked for", () => {
    // The lane was 34px wide and the `•••` inside it was `opacity: .45` at
    // rest, on all five rows of a three-file workspace.
    expect(styles).toContain(".tree-row-wrap { --tree-action-lane: 0px;");
    expect(styles).toContain(".tree-row-wrap:hover, .tree-row-wrap:focus-within { --tree-action-lane: 30px; }");
    const overflow = styles.match(/\.tree-overflow \{([^}]+)\}/u)?.[1] ?? "";
    expect(overflow).toContain("opacity: 0;");
    // `:focus-within` is what keeps it reachable when the keyboard puts focus
    // on the row, and the row's own menu keys never depended on it.
    expect(styles).toContain(".tree-row-wrap:focus-within .tree-overflow");
    expect(source).toContain('aria-keyshortcuts={node.kind === "file" ? "Enter Shift+Enter Control+Enter Shift+F10"');
    expect(source).toContain('aria-label={`Actions for ${node.name}`}');
  });

  it("keeps the lane open where there is no hover to open it with", () => {
    const coarse = coarseBlock(styles);
    // Listed with its own `:hover`/`:focus-within` selectors, which outrank the
    // bare class and would otherwise win this argument on a device that has
    // neither.
    expect(coarse).toContain(".tree-row-wrap, .tree-row-wrap:hover, .tree-row-wrap:focus-within { --tree-action-lane: 47px; }");
    expect(coarse).toContain("width: 44px;");
    expect(coarse).toContain("opacity: 1;");
  });

  it("splits the activity row between Explorer and Source Control", () => {
    // Equal flex tracks make the two destinations easy to scan and the gap
    // gives them a quiet separation without inventing a second tab grammar.
    // Every rule the strip's tab button carries, joined: the button is named by
    // two of them — one for the padding, one for the `min-width: 0` that lets a
    // 240px rail truncate a label instead of hiding a whole tab.
    const button = [...styles.matchAll(/\.tabs\.workbench-mode-tabs \.tabs__tab-button \{([^}]+)\}/gu)]
      .map((match) => match[1] ?? "").join("\n");
    expect(button).toContain("padding: 0 var(--sp-3);");
    // The step down in *size* keeps its documented reason: "Source Control"
    // plus its count has to fit a 15rem rail.
    expect(button).toContain("font-size: var(--fs-body);");
    expect(styles).toContain(".tabs.workbench-mode-tabs .tabs__strip {");
    expect(styles).toContain("gap: var(--sp-2);");
    expect(styles).toContain(".tabs.workbench-mode-tabs .tabs__tab {");
    expect(styles).toContain("flex: 1 1 0;");
    expect(source).toContain('{ id: "explorer", label: "Explorer", leading: <Icon name="workspace" size={15} /> }');
  });

  it("calls the same control the same thing on a phone and on a desktop", () => {
    // The desktop strip said Explorer and the phone strip said Files: one
    // control, two names, and a reader who learns it twice. Every `explorer`
    // tab in this file agrees now — asserted by collecting them rather than by
    // spelling either strip's line out, so a third strip cannot quietly
    // reintroduce a third name.
    const labels = [...source.matchAll(/\{ id: "explorer", label: "([^"]+)"/gu)].map((match) => match[1]);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels).size).toBe(1);
    // And it is the name the tree's own heading and the route already use.
    expect(source).toContain('{mode === "source" ? "Source Control" : "Explorer"}');
  });
});

/*
 * The editor column has to be able to run out of room. With the terminal dock
 * open on a 932×430 landscape phone it has about 65px for the code frame and
 * the file strip together; the frame shrinks to nothing, as its flex terms ask,
 * and then the only question is whether its content stays inside it. It did
 * not: three wrapped lines painted straight through the Modified verdict, the
 * path, the revision and the Wrap/Save controls.
 */
describe("the editing sheet under a column that has run out of height", () => {
  const styles = readFileSync(new URL("./workspace-view.css", import.meta.url), "utf8");

  it("clips the code frame instead of letting it paint over the file strip", () => {
    const frame = styles.match(/\.code-editor-frame \{([^}]+)\}/u)?.[1] ?? "";
    expect(frame).toContain("flex: 1 1 auto");
    expect(frame).toContain("min-height: 0");
    expect(frame).toContain("overflow: hidden");
    // The strip is the half that must not shrink; the frame is the half that
    // must. A strip that could shrink would simply lose the same facts slowly.
    expect(styles.match(/\.editor-strip \{([^}]+)\}/u)?.[1] ?? "").toContain("flex: 0 0 auto");
  });
});

/** The one `@media (pointer: coarse)` block a workbench sheet is allowed. */
function coarseBlock(styles: string): string {
  return [...styles.matchAll(/@media \(pointer: coarse\) \{\n((?:[^@]|\n)*?)\n\}\n/gu)].map((match) => match[1] ?? "").join("\n");
}
