import { deepFreeze } from "../../core/freeze";
import type { ApiKeyAuthMethod, InferenceProviderDescriptor } from "./contracts";
import { normalizeProvider } from "./provider-catalog";
import { boundedText, headerName, providerBaseUrl } from "./validation";

export type OpenAiCompatibleProviderInput = Readonly<{
  label: string;
  baseUrl: string;
  modelsUrl?: string;
  apiKeyHeader?: string;
  apiKeyScheme?: ApiKeyAuthMethod["header"]["scheme"];
}>;

/**
 * Build one page-memory provider descriptor from a user-owned endpoint.
 *
 * Every input property is read and validated synchronously before SHA-256 can
 * yield. The identifier is the full 256-bit digest of the complete canonical
 * wire descriptor. It deliberately carries no hostname or endpoint slug: a
 * provider-controlled name cannot become public identifier material, and two
 * different wire authorities cannot be collapsed by the old 32-bit hash.
 */
export function createOpenAiCompatibleProvider(
  input: OpenAiCompatibleProviderInput,
): Promise<InferenceProviderDescriptor> {
  const staged = stageOpenAiCompatibleProvider(input);
  return createStagedOpenAiCompatibleProvider(staged);
}

type StagedOpenAiCompatibleProvider = Readonly<{
  label: string;
  baseUrl: string;
  modelsUrl: string;
  header: string;
  scheme: ApiKeyAuthMethod["header"]["scheme"];
  canonicalWireDescriptor: string;
}>;

function stageOpenAiCompatibleProvider(
  input: OpenAiCompatibleProviderInput,
): StagedOpenAiCompatibleProvider {
  if (!input || typeof input !== "object") {
    throw new TypeError("Provider settings are invalid.");
  }

  // Read each caller-owned property exactly once. From here onward only local
  // primitives are used, including across the asynchronous digest boundary.
  const rawLabel = input.label;
  const rawBaseUrl = input.baseUrl;
  const rawModelsUrl = input.modelsUrl;
  const rawApiKeyHeader = input.apiKeyHeader;
  const rawApiKeyScheme = input.apiKeyScheme;

  const label = boundedText(rawLabel, "Provider name", 128).trim();
  if (!label) throw new TypeError("Provider name is invalid.");

  const normalizedBaseUrl = providerBaseUrl(
    rawBaseUrl,
    "Provider base URL",
    "provider-tls",
  );
  const baseDirectory = new URL(normalizedBaseUrl);
  if (baseDirectory.search) {
    throw new TypeError("Provider base URL must not contain a query.");
  }
  if (!baseDirectory.pathname.endsWith("/")) {
    baseDirectory.pathname = `${baseDirectory.pathname}/`;
  }
  const baseUrl = baseDirectory.toString();

  if (rawModelsUrl !== undefined && typeof rawModelsUrl !== "string") {
    throw new TypeError("Provider models URL is invalid.");
  }
  const modelsCandidate = rawModelsUrl?.trim()
    || new URL("models", baseDirectory).toString();
  const modelsUrl = providerBaseUrl(
    modelsCandidate,
    "Provider models URL",
    "provider-tls",
  );
  if (new URL(modelsUrl).search) {
    throw new TypeError("Provider models URL must not contain a query.");
  }

  if (rawApiKeyHeader !== undefined && typeof rawApiKeyHeader !== "string") {
    throw new TypeError("The API-key header name is invalid.");
  }
  // Header names are case-insensitive on the wire. Lower-casing makes aliases
  // such as Authorization/authorization one canonical authority.
  const header = customCredentialHeader(
    rawApiKeyHeader?.trim() || "Authorization",
  ).toLowerCase();
  const scheme = rawApiKeyScheme ?? "bearer";
  if (scheme !== "bearer" && scheme !== "raw") {
    throw new TypeError("The API-key format is invalid.");
  }

  const canonicalWireDescriptor = JSON.stringify({
    version: 1,
    label,
    protocol: "openai-compatible",
    transportBoundary: "provider-tls",
    baseUrl,
    modelsUrl,
    apiKeyHeader: header,
    apiKeyScheme: scheme,
  });
  return Object.freeze({
    label,
    baseUrl,
    modelsUrl,
    header,
    scheme,
    canonicalWireDescriptor,
  });
}

async function createStagedOpenAiCompatibleProvider(
  staged: StagedOpenAiCompatibleProvider,
): Promise<InferenceProviderDescriptor> {
  const id = `openai-compatible-${await sha256Hex(staged.canonicalWireDescriptor)}`;
  const destinations = [...new Set([
    new URL(staged.baseUrl).origin,
    new URL(staged.modelsUrl).origin,
  ])].join(" and ");
  return normalizeProvider(deepFreeze({
    version: 1,
    id,
    label: staged.label,
    protocol: "openai-compatible",
    transportBoundary: "provider-tls",
    baseUrl: staged.baseUrl,
    modelsUrl: staged.modelsUrl,
    oauth: {
      state: "not-documented",
      detail: "This custom connection uses the API-key settings entered on this page.",
    },
    authMethods: [{
      id: `${id}-api-key`,
      kind: "api-key",
      label: `${staged.label} API key`,
      header: { name: staged.header, scheme: staged.scheme },
      browserUse: "dangerous-user-opt-in",
      warning: `The key stays in this tab and is sent directly to ${destinations}. Those endpoints must allow this site through CORS.`,
    }],
    capabilities: ["invoke", "models:list"],
  } satisfies InferenceProviderDescriptor));
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable.");
  const digest = new Uint8Array(
    await subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "host",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

function customCredentialHeader(value: string): string {
  const normalized = headerName(value);
  const lower = normalized.toLowerCase();
  if (
    FORBIDDEN_CREDENTIAL_HEADERS.has(lower)
    || lower.startsWith("proxy-")
    || lower.startsWith("sec-")
  ) {
    throw new TypeError("The API-key header is controlled by the browser and cannot carry a credential.");
  }
  return normalized;
}
