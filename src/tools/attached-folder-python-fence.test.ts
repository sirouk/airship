import { beforeAll, describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../approvals/broker";
import { createApprovalModePolicy } from "../approvals/modes";
import type { JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { LocalFolderWorkspacePort, MountedLocalFolderWorkspace, type LocalDirectoryHandleLike } from "../workspace/local-folder";
import { MemoryWorkspace } from "../workspace/memory";
import { getClientExecutionRuntime, installPyodideExecutionRuntime } from "./execution-tools";

/**
 * Pyodide is the fourth snapshot/write-back tier, and the execution fence missed it.
 *
 * `src/execution/attached-folder-fence.test.ts` pins the same rule for
 * airship-sh; the WASI and Node tiers carry it in their own packs. Python was
 * left out, and it is the one tier whose tool is `effect: "execute"`, so Full
 * Access allows it with nobody asked. Measured before this file existed:
 * `mountedFiles: 2` carried the person's own file into the interpreter,
 * `writtenPaths` replaced `salary.txt` on disk with `PWNED`, and a second run
 * that simply did not return the file deleted it in place.
 */
function fakeDirectory(files: Map<string, string>): LocalDirectoryHandleLike {
  const fileHandle = (name: string) => ({
    kind: "file" as const,
    name,
    async getFile() {
      const bytes = new TextEncoder().encode(files.get(name) ?? "");
      return { size: bytes.byteLength, lastModified: 0, async arrayBuffer() { return bytes.buffer.slice(0) as ArrayBuffer; } };
    },
    async createWritable() {
      let next = "";
      return {
        async write(data: unknown) { next += typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array); },
        async close() { files.set(name, next); },
      };
    },
  });
  return {
    kind: "directory",
    name: "notes",
    async *entries() { for (const name of [...files.keys()]) yield [name, fileHandle(name)]; },
    async getDirectoryHandle() { throw new Error("no nested directories in this stand-in"); },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) { if (!options?.create) throw new Error("not found"); files.set(name, ""); }
      return fileHandle(name);
    },
    async removeEntry(name: string) { files.delete(name); },
    async queryPermission() { return "granted" as const; },
    async requestPermission() { return "granted" as const; },
  } as unknown as LocalDirectoryHandleLike;
}

type WorkerFile = Readonly<{ path: string; bytes: Uint8Array }>;
type WorkerCompletion = Readonly<{
  exitCode: number; stdout: string; stderr: string; valueJson: string;
  workspaceFiles?: readonly WorkerFile[];
}>;
/** The interpreter probe `installPyodideExecutionRuntime` runs before it registers. */
let nextCompletion: WorkerCompletion = { exitCode: 0, stdout: "3.14\n", stderr: "", valueJson: "null" };

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(): void {
    queueMicrotask(() => { this.emit({ type: "ready" }); this.emit({ ok: true, ...nextCompletion }); });
  }
  terminate(): void {}
  private emit(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
}

/** `execute_code`'s real definition; the effect is what decides who is asked. */
const EXECUTE_CODE: ToolDefinition = {
  name: "execute_code",
  description: "run one browser job",
  effect: "execute",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
};

function toolContext(): ToolContext {
  return { sessionId: "s1", turnId: "t1", operationId: "o1", signal: new AbortController().signal } as ToolContext;
}

function mounted(disk: Map<string, string>): MountedLocalFolderWorkspace {
  const folder = new LocalFolderWorkspacePort(fakeDirectory(disk), "/workspace/local/notes");
  return new MountedLocalFolderWorkspace(new MemoryWorkspace(), folder);
}

beforeAll(async () => {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("location", new URL("https://airship.test/"));
  await installPyodideExecutionRuntime(5_000, new AbortController().signal);
});

describe("attached folder fence: python-pyodide", () => {
  it("refuses a write addressed into the attached folder, with nobody asked", async () => {
    const disk = new Map<string, string>([["salary.txt", "original\n"]]);
    const workspace = mounted(disk);
    await workspace.write("/workspace/kept.txt", "kept\n", { expectedRevision: null });

    // The reviewed arguments name /workspace and never the folder, so
    // `namesAttachedFolder` cannot see it and Full Access asks nobody. This is
    // exactly why the fence has to live in the runtime.
    const args: JsonValue = { runtime: "python-pyodide", code: "x", workspaceRoot: "/workspace", writeBack: true };
    const broker = new ApprovalBroker();
    const asked: string[] = [];
    broker.subscribe((snapshot) => { for (const entry of snapshot.pending) asked.push(entry.toolName); });
    await expect(createApprovalModePolicy({ mode: "full-access", broker }).review(EXECUTE_CODE, args, toolContext()))
      .resolves.toBe("allow");
    expect(asked).toEqual([]);

    nextCompletion = {
      exitCode: 0, stdout: "", stderr: "", valueJson: "null",
      workspaceFiles: [
        { path: "/workspace/kept.txt", bytes: new TextEncoder().encode("changed\n") },
        { path: "/workspace/local/notes/salary.txt", bytes: new TextEncoder().encode("PWNED\n") },
      ],
    };
    const result = await getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "open('local/notes/salary.txt','w').write('PWNED')",
      workspace,
      workspaceRoot: "/workspace",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    // Not carried in, and nothing addressed to it written back.
    expect(result.workspace?.mountedFiles).toBe(1);
    expect(result.workspace?.refusedPaths).toEqual(["/workspace/local/notes/salary.txt"]);
    expect(result.workspace?.refusalReason).toContain("does not carry the folder you attached from this device");
    expect(result.workspace?.writtenPaths).toEqual(["/workspace/kept.txt"]);
    expect(disk.get("salary.txt")).toBe("original\n");
  });

  it("never reports a file it did not carry as one the job deleted", async () => {
    const disk = new Map<string, string>([["salary.txt", "original\n"]]);
    const workspace = mounted(disk);
    await workspace.write("/workspace/kept.txt", "kept\n", { expectedRevision: null });
    nextCompletion = {
      exitCode: 0, stdout: "", stderr: "", valueJson: "null",
      workspaceFiles: [{ path: "/workspace/kept.txt", bytes: new TextEncoder().encode("kept\n") }],
    };
    const result = await getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "import os; os.remove('local/notes/salary.txt')",
      workspace,
      workspaceRoot: "/workspace",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(result.workspace?.deletedPaths).toEqual([]);
    expect(disk.has("salary.txt")).toBe(true);
  });
});
