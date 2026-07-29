import { describe, expect, it, vi } from "vitest";
import {
  ClientExecutionRuntime,
  deriveBrowserExecutionTier,
  type ExecutionAdapter,
} from "./runtime-registry";

const javascriptAdapter: ExecutionAdapter = {
  capability: {
    id: "javascript-worker",
    label: "JavaScript",
    languages: ["javascript"],
    state: "ready",
    tier: "web-baseline",
    isolation: "disposable-worker",
    persistence: "ephemeral",
    commandInterface: "javascript-function",
    shell: "none",
    workspaceAccess: "none",
    output: "bounded-stream",
    cancellation: "terminate-worker",
    detail: "test adapter",
  },
  async execute(request) {
    return {
      runtime: "javascript-worker",
      exitCode: 0,
      stdout: request.code ?? "",
      stderr: "",
      value: 42,
      provenance: { capabilityTier: "web-baseline", authority: "browser", engine: "test", artifactKind: "source" },
    };
  },
};

describe("ClientExecutionRuntime", () => {
  it("promotes only a genuinely ready enhanced runtime", () => {
    expect(deriveBrowserExecutionTier([
      { state: "ready", tier: "web-baseline" },
      { state: "installable", tier: "web-enhanced" },
    ])).toBe("web-baseline");
    expect(deriveBrowserExecutionTier([
      { state: "ready", tier: "web-baseline" },
      { state: "ready", tier: "web-enhanced" },
    ])).toBe("web-enhanced");
  });

  it("reports installed and optional runtimes without claiming that packs are ready", () => {
    const runtime = new ClientExecutionRuntime([{
      id: "python-pyodide",
      label: "Python",
      languages: ["python"],
      state: "installable",
      tier: "web-enhanced",
      isolation: "dedicated-worker",
      persistence: "workspace-checkpoint",
      commandInterface: "python-job",
      shell: "none",
      workspaceAccess: "bounded-snapshot-writeback",
      output: "bounded-stream",
      cancellation: "terminate-worker",
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
      tier: "web-enhanced",
      isolation: "dedicated-worker",
      persistence: "workspace-checkpoint",
      commandInterface: "python-job",
      shell: "none",
      workspaceAccess: "bounded-snapshot-writeback",
      output: "bounded-stream",
      cancellation: "terminate-worker",
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
      tier: "web-enhanced",
      isolation: "webcontainer",
      persistence: "workspace-checkpoint",
      commandInterface: "direct-process",
      shell: "webcontainer-jsh",
      workspaceAccess: "bounded-snapshot-writeback",
      output: "bounded-stream",
      cancellation: "kill-process",
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

  it("names the host condition that blocked an advertised runtime, and what would change it", () => {
    // A page that is not cross-origin isolated is the shipped reason
    // node-webcontainer cannot boot. The route used to answer that with "No
    // activation path is advertised by this release" — a claim about the build,
    // when the blocker was the page.
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("document", {});
    vi.stubGlobal("crossOriginIsolated", false);
    try {
      const blocked = new ClientExecutionRuntime().capabilities().find(({ id }) => id === "node-webcontainer");
      expect(blocked?.state).toBe("unavailable");
      expect(blocked?.blocker?.condition).toBe("This page is not cross-origin isolated.");
      expect(blocked?.blocker?.remedy).toContain("COOP");
      // The condition is stated once and carried in both places, so a surface
      // never has to parse it back out of the prose.
      expect(blocked?.detail).toContain("This page is not cross-origin isolated.");

      vi.stubGlobal("crossOriginIsolated", true);
      const offered = new ClientExecutionRuntime().capabilities().find(({ id }) => id === "node-webcontainer");
      expect(offered?.state).toBe("installable");
      expect(offered?.blocker).toBeUndefined();

      // wasix is unavailable because this release does not promote it. No host
      // condition may overwrite that with something the reader could "fix".
      vi.stubGlobal("crossOriginIsolated", false);
      const unadvertised = new ClientExecutionRuntime().capabilities().find(({ id }) => id === "wasix");
      expect(unadvertised?.state).toBe("unavailable");
      expect(unadvertised?.blocker).toBeUndefined();
      expect(unadvertised?.detail).not.toContain("This page is not cross-origin isolated.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a pack result that spoofs another runtime identity", async () => {
    const runtime = new ClientExecutionRuntime([]);
    runtime.register({
      ...javascriptAdapter,
      async execute() {
        return {
          runtime: "wasi-preview1",
          exitCode: 0,
          stdout: "",
          stderr: "",
          provenance: { capabilityTier: "web-baseline", authority: "browser", engine: "spoof", artifactKind: "wasi-command" },
        };
      },
    });
    await expect(runtime.execute({
      runtime: "javascript-worker",
      code: "42",
      timeoutMs: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow(/mismatched runtime identity/u);
  });

  it("rejects result provenance that promotes the registered capability tier", async () => {
    const runtime = new ClientExecutionRuntime([]);
    runtime.register({
      ...javascriptAdapter,
      async execute() {
        return {
          runtime: "javascript-worker",
          exitCode: 0,
          stdout: "",
          stderr: "",
          provenance: { capabilityTier: "web-enhanced", authority: "browser", engine: "spoof", artifactKind: "source" },
        };
      },
    });
    await expect(runtime.execute({
      runtime: "javascript-worker",
      code: "42",
      timeoutMs: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow(/provenance/u);
  });
});
