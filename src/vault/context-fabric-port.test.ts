import { describe, expect, it, vi } from "vitest";
import { canonicalContextSelection, verifyContextSelection } from "../core/context-selection";
import { ClientContextRuntime } from "../retrieval/client-context-runtime";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store.test-support";
import { MemoryWorkspace } from "../workspace/memory";
import { isWorkspaceControlPlanePath } from "../workspace/contracts";
import { EncryptedObjectWorkspace } from "./encrypted-workspace";
import { CONTEXT_ROUTING_MIRROR_PATH, VaultContextFabricPort } from "./context-fabric-port";
import { VaultReclamationQueue } from "./reclamation-queue";

describe("VaultContextFabricPort", () => {
  it("publishes one stable generation and range-reads only routed encrypted experts", async () => {
    const source = new MemoryWorkspace();
    await source.write("docs/architecture.md", "Authenticated encrypted range retrieval for private context.");
    await source.write("src/engine.ts", "export const engine = 'browser edge';");
    const runtime = new ClientContextRuntime(source, { dimensions: 64, debounceMs: 0 });
    await runtime.refreshNow();
    const publication = runtime.exportActiveGeneration();

    const store = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const encryptedWorkspace = new EncryptedObjectWorkspace(store, key);
    const port = new VaultContextFabricPort(store, key, encryptedWorkspace);
    const put = vi.spyOn(store, "putIfAbsent");
    const range = vi.spyOn(store, "getRange");

    const binding = await port.install({
      workspaceId: "vault+test://workspace-one",
      publication,
      publicationPolicy: "explicit-user-approved",
    });
    const mirror = await encryptedWorkspace.read(CONTEXT_ROUTING_MIRROR_PATH);
    expect(mirror).toBeDefined();
    expect(isWorkspaceControlPlanePath(CONTEXT_ROUTING_MIRROR_PATH)).toBe(true);
    expect(JSON.parse(mirror!.content)).toMatchObject({
      version: 2,
      workspaceId: "vault+test://workspace-one",
      generation: publication.generation.lineage.generationDigest,
      lineage: { sourceRevision: publication.generation.workspaceSnapshotDigest },
    });

    const events = [];
    for await (const event of binding.driver.search("authenticated range", {}, { topK: 2, maxExperts: 1 })) events.push(event);
    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      type: "complete",
      commitment: { selectedExperts: [expect.any(String)], complete: true },
    });
    if (!complete || complete.type !== "complete") throw new Error("expected complete retrieval");
    expect(complete.hits[0]).toMatchObject({
      path: "/workspace/docs/architecture.md",
      contentDigest: expect.stringMatching(/^sha256:/u),
      chunkIndex: 0,
    });
    expect(range).toHaveBeenCalledTimes(1);

    range.mockClear();
    const selection = await binding.turnProvider.selectForTurn("authenticated range", {
      sessionId: "vault-context-session",
      maxHits: 2,
      maxBytes: 4_096,
    });
    expect(canonicalContextSelection(selection)).toBeDefined();
    expect(await verifyContextSelection(selection)).toBe(true);
    expect(selection).toMatchObject({
      version: 2,
      retrieval: {
        mode: "encrypted-object-range-v1",
        rangeContract: "exact-or-fail",
        adapter: "memory",
        bytesRead: expect.any(Number),
      },
      lineage: { retriever: "airship-vault-workspace-turn-context-v1" },
    });
    expect(range.mock.calls.length).toBeGreaterThan(0);

    const writesAfterFirstInstall = put.mock.calls.length;
    put.mockClear();
    const adopted = await port.resolveExisting({
      workspaceId: "vault+test://workspace-one",
      publication,
    });
    expect(adopted).toMatchObject({
      mode: "ranged-vault",
      provenance: {
        workspaceId: "vault+test://workspace-one",
        generation: publication.generation.lineage.generationDigest,
        workspaceSnapshotDigest: publication.generation.workspaceSnapshotDigest,
      },
    });
    expect(put).not.toHaveBeenCalled();

    await port.install({
      workspaceId: "vault+test://workspace-one",
      publication,
      publicationPolicy: "explicit-user-approved",
    });
    expect(put).toHaveBeenCalledTimes(0);
    expect(writesAfterFirstInstall).toBeGreaterThan(0);
  });

