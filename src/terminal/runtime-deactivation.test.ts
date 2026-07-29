import { describe, expect, it, vi } from "vitest";
import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import { MemoryWorkspace } from "../workspace/memory";
import type { WorkspacePort } from "../workspace/contracts";
import { executeExecutionTool } from "../tools/execution-tools";
import { getBrowserTerminalManager } from "./manager";

/*
 * The WebContainer instance is shared: the agent's execution runtime and
 * Workspace Terminal mount the same one. `deactivate_execution_runtime` owned
 * only the runtime half, so it tore the instance down while the terminal's
 * mount still held work that had never been reconciled into the workspace — and
 * the lifecycle event that tells the terminal it lost its host is published
 * after the instance is gone, far too late to save anything. The deletion was
 * silent, which is the part that made it dangerous.
 *
 * The tool and the terminal do NOT hold the same workspace object, so these
 * tests hand the tool a facade rather than the provider the terminal is keyed
 * by. A quiesce addressed by workspace identity passes when both sides share
 * one object and is a silent no-op in the real app; only the facade reproduces
 * production.
 */

/**
 * Stand-in for `ClientContextRuntime.observeWorkspace()` wrapped in
 * `GitSynchronizedWorkspace`: same reads and writes, different object identity.
 */
function toolFacade(workspace: MemoryWorkspace): WorkspacePort {
  return Object.freeze({
    read: (path: string) => workspace.read(path),
    list: (path?: string) => workspace.list(path),
    write: (path: string, content: string, options?: { expectedRevision?: string | null }) =>
      workspace.write(path, content, options),
    remove: (path: string, options?: { expectedRevision?: string }) => workspace.remove(path, options),
  });
}

let mounted: FileSystemTree = {};

vi.mock("../execution/node-webcontainer-pack", () => ({
  activateNodeWebContainerHost: async () => host,
  getNodeWebContainerHostGeneration: () => 1,
  subscribeNodeWebContainerLifecycle: () => () => undefined,
}));

const host = {
  fs: {
    async mkdir() { return undefined; },
    async rm() { mounted = {}; },
  },
  async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
  async export() { return structuredClone(mounted); },
  async spawn() {
    let closeOutput!: () => void;
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
    return {
      exit,
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { closeOutput = () => controller.close(); } }),
      kill() { closeOutput(); resolveExit(130); },
      resize() {},
    };
  },
} as unknown as WebContainer;

function context() {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    operationId: "operation-1",
    signal: new AbortController().signal,
  };
}

describe("deactivate_execution_runtime and the shared terminal mount", () => {
  it("reconciles unreconciled terminal work before tearing the shared runtime down, and names what it saved", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/README.md", "mounted\n", { expectedRevision: null });
    // The manager must come from the page-global registry, keyed by the raw
    // provider exactly as the Terminal route keys it.
    const manager = getBrowserTerminalManager(workspace);
    await manager.ready;
    await manager.start(manager.list()[0]!.id);
    // Stand in for work typed into the terminal: it exists only in the shared
    // instance's mount until something reconciles it back.
    mounted["notes.txt"] = { file: { contents: "written inside the terminal\n" } };

    const result = await executeExecutionTool(
      "deactivate_execution_runtime",
      { runtime: "node-webcontainer" },
      context(),
      // The tool never sees the provider the terminal is keyed by, so it must
      // find the terminal through the shared host it holds, not this object.
      toolFacade(workspace),
    );

    expect((await workspace.read("/workspace/notes.txt"))?.content).toBe("written inside the terminal\n");
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("/workspace/notes.txt");
    expect((result.metadata as Record<string, unknown> | undefined)?.reconciledTerminalPaths).toEqual(["/workspace/notes.txt"]);
    expect(manager.list()[0]).toMatchObject({ status: "restart-required" });
  });

  // Nothing holds the shared instance here, so the quiesce must cost nothing
  // rather than tearing down terminals belonging to some other workspace.
  it("does not fail deactivation when no terminal ever mounted the shared runtime", async () => {
    const workspace = new MemoryWorkspace();

    const result = await executeExecutionTool(
      "deactivate_execution_runtime",
      { runtime: "node-webcontainer" },
      context(),
      toolFacade(workspace),
    );

    expect(result.isError).not.toBe(true);
    expect((result.metadata as Record<string, unknown> | undefined)?.reconciledTerminalPaths).toEqual([]);
  });
});
