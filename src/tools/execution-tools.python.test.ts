import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import {
  getClientExecutionRuntime,
  installPyodideExecutionRuntime,
  runDisposablePyodide,
} from "./execution-tools";

type WorkerFile = Readonly<{ path: string; bytes: Uint8Array }>;
type WorkerCompletion = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  valueJson: string;
  workspaceFiles?: readonly WorkerFile[];
  workspaceError?: string;
}>;

const PROBE_COMPLETION: WorkerCompletion = { exitCode: 0, stdout: "3.14\n", stderr: "", valueJson: "null" };

let nextCompletion: WorkerCompletion = PROBE_COMPLETION;
/** Simulated CPython cold start before the worker reports `ready`. */
let bootDelayMs = 0;
/** Set to keep the worker silent after `ready` so the job timer is observable. */
let neverCompletes = false;

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  postMessage(): void {
    const boot = () => {
      this.emit({ type: "ready" });
      if (!neverCompletes) this.emit({ ok: true, ...nextCompletion });
    };
    if (bootDelayMs > 0) setTimeout(boot, bootDelayMs);
    else queueMicrotask(boot);
  }

  terminate(): void {}

  private emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

beforeAll(async () => {
  installBrowserWorkerStub();
  nextCompletion = PROBE_COMPLETION;
  await installPyodideExecutionRuntime(5_000, new AbortController().signal);
});

afterEach(() => {
  nextCompletion = PROBE_COMPLETION;
  bootDelayMs = 0;
  neverCompletes = false;
  installBrowserWorkerStub();
});

describe("Python workspace egress", () => {
  it("refuses the control-plane write the job created and keeps the rest of the run", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "analysis complete\n",
      stderr: "",
      valueJson: "null",
      workspaceFiles: [
        { path: "/workspace/project/input.txt", bytes: new TextEncoder().encode("after\n") },
        { path: "/workspace/project/.git/config", bytes: new TextEncoder().encode("[core]\n") },
      ],
    };

    const result = await getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "import os\nos.makedirs('.git', exist_ok=True)",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    // The completed run keeps its exit code and streams; only the offending
    // path is dropped, and it is named rather than silently discarded.
    expect(result).toMatchObject({ exitCode: 0, stdout: "analysis complete\n" });
    expect(result.workspace?.refusedPaths).toEqual(["/workspace/project/.git/config"]);
    expect(result.workspace?.refusalReason).toMatch(/control-plane/u);
    expect(result.workspace?.changedPaths).toEqual(["/workspace/project/input.txt"]);
    expect(result.workspace?.writtenPaths).toEqual(["/workspace/project/input.txt"]);
    expect(result.workspace?.deletedPaths).toEqual([]);
    expect(await workspace.read("/workspace/project/.git/config")).toBeUndefined();
    expect(await workspace.read("/workspace/project/input.txt")).toMatchObject({ content: "after\n" });
  });

  it("refuses an excluded dependency segment and still rejects a path outside the mounted root", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      ...PROBE_COMPLETION,
      stdout: "",
      workspaceFiles: [
        { path: "/workspace/project/input.txt", bytes: new TextEncoder().encode("before\n") },
        { path: "/workspace/project/node_modules/pkg.json", bytes: new TextEncoder().encode("{}\n") },
      ],
    };
    const refusal = await getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "pass",
      workspace,
      workspaceRoot: "/workspace/project",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(refusal.exitCode).toBe(0);
    expect(refusal.workspace?.refusedPaths).toEqual(["/workspace/project/node_modules/pkg.json"]);
    expect(refusal.workspace?.refusalReason).toMatch(/node_modules/u);
    // A refused path is never laundered into a reported deletion.
    expect(refusal.workspace?.changedPaths).toEqual([]);
    expect(refusal.workspace?.deletedPaths).toEqual([]);

    nextCompletion = {
      ...PROBE_COMPLETION,
      stdout: "",
      workspaceFiles: [{ path: "/workspace/elsewhere/escaped.txt", bytes: new TextEncoder().encode("escaped\n") }],
    };
    await expect(getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "pass",
      workspace,
      workspaceRoot: "/workspace/project",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/outside its workspace root/u);
    expect(await workspace.read("/workspace/elsewhere/escaped.txt")).toBeUndefined();
  });

  it("still adopts ordinary changes with revision CAS", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      valueJson: "null",
      workspaceFiles: [{ path: "/workspace/project/input.txt", bytes: new TextEncoder().encode("after\n") }],
    };

    const result = await getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "pass",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(result.workspace).toMatchObject({
      changedPaths: ["/workspace/project/input.txt"],
      writtenPaths: ["/workspace/project/input.txt"],
      adopted: true,
    });
    expect(await workspace.read("/workspace/project/input.txt")).toMatchObject({ content: "after\n" });
  });
});

describe("Python workspace collection overflow", () => {
  it("keeps the run's exit code and output, adopts nothing, and reports the failure", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "analysis complete\n",
      stderr: "",
      valueJson: "null",
      workspaceError: "Python workspace collection failed: Python generated a file over 512 KiB: /workspace/project/big.bin",
    };

    const result = await getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "pass",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: "analysis complete\n" });
    expect(result.workspace).toMatchObject({
      mountedFiles: 1,
      changedPaths: [],
      writtenPaths: [],
      deletedPaths: [],
      adopted: false,
    });
    expect(result.workspace?.workspaceError).toContain("Python workspace collection failed");
    // The mounted file must not be reported or treated as deleted.
    expect(await workspace.read("/workspace/project/input.txt")).toMatchObject({ content: "before\n" });
  });
});

describe("Python cold-start budget", () => {
  it("does not charge the interpreter boot against the job timeout", async () => {
    bootDelayMs = 60;
    nextCompletion = { exitCode: 0, stdout: "booted\n", stderr: "", valueJson: "null" };

    const result = await runDisposablePyodide("print('booted')", [], {}, 40, new AbortController().signal);

    expect(result).toMatchObject({ exitCode: 0, stdout: "booted\n" });
    expect(result.bootMs ?? 0).toBeGreaterThanOrEqual(50);
  });

  it("still bounds execution once the interpreter is ready", async () => {
    neverCompletes = true;
    await expect(runDisposablePyodide("while True: pass", [], {}, 30, new AbortController().signal))
      .rejects.toThrow(/Python execution exceeded 30 ms/u);
  });

  it("bounds the boot by the caller's budget rather than the install default", async () => {
    bootDelayMs = 5_000;
    const started = Date.now();
    await expect(runDisposablePyodide("pass", [], {}, 1_000, new AbortController().signal, { bootTimeoutMs: 40 }))
      .rejects.toThrow(/Pyodide boot exceeded 40 ms/u);
    // The 30 s install default would have kept this pending far past the boot
    // budget the caller asked for.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("Pyodide activation budget", () => {
  it("fails install_execution_runtime at its own timeoutMs instead of the 30 s boot default", async () => {
    // A fresh module realm is required: the memoized install promise from the
    // suite's beforeAll would otherwise resolve immediately.
    vi.resetModules();
    installBrowserWorkerStub();
    bootDelayMs = 5_000;
    const tools = await import("./execution-tools");
    const started = Date.now();

    await expect(tools.installPyodideExecutionRuntime(120, new AbortController().signal))
      .rejects.toThrow(/exceeded 120 ms|Pyodide boot exceeded 120 ms/u);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(tools.getClientExecutionRuntime().capabilities()
      .find(({ id }) => id === "python-pyodide")?.state).toBe("failed");
  });
});

function installBrowserWorkerStub(): void {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("location", new URL("https://airship.test/"));
}
