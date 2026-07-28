import type { BrowserGitClient } from "../git";
import type { EventJournal } from "../core/journal";
import type { Tool } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";
import type { EmbeddingProvider } from "../indexing/contracts";
import type { TurnContextProvider, TurnContextRequest } from "../core/context-selection";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import type {
  VaultContextFabricBinding,
  VaultContextFabricPort,
  VaultContextFabricResolution,
} from "../vault/context-fabric-port";

type ToolBundle = typeof import("./tool-bundle");
let toolBundle: Promise<ToolBundle> | undefined;

export type AirshipToolRegistryOptions = Readonly<{
  workspace: WorkspacePort;
  journal: EventJournal;
  git?: BrowserGitClient;
  fetch?: typeof globalThis.fetch;
  /** Optional lazy, on-device provider. The hash tier remains the default. */
  embeddings?: EmbeddingProvider;
  /** Optional encrypted/ranged workspace retrieval adapter behind the same turn seam. */
  workspaceTurnContextProvider?: TurnContextProvider;
  /**
   * Small, capability-owned tools that do not belong to the workspace bundle.
   * Callers retain their authorities; the registry receives only the narrow
   * credential-free Tool interface.
   */
  additionalTools?: readonly Tool[];
}>;

/**
 * Airship's narrow model-tool waist. Everything here has a real browser-side
 * executor; profile prose and UI affordances never manufacture capabilities.
 */
export async function createAirshipToolRegistry(options: AirshipToolRegistryOptions) {
  toolBundle ??= import("./tool-bundle");
  const { createLoadedAirshipToolRegistry } = await toolBundle;
  return createLoadedAirshipToolRegistry(options);
}

export type VaultAwareToolRegistry = Readonly<{
  tools: Awaited<ReturnType<typeof createAirshipToolRegistry>>;
  context?: VaultContextFabricBinding;
  contextMode: "encrypted-ranged" | "local-fallback";
  resolution?: VaultContextFabricResolution;
}>;

/**
 * Production adoption path. It can activate an existing, generation-matched
 * encrypted routing mirror, but it has no publication authority. Missing,
 * malformed, or stale mirrors leave the same on-device index in service.
 */
export async function createVaultAwareAirshipToolRegistry(
  options: Omit<AirshipToolRegistryOptions, "workspaceTurnContextProvider"> & Readonly<{
    workspaceId: string;
    contextFabric: VaultContextFabricPort;
    signal?: AbortSignal;
  }>,
): Promise<VaultAwareToolRegistry> {
  const { workspaceId, contextFabric, signal, ...registryOptions } = options;
  const { bootstrap, contextRuntime, publication } = await prepareContextRegistry(registryOptions, signal);
  const resolution = await contextFabric.resolveExisting({ workspaceId, publication, signal });
  if (resolution.mode === "local-fallback") {
    return Object.freeze({ tools: bootstrap, contextMode: "local-fallback", resolution });
  }
  const tools = await createAirshipToolRegistry({
    ...registryOptions,
    workspaceTurnContextProvider: generationFencedProvider(contextRuntime, resolution.binding),
  });
  return Object.freeze({
    tools,
    context: resolution.binding,
    contextMode: "encrypted-ranged",
    resolution,
  });
}

/**
 * Explicit publication path. The literal policy acknowledgement prevents a
 * registry construction or Vault adoption from becoming upload authority.
 */
export async function createVaultBackedAirshipToolRegistry(
  options: Omit<AirshipToolRegistryOptions, "workspaceTurnContextProvider"> & Readonly<{
    workspaceId: string;
    contextFabric: VaultContextFabricPort;
    publicationPolicy: "explicit-user-approved";
    signal?: AbortSignal;
  }>,
): Promise<VaultAwareToolRegistry> {
  const { workspaceId, contextFabric, publicationPolicy, signal, ...registryOptions } = options;
  const { bootstrap, contextRuntime, publication } = await prepareContextRegistry(registryOptions, signal);
  if (!publication.chunks.length) {
    return Object.freeze({ tools: bootstrap, contextMode: "local-fallback" as const });
  }
  const context = await contextFabric.install({ workspaceId, publication, publicationPolicy, signal });
  const tools = await createAirshipToolRegistry({
    ...registryOptions,
    workspaceTurnContextProvider: generationFencedProvider(contextRuntime, context),
  });
  return Object.freeze({ tools, context, contextMode: "encrypted-ranged" as const });
}

async function prepareContextRegistry(
  registryOptions: Omit<AirshipToolRegistryOptions, "workspaceTurnContextProvider">,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const bootstrap = await createAirshipToolRegistry(registryOptions);
  const contextRuntime = bootstrap.getContextRuntime();
  if (!contextRuntime) throw new Error("The Airship tool registry did not expose its client context runtime.");
  await contextRuntime.refreshNow();
  signal?.throwIfAborted();
  return Object.freeze({ bootstrap, contextRuntime, publication: contextRuntime.exportActiveGeneration() });
}

/**
 * Never serve a published generation after the live workspace has moved on.
 * Local indexing stays authoritative and immediately searchable; the Vault
 * generation becomes eligible again only after a separate explicit republish.
 */
function generationFencedProvider(
  local: ClientContextRuntime,
  vault: VaultContextFabricBinding,
): TurnContextProvider {
  return Object.freeze({
    async selectForTurn(query: string, request: TurnContextRequest) {
      request.signal?.throwIfAborted();
      await local.refreshNow();
      request.signal?.throwIfAborted();
      const current = local.exportActiveGeneration().generation;
      if (
        current.lineage.generationDigest !== vault.generation ||
        current.workspaceSnapshotDigest !== vault.workspaceSnapshotDigest
      ) {
        return local.selectForTurn(query, request);
      }
      return vault.turnProvider.selectForTurn(query, request);
    },
  });
}
