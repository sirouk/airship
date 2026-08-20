import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { MemoryWorkspace } from "../workspace/memory";
import { createBuiltInProfileCatalog } from "../profiles/catalog";
import { createGlobalSkillSettings } from "../profiles/domain";
import { EncryptedProfileCatalogStore, MemoryProfileCatalogStore } from "../profiles/persistence";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { EncryptedObjectJournalBackend } from "../storage/encrypted-object-journal";
import { MemoryObjectStore } from "../storage/memory-object-store.test-support";
import {
  adoptionCarriedNote,
  migrateJournalState,
  migrateProfileCatalogState,
  migrateWorkspaceState,
  readAdoptionCarriedWork,
} from "./runtime-adoption";

describe("what adoption tells the person it just moved", () => {
  /*
   * The measured defect (J110): a completed turn in `#chat/7ec47231…`, then
   * Vault → "Create encrypted Vault" → Chat, and the person is in
   * `#chat/40ec5b12…` with a rail reading "General · encrypted vault — No
   * messages yet". The work was not destroyed — this migration had copied it —
   * but nothing on any screen said so, and the conversation they were in is
   * fork-required from that moment because its manifest pins the page-memory
   * workspace. Silence turned a structural consequence into a disappearance.
   */
  it("names the count and the thread, and does not promise continuity it cannot deliver", () => {
    const note = adoptionCarriedNote({ conversations: 2, activeTitle: "Draft the Q3 pricing memo" });
    expect(note).toContain("2 conversations");
    expect(note).toContain("Draft the Q3 pricing memo");
    expect(note).toContain("All conversations");
    // The half that must never be dropped: a count with no route forward reads
    // as "we kept it somewhere" and sends a person hunting for a resume that
    // the workspace pin will refuse.
    expect(note).toContain("Fork to continue");
    expect(adoptionCarriedNote({ conversations: 1 })).toContain("1 conversation from page memory");
  });

  it("says nothing when nothing was carried", () => {
    // A first-ever visit adopting a Vault has no story to tell, and inventing
    // one is how a welcome screen starts reporting losses that never happened.
    expect(adoptionCarriedNote(undefined)).toBe("");
    expect(adoptionCarriedNote({ conversations: 0 })).toBe("");
  });

  it("reads the count and the active thread out of the journal it is about to copy", async () => {
    const backend = new MemoryJournalBackend();
    const journal = new EventJournal(backend);
    const manifest = await createSessionManifest({
      systemPrompt: "stable prompt",
      providerId: "test-provider",
      model: "test-model",
      tools: [],
      workspaceId: "memory://page",
      now: "2026-07-19T00:00:00.000Z",
    });
    const first = await journal.createSession("Draft the Q3 pricing memo", manifest);
    await journal.createSession("quick unrelated question about timezones", manifest);

    expect(await readAdoptionCarriedWork(journal, "general")).toMatchObject({ conversations: 2 });
    // With no profile pointer the count still stands and the name is simply
    // absent, rather than the sentence naming the wrong conversation.
    expect((await readAdoptionCarriedWork(journal, "general")).activeTitle).toBeUndefined();
    expect(first.title).toBe("Draft the Q3 pricing memo");
  });
});

