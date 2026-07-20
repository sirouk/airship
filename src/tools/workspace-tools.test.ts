import { describe, expect, it } from "vitest";
import type { JsonValue, Tool, ToolContext } from "../core/contracts";
import { MemoryWorkspace } from "../workspace/memory";
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
    const matches = JSON.parse(insensitive.content) as Array<Record<string, unknown>>;
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
    expect(JSON.parse(sensitive.content)).toEqual([
      expect.objectContaining({ path: "/workspace/a.txt", line: 2, column: 8 }),
    ]);
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
});
