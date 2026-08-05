import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import type { WorkspacePort } from "../workspace/contracts";
import { TERMINAL_METADATA_PATH } from "./contracts";
import { BrowserTerminalManager } from "./manager";
import type { WebContainer } from "@webcontainer/api";

describe("BrowserTerminalManager persist coalescing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("persists a small constant number of passes per output burst instead of one per debounce tick", async () => {
    const base = new MemoryWorkspace();
    const slow = gatedWorkspace(base);
    const { host, emit } = streamingHost();
    const manager = new BrowserTerminalManager(slow.workspace, { activateHost: async () => host });
    await manager.ready;
    await settle(slow);
    const writesBeforeStart = slow.writes();
    const tab = manager.list()[0]!;
    await manager.start(tab.id);
    await settle(slow);

    // Sustained PTY output: thirty debounce ticks at the 100ms cadence while
    // metadata writes sit blocked behind a slow authority. Every tick sets the
    // dirty flag; none may queue another full read+CAS pass per tick.
    for (let i = 0; i < 30; i += 1) {
      emit(`chunk-${i}\n`);
      await vi.advanceTimersByTimeAsync(100);
    }

    // Only the in-flight pass may be touching the authority while output runs.
    expect(slow.writes()).toBeLessThan(writesBeforeStart + 4);

    // Release the slow authority and let everything drain. The trailing pass
    // must land the final output without replaying one manifest per tick.
    slow.release();
    await settle(slow);
    // One pass per tick would be ~30 here; coalescing keeps it to a handful
    // (create, start/audit, the in-flight pass, and the trailing pass).
    expect(slow.writes()).toBeLessThan(writesBeforeStart + 8);

    const persisted = (await base.read(TERMINAL_METADATA_PATH))?.content ?? "";
    expect(persisted).toBeDefined();
    const tail = Buffer.from(persisted.split("airship-terminal-utf8-base64-v1:")[1]?.split('"')[0] ?? "", "base64").toString("utf8");
    expect(tail).toContain("chunk-29");
    expect(manager.persistenceFailure()).toBeUndefined();
    await manager.quiesce("test cleanup");
  });

  it("reports a failing authority once and terminates the pass instead of spinning", async () => {
    const base = new MemoryWorkspace();
    const slow = gatedWorkspace(base);
    slow.reject(new Error("The workspace storage quota is exhausted."));
    const { host, emit } = streamingHost();
    const manager = new BrowserTerminalManager(slow.workspace, { activateHost: async () => host });
    await manager.ready;
    await manager.start(manager.list()[0]!.id);
    const observed: Array<string | undefined> = [];
    const unsubscribe = manager.subscribePersistence((failure) => observed.push(failure));

    for (let i = 0; i < 30; i += 1) {
      emit(`chunk-${i}\n`);
      await vi.advanceTimersByTimeAsync(100);
      await settle(slow);
    }

    // Dozens of failed opportunities, one reported transition: the projection
    // reflects the last real persist outcome without a listener storm.
    expect(manager.persistenceFailure()).toBe("The workspace storage quota is exhausted.");
    expect(observed).toEqual([undefined, "The workspace storage quota is exhausted."]);

    // Recovery on the next real mutation still clears the projection.
    slow.release();
    slow.accept();
    manager.rename(manager.list()[0]!.id, "Recovered");
    await settle(slow);
    expect(manager.persistenceFailure()).toBeUndefined();
    expect(observed).toEqual([undefined, "The workspace storage quota is exhausted.", undefined]);
    unsubscribe();
    await manager.quiesce("test cleanup");
  });

  it("attempts a final drain at quiesce when a failed pass left the dirty flag armed", async () => {
    const base = new MemoryWorkspace();
    const slow = gatedWorkspace(base);
    const manager = new BrowserTerminalManager(slow.workspace);
    await manager.ready;
    await settle(slow);
    const observed: Array<string | undefined> = [];
    const unsubscribe = manager.subscribePersistence((failure) => observed.push(failure));
    slow.reject(new Error("The workspace storage quota is exhausted."));

    // One mutation, one failed pass: the pass terminates with the dirty flag
    // re-armed and neither a timer nor an in-flight drain left to carry the
    // retry — exactly the teardown corner the flush used to abandon.
    manager.rename(manager.list()[0]!.id, "Armed");
    await settle(slow);
    expect(manager.persistenceFailure()).toBe("The workspace storage quota is exhausted.");
    const writesAfterFailure = slow.writes();

    // The authority recovers with no new mutation in between. Quiesce owes
    // the armed state one final attempt before `persistenceTail` settles.
    slow.release();
    slow.accept();
    await manager.quiesce("test cleanup");
    expect(slow.writes()).toBeGreaterThan(writesAfterFailure);
    expect(manager.persistenceFailure()).toBeUndefined();
    expect(observed).toEqual([undefined, "The workspace storage quota is exhausted.", undefined]);
    unsubscribe();
  });

  it("isolates a throwing persistence subscriber from the drain and from other listeners", async () => {
    const base = new MemoryWorkspace();
    const slow = gatedWorkspace(base);
    const manager = new BrowserTerminalManager(slow.workspace);
    await manager.ready;
    await settle(slow);
    const observed: Array<string | undefined> = [];
    const unsubscribeHealthy = manager.subscribePersistence((failure) => observed.push(failure));
    // Subscribing replays the current projection synchronously, so the throw
    // surfaces to the subscriber's own caller; the listener stays registered.
    let unsubscribeThrowing: () => void = () => undefined;
    try {
      unsubscribeThrowing = manager.subscribePersistence(() => { throw new Error("Observer bug."); });
    } catch { /* The subscriber's own subscribe-time throw is its caller's problem. */ }

    // A failure transition fans out through the throwing listener: the drain
    // must survive it, `persistenceTail` must stay settled, and the healthy
    // listener must still observe the outcome.
    slow.reject(new Error("The workspace storage quota is exhausted."));
    manager.rename(manager.list()[0]!.id, "Failing");
    await settle(slow);
    expect(manager.persistenceFailure()).toBe("The workspace storage quota is exhausted.");
    expect(observed).toEqual([undefined, "The workspace storage quota is exhausted."]);

    // The throwing observer did not poison the tail: the next mutation still
    // persists and the recovery transition still reaches the healthy side.
    const writesBeforeRecovery = slow.writes();
    slow.release();
    slow.accept();
    manager.rename(manager.list()[0]!.id, "Recovered");
    await settle(slow);
    expect(slow.writes()).toBeGreaterThan(writesBeforeRecovery);
    expect(manager.persistenceFailure()).toBeUndefined();
    expect(observed).toEqual([undefined, "The workspace storage quota is exhausted.", undefined]);
    unsubscribeThrowing();
    unsubscribeHealthy();
    await manager.quiesce("test cleanup");
  });
});

