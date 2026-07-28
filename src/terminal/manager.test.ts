import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { TERMINAL_METADATA_PATH } from "./contracts";
import { BrowserTerminalManager } from "./manager";
import type { FileSystemTree, WebContainer } from "@webcontainer/api";

describe("BrowserTerminalManager metadata", () => {
  it("persists tab/thread/history metadata without claiming a process survives reload", async () => {
    vi.useFakeTimers();
    const workspace = new MemoryWorkspace();
    const manager = new BrowserTerminalManager(workspace);
    await manager.ready;
    const created = manager.create({ name: "Build", threadId: "session-123", cwd: "/workspace/src" });
    await vi.waitFor(async () => expect(await workspace.read(TERMINAL_METADATA_PATH)).toBeDefined());
    const file = await workspace.read(TERMINAL_METADATA_PATH);
    expect(file?.content).not.toContain("bufferedOutput");
    expect(file?.content).toContain("session-123");

    const restored = new BrowserTerminalManager(workspace);
    await restored.ready;
    expect(restored.list().find(({ id }) => id === created.id)).toMatchObject({
      name: "Build",
      threadId: "session-123",
      cwd: "/workspace/src",
      status: "idle",
      bufferedOutput: "",
    });
    vi.useRealTimers();
  });

  it("converts persisted running claims into an explicit restart-required state", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write(TERMINAL_METADATA_PATH, `${JSON.stringify({
      version: 2,
      sessions: [{
        id: "terminal-live",
        name: "Prior process",
        cwd: "/workspace",
        status: "running",
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:01:00.000Z",
        history: ["npm test"],
        detail: "running",
        transcriptTail: "$ npm test\r\n42 passed\r\n",
      }],
    })}\n`, { expectedRevision: null });
    const manager = new BrowserTerminalManager(workspace);
    await manager.ready;

    expect(manager.list()[0]).toMatchObject({ status: "restart-required" });
    expect(manager.list()[0]?.detail).toContain("fresh browser process");
    expect(manager.list()[0]?.bufferedOutput).toContain("42 passed");
    expect(manager.list()[0]?.bufferedOutput).toContain("prior browser process ended with the page");
  });

  it("persists only a bounded encrypted transcript tail and reconstructs it after refresh", async () => {
    const workspace = new MemoryWorkspace();
    const manager = new BrowserTerminalManager(workspace);
    await manager.ready;
    const tab = manager.list()[0]!;
    manager.recordBridgeCommand(tab.id, "git status", `${"x".repeat(80 * 1_024)}\nfinal-marker\n`);

    await vi.waitFor(async () => {
      const content = (await workspace.read(TERMINAL_METADATA_PATH))?.content;
      expect(content).toBeDefined();
      const persisted = JSON.parse(content!) as { sessions: Array<{ transcriptTail: string }> };
      expect(persisted.sessions[0]?.transcriptTail).toMatch(/^airship-terminal-utf8-base64-v1:.+/u);
    });
    const stored = JSON.parse((await workspace.read(TERMINAL_METADATA_PATH))!.content) as {
      version: number;
      sessions: Array<{ transcriptTail: string }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.sessions[0]!.transcriptTail).toMatch(/^airship-terminal-utf8-base64-v1:/u);
    expect(stored.sessions[0]!.transcriptTail.length).toBeLessThan(88 * 1_024);

    const restored = new BrowserTerminalManager(workspace);
    await restored.ready;
    expect(restored.list()[0]?.bufferedOutput).toContain("final-marker");
    expect(restored.list()[0]?.history).toEqual(["git status"]);
  });

  it("renames a tab inline and persists the bounded name", async () => {
    const workspace = new MemoryWorkspace();
    const manager = new BrowserTerminalManager(workspace);
    await manager.ready;
    const tab = manager.list()[0]!;

    expect(manager.rename(tab.id, "  Release console  ")).toMatchObject({ name: "Release console" });
    expect(() => manager.rename(tab.id, "   ")).toThrow("Terminal tab name is invalid");
    await vi.waitFor(async () => expect((await workspace.read(TERMINAL_METADATA_PATH))?.content).toContain("Release console"));

    const restored = new BrowserTerminalManager(workspace);
    await restored.ready;
    expect(restored.list()[0]?.name).toBe("Release console");
  });

  it("owns a real interactive process lifecycle with input, resize, interrupt, and close", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "mounted\n", { expectedRevision: null });
    const input: string[] = [];
    const sizes: Array<{ cols: number; rows: number }> = [];
    let killed = false;
    let mounted: FileSystemTree = {};
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const process = {
      exit,
      input: new WritableStream<string>({ write(chunk) { input.push(chunk); } }),
      output: new ReadableStream<string>({ start(controller) { controller.enqueue("Airship jsh ready\r\n"); } }),
      kill() { killed = true; resolveExit(130); },
      resize(size: { cols: number; rows: number }) { sizes.push(size); },
    };
    const host = {
      fs: {
        async mkdir() { return undefined; },
        async rm() { mounted = {}; },
      },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return mounted; },
      async spawn() { return process; },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;

    await manager.start(tab.id, { cols: 120, rows: 40 });
    expect(manager.list()[0]).toMatchObject({ status: "running" });
    await vi.waitFor(async () => {
      const content = (await workspace.read(TERMINAL_METADATA_PATH))?.content;
      expect(content).toBeDefined();
      const persisted = JSON.parse(content!) as { sessions: Array<{ transcriptTail: string }> };
      expect(persisted.sessions[0]?.transcriptTail).toMatch(/^airship-terminal-utf8-base64-v1:.+/u);
    });
    await manager.write(tab.id, "npm test\r");
    await manager.interrupt(tab.id);
    manager.resize(tab.id, { cols: 140, rows: 50 });
    expect(input).toEqual(["npm test\r", "\x03"]);
    expect(sizes).toEqual([{ cols: 140, rows: 50 }]);
    expect(manager.list()[0]?.history).toEqual(["npm test"]);
    await vi.waitFor(async () => expect((await workspace.read(TERMINAL_METADATA_PATH))?.content).toContain("npm test"));

    await manager.close(tab.id);
    expect(killed).toBe(true);
    expect(manager.list()).toEqual([]);
  });

  it("kills a partially started process when its input writer cannot be acquired", async () => {
    const workspace = new MemoryWorkspace();
    let killed = false;
    const input = new WritableStream<string>();
    const lock = input.getWriter();
    const process = {
      exit: new Promise<number>(() => undefined),
      input,
      output: new ReadableStream<string>(),
      kill() { killed = true; },
      resize() {},
    };
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { return undefined; } },
      async mount() {},
      async export() { return {}; },
      async spawn() { return process; },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;

    await manager.start(manager.list()[0]!.id);

    expect(killed).toBe(true);
    expect(manager.list()[0]).toMatchObject({ status: "failed" });
    expect(manager.list()[0]?.detail).toContain("locked");
    lock.releaseLock();
    await manager.quiesce("test cleanup");
  });

  it("fails and kills a live process when its terminal output stream errors", async () => {
    const workspace = new MemoryWorkspace();
    let killed = false;
    const process = {
      exit: new Promise<number>(() => undefined),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({
        start(controller) { controller.error(new Error("provider output disconnected")); },
      }),
      kill() { killed = true; },
      resize() {},
    };
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { return undefined; } },
      async mount() {},
      async export() { return {}; },
      async spawn() { return process; },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;

    await manager.start(manager.list()[0]!.id);
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe("failed"));

    expect(killed).toBe(true);
    expect(manager.list()[0]?.detail).toContain("provider output disconnected");
    expect(manager.list()[0]?.bufferedOutput).toContain("Terminal output failed");
    await manager.quiesce("test cleanup");
  });

  it("invalidates every live terminal when the shared WebContainer is torn down", async () => {
    const workspace = new MemoryWorkspace();
    let generation = 1;
    let lifecycleListener: ((event: { generation: number; state: "ready" | "inactive"; reason: "activated" | "deactivated" }) => void) | undefined;
    const process = {
      exit: new Promise<number>(() => undefined),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>(),
      kill() {},
      resize() {},
    };
    const host = {
      fs: { async mkdir() { return undefined; } },
      async mount() {},
      async spawn() { return process; },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, {
      activateHost: async () => host,
      hostLifecycle: {
        generation: () => generation,
        subscribe(listener) { lifecycleListener = listener; return () => { lifecycleListener = undefined; }; },
      },
    });
    await manager.ready;
    const terminal = manager.list()[0]!;
    await manager.start(terminal.id);
    expect(manager.list()[0]?.status).toBe("running");

    generation = 2;
    lifecycleListener?.({ generation, state: "inactive", reason: "deactivated" });
    expect(manager.list()[0]).toMatchObject({ status: "restart-required" });
    expect(manager.list()[0]?.detail).toContain("fresh isolated host");
    expect(manager.list()[0]?.bufferedOutput).toContain("requires restart");
  });

  it("reconciles and revokes the prior workspace before the page-global host is remounted", async () => {
    const firstWorkspace = new MemoryWorkspace();
    const secondWorkspace = new MemoryWorkspace();
    await firstWorkspace.write("/workspace/first.txt", "first\n", { expectedRevision: null });
    await secondWorkspace.write("/workspace/second.txt", "second\n", { expectedRevision: null });
    let mounted: FileSystemTree = {};
    const killed: boolean[] = [];
    const host = {
      fs: {
        async mkdir() { return undefined; },
        async rm() { mounted = {}; },
      },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
      async spawn() {
        const index = killed.push(false) - 1;
        let closeOutput!: () => void;
        let resolveExit!: (code: number) => void;
        const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
        return {
          exit,
          input: new WritableStream<string>(),
          output: new ReadableStream<string>({ start(controller) { closeOutput = () => controller.close(); } }),
          kill() { killed[index] = true; closeOutput(); resolveExit(130); },
          resize() {},
        };
      },
    } as unknown as WebContainer;
    const first = new BrowserTerminalManager(firstWorkspace, { activateHost: async () => host });
    const second = new BrowserTerminalManager(secondWorkspace, { activateHost: async () => host });
    await Promise.all([first.ready, second.ready]);
    await first.start(first.list()[0]!.id);

    await second.start(second.list()[0]!.id);

    expect(killed[0]).toBe(true);
    expect(first.list()[0]).toMatchObject({ status: "restart-required" });
    expect(first.list()[0]?.detail).toContain("Another workspace acquired");
    expect(second.list()[0]).toMatchObject({ status: "running" });
    expect(treeText(mounted, "second.txt")).toBe("second\n");
    expect(treeText(mounted, "first.txt")).toBeUndefined();

    await first.syncWorkspace();
    expect(treeText(mounted, "second.txt")).toBe("second\n");
    await second.close(second.list()[0]!.id);
  });
});

function treeText(tree: FileSystemTree, name: string): string | undefined {
  const node = tree[name];
  if (!node || !("file" in node) || !("contents" in node.file)) return undefined;
  return typeof node.file.contents === "string"
    ? node.file.contents
    : new TextDecoder().decode(node.file.contents);
}
