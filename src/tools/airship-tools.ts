import type { BrowserGitClient } from "../git";
import type { EventJournal } from "../core/journal";
import type { WorkspacePort } from "../workspace/contracts";
import type { EmbeddingProvider } from "../indexing/contracts";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";

export type AirshipToolRegistryOptions = Readonly<{
  workspace: WorkspacePort;
  journal: EventJournal;
  git?: BrowserGitClient;
  fetch?: typeof globalThis.fetch;
  /** Optional lazy, on-device provider. The hash tier remains the default. */
  embeddings?: EmbeddingProvider;
}>;

/**
 * Airship's narrow model-tool waist. Everything here has a real browser-side
 * executor; profile prose and UI affordances never manufacture capabilities.
 */
export async function createAirshipToolRegistry(options: AirshipToolRegistryOptions) {
  const { createLoadedAirshipToolRegistry } = await loadDeferredCapabilities();
  return createLoadedAirshipToolRegistry(options);
}
