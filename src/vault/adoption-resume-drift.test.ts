import { describe, expect, it } from "vitest";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { migrateJournalState } from "./runtime-adoption";

/**
 * An interrupted adoption is resumable, including after the person did
 * something ordinary to the conversation while it was interrupted.
 *
 * Measured before this: one dropped connection left a genesis stub, one rename
 * on the source afterwards made every later attempt refuse by name — "contains
 * a conflicting session" — forever, and with it the whole Vault adoption. The
 * title, the approval mode and the model are device-granted facts the target
 * owns; none of them makes this a different conversation.
 */
function interrupting(target: MemoryJournalBackend): MemoryJournalBackend {
  return new Proxy(target, {
    get(instance, property, receiver) {
      if (property === "append") return async () => { throw new Error("network blip"); };
      const value = Reflect.get(instance, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
    },
  }) as MemoryJournalBackend;
}

async function sourceWithOneConversation() {
  const backend = new MemoryJournalBackend();
  const journal = new EventJournal(backend);
  const created = await journal.createSession("Quarterly numbers", {
    protocolVersion: 2,
    turnContext: "disabled",
    systemPrompt: "prompt",
    systemPromptDigest: "digest",
    providerId: "demo",
    model: "airship/demo-v1",
    toolManifestDigest: "digest",
    tools: [],
    workspaceId: "ws-1",
    capabilityTier: "web-baseline",
    createdAt: new Date(0).toISOString(),
  } as never);
  await journal.append(created.id, [
    { type: "turn.requested", payload: { text: "hello" } },
    { type: "turn.completed", payload: { text: "hi" } },
  ]);
  return { backend, journal, sessionId: created.id };
}

describe("interrupted vault adoption", () => {
  for (const [what, disturb] of [
    ["a rename", async (journal: EventJournal, id: string) => { await journal.renameSession(id, "Quarterly numbers (final)"); }],
    ["an approval-mode change", async (journal: EventJournal, id: string) => { await journal.setSessionApprovalMode(id, "auto-approve"); }],
    ["a model change", async (journal: EventJournal, id: string) => { await journal.setSessionModel(id, "airship/demo-v2"); }],
  ] as const) {
    it(`finishes after ${what} between the interruption and the retry`, async () => {
      const { backend, journal, sessionId } = await sourceWithOneConversation();
      const target = new MemoryJournalBackend();
      await expect(migrateJournalState(backend, interrupting(target))).rejects.toThrow(/network blip/u);
      expect((await target.getSession(sessionId))?.headSequence).toBe(0);

      await disturb(journal, sessionId);
      await migrateJournalState(backend, target);

      const source = await journal.getSession(sessionId);
      const landed = await target.getSession(sessionId);
      expect(landed?.headSequence).toBe(source?.headSequence);
      expect(landed?.headDigest).toBe(source?.headDigest);
      // The rename is an event, so the replay carries the new name in itself.
      expect(landed?.title).toBe(source?.title);
    });
  }

  it("still refuses a genuinely different conversation under the same id", async () => {
    const { backend, journal, sessionId } = await sourceWithOneConversation();
    const target = new MemoryJournalBackend();
    const impostor = await journal.getSession(sessionId);
    await target.createSession({ ...impostor!, createdAt: "2020-01-01T00:00:00.000Z", headSequence: 0, headDigest: "genesis" });
    await expect(migrateJournalState(backend, target)).rejects.toThrow(/conflicting session/u);
  });
});
