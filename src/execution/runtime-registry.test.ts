import { describe, expect, it } from "vitest";
import { ClientExecutionRuntime, type ExecutionAdapter } from "./runtime-registry";

const javascriptAdapter: ExecutionAdapter = {
  capability: {
    id: "javascript-worker",
    label: "JavaScript",
    languages: ["javascript"],
    state: "ready",
    isolation: "disposable-worker",
    persistence: "ephemeral",
    detail: "test adapter",
  },
  async execute(request) {
    return { runtime: "javascript-worker", exitCode: 0, stdout: request.code ?? "", stderr: "", value: 42 };
  },
};

describe("ClientExecutionRuntime", () => {
  it("reports installed and optional runtimes without claiming that packs are ready", () => {
    const runtime = new ClientExecutionRuntime([{
      id: "python-pyodide",
      label: "Python",
      languages: ["python"],
      state: "installable",
      isolation: "dedicated-worker",
      persistence: "workspace-checkpoint",
      detail: "lazy pack",
    }]);
    runtime.register(javascriptAdapter);

    expect(runtime.capabilities()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "javascript-worker", state: "ready" }),
      expect.objectContaining({ id: "python-pyodide", state: "unavailable" }),
    ]));
  });

  it("routes execution only to a registered ready adapter", async () => {
    const runtime = new ClientExecutionRuntime([]);
    runtime.register(javascriptAdapter);
    const result = await runtime.execute({
      runtime: "javascript-worker",
      code: "answer",
      timeoutMs: 100,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "answer", value: 42 });
  });

  it("does not let an optional-pack label become an executable capability", async () => {
    const runtime = new ClientExecutionRuntime([{
      id: "python-pyodide",
      label: "Python",
      languages: ["python"],
      state: "installable",
      isolation: "dedicated-worker",
      persistence: "workspace-checkpoint",
      detail: "lazy pack",
    }]);
    await expect(runtime.execute({
      runtime: "python-pyodide",
      code: "print(42)",
      timeoutMs: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow(/unavailable|not installed/u);
  });

  it("rejects duplicate and non-ready adapter registrations", () => {
    const runtime = new ClientExecutionRuntime([]);
    runtime.register(javascriptAdapter);
    expect(() => runtime.register(javascriptAdapter)).toThrow(/already registered/u);
    expect(() => runtime.register({
      ...javascriptAdapter,
      capability: { ...javascriptAdapter.capability, id: "python-pyodide", state: "installable" },
    })).toThrow(/must report ready/u);
  });

  it("keeps optional activation lifecycle honest until a ready adapter registers", () => {
    const runtime = new ClientExecutionRuntime([{
      id: "node-webcontainer",
      label: "Node",
      languages: ["node"],
      state: "installable",
      isolation: "webcontainer",
      persistence: "workspace-checkpoint",
      detail: "cold",
    }]);
    runtime.setOptionalState("node-webcontainer", "activating", "booting");
    expect(runtime.capabilities()).toContainEqual(expect.objectContaining({
      id: "node-webcontainer",
      state: "activating",
      detail: "booting",
    }));
    runtime.setOptionalState("node-webcontainer", "failed", "provider refused boot");
    expect(runtime.capabilities()).toContainEqual(expect.objectContaining({
      id: "node-webcontainer",
      state: "failed",
      detail: "provider refused boot",
    }));
    runtime.clearOptionalState("node-webcontainer");
    expect(runtime.capabilities()).toContainEqual(expect.objectContaining({
      id: "node-webcontainer",
      state: "unavailable",
    }));
  });

  it("rejects a pack result that spoofs another runtime identity", async () => {
    const runtime = new ClientExecutionRuntime([]);
    runtime.register({
      ...javascriptAdapter,
      async execute() {
        return { runtime: "wasi-preview1", exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await expect(runtime.execute({
      runtime: "javascript-worker",
      code: "42",
      timeoutMs: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow(/mismatched runtime identity/u);
  });
});
