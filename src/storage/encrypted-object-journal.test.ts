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
