import { describe, expect, it } from "vitest";
import { runTurn as runCoreTurn } from "../../core/agent";
import type { InferenceTransport } from "../../core/contracts";
import { runTurn as runGatedTurn } from "../../load-agent-runtime";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { createSessionManifest } from "../../core/session-manifest";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PRIME_EVENT_TYPES } from "./prime-events";
import { runPrimeTurn } from "./runtime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function transport(): InferenceTransport {
  return {
    id: "faux",
    posture: "local",
    async *stream() {
      yield { type: "text-delta", text: "won" };
      yield { type: "completed", finishReason: "stop" };
    },
  };
}

async function twoJournalFixture() {
  const backend = new MemoryJournalBackend();
  const primeJournal = new EventJournal(backend);
  const coreJournal = new EventJournal(backend);
  const tools = new ToolRegistry();
  const manifest = await createSessionManifest({
    systemPrompt: "atomic runtime selection",
    providerId: "faux",
    model: "faux-model",
    tools: tools.definitions(),
    workspaceId: "ws-runtime-race",
    securityPosture: "local",
  });
  const session = await coreJournal.createSession("runtime race", manifest);
  const options = {
    sessionId: session.id,
    content: "claim the runtime",
    transport: transport(),
    tools,
    approvalPolicy: allowAllForTests,
    signal: new AbortController().signal,
  };
  return { primeJournal, coreJournal, session, options };
}

describe("atomic Prime/Core runtime selection", () => {
  it("refuses stale Prime after Core wins and never writes a Prime marker", async () => {
    const { primeJournal, coreJournal, session, options } = await twoJournalFixture();
    const staleReadCaptured = deferred();
    const releaseStaleRead = deferred();
    const originalGetSession = primeJournal.getSession.bind(primeJournal);
    let paused = false;
    primeJournal.getSession = (async (...args: Parameters<EventJournal["getSession"]>) => {
      const record = await originalGetSession(...args);
      if (!paused) {
        paused = true;
        staleReadCaptured.resolve();
        await releaseStaleRead.promise;
      }
      return record;
    }) as EventJournal["getSession"];

    const prime = runPrimeTurn({ ...options, runtime: "prime", journal: primeJournal });
    await staleReadCaptured.promise;
    await coreJournal.appendAtHead(
      session.id,
      { sequence: session.headSequence, digest: session.headDigest },
      [{ type: "turn.requested", turnId: "core-turn", payload: { content: "core won" } }],
    );
    releaseStaleRead.resolve();

    await expect(prime).rejects.toThrow(
      "runtime selection mismatch: this session runs airship-core; fork the session to use the PRIME runtime.",
    );
    const events = await coreJournal.readEvents(session.id);
    expect(events.filter((event) => event.type === PRIME_EVENT_TYPES.sessionRuntimeSelected)).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["session.created", "turn.requested"]);
  });

  it("refuses stale Core after Prime wins and never writes a Core turn request", async () => {
    const { primeJournal, coreJournal, session, options } = await twoJournalFixture();
    const staleReadCaptured = deferred();
    const releaseStaleRead = deferred();
    const originalGetSession = coreJournal.getSession.bind(coreJournal);
    let paused = false;
    coreJournal.getSession = (async (...args: Parameters<EventJournal["getSession"]>) => {
      const record = await originalGetSession(...args);
      if (!paused) {
        paused = true;
        staleReadCaptured.resolve();
        await releaseStaleRead.promise;
      }
      return record;
    }) as EventJournal["getSession"];

    const markerCommitted = deferred();
    const releaseMarker = deferred();
    const originalAppendAtHead = primeJournal.appendAtHead.bind(primeJournal);
    primeJournal.appendAtHead = (async (...args: Parameters<EventJournal["appendAtHead"]>) => {
      const commit = await originalAppendAtHead(...args);
      if (args[2].some((draft) => draft.type === PRIME_EVENT_TYPES.sessionRuntimeSelected)) {
        markerCommitted.resolve();
        await releaseMarker.promise;
      }
      return commit;
    }) as EventJournal["appendAtHead"];

    const core = runCoreTurn({ ...options, journal: coreJournal });
    await staleReadCaptured.promise;
    const prime = runPrimeTurn({ ...options, runtime: "prime", journal: primeJournal });
    await markerCommitted.promise;
    releaseStaleRead.resolve();

    await expect(core).rejects.toThrow(
      "runtime selection mismatch: this session is prime-pinned by journal records; fork the session to use the airship-core runtime.",
    );
    const eventsAtRefusal = await primeJournal.readEvents(session.id);
    expect(eventsAtRefusal.filter((event) => event.type === PRIME_EVENT_TYPES.sessionRuntimeSelected)).toHaveLength(1);
    expect(eventsAtRefusal.some((event) => event.type === "turn.requested")).toBe(false);

    releaseMarker.resolve();
    await expect(prime).resolves.toMatchObject({ content: "won" });
  });

  it("refuses direct Core when the Prime marker already precedes its session read", async () => {
    const { primeJournal, coreJournal, session, options } = await twoJournalFixture();
    await primeJournal.appendAtHead(
      session.id,
      { sequence: session.headSequence, digest: session.headDigest },
      [{
        type: PRIME_EVENT_TYPES.sessionRuntimeSelected,
        payload: { runtime: "prime", selectedBy: "race-test", at: "2026-08-20T00:00:00.000Z" },
      }],
    );

    await expect(runCoreTurn({ ...options, journal: coreJournal })).rejects.toThrow(
      "runtime selection mismatch: this session is prime-pinned by journal records; fork the session to use the airship-core runtime.",
    );
    const events = await coreJournal.readEvents(session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      PRIME_EVENT_TYPES.sessionRuntimeSelected,
    ]);
  });

  it("rereads in Core after the outer gate selected it from stale unpinned history", async () => {
    const { primeJournal, coreJournal, session, options } = await twoJournalFixture();
    const staleGateReadCaptured = deferred();
    const releaseGateRead = deferred();
    const originalReadEvents = coreJournal.readEvents.bind(coreJournal);
    let paused = false;
    coreJournal.readEvents = (async (...args: Parameters<EventJournal["readEvents"]>) => {
      const events = await originalReadEvents(...args);
      if (!paused) {
        paused = true;
        staleGateReadCaptured.resolve();
        await releaseGateRead.promise;
      }
      return events;
    }) as EventJournal["readEvents"];

    const core = runGatedTurn({
      ...options,
      runtime: "airship-core",
      journal: coreJournal,
    });
    await staleGateReadCaptured.promise;
    await primeJournal.appendAtHead(
      session.id,
      { sequence: session.headSequence, digest: session.headDigest },
      [{
        type: PRIME_EVENT_TYPES.sessionRuntimeSelected,
        payload: { runtime: "prime", selectedBy: "race-test", at: "2026-08-20T00:00:00.000Z" },
      }],
    );
    releaseGateRead.resolve();

    await expect(core).rejects.toThrow(
      "runtime selection mismatch: this session is prime-pinned by journal records; fork the session to use the airship-core runtime.",
    );
    const events = await primeJournal.readEvents(session.id);
    expect(events.some((event) => event.type === "turn.requested")).toBe(false);
  });
});
