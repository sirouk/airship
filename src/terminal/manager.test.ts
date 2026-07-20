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
      version: 1,
      sessions: [{
        id: "terminal-live",
        name: "Prior process",
        cwd: "/workspace",
        status: "running",
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:01:00.000Z",
        history: ["npm test"],
        detail: "running",
      }],
    })}\n`, { expectedRevision: null });
    const manager = new BrowserTerminalManager(workspace);
    await manager.ready;

    expect(manager.list()[0]).toMatchObject({ status: "restart-required" });
    expect(manager.list()[0]?.detail).toContain("never survive reload");
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
      fs: { async mkdir() { return undefined; } },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return mounted; },
      async spawn() { return process; },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;

    await manager.start(tab.id, { cols: 120, rows: 40 });
    expect(manager.list()[0]).toMatchObject({ status: "running" });
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
});
