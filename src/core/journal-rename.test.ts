import { describe, expect, it } from "vitest";
import { createSessionManifest } from "./agent";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("durable session rename", () => {
  it("records the title change in the hash-linked event stream", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Before", manifest);
    const renamed = await journal.renameSession(session.id, "After");
    expect(renamed.title).toBe("After");
    expect((await journal.readEvents(session.id)).at(-1)).toMatchObject({ type: "session.renamed", payload: { title: "After" } });
    expect((await journal.listSessions())[0]?.title).toBe("After");
    const report = await auditSessionHistory({ session: renamed, events: await journal.readEvents(session.id) });
    expect(report.status).toBe("verified");
    expect(report.counts.turns).toBe(0);
  });

  it("fails audit closed for a malformed rename event", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Before", manifest);
    await journal.append(session.id, [{ type: "session.renamed", payload: { title: "" } }]);
    const projected = await journal.getSession(session.id);
    const report = await auditSessionHistory({ session: projected!, events: await journal.readEvents(session.id) });
    expect(report.status).toBe("invalid");
  });

  it("does not append a title change after the admitted turn is cancelled", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Before", manifest);
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped by user", "AbortError"));

    await expect(journal.renameSession(session.id, "After", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect((await journal.getSession(session.id))?.title).toBe("Before");
  });
});

describe("rename durability across every journal backend", () => {
  /*
   * A rename is only an appended `session.renamed` event; projecting it into
   * the session record is each backend's job. Two backends did it and the
   * encrypted object journal did not, so a rename was durable in page memory
   * and on IndexedDB and silently lost in a Vault. The record then disagreed
   * with its own history, which the audit reports as
   * SESSION_TITLE_SNAPSHOT_MISMATCH — and an unresumable session takes every
   * conversation behind it down with it on the next reload.
   *
   * The projection is one shared function now. This asserts the behaviour at
   * each backend anyway, because the defect was precisely that two
   * implementations of one rule disagreed.
   */
  async function backends() {
    const { WorkspaceRootKey } = await import("../storage/encrypted-envelope");
    const { MemoryObjectStore } = await import("../storage/memory-object-store.test-support");
    const { EncryptedObjectJournalBackend } = await import("../storage/encrypted-object-journal");
    const { key } = await WorkspaceRootKey.generate();
    return [
      { name: "memory", backend: new MemoryJournalBackend() },
      { name: "encrypted object store", backend: new EncryptedObjectJournalBackend(new MemoryObjectStore(), key) },
    ];
  }

  it("persists the renamed title in the session record and keeps the session resumable", async () => {
    for (const { name, backend } of await backends()) {
      const journal = new EventJournal(backend);
      const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
      const created = await journal.createSession("Before", manifest);
      const renamed = await journal.renameSession(created.id, "Renamed before reload");

      expect(renamed.title, name).toBe("Renamed before reload");
      // Re-read rather than trust the return value: the record is what a
      // reload sees, and that is where the title was being dropped.
      expect((await journal.getSession(created.id))?.title, name).toBe("Renamed before reload");
      expect((await journal.listSessions()).find((s) => s.id === created.id)?.title, name).toBe("Renamed before reload");

      const report = await auditSessionHistory({
        session: (await journal.getSession(created.id))!,
        events: await journal.readEvents(created.id),
      });
      expect(report.status, name).toBe("verified");
      expect(report.findings.map((finding) => finding.code), name).not.toContain("SESSION_TITLE_SNAPSHOT_MISMATCH");
    }
  });
});
