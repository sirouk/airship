import { describe, expect, it } from "vitest";
import { EventJournal, type DurableEvent, type JournalBackend, type SessionRecord } from "./journal";

describe("EventJournal cancellation propagation", () => {
  it("forwards a turn signal to a cloud-style blocking session read", async () => {
    let observed: AbortSignal | undefined;
    const backend: JournalBackend = {
      async createSession() {},
      async getSession(_sessionId, signal) {
        observed = signal;
        return new Promise<SessionRecord | undefined>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async listSessions() { return []; },
      async readEvents() { return []; },
      async deleteSession() {},
      async append(_sessionId, _head, _events): Promise<SessionRecord> { throw new Error("not reached"); },
    };
    const journal = new EventJournal(backend);
    const controller = new AbortController();
    const pending = journal.getSession("blocked", controller.signal);

    controller.abort(new DOMException("Stopped by user", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observed).toBe(controller.signal);
  });

  it("forwards the signal through the append read and write boundary", async () => {
    const session: SessionRecord = {
      id: "session-1",
      title: "Session",
      manifest: {
        protocolVersion: 1,
        systemPrompt: "test",
        systemPromptDigest: "sha256:system",
        providerId: "test",
        model: "test",
        toolManifestDigest: "sha256:tools",
        tools: [],
        workspaceId: "memory://test",
        capabilityTier: "web-baseline",
        createdAt: "2026-07-19T00:00:00.000Z",
      },
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      headSequence: 0,
      headDigest: "genesis",
    };
    const seen: AbortSignal[] = [];
    const backend: JournalBackend = {
      async createSession() {},
      async getSession(_sessionId, signal) { if (signal) seen.push(signal); return session; },
      async listSessions() { return []; },
      async readEvents() { return []; },
      async deleteSession() {},
      async append(_sessionId, _head, _events: DurableEvent[], signal) {
        if (signal) seen.push(signal);
        return session;
      },
    };
    const controller = new AbortController();
    const journal = new EventJournal(backend, () => "2026-07-19T00:00:01.000Z", () => "event-1");

    await journal.append("session-1", [{ type: "turn.requested", payload: { content: "hello" } }], controller.signal);

    expect(seen).toEqual([controller.signal, controller.signal]);
  });
});
