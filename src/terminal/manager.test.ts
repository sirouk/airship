import { describe, expect, it, vi } from "vitest";
import { UUID_V4_PATTERN } from "../core/id";
import { MemoryWorkspace } from "../workspace/memory";
import type { WorkspacePort } from "../workspace/contracts";
import { TERMINAL_METADATA_PATH, TERMINAL_WORKSPACE_MOUNT, WEB_CONTAINER_TERMINAL_RUNTIME } from "./contracts";
import { BrowserTerminalManager, TERMINAL_LEASE_RENEW_MS, terminalProcessBanner } from "./manager";
import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";

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
    // Fake timers from the outset so the writer-lease heartbeat is a timer this
    // test can drive; the takeover it enforces is otherwise 12 seconds away.
    vi.useFakeTimers();
    const workspace = new MemoryWorkspace();
    const seed = new BrowserTerminalManager(workspace, { defaultProfileId: "profile-alpha" });
    await seed.ready;
    await vi.waitFor(async () => expect(await workspace.read(TERMINAL_METADATA_PATH)).toBeDefined());

    let resolveExit!: (code: number) => void;
    let outputController!: ReadableStreamDefaultController<string>;
    let killed = false;
    const submitted: string[] = [];
    const process = {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input: new WritableStream<string>({ write(chunk) { submitted.push(chunk); } }),
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
    // Nobody is typing into this tab, so no input-path observation can fire:
    // the heartbeat is the whole guarantee here, and driving it is what proves
    // the takeover is still enforced for a tab left idle.
    await vi.advanceTimersByTimeAsync(TERMINAL_LEASE_RENEW_MS);
    expect(killed).toBe(true);
    expect(first.list("profile-alpha")[0]).toMatchObject({ status: "failed" });
    expect(first.list("profile-alpha")[0]?.detail).toContain("Terminal writer lease was lost");
    // And input is refused afterwards rather than reaching a process whose
    // durable writer lease this page no longer holds.
    await first.write(sharedId, "echo unsafe\r");
    expect(submitted).toEqual([]);
    // Past the 100ms transcript-persist debounce, so any write this page still
    // wanted to make has been made by the time the manifest is read back.
    await vi.advanceTimersByTimeAsync(200);
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
    vi.useRealTimers();
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

  it("claims each submitted git line once and appends a control-safe Airship Browser Git answer", async () => {
    const workspace = new MemoryWorkspace();
    const { host } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    await manager.start(tab.id);

    await manager.write(tab.id, "git status\r");
    const first = manager.pendingBrowserGitIntent();
    expect(first).toMatchObject({ sessionId: tab.id, command: "git status", cwd: "/workspace" });
    expect(manager.claimBrowserGitIntent(first!)).toBe(true);
    expect(manager.claimBrowserGitIntent(first!)).toBe(false);
    manager.recordBrowserGitResult(first!, {
      output: "On branch main\nmalicious\x1b[2Jname\n",
      changed: false,
      failed: false,
    });

    const answered = manager.list()[0]!;
    expect(answered.bufferedOutput).toContain("Airship Browser Git · completed · BrowserGitClient, not jsh");
    expect(answered.bufferedOutput).toContain("maliciousname");
    expect(answered.bufferedOutput).not.toContain("\x1b[2J");
    expect(answered.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "browser-git",
        outcome: "completed",
        sourceRecordId: first!.sourceRecordId,
        command: "git status",
      }),
    ]));
    expect(manager.pendingBrowserGitIntent()).toBeUndefined();

    // A compound jsh program is not one Git intent: its suffix could execute
    // in the real shell even though the `git` binary is absent, so Airship must
    // not label BrowserGitClient as the author of the whole line.
    await manager.write(tab.id, "git status && echo shell-effect\r");
    expect(manager.pendingBrowserGitIntent()).toBeUndefined();

    // The command string may repeat; identity comes from the submitted input
    // record, not from text that would suppress a legitimate second status.
    await manager.write(tab.id, "git status\r");
    const second = manager.pendingBrowserGitIntent();
    expect(second?.sourceRecordId).not.toBe(first?.sourceRecordId);
    expect(manager.claimBrowserGitIntent(second!)).toBe(true);
    manager.recordBrowserGitResult(second!, { output: "clean", changed: false, failed: false });
    expect(manager.pendingBrowserGitIntent()).toBeUndefined();
    await manager.quiesce("test cleanup");
  });

  it("never replays an unhandled git line restored from a prior page", async () => {
    const workspace = new MemoryWorkspace();
    const firstHost = recordingHost();
    const first = new BrowserTerminalManager(workspace, { activateHost: async () => firstHost.host });
    await first.ready;
    const tab = first.list()[0]!;
    await first.start(tab.id);
    await first.write(tab.id, "git add -A\r");
    expect(first.pendingBrowserGitIntent()?.command).toBe("git add -A");
    await first.quiesce("page ended before Browser Git answered");

    const secondHost = recordingHost();
    const restored = new BrowserTerminalManager(workspace, { activateHost: async () => secondHost.host });
    await restored.ready;
    const restoredTab = restored.list()[0]!;
    await restored.start(restoredTab.id);
    expect(restored.pendingBrowserGitIntent()).toBeUndefined();
    await restored.quiesce("test cleanup");
  });

  it("kills a partially started process when its input writer cannot be acquired", async () => {
    const workspace = new MemoryWorkspace();
    let killed = false;
    let resolveExit!: (code: number) => void;
    const input = new WritableStream<string>();
    const lock = input.getWriter();
    const process = {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input,
      output: new ReadableStream<string>(),
      kill() { killed = true; resolveExit(130); },
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

  it("handles a rejected process exit during workspace-authority release", async () => {
    const workspace = new MemoryWorkspace();
    let rejectExit!: (reason: unknown) => void;
    let outputController!: ReadableStreamDefaultController<string>;
    const process = {
      exit: new Promise<number>((_resolve, reject) => { rejectExit = reject; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { outputController = controller; } }),
      kill() {
        outputController.close();
        rejectExit({ message: "no such file or directory" });
      },
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
    const tab = manager.list()[0]!;
    await manager.start(tab.id);

    await expect(manager.quiesce("Profile authority changed.")).resolves.toEqual([]);
    await Promise.resolve();
    expect(manager.list()[0]).toMatchObject({
      status: "restart-required",
      detail: "Profile authority changed.",
    });
  });

  it("waits for process completion after forcing terminal shutdown", async () => {
    const workspace = new MemoryWorkspace();
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
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    await manager.start(manager.list()[0]!.id);

    await manager.quiesce("Profile authority changed.");
    expect(killed).toBe(true);
    expect(manager.list()[0]).toMatchObject({ status: "restart-required" });
  });

  it("settles a jsh spawn overtaken by quiesce before unmounting its cwd", async () => {
    const workspace = new MemoryWorkspace();
    const order: string[] = [];
    let resolveSpawn!: (process: WebContainerProcess) => void;
    let announceSpawn!: () => void;
    let rejectExit!: (reason: unknown) => void;
    const spawnRequested = new Promise<void>((resolve) => { announceSpawn = resolve; });
    const process = {
      exit: new Promise<number>((_resolve, reject) => { rejectExit = reject; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>(),
      kill() {
        order.push("kill");
        rejectExit({ code: "ENOENT", message: "no such file or directory" });
      },
      resize() {},
    } as WebContainerProcess;
    const host = {
      fs: {
        async mkdir() { return undefined; },
        async rm() { order.push("unmount"); },
      },
      async mount() {},
      async export() { return {}; },
      spawn() {
        announceSpawn();
        return new Promise<WebContainerProcess>((resolve) => { resolveSpawn = resolve; });
      },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const start = manager.start(manager.list()[0]!.id);
    await spawnRequested;

    const quiesce = manager.quiesce("Profile authority changed.");
    resolveSpawn(process);
    await expect(Promise.all([start, quiesce])).resolves.toBeDefined();

    expect(order).toEqual(["kill", "unmount"]);
    expect(manager.list()[0]).toMatchObject({ status: "restart-required" });
  });

  it("bounds a stalled input write before forcing terminal shutdown", async () => {
    const workspace = new MemoryWorkspace();
    let resolveExit!: (code: number) => void;
    let killed = false;
    const process = {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input: new WritableStream<string>({ write: () => new Promise<void>(() => undefined) }),
      output: new ReadableStream<string>(),
      kill() { killed = true; resolveExit(130); },
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
    const tab = manager.list()[0]!;
    await manager.start(tab.id);
    void manager.write(tab.id, "blocked").catch(() => undefined);

    await expect(manager.quiesce("Profile authority changed.")).resolves.toEqual([]);
    expect(killed).toBe(true);
  });

  it("restart detaches a stalled old writer before accepting new input", async () => {
    const workspace = new MemoryWorkspace();
    const writes: string[] = [];
    let spawnIndex = 0;
    const processes = [0, 1].map((index) => {
      let resolveExit!: (code: number) => void;
      let output!: ReadableStreamDefaultController<string>;
      return {
        exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
        input: new WritableStream<string>({
          write(chunk) {
            if (index === 0) return new Promise<void>(() => undefined);
            writes.push(chunk);
          },
        }),
        output: new ReadableStream<string>({ start(controller) { output = controller; } }),
        kill() { output.close(); resolveExit(130); },
        resize() {},
      } as WebContainerProcess;
    });
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { return undefined; } },
      async mount() {},
      async export() { return {}; },
      async spawn() { return processes[spawnIndex++]!; },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    await manager.start(tab.id);
    void manager.write(tab.id, "blocked").catch(() => undefined);

    await manager.restart(tab.id);
    await expect(Promise.race([
      manager.write(tab.id, "new process input"),
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("new input remained behind the old writer")), 100)),
    ])).resolves.toBeUndefined();

    expect(spawnIndex).toBe(2);
    expect(writes).toEqual(["new process input"]);
    await manager.quiesce("test cleanup");
  });

  it("close does not archive a tab until its process confirms exit", async () => {
    const workspace = new MemoryWorkspace();
    let resolveExit!: (code: number) => void;
    let output!: ReadableStreamDefaultController<string>;
    let killed = false;
    const process = {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { output = controller; } }),
      kill() { killed = true; },
      resize() {},
    } as WebContainerProcess;
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { return undefined; } },
      async mount() {},
      async export() { return {}; },
      async spawn() { return process; },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    await manager.start(tab.id);

    let closed = false;
    const closing = manager.close(tab.id).then(() => { closed = true; });
    await vi.waitFor(() => expect(killed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    expect(manager.list()[0]?.status).toBe("starting");
    expect(manager.list()[0]?.closedAt).toBeUndefined();

    output.close();
    resolveExit(0);
    await closing;
    expect(manager.list()).toEqual([]);
    await vi.waitFor(async () => {
      const stored = JSON.parse((await workspace.read(TERMINAL_METADATA_PATH))!.content) as {
        sessions: Array<{ status: string; closedAt?: string }>;
      };
      expect(stored.sessions[0]).toMatchObject({ status: "exited" });
      expect(stored.sessions[0]?.closedAt).toBeDefined();
    });
    await manager.quiesce("test cleanup");
  });

  it("retains workspace authority when an overtaken spawn misses the shutdown bound", async () => {
    const workspace = new MemoryWorkspace();
    const removed: string[] = [];
    let spawnCount = 0;
    let resolveSpawn!: (process: WebContainerProcess) => void;
    let announceSpawn!: () => void;
    const spawnRequested = new Promise<void>((resolve) => { announceSpawn = resolve; });
    const host = {
      fs: {
        async mkdir() { return undefined; },
        async rm(path: string) { removed.push(path); },
      },
      async mount() {},
      async export() { return {}; },
      spawn() {
        spawnCount += 1;
        announceSpawn();
        return new Promise<WebContainerProcess>((resolve) => { resolveSpawn = resolve; });
      },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    const start = manager.start(tab.id);
    await spawnRequested;

    await expect(manager.quiesce("Profile authority changed."))
      .rejects.toThrow("Browser terminal did not settle before workspace release.");
    expect(removed).not.toContain(TERMINAL_WORKSPACE_MOUNT);
    expect(manager.canReconcile()).toBe(true);
    await expect(manager.start(tab.id)).rejects.toThrow("previous browser shell is still stopping");
    expect(spawnCount).toBe(1);
    expect(removed).not.toContain(TERMINAL_WORKSPACE_MOUNT);

    let resolveExit!: (code: number) => void;
    let output!: ReadableStreamDefaultController<string>;
    resolveSpawn({
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { output = controller; } }),
      kill() { output.close(); resolveExit(130); },
      resize() {},
    } as WebContainerProcess);
    await start;
    await manager.quiesce("Profile authority changed.");
    expect(removed).toContain(TERMINAL_WORKSPACE_MOUNT);
  });

  it("records a normal-exit lease release failure without an unhandled rejection", async () => {
    const base = new MemoryWorkspace();
    const workspace: WorkspacePort = {
      read: (path) => base.read(path),
      readBounded: (path, maxBytes) => base.readBounded(path, maxBytes),
      list: (path) => base.list(path),
      write: (path, content, options) => base.write(path, content, options),
      remove: (path, options) => path.includes("/.airship/terminal/leases/")
        ? Promise.reject(new Error("lease remove failed"))
        : base.remove(path, options),
    };
    let resolveExit!: (code: number) => void;
    let output!: ReadableStreamDefaultController<string>;
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { return undefined; } },
      async mount() {},
      async export() { return {}; },
      async spawn() {
        return {
          exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
          input: new WritableStream<string>(),
          output: new ReadableStream<string>({ start(controller) { output = controller; } }),
          kill() {},
          resize() {},
        } as WebContainerProcess;
      },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    await manager.start(manager.list()[0]!.id);

    output.close();
    resolveExit(0);
    await vi.waitFor(() => expect(manager.persistenceFailure()).toBe("lease remove failed"));
    expect(manager.list()[0]).toMatchObject({ status: "exited", exitCode: 0 });
    await manager.quiesce("test cleanup");
  });

  it("drops process output that arrives after the authority boundary", async () => {
    const workspace = new MemoryWorkspace();
    let resolveExit!: (code: number) => void;
    let output!: ReadableStreamDefaultController<string>;
    const process = {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { output = controller; } }),
      kill() {
        output.enqueue("stale process output");
        output.close();
        resolveExit(130);
      },
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

    await manager.quiesce("Profile authority changed.");

    expect(manager.list()[0]?.bufferedOutput).toContain("Airship changed terminal workspace authority");
    expect(manager.list()[0]?.bufferedOutput).not.toContain("stale process output");
  });

  it("turns an unexpected rejected process exit into a visible failed tab", async () => {
    const workspace = new MemoryWorkspace();
    let rejectExit!: (reason: unknown) => void;
    let outputController!: ReadableStreamDefaultController<string>;
    const process = {
      exit: new Promise<number>((_resolve, reject) => { rejectExit = reject; }),
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start(controller) { outputController = controller; } }),
      kill() { outputController.close(); },
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
    const tab = manager.list()[0]!;
    await manager.start(tab.id);

    rejectExit({ message: "provider exit channel closed" });
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe("failed"));
    expect(manager.list()[0]?.detail).toBe("Terminal process completion failed: provider exit channel closed");
    expect(manager.list()[0]?.bufferedOutput).toContain("Terminal process completion failed");
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
    // This path runs only after the host is already gone, so nothing here can
    // be reconciled. Airship's own deactivation quiesces first; an external
    // teardown does not, and the loss has to be stated rather than implied.
    expect(manager.list()[0]?.detail).toContain("discarded");
    expect(manager.list()[0]?.bufferedOutput).toContain("unreconciled terminal writes were discarded");
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

  it("never destroys the shared mount under another tab's live process", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/README.md", "mounted\n", { expectedRevision: null });
    const { host, removed, mounted, install } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const first = manager.list()[0]!;
    await manager.start(first.id);
    // Mount-only state the shell produced: an install carries no workspace
    // revision, is excluded from export, and therefore cannot be remounted.
    install("node_modules", "installed\n");

    const second = manager.create({ name: "Second tab" });
    await manager.start(second.id);

    expect(manager.list().find(({ id }) => id === first.id)).toMatchObject({ status: "running" });
    expect(removed).toEqual([]);
    expect(mounted().node_modules).toBeDefined();
    expect(treeText((mounted().node_modules as { directory: FileSystemTree }).directory, "installed")).toBe("installed\n");
    expect(manager.list().find(({ id }) => id === second.id)?.detail).toContain("mount was not rebuilt");
    await manager.quiesce("test cleanup");
  });

  it("still rebuilds the shared mount once no other terminal process is live", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/README.md", "mounted\n", { expectedRevision: null });
    const { host, removed } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const first = manager.list()[0]!;
    await manager.start(first.id);
    await manager.close(first.id);
    removed.length = 0;

    const second = manager.create({ name: "Second tab" });
    await manager.start(second.id);

    expect(removed).toEqual([TERMINAL_WORKSPACE_MOUNT]);
    expect(manager.list().find(({ id }) => id === second.id)?.detail).not.toContain("mount was not rebuilt");
    await manager.quiesce("test cleanup");
  });

  it("keeps an Editor revision committed while a tab was live instead of reverting it from the stale mount", async () => {
    const workspace = new MemoryWorkspace();
    const created = await workspace.write("/workspace/f.txt", "original\n", { expectedRevision: null });
    const { host } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const first = manager.list()[0]!;
    await manager.start(first.id);
    // The Editor commits while the live process pins the mount open, so the
    // mount keeps the old body until a reconcile can rebuild it.
    await workspace.write("/workspace/f.txt", "from editor\n", { expectedRevision: created.revision });

    const second = manager.create({ name: "Second tab" });
    await manager.start(second.id);
    await manager.close(first.id);
    await manager.close(second.id);

    // The mount-only syncs must not have adopted "from editor" as a baseline
    // the mount never received; otherwise the final reconcile republishes the
    // stale mount copy as a terminal edit.
    await expect(workspace.read("/workspace/f.txt")).resolves.toMatchObject({ content: "from editor\n" });
    await manager.quiesce("test cleanup");
  });

  it("leaves a file the Editor deleted while a tab was live deleted", async () => {
    const workspace = new MemoryWorkspace();
    const created = await workspace.write("/workspace/gone.txt", "original\n", { expectedRevision: null });
    const { host } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const first = manager.list()[0]!;
    await manager.start(first.id);
    await workspace.remove("/workspace/gone.txt", { expectedRevision: created.revision });

    const second = manager.create({ name: "Second tab" });
    await manager.start(second.id);
    await manager.close(first.id);
    await manager.close(second.id);

    await expect(workspace.read("/workspace/gone.txt")).resolves.toBeUndefined();
    await manager.quiesce("test cleanup");
  });

  it("publishes the moment its mount stops being reconcilable, with no session state to change", async () => {
    const first = new MemoryWorkspace();
    const second = new MemoryWorkspace();
    const { host } = recordingHost();
    const holder = new BrowserTerminalManager(first, { activateHost: async () => host });
    const taker = new BrowserTerminalManager(second, { activateHost: async () => host });
    await Promise.all([holder.ready, taker.ready]);
    const tab = holder.list()[0]!;
    await holder.start(tab.id);
    await holder.close(tab.id);
    expect(holder.canReconcile()).toBe(true);
    // A closed tab is not live, so authority loss changes no session status;
    // a view that reads `canReconcile()` during render has nothing else to go on.
    let publications = 0;
    const unsubscribe = holder.subscribeList(() => { publications += 1; });
    // Authority moves *between* managers, so the one losing it is not the one
    // running that code. The loser's own subscribers still have to hear it.
    const authority: boolean[] = [];
    const stopAuthority = holder.subscribeReconcile((available) => authority.push(available));

    await taker.start(taker.list()[0]!.id);

    expect(holder.canReconcile()).toBe(false);
    expect(publications).toBeGreaterThan(1);
    expect(authority).toEqual([true, false]);
    stopAuthority();
    unsubscribe();
    await taker.quiesce("test cleanup");
  });

  it("publishes the moment its mount becomes reconcilable, not once a PTY finally spawns", async () => {
    const workspace = new MemoryWorkspace();
    const { host } = recordingHost();
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    // A cold WebContainer boot is seconds of `spawn`, and the mount is already
    // reconcilable throughout it. The gate makes that window a fixed point.
    const slowHost = {
      ...(host as unknown as Record<string, unknown>),
      async spawn(...args: readonly unknown[]) {
        await spawnGate;
        return (host as unknown as { spawn(...args: readonly unknown[]): unknown }).spawn(...args);
      },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => slowHost });
    await manager.ready;
    const tab = manager.list()[0]!;

    const events: string[] = [];
    const stopList = manager.subscribeList((sessions) => events.push(`list:${sessions[0]?.status ?? "gone"}`));
    const stopReconcile = manager.subscribeReconcile((available) => events.push(`reconcile:${available}`));
    const started = manager.start(tab.id);
    await vi.waitFor(() => expect(manager.canReconcile()).toBe(true));

    // The session is still "starting", and the only thing that said the mount
    // had arrived is the signal: a Reconcile control derived from session state
    // would stay disabled for the whole boot it could already have served.
    expect(manager.list()[0]?.status).toBe("starting");
    expect(events).toEqual(["list:idle", "reconcile:false", "list:starting", "reconcile:true"]);

    releaseSpawn();
    await started;
    stopList();
    stopReconcile();
    await manager.quiesce("test cleanup");
  });

  it("stops a live process from the input path once another page owns the lease", async () => {
    const workspace = new MemoryWorkspace();
    const { host } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    await manager.start(tab.id);
    const leasePath = `/workspace/.airship/terminal/leases/${encodeURIComponent(tab.id)}.json`;
    const lease = (await workspace.read(leasePath))!;
    await workspace.write(leasePath, `${JSON.stringify({
      version: 1,
      sessionId: tab.id,
      ownerId: "other-authority",
      expiresAt: Date.now() + 45_000,
    })}\n`, { expectedRevision: lease.revision });

    // Whether this exact chunk reaches the PTY is a race with the probe's read;
    // the guarantee under test is what happens to the process next.
    const refusal = await manager.write(tab.id, "echo hello\r").then(() => undefined, (error: Error) => error.message);
    if (refusal !== undefined) expect(refusal).toMatch(/no longer owns the terminal writer lease/u);

    // No heartbeat is driven here: input itself observes the takeover by a
    // read, so this page stops feeding its PTY inside a second rather than
    // running whatever else is typed for the rest of the 12s renewal window.
    await vi.waitFor(() => {
      expect(manager.list()[0]).toMatchObject({ status: "failed" });
      expect(manager.list()[0]?.detail).toContain("Terminal writer lease was lost");
    });
    await manager.quiesce("test cleanup");
  });

  it("keeps one writer-lease heartbeat under concurrent input instead of racing itself", async () => {
    const base = new MemoryWorkspace();
    const writes: string[] = [];
    const workspace = deferredWorkspace(base, writes);
    const { host } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    await manager.start(tab.id);
    const leaseWritesAfterStart = writes.filter((path) => path.includes("/leases/")).length;

    await Promise.all(Array.from({ length: 20 }, () => manager.write(tab.id, "a")));

    expect(manager.list()[0]).toMatchObject({ status: "running" });
    expect(manager.list()[0]?.detail).not.toMatch(/lease/u);
    // Twenty characters are twenty characters, not twenty compare-and-swap
    // transactions on one lease file; the heartbeat timer owns renewal.
    expect(writes.filter((path) => path.includes("/leases/")).length).toBe(leaseWritesAfterStart);
    await vi.waitFor(async () => {
      const file = await base.read(TERMINAL_METADATA_PATH);
      expect(file?.content).toContain(tab.id);
    });
    await manager.quiesce("test cleanup");
  });

  it("publishes the appended chunk and a sequence even once the transcript tail slides", async () => {
    const workspace = new MemoryWorkspace();
    let emit!: (chunk: string) => void;
    let closeOutput!: () => void;
    let resolveExit!: (code: number) => void;
    const host = {
      fs: { async mkdir() { return undefined; }, async rm() { return undefined; } },
      async mount() {},
      async export() { return {}; },
      async spawn() {
        return {
          exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
          input: new WritableStream<string>(),
          output: new ReadableStream<string>({ start(controller) {
            emit = (chunk) => controller.enqueue(chunk);
            closeOutput = () => controller.close();
          } }),
          kill() { closeOutput(); resolveExit(130); },
          resize() {},
        };
      },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    const tab = manager.list()[0]!;
    const seen: Array<{ sequence: number; appended: string; length: number }> = [];
    const unsubscribe = manager.subscribe(tab.id, (next) => {
      seen.push({ sequence: next.outputSequence, appended: next.appendedOutput, length: next.bufferedOutput.length });
    });
    await manager.start(tab.id);

    // Fill past the 256 KiB cap, at which point the published buffer is a
    // sliding window and no consumer can recover the delta from it.
    emit("x".repeat(300 * 1_024));
    await vi.waitFor(() => expect(seen.at(-1)?.length).toBe(256 * 1_024));
    const capped = seen.at(-1)!;

    emit("0123456789");
    await vi.waitFor(() => expect(seen.at(-1)?.sequence).toBe(capped.sequence + 1));
    // Exactly the ten characters, one step on, and the tail did not grow.
    expect(seen.at(-1)).toEqual({ sequence: capped.sequence + 1, appended: "0123456789", length: 256 * 1_024 });
    unsubscribe();
    await manager.quiesce("test cleanup");
  });

  it("reports a metadata persistence failure instead of discarding it", async () => {
    const base = new MemoryWorkspace();
    const workspace: WorkspacePort = {
      read: (path) => base.read(path),
      readBounded: (path, maxBytes) => base.readBounded(path, maxBytes),
      list: (path) => base.list(path),
      remove: (path, options) => base.remove(path, options),
      write: (path, content, options) => rejectWrites
        ? Promise.reject(new Error("The workspace storage quota is exhausted."))
        : base.write(path, content, options),
    };
    let rejectWrites = true;
    const observed: Array<string | undefined> = [];
    const manager = new BrowserTerminalManager(workspace);
    await manager.ready;
    const unsubscribe = manager.subscribePersistence((failure) => observed.push(failure));
    manager.create({ name: "Failing" });

    await vi.waitFor(() => expect(manager.persistenceFailure()).toBe("The workspace storage quota is exhausted."));
    rejectWrites = false;
    manager.rename(manager.list()[0]!.id, "Recovered");
    await vi.waitFor(() => expect(manager.persistenceFailure()).toBeUndefined());
    expect(observed).toEqual([undefined, "The workspace storage quota is exhausted.", undefined]);
    unsubscribe();
  });

  it("offers reconcile from the mount it holds, not from a session-status proxy", async () => {
    const workspace = new MemoryWorkspace();
    let failed = false;
    const healthy = recordingHost();
    const host = {
      fs: healthy.host.fs,
      mount: healthy.host.mount.bind(healthy.host),
      export: healthy.host.export.bind(healthy.host),
      async spawn(...args: Parameters<WebContainer["spawn"]>) {
        if (!failed) return healthy.host.spawn(...args);
        return {
          exit: new Promise<number>(() => undefined),
          input: new WritableStream<string>(),
          output: new ReadableStream<string>({ start(controller) { controller.error(new Error("provider output disconnected")); } }),
          kill() {},
          resize() {},
        };
      },
    } as unknown as WebContainer;
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    expect(manager.canReconcile()).toBe(false);

    const tab = manager.list()[0]!;
    await manager.start(tab.id);
    expect(manager.canReconcile()).toBe(true);

    // A failed tab's mount is still reconcilable — the work in it is exactly
    // what a status-gated control would have stranded.
    await manager.close(tab.id);
    const failing = manager.create({ name: "Failing" });
    failed = true;
    await manager.start(failing.id);
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe("failed"));
    expect(manager.canReconcile()).toBe(true);

    await manager.quiesce("test cleanup");
    expect(manager.canReconcile()).toBe(false);
  });

  it("unmounts only the workspace projection on handoff, deliberately retaining the page-shared container", async () => {
    const workspace = new MemoryWorkspace();
    const { host, removed, install } = recordingHost();
    const manager = new BrowserTerminalManager(workspace, { activateHost: async () => host });
    await manager.ready;
    await manager.start(manager.list()[0]!.id);
    install("node_modules", "installed\n");

    await manager.quiesce("The active workspace provider changed.");

    // Deliberate, not accidental: WebContainer boots once per page, so the only
    // thing a Profile handoff owns is this mount. Everything the shell wrote
    // elsewhere in the container is page-shared and survives the switch — the
    // Terminal route says so, and changing this line is a decision.
    expect(removed).toEqual([TERMINAL_WORKSPACE_MOUNT]);
  });

  /*
   * `npm run dev:lan` and `npm run preview:lan` serve on 0.0.0.0, and a
   * non-secure origin is exactly where browsers expose getRandomValues but
   * intentionally omit randomUUID. This manager used to answer that case with
   * `terminal-<epoch>-<Math.random>` for both the tab ID and the compare-and-swap
   * lease owner — a Math.random identity where every other subsystem's is
   * crypto-random, and the lease is what stops two tabs writing the same
   * metadata file.
   */
  it("mints crypto-random session identities on a LAN origin with no randomUUID", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      const manager = new BrowserTerminalManager(new MemoryWorkspace());
      await manager.ready;
      // The same reference src/core/id.test.ts asserts, not a copy of it.
      expect(manager.create({ name: "LAN" }).id).toMatch(UUID_V4_PATTERN);
      await manager.quiesce("test cleanup");
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    }
  });
});

