const IDENTIFIER = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/u;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/u;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/u;
const SAFE_CODE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const FORBIDDEN_OAUTH_FIELDS = new Set([
  "clientsecret",
  "client_secret",
  "client-secret",
  "tokenendpointauthsecret",
]);

export function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function opaqueIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !OPAQUE_IDENTIFIER.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function boundedText(value: string, label: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO 8601.`);
  }
  return value;
}

export function positiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function nonNegativeFinite(value: number, label: string, maximum: number): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function headerName(value: string): string {
  if (!HEADER_NAME.test(value)) throw new TypeError("The API-key header name is invalid.");
  return value;
}

export function scopes(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 128) throw new TypeError(`${label} are invalid.`);
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !SCOPE.test(value) || unique.has(value)) {
      throw new TypeError(`${label} are invalid.`);
    }
    unique.add(value);
  }
  return Object.freeze([...unique]);
}

export function optionalCode(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!SAFE_CODE.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

export function httpsUrl(value: string, label: string): string {
  return reviewedUrl(value, label, false);
}

export function providerBaseUrl(
  value: string,
  label: string,
  boundary: "e2ee-attestable" | "provider-tls" | "loopback-local",
): string {
  if (boundary === "loopback-local") {
    let candidate: URL;
    try {
      candidate = new URL(value);
    } catch {
      throw new TypeError(`${label} is invalid.`);
    }
    if (!isLoopbackHostname(candidate.hostname)) {
      throw new TypeError(`${label} must use a loopback host.`);
    }
  }
  const normalized = reviewedUrl(value, label, boundary === "loopback-local");
  const url = new URL(normalized);
  if (boundary === "loopback-local" && !isLoopbackHostname(url.hostname)) {
    throw new TypeError(`${label} must use a loopback host.`);
  }
  return normalized;
}

export function redirectUri(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) {
    throw new TypeError("OAuth redirect URIs cannot contain credentials or fragments.");
  }
  const allowedHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !allowedHttp) {
    throw new TypeError("OAuth redirect URIs must use HTTPS or loopback HTTP.");
  }
  return url.href;
}

export function rejectOAuthSecrets(value: object): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OAUTH_FIELDS.has(key.toLowerCase())) {
      throw new TypeError("Public PKCE metadata cannot contain a client secret.");
    }
  }
}

export function credential(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > 16 * 1_024
    || value.trim() !== value
    || /\s|\u0000|\u007f/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

function reviewedUrl(value: string, label: string, allowLoopbackHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} is invalid.`);
  }
  if (url.username || url.password || url.hash) throw new TypeError(`${label} is invalid.`);
  const allowedHttp = allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !allowedHttp) throw new TypeError(`${label} must use HTTPS.`);
  return url.href;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
