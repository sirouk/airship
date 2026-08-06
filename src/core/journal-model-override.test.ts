import { describe, expect, it } from "vitest";
import { createSessionManifest } from "./agent";
import { createSessionContextPolicy } from "./context-policy";
import { EventJournal, effectiveSessionContextPolicy, effectiveSessionModel } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("durable same-thread model switching", () => {
  async function seed(model = "original/model-a") {
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({
      systemPrompt: "test",
      providerId: "local",
      model,
      tools: [],
      workspaceId: "workspace",
    });
    const session = await journal.createSession("Thread", manifest);
    return { journal, session, manifest };
  }

  it("records an in-flight model switch on the same chain without forking anything", async () => {
    const { journal, session, manifest } = await seed();
    const before = await journal.getSession(session.id);
    expect(before!.modelOverride).toBeUndefined();
    expect(effectiveSessionModel(before!)).toBe("original/model-a");

    const changed = await journal.setSessionModel(session.id, "different/provider-model-b");

    expect(changed.id).toBe(session.id);
    expect(changed.modelOverride).toBe("different/provider-model-b");
    expect(effectiveSessionModel(changed)).toBe("different/provider-model-b");
    // The manifest — like title's original spelling and the approval policy's
    // birth pin — is never touched by an override.
    expect(changed.manifest.model).toBe("original/model-a");
    expect((await journal.readEvents(session.id)).at(-1)).toMatchObject({
      type: "session.model-changed",
      payload: { model: "different/provider-model-b" },
    });
    expect((await journal.listSessions())[0]?.modelOverride).toBe("different/provider-model-b");
    const report = await auditSessionHistory({ session: changed, events: await journal.readEvents(session.id) });
    expect(report.status).toBe("verified");
  });

  it("projects the latest switch across journal backends and preserves the older pin through later renames", async () => {
    const { WorkspaceRootKey } = await import("../storage/encrypted-envelope");
    const { MemoryObjectStore } = await import("../storage/memory-object-store");
    const { EncryptedObjectJournalBackend } = await import("../storage/encrypted-object-journal");
    const { key } = await WorkspaceRootKey.generate();
    const backends = [
      { name: "memory", backend: new MemoryJournalBackend() },
      { name: "encrypted object store", backend: new EncryptedObjectJournalBackend(new MemoryObjectStore(), key) },
    ];
    for (const { name, backend } of backends) {
      const journal = new EventJournal(backend);
      const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "original/model-a", tools: [], workspaceId: "workspace" });
      const session = await journal.createSession("Thread", manifest);
      await journal.setSessionModel(session.id, "different/model-b");
      await journal.renameSession(session.id, "Renamed");

      const record = (await journal.getSession(session.id))!;
      expect(record.modelOverride, name).toBe("different/model-b");
      expect(record.title, name).toBe("Renamed");
      expect(record.manifest.model, name).toBe("original/model-a");
      const report = await auditSessionHistory({ session: record, events: await journal.readEvents(session.id) });
      expect(report.status, name).toBe("verified");
    }
  });

  it("rejects a malformed switch before it lands, and the audit fails closed on a forged one inside the chain", async () => {
    const { journal, session } = await seed();
    await expect(journal.setSessionModel(session.id, "\n")).rejects.toThrow(TypeError);
    expect((await journal.getSession(session.id))!.modelOverride).toBeUndefined();

    await journal.append(session.id, [{ type: "session.model-changed", payload: { model: "\u0007" } }]);
    const report = await auditSessionHistory({
      session: (await journal.getSession(session.id))!,
      events: await journal.readEvents(session.id),
    });
    expect(report.status).toBe("invalid");
  });

  it("the newest switch wins, and older pins in the same chain settle into the oldest receipts with their own honest names", async () => {
    const { journal, session } = await seed();
    await journal.setSessionModel(session.id, "different/model-b");
    await journal.setSessionModel(session.id, "another/model-c");
    await journal.setSessionApprovalMode(session.id, "auto-approve");

    const record = (await journal.getSession(session.id))!;
    expect(record.modelOverride).toBe("another/model-c");
    expect(record.approvalModeOverride).toBe("auto-approve");
    const report = await auditSessionHistory({ session: record, events: await journal.readEvents(session.id) });
    expect(report.status).toBe("verified");
  });
});
  it("rides the context-window policy into the compressing machinery with the model that provoked it", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const narrowPolicy = createSessionContextPolicy({
      contextWindowTokens: 2_048,
      source: { kind: "provider-catalog", field: "contextTokens" },
      summarizer: { mode: "extractive-fallback" },
    });
    const widePolicy = createSessionContextPolicy({
      contextWindowTokens: 32_768,
      source: { kind: "provider-catalog", field: "contextTokens" },
      summarizer: { mode: "extractive-fallback" },
    });
    const manifest = await createSessionManifest({
      systemPrompt: "test",
      providerId: "local",
      model: "original/model-a",
      tools: [],
      workspaceId: "workspace",
      contextPolicy: narrowPolicy,
    });
    const session = await journal.createSession("Thread", manifest);
    expect(effectiveSessionContextPolicy((await journal.getSession(session.id))!)?.contextWindowTokens).toBe(2_048);

    const changed = await journal.setSessionModel(session.id, "different/model-c", { contextPolicy: widePolicy });
    expect(effectiveSessionModel(changed)).toBe("different/model-c");
    expect(effectiveSessionContextPolicy(changed)?.contextWindowTokens).toBe(32_768);
    expect(changed.contextPolicyOverride).toEqual(widePolicy);

    // The audit replays the policy from the same chain that witnesses the model:
    expect((await auditSessionHistory({ session: changed, events: await journal.readEvents(session.id) })).status).toBe("verified");

    // An explicit "no policy" read is never schema-melted back to the manifest pin.
    const cleared = await journal.setSessionModel(session.id, "another/model-d", { contextPolicy: null });
    expect(cleared.contextPolicyOverride).toBeNull();
    expect(effectiveSessionContextPolicy(cleared)).toBeUndefined();
    expect(effectiveSessionModel(cleared)).toBe("another/model-d");
  });