describe("vault runtime adoption", () => {
  it("creates, recovers, and conflict-fences the provider-neutral profile catalog", async () => {
    const sourceStore = new MemoryProfileCatalogStore();
    const builtIn = await createBuiltInProfileCatalog();
    const source = (await sourceStore.initialize(builtIn)).checkpoint;
    const objects = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const vault = new EncryptedProfileCatalogStore(objects, key);

    const created = await migrateProfileCatalogState(source, vault, { sourceIsBootstrap: true });
    expect(created).toMatchObject({ disposition: "created", checkpoint: { generation: 1, digest: source.digest } });

    const editedCatalog = Object.freeze({
      ...created.checkpoint.catalog,
      globalSkills: createGlobalSkillSettings({ ...created.checkpoint.catalog.globalSkills, "concise-handoff": true }),
    });
    const edited = await vault.commit(created.checkpoint, editedCatalog);
    const freshPage = new MemoryProfileCatalogStore();
    const freshSeed = (await freshPage.initialize(builtIn)).checkpoint;
    const recovered = await migrateProfileCatalogState(freshSeed, vault, { sourceIsBootstrap: true });
    expect(recovered).toMatchObject({
      disposition: "adopted-existing",
      checkpoint: { digest: edited.digest, catalog: { globalSkills: { "concise-handoff": true } } },
    });

    const locallyEdited = await freshPage.commit(freshSeed, Object.freeze({
      ...builtIn,
      globalSkills: createGlobalSkillSettings({ ...builtIn.globalSkills, "workspace-steward": true }),
    }));
    await expect(migrateProfileCatalogState(locallyEdited, vault, { sourceIsBootstrap: false }))
      .rejects.toThrow("different profile catalog");
  });

  it("copies workspace content idempotently and refuses divergent cloud files", async () => {
    const source = new MemoryWorkspace();
    const target = new MemoryWorkspace();
    await source.write("README.md", "same bytes");
    await source.write("src/index.ts", "export const edge = true;\n");
    await source.write(".airship/git/head.v1.json", "git owns this migration plane");
    await source.write(".airship/browser-git-repositories.v1.json", "real Git registry");
    await source.write("sources/example/.git/HEAD", "real Git HEAD");
    await source.write("sources/example/.git/index", "real Git index");
    await source.write(".airship/terminal/sessions.v1.json", "terminal metadata is ordinary encrypted state");
    await target.write("README.md", "same bytes");

    await migrateWorkspaceState(source, target);
    expect((await target.read("src/index.ts"))?.content).toContain("edge = true");
    expect(await target.read(".airship/git/head.v1.json")).toBeUndefined();
    expect(await target.read(".airship/browser-git-repositories.v1.json")).toMatchObject({ content: "real Git registry" });
    expect(await target.read("sources/example/.git/HEAD")).toMatchObject({ content: "real Git HEAD" });
    expect(await target.read("sources/example/.git/index")).toMatchObject({ content: "real Git index" });
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

  it("restores an exact deleted encrypted ID and appends its preserved history under the new incarnation", async () => {
    const source = new EventJournal(
      new MemoryJournalBackend(),
      () => "2026-08-20T00:00:00.000Z",
      () => "same-id",
    );
    const manifest = await createSessionManifest({
      systemPrompt: "stable prompt",
      providerId: "test-provider",
      model: "test-model",
      tools: [],
      workspaceId: "memory://test",
      now: "2026-08-20T00:00:00.000Z",
    });
    const session = await source.createSession("Restored history", manifest);
    await source.append(session.id, [
      { type: "message.user", payload: { content: "preserve me" } },
    ]);
    const { key } = await WorkspaceRootKey.generate();
    const target = new EncryptedObjectJournalBackend(new MemoryObjectStore(), key, "adoption-reuse");
    await migrateJournalState(source, target);
    const first = (await target.getSession(session.id))!;
    await target.deleteSession(session.id, {
      sequence: first.headSequence,
      digest: first.headDigest,
      incarnation: first.headIncarnation,
    });

    await expect(migrateJournalState(source, target)).resolves.toBeUndefined();
    expect((await target.getSession(session.id))?.title).toBe("Restored history");
    expect(await target.readEvents(session.id)).toEqual(await source.readEvents(session.id));
  });

  it("migrates a newly created session whose journal head is still genesis", async () => {
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
    const session = {
      id: "empty-migration-session",
      title: "Empty migration",
      manifest,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      headSequence: 0,
      headDigest: "genesis",
    };
    await sourceBackend.createSession(session);

    await expect(migrateJournalState(source, target)).resolves.toBeUndefined();
    await expect(target.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      headSequence: 0,
      headDigest: "genesis",
    });
    await expect(target.readEvents(session.id)).resolves.toEqual([]);
  });

  it("refuses conflicting session authority even when the journal head and prompt digests match", async () => {
    const sourceBackend = new MemoryJournalBackend();
    const source = new EventJournal(sourceBackend);
    const target = new MemoryJournalBackend();
    const manifest = await createSessionManifest({
      systemPrompt: "stable prompt",
      providerId: "test-provider",
      model: "source-model",
      tools: [],
      workspaceId: "memory://source",
      now: "2026-07-19T00:00:00.000Z",
    });
    const session = {
      id: "conflicting-authority-session",
      title: "Source session",
      manifest,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      headSequence: 0,
      headDigest: "genesis",
    };
    await sourceBackend.createSession(session);
    await target.createSession({
      ...structuredClone(session),
      manifest: {
        ...structuredClone(session.manifest),
        model: "substituted-model",
      },
    });

    await expect(migrateJournalState(source, target)).rejects.toThrow("conflicting session");
    await expect(target.getSession(session.id)).resolves.toMatchObject({
      manifest: { model: "substituted-model" },
    });
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
