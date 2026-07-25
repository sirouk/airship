import type {
  LocalEndpointAccess,
  LocalProviderDiagnostic,
  LocalProviderDiagnosticCode,
} from "./contracts";

export class LocalProviderError extends Error {
  readonly diagnostic: LocalProviderDiagnostic;

  constructor(diagnostic: LocalProviderDiagnostic, options?: ErrorOptions) {
    super(diagnostic.message, options);
    this.name = "LocalProviderError";
    this.diagnostic = diagnostic;
  }
}

export type ResolvedLocalEndpoint = Readonly<{
  url: URL;
  loopback: true;
  diagnostics: readonly LocalProviderDiagnostic[];
}>;

export const DEFAULT_LOCAL_MODEL_ORIGINS = Object.freeze([
  "http://127.0.0.1:11434",
  "http://localhost:11434",
  "http://127.0.0.1:1234",
  "http://localhost:1234",
] as const);

export function resolveLocalEndpoint(
  value: string,
  access: LocalEndpointAccess = {},
): ResolvedLocalEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new LocalProviderError(errorDiagnostic(
      "endpoint-invalid",
      "Enter a complete local model URL such as http://127.0.0.1:11434.",
    ), { cause });
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "" && url.pathname !== "/v1" && url.pathname !== "/v1/")
  ) {
    throw new LocalProviderError(errorDiagnostic(
      "endpoint-invalid",
      "Local model endpoints must be an HTTP(S) origin or exact /v1 base URL without credentials, a query, or fragment.",
    ));
  }

  url.pathname = "/";
  const hostname = normalizeHostname(url.hostname);
  if (!isLoopbackHost(hostname)) {
    throw new LocalProviderError(errorDiagnostic(
      "endpoint-not-local",
      "Direct local-model connections are limited to Airship's exact loopback origins. Private-LAN and public hosts are not supported.",
    ));
  }

  const allowed = new Set(DEFAULT_LOCAL_MODEL_ORIGINS.map(validateAllowedOrigin));
  if (!allowed.has(url.origin)) {
    throw new LocalProviderError(errorDiagnostic(
      "endpoint-not-local",
      `The exact loopback origin ${url.origin} is not in Airship's local-model allowlist.`,
    ));
  }

  const diagnostics: LocalProviderDiagnostic[] = [];
  const pageUrl = safeUrl(access.pageUrl ?? globalThis.location?.href);
  if (pageUrl?.protocol === "https:" && url.protocol === "http:") {
    diagnostics.push(providerDiagnostic(
      "mixed-content",
      "HTTP loopback is potentially trustworthy, but the browser still decides CORS and local-network access. Use a local Airship origin if this probe is blocked.",
      { severity: "info", blocking: false },
    ));
  }
  return Object.freeze({ url, loopback: true, diagnostics: Object.freeze(diagnostics) });
}

function validateAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new LocalProviderError(errorDiagnostic(
      "endpoint-invalid",
      "A local-model origin allowlist entry is not a valid URL.",
    ), { cause });
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
    || !isLoopbackHost(hostname)
  ) {
    throw new LocalProviderError(errorDiagnostic(
      "endpoint-invalid",
      "Local-model origin allowlist entries must be exact HTTP(S) loopback origins.",
    ));
  }
  return url.origin;
}

export function directFetchDiagnostic(error: unknown): LocalProviderDiagnostic {
  if (error instanceof LocalProviderError) return error.diagnostic;
  if (error instanceof DOMException && error.name === "AbortError") {
    return /timed out/i.test(error.message)
      ? errorDiagnostic("timeout", "The local model request timed out.")
      : errorDiagnostic("cancelled", "The local model request was cancelled.");
  }
  if (globalThis.navigator?.onLine === false) {
    return errorDiagnostic("offline", "This device is offline and the local model endpoint could not be reached.");
  }
  return errorDiagnostic(
    "cors-or-private-network-access",
    "The browser could not reach the local model directly. Start its loopback API server and allow this Airship origin in the provider's CORS/browser access settings.",
  );
}

export function providerDiagnostic(
  code: LocalProviderDiagnosticCode,
  message: string,
  init: Partial<Omit<LocalProviderDiagnostic, "code" | "message">> = {},
): LocalProviderDiagnostic {
  return Object.freeze({
    code,
    message,
    severity: init.severity ?? "error",
    blocking: init.blocking ?? true,
    ...(init.modelId ? { modelId: init.modelId } : {}),
    ...(init.status !== undefined ? { status: init.status } : {}),
  });
}

function errorDiagnostic(
  code: LocalProviderDiagnosticCode,
  message: string,
): LocalProviderDiagnostic {
  return providerDiagnostic(code, message);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  const octets = parseIpv4(hostname);
  return !!octets && octets[0] === 127;
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const values = parts.map((part) => part === "" ? Number.NaN : Number(part));
  return values.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? values
    : undefined;
}

function safeUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