/** Release every blocked metadata write, then flush the async persist chain. */
async function settle(slow: ReturnType<typeof gatedWorkspace>): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    slow.flush();
    await vi.advanceTimersByTimeAsync(0);
  }
}

/**
 * A workspace whose metadata writes block until `flush()` — an authority with
 * latency far beyond the 100ms transcript debounce. `release()` stops gating
 * so teardown writes never deadlock.
 */
function gatedWorkspace(base: MemoryWorkspace) {
  const pending: Array<() => void> = [];
  let metadataWrites = 0;
  let gated = true;
  let failure: Error | undefined;
  const workspace: WorkspacePort = {
    read: (path) => base.read(path),
    readBounded: (path, maxBytes) => base.readBounded(path, maxBytes),
    list: (path) => base.list(path),
    remove: (path, options) => base.remove(path, options),
    async write(path, content, options) {
      if (path === TERMINAL_METADATA_PATH) {
        metadataWrites += 1;
        if (gated) await new Promise<void>((resolve) => pending.push(resolve));
        if (failure) throw failure;
      }
      return base.write(path, content, options);
    },
  };
  return {
    workspace,
    flush: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    release: () => { gated = false; },
    reject: (error: Error) => { failure = error; },
    accept: () => { failure = undefined; },
    writes: () => metadataWrites,
  };
}

/** A host whose spawned process lets the test push PTY output on demand. */
function streamingHost() {
  let emit!: (chunk: string) => void;
  let closeOutput!: () => void;
  let resolveExit!: (code: number) => void;
  const host = {
    fs: {
      async mkdir() { return undefined; },
      async rm() { return undefined; },
    },
    async mount() { return undefined; },
    async export() { return {}; },
    async spawn() {
      return {
        exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
        input: new WritableStream<string>({ close() { closeOutput(); resolveExit(0); } }),
        output: new ReadableStream<string>({ start(controller) {
          emit = (chunk) => controller.enqueue(chunk);
          closeOutput = () => controller.close();
        } }),
        kill() { closeOutput(); resolveExit(130); },
        resize() {},
      };
    },
  } as unknown as WebContainer;
  return { host, emit: (chunk: string) => emit(chunk) };
}
