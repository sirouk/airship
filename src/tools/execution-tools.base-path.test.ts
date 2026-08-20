import { afterEach, describe, expect, it, vi } from "vitest";

let constructedWorker: Readonly<{ url: unknown; options?: WorkerOptions }> | undefined;

class CompletingWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: unknown, options?: WorkerOptions) {
    constructedWorker = Object.freeze({ url, options });
  }

  postMessage(): void {
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: "ready" } } as MessageEvent);
      this.onmessage?.({
        data: {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          valueJson: "42",
        },
      } as MessageEvent);
    });
  }

  terminate(): void {}
}

afterEach(() => {
  constructedWorker = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each([
  { base: "/", expectedBase: "https://airship.test/execution-packs/pyodide/" },
  { base: "/airship/", expectedBase: "https://airship.test/airship/execution-packs/pyodide/" },
])("disposable Pyodide under Vite base $base", ({ base, expectedBase }) => {
  it("runs through a module Worker whose generated source carries only the pinned same-origin pack", async () => {
    vi.stubEnv("BASE_URL", base);
    vi.stubGlobal("location", new URL("https://airship.test/caller/controlled/route?assetBase=https://attacker.test/"));
    vi.stubGlobal("Worker", CompletingWorker);
    const hostFetch = vi.fn(() => Promise.reject(new Error("The host must not preflight the worker-owned module.")));
    vi.stubGlobal("fetch", hostFetch);
    let workerBlob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
      workerBlob = value as Blob;
      return "blob:https://airship.test/disposable-pyodide";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.resetModules();
    const { runDisposablePyodide } = await import("./execution-tools");

    const result = await runDisposablePyodide(
      "40 + 2",
      [],
      {},
      1_000,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ runtime: "python-pyodide", exitCode: 0, value: 42 });
    expect(constructedWorker).toMatchObject({
      url: "blob:https://airship.test/disposable-pyodide",
      options: { name: "airship-python-pyodide", type: "module" },
    });
    expect(workerBlob).toBeInstanceOf(Blob);
    const source = await workerBlob!.text();
    expect(source).toContain(`const PYODIDE_MODULE = ${JSON.stringify(`${expectedBase}pyodide.mjs`)};`);
    expect(source).toContain(`const PYODIDE_BASE = ${JSON.stringify(expectedBase)};`);
    expect(source).toContain("const module = await import(PYODIDE_MODULE);");
    expect(source).not.toContain("/caller/controlled/route");
    expect(source).not.toContain("attacker.test");
    expect(hostFetch).not.toHaveBeenCalled();
  });
});

describe.each([
  { label: "cross-origin URL", base: "https://cdn.attacker.test/airship/" },
  { label: "network-path URL", base: "//cdn.attacker.test/airship/" },
  { label: "relative path", base: "airship/" },
  { label: "missing trailing slash", base: "/airship" },
  { label: "query-bearing path", base: "/airship/?pack=attacker" },
  { label: "non-canonical parent segment", base: "/airship/../" },
  { label: "duplicate path separator", base: "/airship//" },
])("invalid Vite base: $label", ({ base }) => {
  it("fails closed before Worker construction", async () => {
    vi.stubEnv("BASE_URL", base);
    vi.stubGlobal("location", new URL("https://airship.test/airship/"));
    vi.stubGlobal("Worker", CompletingWorker);
    vi.resetModules();
    const { runDisposablePyodide } = await import("./execution-tools");

    await expect(runDisposablePyodide(
      "40 + 2",
      [],
      {},
      1_000,
      new AbortController().signal,
    )).rejects.toThrow(/valid Vite-pinned same-origin deployment base/u);
    expect(constructedWorker).toBeUndefined();
  });
});
