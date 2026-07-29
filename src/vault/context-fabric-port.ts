import type { ClientContextGenerationExport } from "../indexing/client-context-engine";
import { ContextFabricDriver } from "../retrieval/context-driver";
import type { ContextRoutingMirror } from "../retrieval/contracts";
import { publishContextGeneration } from "../retrieval/publisher";
import { VaultTurnContextProvider } from "../retrieval/vault-turn-context";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";
import type { ObjectStore } from "../storage/object-store";
import { CONTEXT_ROUTING_MIRROR_PATH, WorkspaceConflictError, type ClientEncryptedWorkspacePort, type WorkspacePort } from "../workspace/contracts";

export { CONTEXT_ROUTING_MIRROR_PATH } from "../workspace/contracts";
const MAX_MIRROR_BYTES = 4 * 1024 * 1024;

export type VaultContextFabricBinding = Readonly<{
  driver: ContextFabricDriver;
  turnProvider: VaultTurnContextProvider;
  generation: string;
  workspaceSnapshotDigest: string;
}>;

export type VaultContextFabricProvenance = Readonly<{
  workspaceId: string;
  generation: string;
  workspaceSnapshotDigest: string;
  embeddingProvider: string;
  dimensions: number;
}>;

export type VaultContextFabricResolution =
  | Readonly<{
      mode: "ranged-vault";
      binding: VaultContextFabricBinding;
      provenance: VaultContextFabricProvenance;
    }>
  | Readonly<{
      mode: "local-fallback";
      reason: "mirror-missing" | "mirror-invalid" | "mirror-generation-mismatch";
      expected: VaultContextFabricProvenance;
      observed?: VaultContextFabricProvenance;
    }>;

/**
 * Narrow, non-extracting Vault facade for encrypted context generations. The
 * UI receives this object, never the WorkspaceRootKey or ObjectStore. A mirror
 * is promoted only when its generation and workspace snapshot exactly match
 * the stable local publication snapshot.
 */
export class VaultContextFabricPort {
  constructor(
    private readonly store: ObjectStore,
    private readonly key: WorkspaceRootKey,
    private readonly workspace: ClientEncryptedWorkspacePort,
  ) {}

  /**
   * Rebind this fabric to one Profile's workspace namespace.
   *
   * The routing mirror is a pointer into a workspace's own indexed content, so
   * it belongs wherever that content lives. It was left on the global storage
   * root after every other consumer moved behind `ProfileWorkspacePort`, which
   * had two consequences: two Profiles publishing would overwrite each other's
   * pointer, and legacy adoption — whose only classifier is "is this path
   * inside a Profile namespace" — read the mirror as pre-namespace user content
   * and moved it into whichever Profile booted first. The generation survived;
   * the pointer to it did not, so a reload found nothing to adopt.
   *
   * Rebinding keeps the facade non-extracting: the caller supplies a workspace
   * it already holds and still never sees the store or the root key.
   */
  scopedTo(workspace: WorkspacePort): VaultContextFabricPort {
    if ((workspace as Partial<ClientEncryptedWorkspacePort>).encryptionBoundary !== "airship-client-envelope-v1") {
      throw new Error("The encrypted context fabric requires a client-encrypted workspace.");
    }
    return new VaultContextFabricPort(this.store, this.key, workspace as ClientEncryptedWorkspacePort);
  }

