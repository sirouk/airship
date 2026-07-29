import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { TERMINAL_METADATA_PATH, WEB_CONTAINER_TERMINAL_RUNTIME } from "./contracts";
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

    expect(manager.list()[0]).toMatchObject({
      status: "restart-required",
      origin: { kind: "terminal-route" },
      runtime: WEB_CONTAINER_TERMINAL_RUNTIME,
      processEpoch: 0,
      reconstructed: true,
    });
    expect(manager.list()[0]?.detail).toContain("fresh interactive jsh process");
    expect(manager.list()[0]?.bufferedOutput).toContain("42 passed");
    expect(manager.list()[0]?.bufferedOutput).toContain("prior browser process ended with the page");
  });

  it("persists only a bounded encoded transcript tail through the active workspace and reconstructs it after refresh", async () => {
    const workspace = new MemoryWorkspace();
    let mounted: FileSystemTree = {};
    const output = `${"x".repeat(80 * 1_024)}\nfinal-marker\n`;
    const host = {
      fs: {
        async mkdir() { return undefined; },
        async rm() { mounted = {}; },
      },
      async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
      async export() { return structuredClone(mounted); },
      async spawn() {
        return {
          exit: Promise.resolve(0),
          input: new WritableStream<string>(),
          output: new ReadableStream<string>({ start(controller) { controller.enqueue(output); controller.close(); } }),
          kill() {},
          resize() {},
        };
      },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    await manager.start(tab.id);

    await vi.waitFor(async () => {
      const content = (await workspace.read(TERMINAL_METADATA_PATH))?.content;
      expect(content).toBeDefined();
      const persisted = JSON.parse(content!) as { sessions: Array<{ transcriptTail: string }> };
      expect(persisted.sessions[0]?.transcriptTail).toMatch(/^airship-terminal-utf8-base64-v1:.+/u);
      expect(content).toContain('"process-exit"');
    });
    const stored = JSON.parse((await workspace.read(TERMINAL_METADATA_PATH))!.content) as {
      version: number;
      sessions: Array<{ transcriptTail: string }>;
    };
    expect(stored.version).toBe(3);
    expect(stored.sessions[0]!.transcriptTail).toMatch(/^airship-terminal-utf8-base64-v1:/u);
    expect(stored.sessions[0]!.transcriptTail.length).toBeLessThan(88 * 1_024);

    const restored = new BrowserTerminalManager(workspace);
    await restored.ready;
    expect(restored.list()[0]?.bufferedOutput).toContain("final-marker");
    expect(restored.list()[0]?.history).toEqual([]);
    expect(restored.list()[0]?.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "process-start", outcome: "completed" }),
      expect.objectContaining({ kind: "process-exit", outcome: "completed", exitCode: 0 }),
    ]));
    await manager.quiesce("test cleanup");
  });

  it("isolates active tabs by profile and reconstructs both profile-owned sets", async () => {
    const workspace = new MemoryWorkspace();
    const manager = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    await manager.ready;

    const alpha = manager.list("profile-alpha")[0]!;
    const beta = manager.ensureProfileSession({
      profileId: "profile-beta",
      threadId: "thread-beta",
      cwd: "/workspace/packages/beta",
    });
    manager.rename(alpha.id, "Alpha shell");
    manager.rename(beta.id, "Beta shell");

    expect(manager.list()).toEqual([]);
    expect(manager.list("profile-alpha").map(({ name }) => name)).toEqual(["Alpha shell"]);
    expect(manager.list("profile-beta")).toEqual([
      expect.objectContaining({
        id: beta.id,
        name: "Beta shell",
        profileId: "profile-beta",
        threadId: "thread-beta",
        origin: { kind: "conversation" },
      }),
    ]);

    await vi.waitFor(async () => {
      const content = (await workspace.read(TERMINAL_METADATA_PATH))?.content;
      expect(content).toContain("profile-alpha");
      expect(content).toContain("profile-beta");
    });
    const stored = JSON.parse((await workspace.read(TERMINAL_METADATA_PATH))!.content) as {
      version: number;
      sessions: Array<{ profileId?: string; runtime?: typeof WEB_CONTAINER_TERMINAL_RUNTIME }>;
    };
    expect(stored.version).toBe(3);
    expect(stored.sessions.map(({ profileId }) => profileId)).toEqual(["profile-alpha", "profile-beta"]);
    expect(stored.sessions.every(({ runtime }) => runtime?.interaction === "interactive-pty")).toBe(true);

    const restored = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    await restored.ready;
    expect(restored.list("profile-alpha")[0]).toMatchObject({ id: alpha.id, reconstructed: true });
    expect(restored.list("profile-beta")[0]).toMatchObject({ id: beta.id, reconstructed: true });
  });

  it("CAS-merges concurrent page manifests without overwriting terminal lineage", async () => {
    const workspace = new MemoryWorkspace();
    const alphaManager = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    const betaManager = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-beta" });
    await Promise.all([alphaManager.ready, betaManager.ready]);

    const alpha = alphaManager.create({ profileId: "profile-alpha", name: "Alpha concurrent" });
    const beta = betaManager.create({ profileId: "profile-beta", name: "Beta concurrent" });

    await vi.waitFor(async () => {
      const file = await workspace.read(TERMINAL_METADATA_PATH);
      const sessions = file ? (JSON.parse(file.content) as { sessions: Array<{ id: string }> }).sessions : [];
      expect(sessions.map(({ id }) => id)).toEqual(expect.arrayContaining([alpha.id, beta.id]));
    });

    const restored = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    await restored.ready;
    expect(restored.list("profile-alpha").map(({ id }) => id)).toContain(alpha.id);
    expect(restored.list("profile-beta").map(({ id }) => id)).toContain(beta.id);
  });

  it("grants one reconstructed terminal writer lease and rejects a concurrent process author", async () => {
    const workspace = new MemoryWorkspace();
    const seed = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    await seed.ready;
    await vi.waitFor(async () => expect(await workspace.read(TERMINAL_METADATA_PATH)).toBeDefined());

    let resolveExit!: (code: number) => void;
    let outputController!: ReadableStreamDefaultController<string>;
    let killed = false;
    const process = {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { outputController = controller; } }),
      kill() { killed = true; outputController.close(); resolveExit(130); },
      resize() {},
    };
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { return undefined; } },
      async mount() {},
      async export() { return {}; },
      async spawn() { return process; },
    } as unknown as WebContainer;
    const first = new BrowserTerminalManager(workspace, {
      defaultProfileId: "profile-alpha",
      activateHost: async () => host,
    });
    const second = new BrowserTerminalManager(workspace, {
      defaultProfileId: "profile-alpha",
      activateHost: async () => host,
    });
    await Promise.all([first.ready, second.ready]);
    const sharedId = first.list("profile-alpha")[0]!.id;
    expect(second.list("profile-alpha")[0]!.id).toBe(sharedId);

    await first.start(sharedId);
    await expect(second.start(sharedId)).rejects.toThrow(/writer heartbeat from another page or device/u);
    expect(first.list("profile-alpha")[0]).toMatchObject({ status: "running" });
    expect(second.list("profile-alpha")[0]).toMatchObject({ status: "idle" });

    await vi.waitFor(async () => {
      expect((await workspace.read(TERMINAL_METADATA_PATH))?.content).toContain('"process-start"');
    });

    const leasePath = `/workspace/.airship/terminal/leases/${encodeURIComponent(sharedId)}.json`;
    const lease = await workspace.read(leasePath);
    expect(lease).toBeDefined();
    await workspace.write(leasePath, `${JSON.stringify({
      version: 1,
      sessionId: sharedId,
      ownerId: "other-authority",
      expiresAt: Date.now() + 45_000,
    })}\n`, { expectedRevision: lease!.revision });
    const beforeTakeover = await workspace.read(TERMINAL_METADATA_PATH);
    const takeoverManifest = JSON.parse(beforeTakeover!.content) as {
      sessions: Array<{ id: string; updatedAt: string; history: string[]; detail: string }>;
    };
    const authoritative = takeoverManifest.sessions.find((session) => session.id === sharedId)!;
    authoritative.updatedAt = "2099-01-01T00:00:00.000Z";
    authoritative.history = ["B authoritative command"];
    authoritative.detail = "B owns the durable writer epoch.";
    await workspace.write(TERMINAL_METADATA_PATH, `${JSON.stringify(takeoverManifest, null, 2)}\n`, {
      expectedRevision: beforeTakeover!.revision,
    });
    await expect(first.write(sharedId, "echo unsafe\r")).rejects.toThrow(/lost the terminal writer lease/u);
    expect(killed).toBe(true);
    expect(first.list("profile-alpha")[0]).toMatchObject({ status: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterLoss = JSON.parse((await workspace.read(TERMINAL_METADATA_PATH))!.content) as {
      sessions: Array<{ id: string; history: string[]; detail: string }>;
    };
    expect(afterLoss.sessions.find((session) => session.id === sharedId)).toMatchObject({
      history: ["B authoritative command"],
      detail: "B owns the durable writer epoch.",
    });
    const foreignLease = await workspace.read(leasePath);
    await workspace.remove(leasePath, { expectedRevision: foreignLease!.revision });
    await expect(first.start(sharedId)).rejects.toThrow(/Reload the workspace to hydrate the authoritative transcript/u);
    await first.quiesce("test cleanup");
  });

  it("slides the bounded audit window past 64 records for one lease owner", async () => {
    const workspace = new MemoryWorkspace();
    let outputController!: ReadableStreamDefaultController<string>;
    let resolveExit!: (code: number) => void;
    const process = {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { outputController = controller; } }),
      kill() { outputController.close(); resolveExit(130); },
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
    const id = manager.list()[0]!.id;
    await manager.start(id);
    await manager.write(id, Array.from({ length: 70 }, (_, index) => `echo ${index}\r`).join(""));

    await vi.waitFor(async () => {
      const file = await workspace.read(TERMINAL_METADATA_PATH);
      const manifest = file ? JSON.parse(file.content) as { sessions: Array<{ id: string; audit: Array<{ sequence: number }> }> } : undefined;
      const audit = manifest?.sessions.find((session) => session.id === id)?.audit ?? [];
      expect(audit).toHaveLength(64);
      expect(audit.at(-1)?.sequence).toBe(71);
    });
    await manager.quiesce("test cleanup");
  });

  it("persists bounded closed-session pruning with a durable tombstone", async () => {
    const workspace = new MemoryWorkspace();
    const manager = new BrowserTerminalManager(workspace);
    await manager.ready;
    for (let index = 1; index < 8; index += 1) manager.create({ name: `Default ${index}` });
    for (let index = 0; index < 8; index += 1) manager.create({ profileId: "profile-one", name: `One ${index}` });
    for (let index = 0; index < 8; index += 1) manager.create({ profileId: "profile-two", name: `Two ${index}` });
    const prunedId = manager.list()[0]!.id;
    await manager.close(prunedId);
    const replacement = manager.create({ profileId: "profile-three", name: "Replacement" });

    await vi.waitFor(async () => {
      const file = await workspace.read(TERMINAL_METADATA_PATH);
      const manifest = file ? JSON.parse(file.content) as {
        sessions: Array<{ id: string }>;
        removedSessions?: Array<{ id: string }>;
      } : undefined;
      expect(manifest?.sessions).toHaveLength(24);
      expect(manifest?.sessions.map(({ id }) => id)).toContain(replacement.id);
      expect(manifest?.sessions.map(({ id }) => id)).not.toContain(prunedId);
      expect(manifest?.removedSessions?.map(({ id }) => id)).toContain(prunedId);
    });

    const restored = new BrowserTerminalManager(workspace);
    await restored.ready;
    expect([...restored.list(), ...restored.archived()].map(({ id }) => id)).not.toContain(prunedId);
    expect(restored.list("profile-three").map(({ id }) => id)).toContain(replacement.id);
  });

  it("fails explicitly before an unbounded prune ledger can exhaust metadata", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write(TERMINAL_METADATA_PATH, `${JSON.stringify({
      version: 3,
      sessions: [],
      removedSessions: Array.from({ length: 4_097 }, (_, index) => ({
        id: `retired-${index}`,
        removedAt: "2026-07-28T00:00:00.000Z",
        reason: "bounded-closed-session-prune",
      })),
    })}\n`, { expectedRevision: null });
    const manager = new BrowserTerminalManager(workspace);
    await expect(manager.ready).rejects.toThrow(/prune ledger exceeds its 4096-entry safety limit/u);
  });

  it("realizes a Workspace open-here request once across rerenders and reconstruction", async () => {
    const workspace = new MemoryWorkspace();
    const manager = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    await manager.ready;

    const opened = manager.openWorkspaceSession({
      requestId: "workspace-open-1",
      profileId: "profile-alpha",
      threadId: "thread-alpha",
      cwd: "/workspace/packages/ui",
      name: "UI package",
    });
    const repeated = manager.openWorkspaceSession({
      requestId: "workspace-open-1",
      profileId: "profile-alpha",
      threadId: "thread-alpha",
      cwd: "/workspace/packages/ui",
    });
    expect(repeated.id).toBe(opened.id);
    expect(manager.list("profile-alpha")).toHaveLength(2);
    expect(opened).toMatchObject({
      origin: { kind: "workspace-path", path: "/workspace/packages/ui", requestId: "workspace-open-1" },
    });

    await vi.waitFor(async () => expect((await workspace.read(TERMINAL_METADATA_PATH))?.content).toContain("workspace-open-1"));
    const restored = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    await restored.ready;
    const replayed = restored.openWorkspaceSession({
      requestId: "workspace-open-1",
      profileId: "profile-alpha",
      cwd: "/workspace/packages/ui",
    });
    expect(replayed.id).toBe(opened.id);
    expect(restored.list("profile-alpha")).toHaveLength(2);
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
    expect(manager.archived()).toEqual([
      expect.objectContaining({
        id: tab.id,
        closedAt: expect.any(String),
        status: "exited",
        processEpoch: 1,
        audit: expect.arrayContaining([
          expect.objectContaining({ kind: "process-start", outcome: "completed", processEpoch: 1 }),
          expect.objectContaining({ kind: "interactive-input", outcome: "submitted", command: "npm test" }),
          expect.objectContaining({ kind: "process-exit", outcome: "completed", processEpoch: 1 }),
        ]),
      }),
    ]);
    await vi.waitFor(async () => expect((await workspace.read(TERMINAL_METADATA_PATH))?.content).toContain('"closedAt"'));

    const restored = new BrowserTerminalManager(workspace);
    await restored.ready;
    expect(restored.archived()[0]).toMatchObject({ id: tab.id, reconstructed: true, closedAt: expect.any(String) });
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
