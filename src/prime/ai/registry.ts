import type { Api, ApiProvider } from "./types";

/**
 * Port of prime-agent packages/ai/src/api-registry.ts. Providers register
 * lazily: the registry stores loader closures so a host only pays bundle and
 * parse cost for provider families it actually uses. `sourceId` groups
 * registrations so test providers can be withdrawn without touching others.
 */

type ProviderLoader = () => Promise<ApiProvider> | ApiProvider;

const providers = new Map<string, ApiProvider>();
const providerSources = new Map<string, string>();
const loaders = new Map<string, ProviderLoader>();
const pending = new Map<string, Promise<ApiProvider>>();

export function registerApiProvider(provider: ApiProvider, sourceId?: string): void {
  providers.set(provider.api, provider);
  if (sourceId) providerSources.set(provider.api, sourceId);
}

export function unregisterApiProviders(sourceId: string): void {
  for (const [api, source] of [...providerSources.entries()]) {
    if (source === sourceId) {
      providers.delete(api);
      providerSources.delete(api);
    }
  }
}

export function registerApiProviderLoader(api: Api, loader: ProviderLoader): void {
  loaders.set(String(api), loader);
}

export function getApiProvider(api: Api): ApiProvider | undefined {
  return providers.get(String(api));
}

export async function resolveApiProvider(api: Api): Promise<ApiProvider | undefined> {
  const existing = providers.get(String(api));
  if (existing) return existing;
  const loader = loaders.get(String(api));
  if (!loader) return undefined;
  let inflight = pending.get(String(api));
  if (!inflight) {
    inflight = Promise.resolve()
      .then(loader)
      .then((provider) => {
        providers.set(String(api), provider);
        pending.delete(String(api));
        return provider;
      });
    pending.set(String(api), inflight);
  }
  return inflight;
}

export function hasApiProvider(api: Api): boolean {
  return providers.has(String(api)) || loaders.has(String(api));
}

export function registeredApis(): string[] {
  return [...new Set([...providers.keys(), ...loaders.keys()])];
}