/**
 * A host whose mount root can be destroyed, and whose export omits the same
 * mount-only state the real one omits.
 *
 * `node_modules` is excluded from both export and mount, so a rebuild of the
 * mount root genuinely cannot restore it — which is precisely why rebuilding
 * under a live process is destructive rather than merely wasteful.
 */
function recordingHost(): Readonly<{
  host: WebContainer;
  removed: string[];
  mounted: () => FileSystemTree;
  install: (name: string, contents: string) => void;
  killed: boolean[];
}> {
  const removed: string[] = [];
  const killed: boolean[] = [];
  let mounted: FileSystemTree = {};
  const host = {
    fs: {
      async mkdir() { return undefined; },
      async rm(path: string) { removed.push(path); mounted = {}; },
    },
    // The real mount writes into the mount point; it does not replace it.
    async mount(tree: FileSystemTree) { mounted = { ...mounted, ...structuredClone(tree) }; },
    async export() {
      const { node_modules: _installed, ...visible } = mounted as Record<string, unknown>;
      return structuredClone(visible) as FileSystemTree;
    },
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
  return {
    host,
    removed,
    killed,
    mounted: () => mounted,
    install: (name, contents) => {
      mounted = { ...mounted, [name]: { directory: { installed: { file: { contents } } } } } as FileSystemTree;
    },
  };
}

/** A workspace whose every operation settles on a later microtask. */
function deferredWorkspace(base: MemoryWorkspace, writes: string[]): WorkspacePort {
  return {
    async read(path) { await Promise.resolve(); return base.read(path); },
    async readBounded(path, maxBytes) { await Promise.resolve(); return base.readBounded(path, maxBytes); },
    async list(path) { await Promise.resolve(); return base.list(path); },
    async write(path, content, options) {
      await Promise.resolve();
      writes.push(path);
      return base.write(path, content, options);
    },
    async remove(path, options) { await Promise.resolve(); return base.remove(path, options); },
  };
}

function treeText(tree: FileSystemTree, name: string): string | undefined {
  const node = tree[name];
  if (!node || !("file" in node) || !("contents" in node.file)) return undefined;
  return typeof node.file.contents === "string"
    ? node.file.contents
    : new TextDecoder().decode(node.file.contents);
}

describe("the line that dates a process", () => {
  /*
   * Measured: after a General → Research → General round trip the buffer read
   * "Airship changed terminal workspace authority; this terminal requires
   * restart." and the next line, typed after it, was `echo STILL-ALIVE`
   * answering "STILL-ALIVE" — because showing a `restart-required` tab
   * auto-starts it and the new process inherits the old scrollback.
   */
  it("closes the restart warning the auto-start silently answered", () => {
    const banner = terminalProcessBanner({ processEpoch: 2, priorStatus: "restart-required", reconstructed: false, startedAt: "20:57:03" });
    expect(banner).toContain("jsh run 2 started 20:57:03");
    expect(banner).toContain("has ended and is not running");
  });

  /*
   * Measured: after a reload the tab still read "Terminal 1" with a green
   * check and "Running", over an empty scrollback and "Input history · 0".
   */
  it("dates a cold process so a restart cannot read as the session you left", () => {
    const banner = terminalProcessBanner({ processEpoch: 1, priorStatus: "idle", reconstructed: false, startedAt: "20:57:03" });
    expect(banner).toContain("jsh run 1 started 20:57:03");
    expect(banner).toContain("a reload ends the process");
  });

  it("names the rebuild when the transcript above it outlived its process", () => {
    const banner = terminalProcessBanner({ processEpoch: 1, priorStatus: "restart-required", reconstructed: true, startedAt: "20:57:03" });
    expect(banner).toContain("rebuilt from saved metadata");
  });
});
