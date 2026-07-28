import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWorkspaceBytes, encodeWorkspaceBytes } from "../workspace/content-codec";
import { MemoryWorkspace } from "../workspace/memory";
import { createWasixAdapter } from "./wasix-pack";

type RunMessage = Readonly<{
  type: "run";
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}>;

type Completion = Readonly<{
  exitCode: number;
  providerExitCode?: number;
  stdout: string;
  stderr: string;
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}>;

let nextCompletion: Completion;
let observedRun: RunMessage | undefined;

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  postMessage(message: RunMessage | Readonly<{ type: "cancel" }>): void {
    if (message.type === "cancel") {
      queueMicrotask(() => this.emit({ type: "worker-tree-stopped", reason: "cancelled", workers: 2 }));
      return;
    }
    observedRun = structuredClone(message);
    queueMicrotask(() => {
      this.emit({ type: "output", stream: "stdout", text: nextCompletion.stdout });
      this.emit({ type: "completed", providerExitCode: nextCompletion.providerExitCode ?? nextCompletion.exitCode, ...nextCompletion });
      this.emit({ type: "worker-tree-stopped", reason: "completed", workers: 2 });
    });
  }

  terminate(): void {}

  private emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  observedRun = undefined;
});

describe("Wasmer WASIX workspace boundary", () => {
  it("mounts only user files, streams non-authoritatively, and adopts text deltas with CAS", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    await workspace.write("/workspace/project/.git/config", "private git metadata\n");
    await workspace.write("/workspace/project/node_modules/cache.txt", "dependency cache\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "done\n",
      stderr: "",
      files: [
        { path: "input.txt", bytes: new TextEncoder().encode("after\n") },
        { path: "created.txt", bytes: new TextEncoder().encode("created\n") },
      ],
    };

    const result = await createWasixAdapter().execute({
      runtime: "wasix",
      code: "printf done",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      onOutput() {
        throw new Error("a view must not control execution");
      },
    });

    expect(observedRun?.files).toEqual([{ path: "input.txt", bytes: new TextEncoder().encode("before\n") }]);
    expect(result.workspace).toMatchObject({
      changedPaths: ["/workspace/project/created.txt", "/workspace/project/input.txt"],
      writtenPaths: ["/workspace/project/created.txt", "/workspace/project/input.txt"],
      adopted: true,
    });
    expect(await workspace.read("/workspace/project/input.txt")).toMatchObject({ content: "after\n" });
    expect(await workspace.read("/workspace/project/.git/config")).toMatchObject({ content: "private git metadata\n" });
  });

  it("rejects a compromised Worker response that targets excluded control-plane paths", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      files: [
        { path: "input.txt", bytes: new TextEncoder().encode("after\n") },
        { path: ".git/config", bytes: new TextEncoder().encode("forged\n") },
      ],
    };

    await expect(createWasixAdapter().execute({
      runtime: "wasix",
      code: "printf forged",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/excludes control-plane path/u);
    expect(await workspace.read("/workspace/project/input.txt")).toMatchObject({ content: "before\n" });
  });

  it("refuses a workspace root inside a dependency or control-plane subtree", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/node_modules/project/input.txt", "hidden\n");

    await expect(createWasixAdapter().execute({
      runtime: "wasix",
      code: "printf hidden",
      workspace,
      workspaceRoot: "/workspace/node_modules/project",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/node_modules/u);
    expect(observedRun).toBeUndefined();
  });

  it("refuses a workspace root that identifies a file", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project.txt", "not a directory\n");

    await expect(createWasixAdapter().execute({
      runtime: "wasix",
      code: "printf hidden",
      workspace,
      workspaceRoot: "/workspace/project.txt",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/must identify a directory/u);
    expect(observedRun).toBeUndefined();
  });

  it("rejects duplicate normalized paths from a compromised Worker", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      files: [
        { path: "folder//same.txt", bytes: new TextEncoder().encode("first\n") },
        { path: "folder/same.txt", bytes: new TextEncoder().encode("second\n") },
      ],
    };

    await expect(createWasixAdapter().execute({
      runtime: "wasix",
      code: "printf duplicate",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/duplicate normalized workspace path/u);
    expect(await workspace.read("/workspace/project/folder/same.txt")).toBeUndefined();
  });

  it("round-trips opaque workspace bytes through the WASIX worker boundary", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    const before = new Uint8Array([0, 255, 1, 128]);
    const after = new Uint8Array([0, 254, 2, 129]);
    await workspace.write("/workspace/project/blob.bin", encodeWorkspaceBytes(before));
    nextCompletion = { exitCode: 0, stdout: "", stderr: "", files: [{ path: "blob.bin", bytes: after }] };

    await createWasixAdapter().execute({
      runtime: "wasix",
      code: "printf binary",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(observedRun?.files[0]?.bytes).toEqual(before);
    expect(decodeWorkspaceBytes((await workspace.read("/workspace/project/blob.bin"))!.content)).toEqual(after);
  });
});

function installBrowserWorkerStub(): void {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("location", new URL("https://airship.test/"));
}
