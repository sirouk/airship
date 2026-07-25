import { describe, expect, it, vi } from "vitest";
import { createSessionManifest } from "../core/agent";
import { canonicalContextSelection, verifyContextSelection } from "../core/context-selection";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store";
import { EncryptedObjectWorkspace } from "../vault/encrypted-workspace";
import { VaultContextFabricPort } from "../vault/context-fabric-port";
import {
  createAirshipToolRegistry,
  createVaultAwareAirshipToolRegistry,
  createVaultBackedAirshipToolRegistry,
} from "./airship-tools";

describe("Vault-aware Airship tool registry", () => {
  it("federates an existing encrypted ranged generation without issuing a write", async () => {
    const store = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const workspace = new EncryptedObjectWorkspace(store, key);
    await workspace.write("docs/ranged.md", "Ranged expert pages ground an Airship turn from encrypted storage.");
    const journal = new EventJournal(new MemoryJournalBackend());
    const contextFabric = new VaultContextFabricPort(store, key, workspace);
    const bootstrap = await createAirshipToolRegistry({ workspace, journal });
    const contextRuntime = bootstrap.getContextRuntime();
    if (!contextRuntime) throw new Error("expected context runtime");
    await contextRuntime.refreshNow();
    await contextFabric.install({
      workspaceId: "vault+test://active-runtime",
      publication: contextRuntime.exportActiveGeneration(),
      publicationPolicy: "explicit-user-approved",
    });
    const put = vi.spyOn(store, "putIfAbsent");

    const adopted = await createVaultAwareAirshipToolRegistry({
      workspace,
      journal,
      workspaceId: "vault+test://active-runtime",
      contextFabric,
    });
    expect(adopted).toMatchObject({
      contextMode: "encrypted-ranged",
      resolution: {
        mode: "ranged-vault",
        provenance: { workspaceId: "vault+test://active-runtime" },
      },
    });
    expect(put).not.toHaveBeenCalled();

    const session = await createSession(journal, adopted.tools, "vault+test://active-runtime");
    const selection = await adopted.tools.getTurnContextProvider()?.selectForTurn("ranged expert pages", {
      sessionId: session.id,
      maxHits: 4,
      maxBytes: 8_192,
    });
    expect(selection).toBeDefined();
    expect(canonicalContextSelection(selection)).toBeDefined();
    expect(await verifyContextSelection(selection!)).toBe(true);
    expect(selection).toMatchObject({
      retrieval: {
        mode: "encrypted-object-range-v1",
        adapter: "memory",
        rangeContract: "exact-or-fail",
        complete: true,
      },
      lineage: {
        retriever: "airship-federated-turn-context-v1",
        generations: [expect.objectContaining({
          corpus: "workspace",
          persistence: "encrypted-vault",
        })],
      },
    });
  });

  it("keeps the on-device provider active when no encrypted mirror exists", async () => {
    const store = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const workspace = new EncryptedObjectWorkspace(store, key);
    await workspace.write("docs/local.md", "Local fallback remains exact and generation pinned.");
    const journal = new EventJournal(new MemoryJournalBackend());
    const put = vi.spyOn(store, "putIfAbsent");

    const adopted = await createVaultAwareAirshipToolRegistry({
      workspace,
      journal,
      workspaceId: "vault+test://local-fallback",
      contextFabric: new VaultContextFabricPort(store, key, workspace),
    });
    expect(adopted).toMatchObject({
      contextMode: "local-fallback",
      resolution: { mode: "local-fallback", reason: "mirror-missing" },
    });
    expect(put).not.toHaveBeenCalled();

    const session = await createSession(journal, adopted.tools, "vault+test://local-fallback");
    const selection = await adopted.tools.getTurnContextProvider()?.selectForTurn("local fallback", {
      sessionId: session.id,
    });
    expect(selection).toBeDefined();
    expect(selection?.retrieval).toBeUndefined();
    expect(selection?.lineage?.generations).toEqual([
      expect.objectContaining({ corpus: "workspace", persistence: "memory-only" }),
    ]);
  });

  it("publishes only through the explicit path and repoints an unchanged session to a newer generation", async () => {
    const store = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const workspace = new EncryptedObjectWorkspace(store, key);
    const initial = await workspace.write("docs/live.md", "The first encrypted generation is range addressable.");
    const journal = new EventJournal(new MemoryJournalBackend());
    const contextFabric = new VaultContextFabricPort(store, key, workspace);
    const bootstrap = await createAirshipToolRegistry({ workspace, journal });
    const session = await createSession(journal, bootstrap, "vault+test://explicit-publication");
    const pinnedBefore = structuredClone(await journal.getSession(session.id));

    const first = await createVaultBackedAirshipToolRegistry({
      workspace,
      journal,
      workspaceId: "vault+test://explicit-publication",
      contextFabric,
      publicationPolicy: "explicit-user-approved",
    });
    expect(first).toMatchObject({
      contextMode: "encrypted-ranged",
      context: { generation: expect.stringMatching(/^sha256:/u) },
    });
    expect(first.tools.definitions()).toEqual(bootstrap.definitions());
    expect(await journal.getSession(session.id)).toEqual(pinnedBefore);

    await workspace.write("docs/live.md", "The second generation contains the cobalt turbine finding.", {
      expectedRevision: initial.revision,
    });
    const generationFencedSelection = await first.tools.getTurnContextProvider()?.selectForTurn("cobalt turbine", {
      sessionId: session.id,
      maxHits: 4,
      maxBytes: 8_192,
    });
    expect(generationFencedSelection).toMatchObject({
      hits: [expect.objectContaining({ text: expect.stringContaining("cobalt turbine") })],
      lineage: {
        generations: [expect.objectContaining({ corpus: "workspace", persistence: "memory-only" })],
      },
    });
    expect(generationFencedSelection?.retrieval).toBeUndefined();

    const put = vi.spyOn(store, "putIfAbsent");
    const staleAdoption = await createVaultAwareAirshipToolRegistry({
      workspace,
      journal,
      workspaceId: "vault+test://explicit-publication",
      contextFabric,
    });
    expect(staleAdoption).toMatchObject({
      contextMode: "local-fallback",
      resolution: { mode: "local-fallback", reason: "mirror-generation-mismatch" },
    });
    expect(put).not.toHaveBeenCalled();

    const second = await createVaultBackedAirshipToolRegistry({
      workspace,
      journal,
      workspaceId: "vault+test://explicit-publication",
      contextFabric,
      publicationPolicy: "explicit-user-approved",
    });
    expect(second.context?.generation).not.toBe(first.context?.generation);
    expect(put.mock.calls.length).toBeGreaterThan(0);
    const selection = await second.tools.getTurnContextProvider()?.selectForTurn("cobalt turbine", {
      sessionId: session.id,
      maxHits: 4,
      maxBytes: 8_192,
    });
    expect(selection).toMatchObject({
      hits: [expect.objectContaining({ text: expect.stringContaining("cobalt turbine") })],
      retrieval: { mode: "encrypted-object-range-v1", rangeContract: "exact-or-fail" },
    });
    expect(await verifyContextSelection(selection!)).toBe(true);
    expect(await journal.getSession(session.id)).toEqual(pinnedBefore);
  });
});

async function createSession(
  journal: EventJournal,
  tools: Awaited<ReturnType<typeof createAirshipToolRegistry>>,
  workspaceId: string,
) {
  return journal.createSession("Vault context", await createSessionManifest({
    systemPrompt: "Use exact selected context.",
    providerId: "test",
    model: "test",
    tools: tools.definitions(),
    workspaceId,
  }));
}