  async install(args: Readonly<{
    workspaceId: string;
    publication: ClientContextGenerationExport;
    /** A caller must bind publication to an explicit user/policy decision. */
    publicationPolicy: "explicit-user-approved";
    signal?: AbortSignal;
  }>): Promise<VaultContextFabricBinding> {
    args.signal?.throwIfAborted();
    if (args.publicationPolicy !== "explicit-user-approved") {
      throw new Error("Encrypted context publication requires an explicit user-approved policy decision.");
    }
    const current = await this.workspace.read(CONTEXT_ROUTING_MIRROR_PATH);
    if (current) {
      try {
        const mirror = parseMirror(current.content);
        if (matchesPublication(mirror, args.workspaceId, args.publication)) {
          return this.binding(mirror, args.publication);
        }
      } catch {
        // An explicit publication may repair a malformed authenticated mirror.
        // Read-only adoption still reports it as invalid and never writes.
      }
    }

    const generation = args.publication.generation;
    if (!args.publication.chunks.length) throw new Error("An empty context generation cannot be promoted to the encrypted Vault.");
    const mirror = await publishContextGeneration({
      store: this.store,
      key: this.key,
      workspaceId: args.workspaceId,
      generation: generation.lineage.generationDigest,
      embeddingProvider: generation.lineage.embeddingProvider,
      dimensions: generation.lineage.embeddingDimensions,
      sourceRevision: generation.workspaceSnapshotDigest,
      sourceDigest: generation.workspaceSnapshotDigest,
      extractor: generation.lineage.extractor,
      chunker: `${generation.lineage.chunker};max=${generation.lineage.maxChunkCharacters};overlap=${generation.lineage.overlapCharacters}`,
      embeddingPosture: generation.lineage.embeddingPosture,
      indexFormat: generation.lineage.indexFormat,
      chunks: [...args.publication.chunks],
      signal: args.signal,
    });
    args.signal?.throwIfAborted();
    // This file is data, not a hash preimage. Use strict JSON so provider
    // reloads never depend on stableStringify's explicit `undefined` tokens.
    const content = JSON.stringify(mirror);
    if (new TextEncoder().encode(content).byteLength > MAX_MIRROR_BYTES) {
      throw new Error("The encrypted context routing mirror exceeds the 4 MiB client limit.");
    }
    try {
      await this.workspace.write(CONTEXT_ROUTING_MIRROR_PATH, content, {
        expectedRevision: current?.revision ?? null,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceConflictError)) throw error;
      const winner = await this.workspace.read(CONTEXT_ROUTING_MIRROR_PATH);
      if (!winner) throw error;
      const winnerMirror = parseMirror(winner.content);
      if (!matchesPublication(winnerMirror, args.workspaceId, args.publication)) throw error;
      return this.binding(winnerMirror, args.publication);
    }
    return this.binding(mirror, args.publication);
  }

  /**
   * Adopt an already-published encrypted generation without creating or
   * mutating any Vault object. A missing, malformed, or stale mirror is an
   * inspectable local fallback, never an implicit publication request.
   */
  async resolveExisting(args: Readonly<{
    workspaceId: string;
    publication: ClientContextGenerationExport;
    signal?: AbortSignal;
  }>): Promise<VaultContextFabricResolution> {
    args.signal?.throwIfAborted();
    const expected = publicationProvenance(args.workspaceId, args.publication);
    const current = await this.workspace.read(CONTEXT_ROUTING_MIRROR_PATH);
    args.signal?.throwIfAborted();
    if (!current) return Object.freeze({ mode: "local-fallback", reason: "mirror-missing", expected });

    let mirror: ContextRoutingMirror;
    try {
      mirror = parseMirror(current.content);
    } catch {
      return Object.freeze({ mode: "local-fallback", reason: "mirror-invalid", expected });
    }
    const observed = mirrorProvenance(mirror);
    if (!matchesPublication(mirror, args.workspaceId, args.publication)) {
      return Object.freeze({
        mode: "local-fallback",
        reason: "mirror-generation-mismatch",
        expected,
        observed,
      });
    }
    try {
      const binding = this.binding(mirror, args.publication);
      return Object.freeze({ mode: "ranged-vault", binding, provenance: observed });
    } catch {
      return Object.freeze({ mode: "local-fallback", reason: "mirror-invalid", expected, observed });
    }
  }

  private binding(mirror: ContextRoutingMirror, publication: ClientContextGenerationExport): VaultContextFabricBinding {
    if (!matchesPublication(mirror, mirror.workspaceId, publication)) {
      throw new Error("The encrypted context mirror no longer matches the live workspace generation.");
    }
    const driver = new ContextFabricDriver({
      store: this.store,
      key: this.key,
      embeddings: publication.embeddings,
      mirror,
    });
    return Object.freeze({
      driver,
      turnProvider: new VaultTurnContextProvider({
        driver,
        mirror,
        adapter: this.store.capabilities.adapter,
      }),
      generation: mirror.generation,
      workspaceSnapshotDigest: mirror.lineage.sourceDigest,
    });
  }
}

