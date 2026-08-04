import { describe, expect, it } from "vitest";
import { boundToolResultContent } from "../core/agent";
import type { JsonValue, Tool, ToolContext } from "../core/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import { encodeWorkspaceBytes } from "../workspace/content-codec";
import { WorkspaceConflictError } from "../workspace/contracts";
import { createWorkspaceToolRegistry } from "./workspace-tools";

const context: ToolContext = {
  sessionId: "session",
  turnId: "turn",
  operationId: "operation",
  signal: new AbortController().signal,
};

function tool(workspace: MemoryWorkspace, name: string): Tool {
  const registered = createWorkspaceToolRegistry(workspace).get(name);
  if (!registered) throw new Error(`Missing tool ${name}`);
  return registered;
}

async function execute(workspace: MemoryWorkspace, name: string, args: JsonValue) {
  return tool(workspace, name).execute(args, context);
}

describe("workspace tools", () => {
  it("exposes bounded reads as read effects and every mutation as a write effect", () => {
    const definitions = createWorkspaceToolRegistry(new MemoryWorkspace()).definitions();
    expect(Object.fromEntries(definitions.map(({ name, effect }) => [name, effect]))).toEqual({
      list_files: "read",
      move_file: "write",
      read_file: "read",
      remove_file: "write",
      replace_text: "write",
      search_text: "read",
      stat_path: "read",
      text_editor: "write",
      write_file: "write",
    });
  });

  it("reports file and directory metadata without returning file content", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("notes/plan.md", "private body");

    const file = await execute(workspace, "stat_path", { path: "notes/plan.md" });
    expect(file.isError).not.toBe(true);
    expect(file.content).toContain('"type": "file"');
    expect(file.content).not.toContain("private body");

    const directory = await execute(workspace, "stat_path", { path: "notes" });
    expect(directory.metadata).toMatchObject({
      type: "directory",
      path: "/workspace/notes",
      files: 1,
      totalSize: 12,
    });
  });

  it("searches literal text with line locations, case controls, and result bounds", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("a.txt", "Alpha needle\nsecond NEEDLE here\nneedle");
    await workspace.write("b.txt", "needle elsewhere");

    const insensitive = await execute(workspace, "search_text", {
      path: "/workspace",
      query: "needle",
      maxResults: 2,
    });
    const { matches } = JSON.parse(insensitive.content) as { matches: Array<Record<string, unknown>> };
    expect(matches).toEqual([
      expect.objectContaining({ path: "/workspace/a.txt", line: 1, column: 7 }),
      expect.objectContaining({ path: "/workspace/a.txt", line: 2, column: 8 }),
    ]);
    expect(insensitive.metadata).toMatchObject({ matches: 2, truncated: true });

    const sensitive = await execute(workspace, "search_text", {
      path: "a.txt",
      query: "NEEDLE",
      caseSensitive: true,
    });
    expect((JSON.parse(sensitive.content) as { matches: unknown[] }).matches).toEqual([
      expect.objectContaining({ path: "/workspace/a.txt", line: 2, column: 8 }),
    ]);
  });

  it("returns a byte window whose halves reassemble into the file, with the notice first", async () => {
    /*
     * `read_file` had no window at all: a 2 MiB file cost a full read and then
     * threw `Tool output exceeded 1048576 bytes.` from registry.ts:149 — after
     * the work, with no part of the file returned and no smaller call to make.
     * The notice leads because `boundToolResultContent` cuts the tail and
     * `metadata` never reaches the model.
     */
    const workspace = new MemoryWorkspace();
    const body = "héllo world\n".repeat(120);
    await workspace.write("big.md", body);

    const first = await execute(workspace, "read_file", { path: "big.md", maxBytes: 500 });
    expect(first.metadata).toMatchObject({ complete: false, offset: 0 });
    expect(first.content.startsWith("[Airship returned bytes 0–")).toBe(true);
    const nextOffset = (first.metadata as { nextOffsetBytes: number }).nextOffsetBytes;

    const second = await execute(workspace, "read_file", { path: "big.md", offset: nextOffset });
    const head = (content: string) => content.slice(content.indexOf("\n\n") + 2);
    // A window that ended mid-character would decode to U+FFFD on both seams and
    // the two halves would not be the file.
    expect(head(first.content) + head(second.content)).toBe(body);
    expect(first.content).not.toContain("�");
    expect(second.metadata).toMatchObject({ complete: false });
    expect(second.content).toContain("This window reaches the end of the file.");
    expect(second.metadata).not.toHaveProperty("nextOffsetBytes");
  });

  it("still returns whole every file that returned whole before the window existed", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("wide.md", "a".repeat(1_040_000));
    const whole = await execute(workspace, "read_file", { path: "wide.md" });
    expect(whole.metadata).toMatchObject({ complete: true });
    expect(whole.content).toHaveLength(1_040_000);
    expect(whole.content.startsWith("[Airship")).toBe(false);

    await workspace.write("wider.md", "b".repeat(2_000_000));
    const windowed = await execute(workspace, "read_file", { path: "wider.md" });
    /*
     * The default has to clear two bars at once: above it, files that work today
     * would start being cut; below `registry.ts:149`'s 1_048_576, the window plus
     * its notice would throw the same error this replaces.
     */
    expect(new TextEncoder().encode(windowed.content).byteLength).toBeLessThan(1_048_576);
    expect(windowed.metadata).toMatchObject({ complete: false, nextOffsetBytes: 1_040_000 });
    await expect(execute(workspace, "read_file", { path: "wider.md", offset: 3_000_000 }))
      .resolves.toMatchObject({ isError: true });
  });

  it("keeps the resume instruction when the turn's remaining bytes cut the result", async () => {
    // The turn's own bound (src/core/agent.ts:653) removes the tail. Measured
    // here rather than assumed, because a tail-placed notice would be the first
    // thing deleted and it is the only carrier of the next offset.
    const workspace = new MemoryWorkspace();
    await workspace.write("big.md", "line\n".repeat(4000));
    const windowed = await execute(workspace, "read_file", { path: "big.md", maxBytes: 4000 });
    const bounded = boundToolResultContent(windowed.content, 600);
    expect(bounded.truncated).toBe(true);
    expect(bounded.content).toContain("Continue with read_file");
    expect(bounded.content).toContain('"offset":4000');
  });

  it("names a next action whenever it reports an incomplete scan", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("a.md", "needle\n".repeat(10));
    await workspace.write("b.md", "needle");
    const capped = JSON.parse((await execute(workspace, "search_text", { query: "needle", maxResults: 3 })).content) as {
      summary: string;
      complete: boolean;
      nextCursor?: string;
      capReachedIn?: string;
      matches: unknown[];
    };
    expect(capped.matches).toHaveLength(3);
    expect(capped.complete).toBe(false);
    // Measured against the first draft of this change: a cap that filled inside
    // the first eligible file returned `complete: false` with no cursor and no
    // other field — an incomplete answer naming no action the caller could take.
    expect(capped.nextCursor ?? capped.capReachedIn).toBe("/workspace/a.md");
    expect(capped.summary).toContain("result cap reached inside");
  });

  it("resumes from its own cursor and then reports a complete scan", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("a.md", "needle a");
    await workspace.write("b.md", "needle b");
    const parse = (content: string) => JSON.parse(content) as {
      complete: boolean;
      nextCursor?: string;
      matches: Array<{ path: string }>;
    };
    const first = parse((await execute(workspace, "search_text", { query: "needle", maxResults: 1 })).content);
    expect(first.matches.map((match) => match.path)).toEqual(["/workspace/a.md"]);
    const second = parse((await execute(workspace, "search_text", { query: "needle", cursor: "/workspace/a.md" })).content);
    expect(second.matches.map((match) => match.path)).toEqual(["/workspace/b.md"]);
    expect(second.complete).toBe(true);
    expect(second.nextCursor).toBeUndefined();
  });

  it("selects files with a relative glob and says how many the filter kept", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("src/a.ts", "needle");
    await workspace.write("src/deep/b.ts", "needle");
    await workspace.write("docs/readme.md", "needle");
    const filtered = JSON.parse((await execute(workspace, "search_text", { query: "needle", include: "src/**/*.ts" })).content) as {
      summary: string;
      matches: Array<{ path: string }>;
    };
    // `src/**/*.ts` is the commonest form a model writes and it selected zero
    // files in the first draft of this matcher, then reported a complete scan.
    expect(filtered.matches.map((match) => match.path)).toEqual(["/workspace/src/a.ts", "/workspace/src/deep/b.ts"]);
    expect(filtered.summary).toContain("2 of 3 files matched the filter");
  });

  it("refuses an include that selects nothing rather than reporting a complete empty scan", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("docs/readme.md", "needle");
    const refused = await execute(workspace, "search_text", { query: "needle", include: "./src/*.ts" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("selected 0 of 1 files");
    expect(refused.content).toContain("/workspace/docs/readme.md");
    expect(refused.metadata).toMatchObject({ selectedFiles: 0 });
  });

  it("keeps include inside the path scope rather than widening past it", async () => {
    // Correct today only because `workspace.list(path)` scopes first. This lane's
    // whole thesis is that filter-vs-bound ordering is load-bearing, so pin it.
    const workspace = new MemoryWorkspace();
    await workspace.write("docs/helper.ts", "no match here");
    await workspace.write("docs/notes.md", "needle");
    await workspace.write("src/other.ts", "needle");
    const filtered = await execute(workspace, "search_text", { path: "/workspace/docs", query: "needle", include: "**/*.ts" });
    expect((JSON.parse(filtered.content) as { matches: unknown[] }).matches).toEqual([]);
  });

  it("keeps opaque workspace bytes out of UTF-8 read, search, and edit tools", async () => {
    const workspace = new MemoryWorkspace();
    const binary = encodeWorkspaceBytes(Uint8Array.from([0, 255, 1, 2]));
    await workspace.write("opaque.json", binary);

    await expect(execute(workspace, "read_file", { path: "opaque.json" })).resolves.toMatchObject({
      isError: true,
      metadata: { encoding: "binary", size: 4 },
    });
    await expect(execute(workspace, "search_text", { query: "airship-git-binary-v1" })).resolves.toMatchObject({
      metadata: { matches: 0, skippedFiles: 1 },
    });
    await expect(execute(workspace, "replace_text", { path: "opaque.json", oldText: "airship", newText: "broken" })).resolves.toMatchObject({ isError: true });
    await expect(execute(workspace, "text_editor", { edits: [{ path: "opaque.json", oldText: "airship", newText: "broken" }] })).rejects.toThrow("opaque binary");
    expect((await workspace.read("opaque.json"))?.content).toBe(binary);
  });

  it("states one size for a binary file across read, list, and stat", async () => {
    // `read_file` refuses binaries and points at `stat_path`, so the two had
    // better agree: the stored base64 envelope is ~4/3 of the file, and the
    // model was previously told both numbers for the same path.
    const workspace = new MemoryWorkspace();
    await workspace.write("assets/raw.bin", encodeWorkspaceBytes(Uint8Array.from([0, 255, 1, 2])));

    const read = await execute(workspace, "read_file", { path: "assets/raw.bin" });
    const stat = await execute(workspace, "stat_path", { path: "assets/raw.bin" });
    const listed = JSON.parse((await execute(workspace, "list_files", { path: "assets" })).content) as JsonValue[];

    expect(read.metadata).toMatchObject({ size: 4 });
    expect(stat.metadata).toMatchObject({ size: 4 });
    expect(JSON.parse(stat.content)).toMatchObject({ type: "file", size: 4 });
    expect(listed).toEqual([expect.objectContaining({ path: "/workspace/assets/raw.bin", size: 4 })]);
    // One size in the transcript, never the storage field beside it.
    expect(JSON.stringify(listed)).not.toContain("contentByteLength");
    expect(stat.content).not.toContain("contentByteLength");
  });

  it("refuses ambiguous replacement by default and supports explicit replace-all with revision safety", async () => {
    const workspace = new MemoryWorkspace();
    const original = await workspace.write("draft.txt", "old / old");

    const ambiguous = await execute(workspace, "replace_text", {
      path: "draft.txt",
      oldText: "old",
      newText: "new",
    });
    expect(ambiguous).toMatchObject({ isError: true, metadata: { occurrences: 2 } });
    expect((await workspace.read("draft.txt"))?.content).toBe("old / old");

    const replaced = await execute(workspace, "replace_text", {
      path: "draft.txt",
      oldText: "old",
      newText: "new",
      replaceAll: true,
      expectedRevision: original.revision,
    });
    expect(replaced.metadata).toMatchObject({ replacements: 2 });
    expect((await workspace.read("draft.txt"))?.content).toBe("new / new");

    await expect(execute(workspace, "replace_text", {
      path: "draft.txt",
      oldText: "new",
      newText: "stale",
      expectedRevision: original.revision,
    })).rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it("applies a preflighted text-editor batch with exact create and replacement semantics", async () => {
    const workspace = new MemoryWorkspace();
    const original = await workspace.write("src/one.ts", "const before = 1;\n");
    const result = await execute(workspace, "text_editor", {
      edits: [
        {
          path: "src/one.ts",
          oldText: "before = 1",
          newText: "after = 2",
          expectedRevision: original.revision,
        },
        {
          path: "src/two.ts",
          oldText: null,
          newText: "export const ready = true;\n",
          expectedRevision: null,
        },
      ],
    });

    expect(result.metadata).toMatchObject({ transaction: "preflight-plus-per-file-cas", atomic: false });
    expect((await workspace.read("src/one.ts"))?.content).toContain("after = 2");
    expect((await workspace.read("src/two.ts"))?.content).toContain("ready = true");

    await expect(execute(workspace, "text_editor", {
      edits: [{ path: "src/one.ts", oldText: null, newText: "overwrite" }],
    })).rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it("moves only to an unoccupied path and removes with optimistic revision checks", async () => {
    const workspace = new MemoryWorkspace();
    const source = await workspace.write("source.txt", "payload");
    await workspace.write("occupied.txt", "keep");

    const occupied = await execute(workspace, "move_file", {
      sourcePath: "source.txt",
      destinationPath: "occupied.txt",
    });
    expect(occupied.isError).toBe(true);
    expect((await workspace.read("source.txt"))?.content).toBe("payload");
    expect((await workspace.read("occupied.txt"))?.content).toBe("keep");

    const moved = await execute(workspace, "move_file", {
      sourcePath: "source.txt",
      destinationPath: "archive/source.txt",
      expectedRevision: source.revision,
    });
    expect(moved.metadata).toMatchObject({
      sourcePath: "/workspace/source.txt",
      destinationPath: "/workspace/archive/source.txt",
    });
    expect(await workspace.read("source.txt")).toBeUndefined();
    const destination = await workspace.read("archive/source.txt");
    expect(destination?.content).toBe("payload");

    await expect(execute(workspace, "remove_file", {
      path: "archive/source.txt",
      expectedRevision: "stale",
    })).rejects.toBeInstanceOf(WorkspaceConflictError);
    await execute(workspace, "remove_file", {
      path: "archive/source.txt",
      expectedRevision: destination!.revision,
    });
    expect(await workspace.read("archive/source.txt")).toBeUndefined();
  });

  it("rolls back the destination if a move loses its source revision race", async () => {
    class ConflictingRemovalWorkspace extends MemoryWorkspace {
      private conflict = true;

      override async remove(path: string, options: { expectedRevision?: string } = {}): Promise<void> {
        if (path === "/workspace/source.txt" && this.conflict) {
          this.conflict = false;
          throw new WorkspaceConflictError();
        }
        return super.remove(path, options);
      }
    }

    const workspace = new ConflictingRemovalWorkspace();
    await workspace.write("source.txt", "payload");

    await expect(execute(workspace, "move_file", {
      sourcePath: "source.txt",
      destinationPath: "destination.txt",
    })).rejects.toBeInstanceOf(WorkspaceConflictError);
    expect((await workspace.read("source.txt"))?.content).toBe("payload");
    expect(await workspace.read("destination.txt")).toBeUndefined();
  });

  it("confines every new tool path to /workspace", async () => {
    const workspace = new MemoryWorkspace();
    for (const [name, args] of [
      ["stat_path", { path: "/etc/passwd" }],
      ["search_text", { path: "../outside", query: "x" }],
      ["replace_text", { path: "/tmp/file", oldText: "x", newText: "y" }],
      ["move_file", { sourcePath: "safe", destinationPath: "../outside" }],
      ["remove_file", { path: "safe/../../outside" }],
    ] as const) {
      await expect(execute(workspace, name, args)).rejects.toThrow(/workspace|\.\./i);
    }
  });

  it("hides and rejects every Airship and Git control-plane path", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("visible.txt", "public needle");
    await workspace.write(".airship/memory.json", "private needle");
    await workspace.write(".airship/future-checkpoint.json", "future needle");
    await workspace.write("repo/.git/config", "git needle");

    const listed = await execute(workspace, "list_files", { path: "/workspace" });
    expect(listed.content).toContain("/workspace/visible.txt");
    expect(listed.content).not.toContain(".airship");
    expect(listed.content).not.toContain(".git");
    expect(listed.metadata).toEqual({ count: 1 });

    const searched = await execute(workspace, "search_text", { path: "/workspace", query: "needle" });
    expect((JSON.parse(searched.content) as { matches: unknown[] }).matches).toEqual([
      expect.objectContaining({ path: "/workspace/visible.txt" }),
    ]);

    const rootStat = await execute(workspace, "stat_path", { path: "/workspace" });
    expect(rootStat.metadata).toMatchObject({ files: 1 });

    const prohibitedCalls: ReadonlyArray<readonly [string, JsonValue]> = [
      ["list_files", { path: "/workspace/.airship" }],
      ["read_file", { path: "/workspace/.airship/memory.json" }],
      ["write_file", { path: "/workspace/.airship/new.json", content: "overwrite" }],
      ["stat_path", { path: "/workspace/repo/.git/config" }],
      ["search_text", { path: "/workspace/.airship", query: "private" }],
      ["replace_text", { path: "/workspace/.airship/memory.json", oldText: "private", newText: "stolen" }],
      ["move_file", { sourcePath: "/workspace/.airship/memory.json", destinationPath: "/workspace/stolen.json" }],
      ["move_file", { sourcePath: "/workspace/visible.txt", destinationPath: "/workspace/.airship/stolen.json" }],
      ["remove_file", { path: "/workspace/.airship/memory.json" }],
      ["text_editor", { edits: [{ path: "/workspace/.airship/memory.json", oldText: "private", newText: "stolen" }] }],
    ];
    for (const [name, args] of prohibitedCalls) {
      await expect(execute(workspace, name, args)).rejects.toThrow(/control-plane/u);
    }

    expect((await workspace.read(".airship/memory.json"))?.content).toBe("private needle");
    expect((await workspace.read("visible.txt"))?.content).toBe("public needle");
    expect(await workspace.read("stolen.json")).toBeUndefined();
  });
});
