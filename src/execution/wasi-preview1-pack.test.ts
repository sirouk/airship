import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWorkspaceBytes } from "../workspace/content-codec";
import { MemoryWorkspace } from "../workspace/memory";
import { WASI_PREVIEW1_MAX_ARTIFACT_BYTES } from "./wasi-preview1-contract";
import { createWasiPreview1Adapter, runDisposableWasi } from "./wasi-preview1-pack";

type RunMessage = Readonly<{
  type: "run";
  wasm: Uint8Array;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  collectWorkspace: boolean;
}>;

type Completion = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  files?: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  workspaceError?: string;
}>;

const ARTIFACT = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0x00]);

let nextCompletion: Completion;
let observedRun: RunMessage | undefined;

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  postMessage(message: RunMessage): void {
    observedRun = message;
    queueMicrotask(() => {
      const { files, workspaceError, ...rest } = nextCompletion;
      this.emit({
        type: "completed",
        ...rest,
        ...(workspaceError !== undefined ? { workspaceError } : files ? { files } : {}),
      });
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

describe("WASI Preview 1 artifact channel", () => {
  it("runs a precompiled artifact referenced by workspace path instead of inline base64", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/tools/hello.wasm", encodeWorkspaceBytes(ARTIFACT));
    nextCompletion = { exitCode: 0, stdout: "ready\n", stderr: "" };

    const result = await createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/tools/hello.wasm",
      workspace,
      args: ["--version"],
      env: {},
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(observedRun?.wasm).toEqual(ARTIFACT);
    expect(observedRun?.collectWorkspace).toBe(false);
    expect(result).toMatchObject({ runtime: "wasi-preview1", exitCode: 0, stdout: "ready\n" });
    expect(result.workspace).toBeUndefined();
  });

  it("requires exactly one artifact channel", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/tools/hello.wasm", encodeWorkspaceBytes(ARTIFACT));

    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmBase64: "AGFzbQEAAAA=",
      wasmPath: "/workspace/tools/hello.wasm",
      workspace,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/exactly one of wasmBase64 or wasmPath/u);

    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/exactly one of wasmBase64 or wasmPath/u);
    expect(observedRun).toBeUndefined();
  });

  it("refuses a workspace path artifact without a bound workspace", async () => {
    installBrowserWorkerStub();
    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/tools/hello.wasm",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/requires a bound Airship workspace/u);
    expect(observedRun).toBeUndefined();
  });

  it("keeps the control-plane and excluded segments out of the artifact channel", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/.git/hooks/payload.wasm", encodeWorkspaceBytes(ARTIFACT));
    await workspace.write("/workspace/node_modules/.bin/payload.wasm", encodeWorkspaceBytes(ARTIFACT));

    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/.git/hooks/payload.wasm",
      workspace,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/excludes control-plane path/u);

    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/node_modules/.bin/payload.wasm",
      workspace,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/excludes the node_modules path segment/u);
    expect(observedRun).toBeUndefined();
  });

  it("fails closed on a missing artifact and on one over the 4 MiB artifact budget", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    const oversized = new Uint8Array(WASI_PREVIEW1_MAX_ARTIFACT_BYTES + 1).fill(0xff);
    await workspace.write("/workspace/tools/huge.wasm", encodeWorkspaceBytes(oversized));

    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/tools/absent.wasm",
      workspace,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/not in the workspace/u);

    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/tools/huge.wasm",
      workspace,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/4 MiB artifact limit/u);
    expect(observedRun).toBeUndefined();
  });

  it("mounts a workspace whose own artifact exceeds the per-file mount cap", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    const large = new Uint8Array(600 * 1_024).fill(0xab);
    await workspace.write("/workspace/project/tool.wasm", encodeWorkspaceBytes(large));
    await workspace.write("/workspace/project/input.txt", "mounted\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      files: [{ path: "input.txt", bytes: new TextEncoder().encode("mounted\n") }],
    };

    const result = await createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/project/tool.wasm",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(observedRun?.wasm.byteLength).toBe(large.byteLength);
    expect(observedRun?.files).toEqual([{ path: "input.txt", bytes: new TextEncoder().encode("mounted\n") }]);
    expect(observedRun?.collectWorkspace).toBe(true);
    expect(result.workspace).toMatchObject({ mountedFiles: 1, changedPaths: [], adopted: false });
  });

  it("keeps a completed run's exit code when its generated files exceed the mount budget", async () => {
    installBrowserWorkerStub();
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "before\n");
    nextCompletion = {
      exitCode: 0,
      stdout: "work finished\n",
      stderr: "",
      workspaceError: "WASI output file exceeds 512 KiB: artifact.bin",
    };

    const result = await createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmBase64: "AGFzbQEAAAA=",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: "work finished\n" });
    expect(result.workspace).toMatchObject({
      mountedFiles: 1,
      changedPaths: [],
      writtenPaths: [],
      deletedPaths: [],
      adopted: false,
      workspaceError: "WASI output file exceeds 512 KiB: artifact.bin",
    });
    expect(await workspace.read("/workspace/project/input.txt")).toMatchObject({ content: "before\n" });
  });

  it("rejects workspace state returned for an unmounted run", async () => {
    installBrowserWorkerStub();
    nextCompletion = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      files: [{ path: "scratch.txt", bytes: new TextEncoder().encode("unexpected\n") }],
    };

    await expect(createWasiPreview1Adapter().execute({
      runtime: "wasi-preview1",
      wasmBase64: "AGFzbQEAAAA=",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/workspace state for an unmounted run/u);
  });

  it("still accepts the base64 entry point used by the browser execution gate", async () => {
    installBrowserWorkerStub();
    nextCompletion = { exitCode: 7, stdout: "gate\n", stderr: "" };

    const result = await runDisposableWasi(
      "AGFzbQEAAAA=",
      ["--version"],
      { AIRSHIP_TEST: "true" },
      1_000,
      new AbortController().signal,
    );

    expect(observedRun?.wasm).toEqual(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    expect(result).toMatchObject({ exitCode: 7, stdout: "gate\n", workspaceFiles: [] });
  });
});

function installBrowserWorkerStub(): void {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("location", new URL("https://airship.test/"));
}
