import type { Provider } from "../types";

/**
 * Browser port of prime-agent packages/ai/src/env-api-keys.ts. The upstream
 * resolves API keys from process.env and OAuth credential files; neither
 * exists in a browser page that holds authority in a Vault. Credentials are
 * therefore injected: callers pass options.apiKey directly, or hand the
 * provider a resolver closure that fronts whatever credential store the host
 * owns. OAuth authorization-code flows are not ported (see PORT.md).
 */

/** Resolves an API key for a provider id when options.apiKey is absent. */
export type ApiKeyResolver = (provider: Provider) => string | undefined;

/** Options fragment every provider accepts for credential injection. */
export interface ApiKeyResolution {
  /** Explicit API key; wins over resolveApiKey. */
  apiKey?: string;
  /** Host-injected credential lookup, consulted only when apiKey is absent. */
  resolveApiKey?: ApiKeyResolver;
}

/** Resolve the credential for a provider: explicit key first, then the injected resolver. */
export function resolveApiKey(options: ApiKeyResolution | undefined, provider: Provider): string | undefined {
  return options?.apiKey ?? options?.resolveApiKey?.(provider) ?? undefined;
}