it("records replaced generation segments into the supersession queue, sparing content-identical survivors", async () => {
    const source = new MemoryWorkspace();
    await source.write("docs/alpha.md", "alpha version one");
    await source.write("docs/beta.md", "beta stays identical across generations");
    const runtime = new ClientContextRuntime(source, { dimensions: 64, debounceMs: 0 });
    await runtime.refreshNow();
    const firstPublication = runtime.exportActiveGeneration();

    const store = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const queue = new VaultReclamationQueue(store, key);
    const encryptedWorkspace = new EncryptedObjectWorkspace(store, key);
    const port = new VaultContextFabricPort(store, key, encryptedWorkspace, queue);

    await port.install({
      workspaceId: "vault+test://workspace-one",
      publication: firstPublication,
      publicationPolicy: "explicit-user-approved",
    });
    const firstReferences = new Set((await port.referencedSegmentKeys())!);
    expect(firstReferences.size).toBeGreaterThan(0);
    // Nothing is superseded by a first install.
    expect(await queue.readEntries()).toEqual([]);

    // A real edit changes the indexed content; beta is untouched so any key
    // derived solely from its bytes must survive both mirrors un-queued.
    await source.write("docs/alpha.md", "alpha version two — an honest supersedure");
    await runtime.refreshNow();
    const secondPublication = runtime.exportActiveGeneration();
    await port.install({
      workspaceId: "vault+test://workspace-one",
      publication: secondPublication,
      publicationPolicy: "explicit-user-approved",
    });

    const secondReferences = new Set((await port.referencedSegmentKeys())!);
    expect(secondReferences.size).toBeGreaterThan(0);
    const queued = (await queue.readEntries()).filter((entry) => entry.kind === "context-segment").map((entry) => entry.cloudKey);
    expect(queued.length).toBeGreaterThan(0);
    // Every queued key died with the first generation: referenced then, not now.
    for (const cloudKey of queued) {
      expect(firstReferences.has(cloudKey)).toBe(true);
      expect(secondReferences.has(cloudKey)).toBe(false);
    }
    // And the intersection the new mirror still names was never offered up.
    const shared = [...firstReferences].filter((cloudKey) => secondReferences.has(cloudKey));
    for (const cloudKey of shared) expect(queued).not.toContain(cloudKey);
    // The mirror file itself is not this recorder's entry: the workspace's own
    // supersession recorder owns file revisions.
    expect((await queue.readEntries()).every((entry) => entry.kind === "context-segment")).toBe(true);
  });

  it("refuses to promote a mirror from a different workspace snapshot", async () => {
    const source = new MemoryWorkspace();
    await source.write("README.md", "first generation");
    const runtime = new ClientContextRuntime(source, { dimensions: 64, debounceMs: 0 });
    await runtime.refreshNow();
    const first = runtime.exportActiveGeneration();
    const store = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const encryptedWorkspace = new EncryptedObjectWorkspace(store, key);
    const port = new VaultContextFabricPort(store, key, encryptedWorkspace);
    await port.install({
      workspaceId: "vault+test://workspace-two",
      publication: first,
      publicationPolicy: "explicit-user-approved",
    });

    await source.write("README.md", "second generation");
    await runtime.refreshNow();
    const second = runtime.exportActiveGeneration();
    expect(second.generation.workspaceSnapshotDigest).not.toBe(first.generation.workspaceSnapshotDigest);
    const stale = await port.resolveExisting({
      workspaceId: "vault+test://workspace-two",
      publication: second,
    });
    expect(stale).toMatchObject({
      mode: "local-fallback",
      reason: "mirror-generation-mismatch",
      expected: { workspaceSnapshotDigest: second.generation.workspaceSnapshotDigest },
      observed: { workspaceSnapshotDigest: first.generation.workspaceSnapshotDigest },
    });
    const secondBinding = await port.install({
      workspaceId: "vault+test://workspace-two",
      publication: second,
      publicationPolicy: "explicit-user-approved",
    });
    const events = [];
    for await (const event of secondBinding.driver.search("second generation", {}, { maxExperts: 1 })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "complete", hits: [expect.objectContaining({ revision: expect.any(String) })] });
  });

  it("keeps a missing encrypted mirror as an inspectable read-only local fallback", async () => {
    const source = new MemoryWorkspace();
    await source.write("README.md", "local context remains available");
    const runtime = new ClientContextRuntime(source, { dimensions: 64, debounceMs: 0 });
    await runtime.refreshNow();
    const publication = runtime.exportActiveGeneration();
    const store = new MemoryObjectStore();
    const put = vi.spyOn(store, "putIfAbsent");
    const { key } = await WorkspaceRootKey.generate();
    const port = new VaultContextFabricPort(store, key, new EncryptedObjectWorkspace(store, key));

    const resolution = await port.resolveExisting({
      workspaceId: "vault+test://missing-mirror",
      publication,
    });

    expect(resolution).toMatchObject({
      mode: "local-fallback",
      reason: "mirror-missing",
      expected: {
        workspaceId: "vault+test://missing-mirror",
        generation: publication.generation.lineage.generationDigest,
        workspaceSnapshotDigest: publication.generation.workspaceSnapshotDigest,
      },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects publication when the explicit policy acknowledgement is absent", async () => {
    const source = new MemoryWorkspace();
    await source.write("README.md", "publication needs authority");
    const runtime = new ClientContextRuntime(source, { dimensions: 64, debounceMs: 0 });
    await runtime.refreshNow();
    const store = new MemoryObjectStore();
    const put = vi.spyOn(store, "putIfAbsent");
    const { key } = await WorkspaceRootKey.generate();
    const port = new VaultContextFabricPort(store, key, new EncryptedObjectWorkspace(store, key));

    await expect(port.install({
      workspaceId: "vault+test://policy-required",
      publication: runtime.exportActiveGeneration(),
      publicationPolicy: undefined as never,
    })).rejects.toThrow("explicit user-approved policy");
    expect(put).not.toHaveBeenCalled();
  });

  it("does not promote or trust a malformed authenticated mirror", async () => {
    const source = new MemoryWorkspace();
    await source.write("README.md", "valid local generation");
    const runtime = new ClientContextRuntime(source, { dimensions: 64, debounceMs: 0 });
    await runtime.refreshNow();
    const store = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const encryptedWorkspace = new EncryptedObjectWorkspace(store, key);
    await encryptedWorkspace.write(CONTEXT_ROUTING_MIRROR_PATH, JSON.stringify({ version: 2 }), {
      expectedRevision: null,
    });
    const put = vi.spyOn(store, "putIfAbsent");

    const port = new VaultContextFabricPort(store, key, encryptedWorkspace);
    const resolution = await port.resolveExisting({
      workspaceId: "vault+test://invalid-mirror",
      publication: runtime.exportActiveGeneration(),
    });

    expect(resolution).toMatchObject({ mode: "local-fallback", reason: "mirror-invalid" });
    expect(put).not.toHaveBeenCalled();

    const repaired = await port.install({
      workspaceId: "vault+test://invalid-mirror",
      publication: runtime.exportActiveGeneration(),
      publicationPolicy: "explicit-user-approved",
    });
    expect(repaired.generation).toMatch(/^sha256:/u);
    expect(JSON.parse((await encryptedWorkspace.read(CONTEXT_ROUTING_MIRROR_PATH))!.content)).toMatchObject({
      version: 2,
      workspaceId: "vault+test://invalid-mirror",
    });
  });
});
