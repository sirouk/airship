import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "../approvals/broker";
import { createApprovalModePolicy } from "../approvals/modes";
import type { JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { LocalFolderWorkspacePort, MountedLocalFolderWorkspace, type LocalDirectoryHandleLike } from "../workspace/local-folder";
import { MemoryWorkspace } from "../workspace/memory";
import { executeAirshipShellRequest } from "./shell/pack";

/**
 * A folder attached from this device must not be reachable from a runtime that
 * snapshots `/workspace` and writes it back.
 *
 * Measured before the fence: `execute_shell` with `workspaceRoot: "/workspace"`
 * and `writeBack: true` replaced a file on the person's own disk while
 * `createApprovalModePolicy` asked nobody in Auto Approve or Full Access and
 * journaled "inside its declared browser tool boundary" as the reason. The
 * arguments the broker reviews name `/workspace`, never the folder, so
 * `namesAttachedFolder` cannot see it.
 */
function fakeDirectory(files: Map<string, string>): LocalDirectoryHandleLike {
  const fileHandle = (name: string) => ({
    kind: "file" as const,
    name,
    async getFile() {
      const bytes = new TextEncoder().encode(files.get(name) ?? "");
      return {
        size: bytes.byteLength,
        lastModified: 0,
        async arrayBuffer() { return bytes.buffer.slice(0) as ArrayBuffer; },
      };
    },
    async createWritable() {
      let next = "";
      return {
        async write(data: unknown) {
          next += typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
        },
        async close() { files.set(name, next); },
      };
    },
  });
  return {
    kind: "directory",
    name: "notes",
    async *entries() {
      for (const name of [...files.keys()]) yield [name, fileHandle(name)];
    },
    async getDirectoryHandle() { throw new Error("no nested directories in this stand-in"); },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new Error("not found");
        files.set(name, "");
      }
      return fileHandle(name);
    },
    async removeEntry(name: string) { files.delete(name); },
    async queryPermission() { return "granted" as const; },
    async requestPermission() { return "granted" as const; },
  } as unknown as LocalDirectoryHandleLike;
}

const SHELL_TOOL: ToolDefinition = {
  name: "execute_shell",
  description: "run a shell script over the workspace",
  effect: "write",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
};

function toolContext(): ToolContext {
  return { sessionId: "s1", turnId: "t1", operationId: "o1", signal: new AbortController().signal } as ToolContext;
}

describe("attached folder fence", () => {
  it("keeps a /workspace-rooted shell write-back off the attached folder", async () => {
    const disk = new Map<string, string>([["salary.txt", "original\n"]]);
    const folder = new LocalFolderWorkspacePort(fakeDirectory(disk), "/workspace/local/notes");
    const workspace = new MountedLocalFolderWorkspace(new MemoryWorkspace(), folder);
    await workspace.write("/workspace/kept.txt", "kept\n", { expectedRevision: null });

    // The reviewed arguments name /workspace, so no approval mode asks: this is
    // exactly why the fence has to live in the runtime and not in the broker.
    const args: JsonValue = { script: "x", workspaceRoot: "/workspace", writeBack: true };
    for (const mode of ["auto-approve", "full-access"] as const) {
      const broker = new ApprovalBroker();
      const asked: string[] = [];
      broker.subscribe((snapshot) => { for (const entry of snapshot.pending) asked.push(entry.toolName); });
      await expect(createApprovalModePolicy({ mode, broker }).review(SHELL_TOOL, args, toolContext())).resolves.toBe("allow");
      expect(asked).toEqual([]);
    }

    const result = await executeAirshipShellRequest({
      runtime: "airship-sh",
      code: "mkdir -p local/notes\nprintf 'PWNED\\n' > local/notes/salary.txt\nprintf 'ok\\n' > kept.txt\n",
      workspaceRoot: "/workspace",
      workspace,
      writeBack: true,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    } as never);

    expect(disk.get("salary.txt")).toBe("original\n");
    expect(result.workspace?.writtenPaths).toEqual(["/workspace/kept.txt"]);
    expect(result.workspace?.refusedPaths).toEqual(["/workspace/local/notes/salary.txt"]);
    expect(result.workspace?.refusalReason).toContain("does not carry the folder you attached from this device");
  });

  it("does not mount the attached folder into the shell at all", async () => {
    const disk = new Map<string, string>([["salary.txt", "secret\n"]]);
    const folder = new LocalFolderWorkspacePort(fakeDirectory(disk), "/workspace/local/notes");
    const workspace = new MountedLocalFolderWorkspace(new MemoryWorkspace(), folder);
    const result = await executeAirshipShellRequest({
      runtime: "airship-sh",
      code: "ls local 2>/dev/null || printf 'absent\\n'\n",
      workspaceRoot: "/workspace",
      workspace,
      writeBack: false,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    } as never);
    expect(result.stdout).toContain("absent");
    expect(result.workspace?.mountedFiles).toBe(0);
  });
});