function matchesPublication(
  mirror: ContextRoutingMirror,
  workspaceId: string,
  publication: ClientContextGenerationExport,
): boolean {
  const generation = publication.generation;
  const chunker = `${generation.lineage.chunker};max=${generation.lineage.maxChunkCharacters};overlap=${generation.lineage.overlapCharacters}`;
  return mirror.workspaceId === workspaceId &&
    mirror.generation === generation.lineage.generationDigest &&
    mirror.lineage.sourceRevision === generation.workspaceSnapshotDigest &&
    mirror.lineage.sourceDigest === generation.workspaceSnapshotDigest &&
    mirror.lineage.extractor === generation.lineage.extractor &&
    mirror.lineage.chunker === chunker &&
    mirror.embeddingProvider === generation.lineage.embeddingProvider &&
    mirror.dimensions === generation.lineage.embeddingDimensions &&
    mirror.lineage.embeddingPosture === generation.lineage.embeddingPosture &&
    mirror.lineage.indexFormat === generation.lineage.indexFormat;
}

function publicationProvenance(
  workspaceId: string,
  publication: ClientContextGenerationExport,
): VaultContextFabricProvenance {
  return Object.freeze({
    workspaceId,
    generation: publication.generation.lineage.generationDigest,
    workspaceSnapshotDigest: publication.generation.workspaceSnapshotDigest,
    embeddingProvider: publication.generation.lineage.embeddingProvider,
    dimensions: publication.generation.lineage.embeddingDimensions,
  });
}

function mirrorProvenance(mirror: ContextRoutingMirror): VaultContextFabricProvenance {
  return Object.freeze({
    workspaceId: mirror.workspaceId,
    generation: mirror.generation,
    workspaceSnapshotDigest: mirror.lineage.sourceDigest,
    embeddingProvider: mirror.embeddingProvider,
    dimensions: mirror.dimensions,
  });
}

function parseMirror(content: string): ContextRoutingMirror {
  if (new TextEncoder().encode(content).byteLength > MAX_MIRROR_BYTES) {
    throw new Error("The encrypted context routing mirror exceeds the 4 MiB client limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The encrypted context routing mirror is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The encrypted context routing mirror is invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  const lineage = candidate.lineage;
  const lineageRecord = lineage && typeof lineage === "object" && !Array.isArray(lineage)
    ? lineage as Record<string, unknown>
    : undefined;
  if (
    candidate.version !== 2 ||
    typeof candidate.workspaceId !== "string" || !candidate.workspaceId ||
    typeof candidate.generation !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(candidate.generation) ||
    typeof candidate.embeddingProvider !== "string" || !candidate.embeddingProvider ||
    !Number.isSafeInteger(candidate.dimensions) || Number(candidate.dimensions) <= 0 ||
    !lineageRecord ||
    typeof lineageRecord.sourceRevision !== "string" || !lineageRecord.sourceRevision ||
    typeof lineageRecord.sourceDigest !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(lineageRecord.sourceDigest) ||
    typeof lineageRecord.extractor !== "string" || !lineageRecord.extractor ||
    typeof lineageRecord.chunker !== "string" || !lineageRecord.chunker ||
    (lineageRecord.embeddingPosture !== "deterministic-bootstrap" && lineageRecord.embeddingPosture !== "local-semantic") ||
    typeof lineageRecord.indexFormat !== "string" || !lineageRecord.indexFormat ||
    !candidate.objects || typeof candidate.objects !== "object" || Array.isArray(candidate.objects) ||
    !Array.isArray(candidate.experts)
  ) {
    throw new Error("The encrypted context routing mirror is invalid.");
  }
  return parsed as ContextRoutingMirror;
}
