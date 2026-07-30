import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { EventJournal, JournalConflictError } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { SessionLibrary } from "./library";

/**
 * The verb the product promised and did not have.
 *
 * `docs/PRODUCT_SPEC.md` sells "Export, migrate, delete, or self-host all state
 * without vendor lock-in", and until this landed there was no delete on the
 * backend contract, on `EventJournal`, or on `SessionLibrary` — while
 * `library.ts` already shipped `UnknownSessionError`'s default message, "That
 * conversation was removed while it was being read.", for a state nothing could
 * produce. Someone who pasted a password or a client's name into a conversation
 * could only destroy the entire Vault.
 *
 * These are behavioural: they call the API and then ask storage whether the
 * bytes are gone, rather than asserting that a method exists.
 */

async function manifest() {
  return createSessionManifest({
    systemPrompt: "system prompt",
    providerId: "test",
    model: "test-model",
    tools: [],
    workspaceId: "workspace",
  });
}

async function seed(): Promise<Readonly<{ library: SessionLibrary; journal: EventJournal; sessionId: string }>> {
  const backend = new MemoryJournalBackend();
  const journal = new EventJournal(backend);
  const session = await journal.createSession("Quarterly numbers", await manifest());
  await journal.append(session.id, [{ type: "turn.started", payload: { prompt: "a client's name" } }]);
  return { library: new SessionLibrary(journal), journal, sessionId: session.id };
}

describe("deleting a conversation", () => {
  it("removes the record and its events, not just the listing", async () => {
    const { library, journal, sessionId } = await seed();
    expect(await journal.readEvents(sessionId)).not.toHaveLength(0);

    await library.delete(sessionId);

    expect(await journal.getSession(sessionId)).toBeUndefined();
    // The events are the part that held the text. A delete that unlists the
    // conversation while leaving its turns behind is the failure this guards.
    expect(await journal.readEvents(sessionId)).toHaveLength(0);
    expect((await journal.listSessions()).map((record) => record.id)).not.toContain(sessionId);
    const page = await library.list();
    expect(page.items.map((item) => item.id)).not.toContain(sessionId);
    expect(page.total).toBe(0);
  });

  it("refuses when a turn landed since the conversation was read", async () => {
    const { library, journal, sessionId } = await seed();
    const read = await journal.getSession(sessionId);
    const staleHead = { sequence: read!.headSequence, digest: read!.headDigest };
    // Someone is still replying while the confirmation dialog is open.
    await journal.append(sessionId, [{ type: "turn.completed", payload: { text: "the reply nobody has read" } }]);

    await expect(library.delete(sessionId, { expectedHead: staleHead })).rejects.toThrow(JournalConflictError);
    // And nothing was destroyed on the way to refusing.
    expect(await journal.getSession(sessionId)).toBeDefined();
  });

  it("deletes at the head it just read when the caller supplies none", async () => {
    const { library, journal, sessionId } = await seed();
    await expect(library.delete(sessionId)).resolves.toBeUndefined();
    expect(await journal.getSession(sessionId)).toBeUndefined();
  });

  it("treats an already-absent conversation as deleted rather than an error", async () => {
    const { library, journal, sessionId } = await seed();
    await library.delete(sessionId);
    // Removal is the goal. A second delete — a double-tap, or two tabs — has
    // already got what it asked for.
    await expect(journal.deleteSession(sessionId, { sequence: 0, digest: "genesis" })).resolves.toBeUndefined();
  });

  it("leaves every other conversation untouched", async () => {
    const backend = new MemoryJournalBackend();
    const journal = new EventJournal(backend);
    const library = new SessionLibrary(journal);
    const doomed = await journal.createSession("Doomed", await manifest());
    const kept = await journal.createSession("Kept", await manifest());
    await journal.append(kept.id, [{ type: "turn.started", payload: { prompt: "still wanted" } }]);

    await library.delete(doomed.id);

    expect(await journal.getSession(kept.id)).toBeDefined();
    expect(await journal.readEvents(kept.id)).toHaveLength(2);
  });

  it("rejects a malformed identifier before touching storage", async () => {
    const { library, journal, sessionId } = await seed();
    await expect(library.delete("../../etc/passwd")).rejects.toThrow();
    expect(await journal.getSession(sessionId)).toBeDefined();
  });
});
