import { readFileSync } from "node:fs";
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
  runSourceMutation,
  workspaceDownloadPayload,
  workspaceRowMenuKey,
  workspaceEditorProjection,
  workspaceFileWindow,
  workspaceGutterLines,
  workspaceHistoryPatch,
  workspacePersistedWorktreeId,
  workbenchDiffRevealPaths,
  workbenchHistoryCount,
  workbenchMenuFocusIndex,
  workbenchSourceLanes,
  workbenchSourceTruncationNote,
  workbenchStatusDiffHint,
  workbenchSupersededStatusDiff,
  workspaceRevealAncestors,
  workspaceTabStorageKey,
  writeWorkspaceTabState,
  SCM_LANE_LIMIT,
  WORKBENCH_HISTORY_DEPTH,
  WORKSPACE_FILE_ROW_HEIGHT,
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
