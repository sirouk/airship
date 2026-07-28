import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../core/contracts";
import { encodeWorkspaceBytes } from "../workspace/content-codec";
import { MemoryWorkspace } from "../workspace/memory";
import { executeExecutionTool } from "./execution-tools";

type RunMessage = Readonly<{ wasm: Uint8Array; args: readonly string[]; collectWorkspace: boolean }>;

const ARTIFACT = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xfe]);

const context: ToolContext = {
  sessionId: "artifact-session",
  turnId: "artifact-turn",
  operationId: "artifact-operation",
  capabilityTier: "web-baseline",
  signal: new AbortController().signal,
};

let nextCompletion: Record<string, unknown> = { type: "completed", exitCode: 0, stdout: "", stderr: "" };
let observedRun: RunMessage | undefined;

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  postMessage(message: RunMessage): void {
    observedRun = message;
    queueMicrotask(() => this.onmessage?.({ data: nextCompletion } as MessageEvent));
  }

  terminate(): void {}
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("location", new URL("https://airship.test/"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  observedRun = undefined;
  nextCompletion = { type: "completed", exitCode: 0, stdout: "", stderr: "" };
});

describe("execute_code artifact channel", () => {
  it("runs a workspace-resident command artifact without inline base64", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/tools/hello.wasm", encodeWorkspaceBytes(ARTIFACT));
    nextCompletion = { type: "completed", exitCode: 0, stdout: "hello\n", stderr: "" };

    const result = await executeExecutionTool("execute_code", {
      runtime: "wasi-preview1",
      wasmPath: "tools/hello.wasm",
      args: ["--version"],
    }, context, workspace);

    expect(observedRun?.wasm).toEqual(ARTIFACT);
    expect(observedRun?.collectWorkspace).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ runtime: "wasi-preview1", exitCode: 0, stdout: "hello\n" });
    expect(result.isError).toBe(false);
  });

  it("requires exactly one artifact channel for WASI", async () => {
    await expect(executeExecutionTool("execute_code", {
      runtime: "wasi-preview1",
      wasmBase64: "AAAAAAAAAAAA",
      wasmPath: "tools/hello.wasm",
    }, context)).rejects.toThrow(/exactly one precompiled command artifact/u);

    await expect(executeExecutionTool("execute_code", {
      runtime: "wasi-preview1",
    }, context)).rejects.toThrow(/exactly one precompiled command artifact/u);
    expect(observedRun).toBeUndefined();
  });

  it("does not open the artifact path to the other runtimes", async () => {
    await expect(executeExecutionTool("execute_code", {
      runtime: "javascript-worker",
      code: "return 42;",
      wasmPath: "tools/hello.wasm",
    }, context)).rejects.toThrow(/accepts only code and timeoutMs/u);

    await expect(executeExecutionTool("execute_code", {
      runtime: "python-pyodide",
      code: "print(42)",
      wasmPath: "tools/hello.wasm",
    }, context)).rejects.toThrow(/not a WASI artifact/u);
    expect(observedRun).toBeUndefined();
  });

  it("fails closed when no workspace is bound to resolve the artifact path", async () => {
    await expect(executeExecutionTool("execute_code", {
      runtime: "wasi-preview1",
      wasmPath: "tools/hello.wasm",
    }, context)).rejects.toThrow(/no bound Airship workspace/u);
    expect(observedRun).toBeUndefined();
  });

  it("reports a run whose generated files could not be collected as an error", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/tool.wasm", encodeWorkspaceBytes(ARTIFACT));
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      type: "completed",
      exitCode: 0,
      stdout: "finished\n",
      stderr: "",
      workspaceError: "WASI output file exceeds 512 KiB: big.bin",
    };

    const result = await executeExecutionTool("execute_code", {
      runtime: "wasi-preview1",
      wasmPath: "project/tool.wasm",
      workspaceRoot: "/workspace/project",
      writeBack: true,
    }, context, workspace);

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ workspaceError: "WASI output file exceeds 512 KiB: big.bin" });
    expect(JSON.parse(result.content)).toMatchObject({
      exitCode: 0,
      workspace: { adopted: false, changedPaths: [], writtenPaths: [] },
    });
    expect(await workspace.read("/workspace/project/input.txt")).toMatchObject({ content: "before\n" });
  });
});
