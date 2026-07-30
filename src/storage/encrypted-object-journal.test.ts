import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { EventJournal, JournalConflictError } from "../core/journal";
import { MemoryObjectStore } from "./memory-object-store";
import { WorkspaceRootKey } from "./encrypted-envelope";
import { EncryptedObjectJournalBackend } from "./encrypted-object-journal";

describe("EncryptedObjectJournalBackend", () => {
  it("round-trips cloud-authoritative sessions without plaintext object bytes", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    let id = 0;
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => `id-${++id}`);
    const session = await journal.createSession("Private title", await manifest());
    await journal.append(session.id, [{ type: "message.user", payload: { content: "private prompt" } }]);

    const sessions = await journal.listSessions();
    const events = await journal.readEvents(session.id);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.headSequence).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["session.created", "message.user"]);
    expect(events[1]!.payload).toEqual({ content: "private prompt" });
    const objects = await store.list("airship/v1/");
    const serializedCiphertext = await Promise.all(objects.map(async (object) => new TextDecoder().decode((await store.get(object.key))!.bytes)));
    expect(serializedCiphertext.join("\n")).not.toContain("Private title");
    expect(serializedCiphertext.join("\n")).not.toContain("private prompt");
  });

  it("serializes concurrent writers with exactly one session-head winner", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const seed = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await seed.createSession("Race", await manifest());
    const left = new EventJournal(backend, () => "2026-07-18T00:00:01.000Z", () => `left-${crypto.randomUUID()}`);
    const right = new EventJournal(backend, () => "2026-07-18T00:00:01.000Z", () => `right-${crypto.randomUUID()}`);

    const results = await Promise.allSettled([
      left.append(session.id, [{ type: "message.user", payload: { writer: "left" } }]),
      right.append(session.id, [{ type: "message.user", payload: { writer: "right" } }]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(JournalConflictError);
    const events = await seed.readEvents(session.id);
    expect(events).toHaveLength(2);
  });
});

async function manifest() {
  return createSessionManifest({
    systemPrompt: "private system prompt",
    providerId: "test",
    model: "test-model",
    tools: [],
    workspaceId: "workspace",
  });
}

/**
 * Deletion at the tier where it matters most.
 *
 * The encrypted Vault is what a person chose when they decided their
 * conversations were nobody else's business, so "delete" here has to mean the
 * ciphertext is gone from the store, not that the conversation stopped being
 * listed. These read the object store directly afterwards rather than trusting
 * the journal's own view of itself.
 */
describe("EncryptedObjectJournalBackend deletion", () => {
  it("removes the head and every segment from the object store", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Doomed", await manifest());
    await journal.append(session.id, [{ type: "message.user", payload: { content: "delete me" } }]);
    const kept = await journal.createSession("Kept", await manifest());
    expect((await store.list("airship/v1/")).length).toBeGreaterThan(2);

    const record = (await journal.getSession(session.id))!;
    await journal.deleteSession(session.id, { sequence: record.headSequence, digest: record.headDigest });

    expect(await journal.getSession(session.id)).toBeUndefined();
    expect((await journal.listSessions()).map((item) => item.id)).toEqual([kept.id]);
    // Nothing of the deleted conversation may remain addressable in the store.
    const remaining = await Promise.all((await store.list("airship/v1/"))
      .map(async (summary) => new TextDecoder().decode((await store.get(summary.key))!.bytes)));
    expect(remaining.join("\n")).not.toContain("delete me");
    // And the conversation that was not deleted is still readable.
    expect(await journal.getSession(kept.id)).toBeDefined();
  });

  it("refuses a delete whose head is not the head that was read", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Racing", await manifest());
    const read = (await journal.getSession(session.id))!;
    await journal.append(session.id, [{ type: "message.user", payload: { content: "arrived late" } }]);

    await expect(journal.deleteSession(session.id, { sequence: read.headSequence, digest: read.headDigest }))
      .rejects.toThrow(JournalConflictError);
    expect(await journal.getSession(session.id)).toBeDefined();
  });

  it("says so rather than reporting a deletion a store cannot perform", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    // A store from the base contract, which is deliberately delete-free.
    const unreclaimable = Object.create(store, { trash: { value: undefined } }) as typeof store;
    const backend = new EncryptedObjectJournalBackend(unreclaimable, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Undeletable", await manifest());
    const record = (await journal.getSession(session.id))!;

    await expect(journal.deleteSession(session.id, { sequence: record.headSequence, digest: record.headDigest }))
      .rejects.toThrow(/cannot delete objects/u);
    // Telling someone their conversation is gone while the ciphertext stays is
    // the one outcome worse than refusing.
    expect(await journal.getSession(session.id)).toBeDefined();
  });
});
