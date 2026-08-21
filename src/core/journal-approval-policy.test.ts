import { describe, expect, it } from "vitest";
import { createSessionManifest } from "./agent";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("durable same-thread approval policy changes", () => {
  async function seed() {
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({
      systemPrompt: "test",
      providerId: "local",
      model: "demo",
      tools: [],
      workspaceId: "workspace",
    });
    const session = await journal.createSession("Thread", manifest);
    return { journal, session, manifest };
  }

  it("records the change on the same chain without minting a new thread", async () => {
    const { journal, session, manifest } = await seed();
    const before = await journal.getSession(session.id);
    expect(before!.approvalModeOverride).toBeUndefined();

    const changed = await journal.setSessionApprovalMode(session.id, "auto-approve");

    expect(changed.id).toBe(session.id);
    expect(changed.approvalModeOverride).toBe("auto-approve");
    // The manifest is the conversation's birth certificate and does not move.
    expect(changed.manifest).toEqual(before!.manifest);
    expect((await journal.readEvents(session.id)).at(-1)).toMatchObject({
      type: "session.approval-policy-changed",
      payload: { approvalMode: "auto-approve" },
    });
    expect((await journal.listSessions())[0]?.approvalModeOverride).toBe("auto-approve");
    const report = await auditSessionHistory({ session: changed, events: await journal.readEvents(session.id) });
    expect(report.status).toBe("verified");
    expect(changed.headSequence).toBe(before!.headSequence + 1);
  });

  it("lets the latest change win, projects it across journal backends, and survives the rename projection", async () => {
    const { WorkspaceRootKey } = await import("../storage/encrypted-envelope");
    const { MemoryObjectStore } = await import("../storage/memory-object-store.test-support");
    const { EncryptedObjectJournalBackend } = await import("../storage/encrypted-object-journal");
    const { key } = await WorkspaceRootKey.generate();
    const backends = [
      { name: "memory", backend: new MemoryJournalBackend() },
      { name: "encrypted object store", backend: new EncryptedObjectJournalBackend(new MemoryObjectStore(), key) },
    ];

    for (const { name, backend } of backends) {
      const journal = new EventJournal(backend);
      const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
      const session = await journal.createSession("Thread", manifest);
      await journal.setSessionApprovalMode(session.id, "auto-approve");
      await journal.setSessionApprovalMode(session.id, "ask-first");
      await journal.renameSession(session.id, "Renamed");

      // Read the record a reload would see, not the return from either call —
      // the override must survive both projections across the vault and
      // page-memory backends alike.
      const record = (await journal.getSession(session.id))!;
      expect(record.title, name).toBe("Renamed");
      expect(record.approvalModeOverride, name).toBe("ask-first");
      const events = await journal.readEvents(session.id);
      expect(events.filter((event) => event.type === "session.approval-policy-changed").length, name).toBe(2);
      const report = await auditSessionHistory({ session: record, events });
      expect(report.status, name).toBe("verified");
    }
  });

  it("fails the audit closed for a malformed mode event", async () => {
    const { journal, session } = await seed();
    await journal.append(session.id, [{ type: "session.approval-policy-changed", payload: { approvalMode: "everywhere" } }]);
    const report = await auditSessionHistory({
      session: (await journal.getSession(session.id))!,
      events: await journal.readEvents(session.id),
    });
    expect(report.status).toBe("invalid");
  });

  it("settles a mode change raced against turn events without refusing either writer", async () => {
    const { journal, session } = await seed();
    const results = await Promise.allSettled([
      journal.append(session.id, [{ type: "turn.requested", payload: { prompt: "streaming turn" } }]),
      journal.setSessionApprovalMode(session.id, "full-access"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const events = await journal.readEvents(session.id);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.previousDigest).toBe(events[index - 1]!.digest);
    }
    expect((await journal.getSession(session.id))?.approvalModeOverride).toBe("full-access");
  });

  it("rejects a mode outside the approved vocabulary before any event lands", async () => {
    const { journal, session } = await seed();
    await expect(journal.setSessionApprovalMode(session.id, "everything" as never)).rejects.toThrow(TypeError);
    const record = await journal.getSession(session.id);
    expect(record?.approvalModeOverride).toBeUndefined();
  });

  it("does not append a mode change after the admitted turn is cancelled", async () => {
    const { journal, session } = await seed();
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped by user", "AbortError"));
    await expect(journal.setSessionApprovalMode(session.id, "auto-approve", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const record = await journal.getSession(session.id);
    expect(record?.approvalModeOverride).toBeUndefined();
  });
});
