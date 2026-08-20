import type { Api, ApiProvider, Provider, ProviderDescriptor } from "./types";

/**
 * Port of prime-agent packages/ai/src/api-registry.ts. API implementations
 * register lazily so a host only pays bundle and parse cost for provider
 * families it uses. Provider descriptors are small wire-default declarations;
 * they remain eager data and are resolved independently of endpoint URLs.
 * `sourceId` groups API registrations so test providers can be withdrawn
 * without touching others.
 */

type ProviderLoader = () => Promise<ApiProvider> | ApiProvider;

const providers = new Map<string, ApiProvider>();
const providerSources = new Map<string, string>();
const loaders = new Map<string, ProviderLoader>();
const pending = new Map<string, Promise<ApiProvider>>();
const descriptorsByApi = new Map<string, Map<string, ProviderDescriptor<Api>>>();

export function registerApiProvider(provider: ApiProvider, sourceId?: string): void {
  providers.set(provider.api, provider);
  if (sourceId) providerSources.set(provider.api, sourceId);
}

/** Register provider-wide defaults for one wire protocol. Last write wins. */
export function registerProviderDescriptor<TApi extends Api>(descriptor: ProviderDescriptor<TApi>): void {
  const api = String(descriptor.api);
  let descriptors = descriptorsByApi.get(api);
  if (!descriptors) {
    descriptors = new Map();
    descriptorsByApi.set(api, descriptors);
  }
  descriptors.set(String(descriptor.provider), descriptor as ProviderDescriptor<Api>);
}

export function getProviderDescriptor<TApi extends Api>(
  api: TApi,
  provider: Provider,
): ProviderDescriptor<TApi> | undefined {
  return descriptorsByApi.get(String(api))?.get(String(provider)) as ProviderDescriptor<TApi> | undefined;
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
