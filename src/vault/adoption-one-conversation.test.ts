import { describe, expect, it } from "vitest";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { migrateJournalState } from "./runtime-adoption";

/**
 * One conversation may not decide the fate of the others.
 *
 * `applyWorkBundleImport` already had this property because it calls the merge
 * once per conversation. The Vault path calls it once for the whole journal
 * (`src/ui/app.tsx`), and the loop used to throw out of the adoption at the
 * first refusal. Measured before this: with a conflicting record under the
 * second conversation's id, `Alpha` and `Charlie` never reached the Vault, and
 * they never would — the refusal is permanent, so every retry stopped at the
 * same conversation and the authority swap after the call never ran.
 *
 * A person reaches this without doing anything unusual: `applyWorkBundleImport`
 * stamps `importedAt` with the time of the import, so the same bundle taken in
 * on two days under the same id produces two records that differ in one field
 * `sameSessionRecord` compares.
 */
async function conversation(journal: EventJournal, title: string): Promise<string> {
  const created = await journal.createSession(title, {
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
  return created.id;
}

describe("vault adoption with one refused conversation", () => {
  it("finishes every conversation it can and still names the one it refused", async () => {
    const backend = new MemoryJournalBackend();
    const journal = new EventJournal(backend);
    const first = await conversation(journal, "Alpha");
    const blocked = await conversation(journal, "Bravo");
    const last = await conversation(journal, "Charlie");

    const target = new MemoryJournalBackend();
    const impostor = await backend.getSession(blocked);
    if (!impostor) throw new Error("the source lost the conversation this test is about");
    // A genuinely different record under the same id: created somewhere else.
    await target.createSession({ ...impostor, createdAt: "2020-01-01T00:00:00.000Z", headSequence: 0, headDigest: "genesis" });

    await expect(migrateJournalState(backend, target)).rejects.toThrow(/conflicting session/u);

    const source = await backend.getSession(first);
    expect((await target.getSession(first))?.headSequence).toBe(source?.headSequence);
    expect((await target.getSession(last))?.headSequence).toBe((await backend.getSession(last))?.headSequence);
    // And the refusal is still a refusal: nothing was written over it.
    expect((await target.getSession(blocked))?.headSequence).toBe(0);
  });

  it("reports every refusal when more than one conversation is refused", async () => {
    const backend = new MemoryJournalBackend();
    const journal = new EventJournal(backend);
    const first = await conversation(journal, "Alpha");
    const second = await conversation(journal, "Bravo");
    const target = new MemoryJournalBackend();
    for (const id of [first, second]) {
      const impostor = await backend.getSession(id);
      if (!impostor) throw new Error("the source lost a conversation this test is about");
      await target.createSession({ ...impostor, createdAt: "2020-01-01T00:00:00.000Z", headSequence: 0, headDigest: "genesis" });
    }
    await expect(migrateJournalState(backend, target)).rejects.toThrow(/Some conversations were refused/u);
  });
});
