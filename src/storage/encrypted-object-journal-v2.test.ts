import { describe, expect, it } from "vitest";
import type { SessionInferenceBindingV2, SessionManifest } from "../core/contracts";
import { EventJournal } from "../core/journal";
import { createSessionManifest } from "../core/session-manifest";
import { EncryptedObjectJournalBackend } from "./encrypted-object-journal";
import { WorkspaceRootKey } from "./encrypted-envelope";
import { MemoryObjectStore } from "./memory-object-store.test-support";

const binding: SessionInferenceBindingV2 = Object.freeze({
  version: 2,
  connectionId: "ollama-loopback",
  connectionGeneration: 2,
  providerId: "ollama",
  providerLabel: "Ollama",
  providerRevision: 1,
  transportId: "ollama-openai-local-v1",
  protocol: "openai-compatible",
  authMethod: "local-none",
  transportBoundary: "loopback-local",
  modelId: "gemma3:latest",
  boundAt: "2026-08-20T00:00:00.000Z",
});

async function v2Manifest(): Promise<SessionManifest> {
  return createSessionManifest({
    systemPrompt: "encrypted split route",
    providerId: binding.providerId,
    model: binding.modelId,
    inferenceBinding: binding,
    tools: [],
    workspaceId: "encrypted-workspace",
  });
}

describe("encrypted v2 inference bindings", () => {
  it("round-trips exact provider, protocol, and transport authority", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const first = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const created = await first.createSession("v2 encrypted", await v2Manifest());
    await first.append(created.id, [{ type: "message.user", payload: { content: "hello" } }]);

    const reopened = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    expect((await reopened.getSession(created.id))?.manifest.inferenceBinding).toEqual(binding);
    expect((await reopened.readEvents(created.id)).map((event) => event.type))
      .toEqual(["session.created", "message.user"]);
  });

  it("refuses malformed v2 route fields before storing ciphertext", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const journal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const valid = await v2Manifest();
    for (const inferenceBinding of [
      { ...binding, transportId: "" },
      { ...binding, protocol: "unknown-wire" },
      { ...binding, providerId: "other" },
    ]) {
      await expect(journal.createSession("invalid", {
        ...valid,
        inferenceBinding,
      } as unknown as SessionManifest)).rejects.toThrow(/inference binding|transport ID/u);
    }
    expect(await store.list("airship/v1/")).toEqual([]);
  });

  it("keeps historical e2ee-attestable v1 records readable but non-upgradable", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const journal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const legacy = await createSessionManifest({
      systemPrompt: "historical",
      providerId: "historical-transport-v1",
      model: binding.modelId,
      tools: [],
      workspaceId: "encrypted-workspace",
      inferenceBinding: {
        version: 1,
        connectionId: binding.connectionId,
        connectionGeneration: binding.connectionGeneration,
        providerId: binding.providerId,
        providerLabel: binding.providerLabel,
        providerRevision: binding.providerRevision,
        authMethod: binding.authMethod,
        transportBoundary: "e2ee-attestable",
        modelId: binding.modelId,
        boundAt: binding.boundAt,
      },
    });
    const created = await journal.createSession("legacy", legacy);
    expect((await journal.getSession(created.id))?.manifest.inferenceBinding)
      .toMatchObject({ version: 1, transportBoundary: "e2ee-attestable" });
  });
});
