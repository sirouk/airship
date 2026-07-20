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
});
