import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { MemoryWorkspace } from "../workspace/memory";
import { migrateJournalState, migrateWorkspaceState } from "./runtime-adoption";

describe("vault runtime adoption", () => {
  it("copies workspace content idempotently and refuses divergent cloud files", async () => {
    const source = new MemoryWorkspace();
    const target = new MemoryWorkspace();
    await source.write("README.md", "same bytes");
    await source.write("src/index.ts", "export const edge = true;\n");
    await source.write(".airship/git/head.v1.json", "git owns this migration plane");
    await source.write(".airship/terminal/sessions.v1.json", "terminal metadata is ordinary encrypted state");
    await target.write("README.md", "same bytes");

    await migrateWorkspaceState(source, target);
    expect((await target.read("src/index.ts"))?.content).toContain("edge = true");
    expect(await target.read(".airship/git/head.v1.json")).toBeUndefined();
    expect(await target.read(".airship/terminal/sessions.v1.json")).toMatchObject({ content: "terminal metadata is ordinary encrypted state" });
    await expect(migrateWorkspaceState(source, target)).resolves.toBeUndefined();

    await target.write("README.md", "different bytes", {
      expectedRevision: (await target.read("README.md"))!.revision,
    });
    await expect(migrateWorkspaceState(source, target)).rejects.toThrow("different content");
  });

  it("refuses an unstable workspace snapshot before writing any vault objects", async () => {
    const source = new MemoryWorkspace();
    const target = new MemoryWorkspace();
    await source.write("README.md", "before");
    const originalRead = source.read.bind(source);
    let changed = false;
    source.read = async (path) => {
      const file = await originalRead(path);
      if (!changed) {
        changed = true;
        await source.write(path, "after", { expectedRevision: file!.revision });
      }
      return file;
    };

    await expect(migrateWorkspaceState(source, target)).rejects.toThrow("changed during vault migration");
    await expect(target.list()).resolves.toEqual([]);
  });

  it("preserves exact event chains and refuses a stale cloud session", async () => {
    const sourceBackend = new MemoryJournalBackend();
    const source = new EventJournal(sourceBackend);
    const target = new MemoryJournalBackend();
    const manifest = await createSessionManifest({
      systemPrompt: "stable prompt",
      providerId: "test-provider",
      model: "test-model",
      tools: [],
      workspaceId: "memory://test",
      now: "2026-07-19T00:00:00.000Z",
    });
    const session = await source.createSession("Migration", manifest);
    await source.append(session.id, [{ type: "turn.requested", turnId: "turn-1", payload: { content: "hello" } }]);

    await migrateJournalState(source, target);
    expect(await target.getSession(session.id)).toMatchObject((await source.getSession(session.id))!);
    expect(await target.readEvents(session.id)).toEqual(await source.readEvents(session.id));
    await expect(migrateJournalState(source, target)).resolves.toBeUndefined();

    await source.append(session.id, [{ type: "turn.completed", turnId: "turn-1", payload: { responseDigest: "digest" } }]);
    await expect(migrateJournalState(source, target)).rejects.toThrow("conflicting session");
  });

  it("refuses a session append racing migration before creating a vault session", async () => {
    const source = new EventJournal(new MemoryJournalBackend());
    const target = new MemoryJournalBackend();
    const session = await source.createSession("Racing migration", await createSessionManifest({
      systemPrompt: "stable prompt",
      providerId: "test-provider",
      model: "test-model",
      tools: [],
      workspaceId: "memory://test",
      now: "2026-07-19T00:00:00.000Z",
    }));
    const originalReadEvents = source.readEvents.bind(source);
    let changed = false;
    source.readEvents = async (sessionId) => {
      const events = await originalReadEvents(sessionId);
      if (!changed) {
        changed = true;
        await source.append(sessionId, [
          { type: "turn.requested", turnId: "racing-turn", payload: { content: "new event" } },
        ]);
      }
      return events;
    };

    await expect(migrateJournalState(source, target)).rejects.toThrow("changed during vault migration");
    await expect(target.getSession(session.id)).resolves.toBeUndefined();
  });
});
