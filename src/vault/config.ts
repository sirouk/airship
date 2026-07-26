export type VaultMode = "strict-production" | "local-development";

export type VaultCredentialSource = {
  kind: "cognito-identity" | "oidc-temporary" | "custom-temporary" | "local-development";
  displayName: string;
  /** Exact public-client origins contacted to obtain temporary credentials. */
  authorityOrigins: string[];
};

export type VaultS3ConfigurationInput = {
  mode: VaultMode;
  endpoint: string;
  region: string;
  bucket: string;
  namespace: string;
  probePrefix?: string;
  forcePathStyle?: boolean;
  credentialSource: VaultCredentialSource;
};

export type VaultS3Configuration = Readonly<{
  mode: VaultMode;
  endpoint: string;
  region: string;
  bucket: string;
  namespace: string;
  probePrefix: string;
  forcePathStyle: boolean;
  credentialSource: Readonly<{
    kind: VaultCredentialSource["kind"];
    displayName: string;
    authorityOrigins: readonly string[];
  }>;
}>;

export type VaultProviderRequirements = Readonly<{
  directBrowserOnly: true;
  credentialContract: Readonly<{
    productionRequiresExpiration: boolean;
    productionRequiresSessionToken: boolean;
    persistence: "memory-only";
    resetEvents: readonly ["logout", "account-switch", "vault-disconnect"];
  }>;
  cspConnectSrc: readonly string[];
  cors: Readonly<{
    allowedMethods: readonly string[];
    allowedRequestHeaders: readonly string[];
    exposedResponseHeaders: readonly string[];
    credentialsMode: "omit";
  }>;
  authorization: Readonly<{
    authenticatedSubjectRequired: true;
    listPrefix: string;
    objectPrefix: string;
    forbiddenByBaseline: readonly string[];
  }>;
  probeLifecycle: Readonly<{
    logicalPrefix: string;
    /**
     * Whether the store this configuration was handed can remove its own probe
     * objects. It is derived from the store, never asserted per provider: the
     * same provider can be reached through a store that reclaims and one that
     * does not, and declaring the wrong one either invents a sweep that never
     * happens or hides one that does.
     */
    deletionAvailableInRuntime: boolean;
    cleanup: "provider-lifecycle-or-out-of-band" | "runtime-reclaimed-then-out-of-band";
  }>;
}>;

export class VaultConfigurationError extends Error {
  constructor(
    readonly code:
      | "endpoint-invalid"
      | "region-invalid"
      | "bucket-invalid"
      | "namespace-invalid"
      | "probe-prefix-invalid"
      | "credential-source-invalid"
      | "mode-invalid",
    message: string,
  ) {
    super(message);
    this.name = "VaultConfigurationError";
  }
}

const DEFAULT_PROBE_PREFIX = ".airship-probes/v1";
const MAX_NAMESPACE_BYTES = 512;

export function validateVaultS3Configuration(input: VaultS3ConfigurationInput): VaultS3Configuration {
  const mode = input.mode;
  if (mode !== "strict-production" && mode !== "local-development") {
    throw new VaultConfigurationError("mode-invalid", "Vault mode is invalid.");
  }
  const endpoint = exactEndpoint(input.endpoint, mode, "S3 endpoint");
  const region = exactRegion(input.region);
  const bucket = exactBucket(input.bucket);
  const namespace = exactNamespace(input.namespace, "namespace", "namespace-invalid");
  const probePrefix = exactNamespace(
    input.probePrefix ?? DEFAULT_PROBE_PREFIX,
    "probe prefix",
    "probe-prefix-invalid",
  );
  const forcePathStyle = input.forcePathStyle ?? mode === "local-development";

  if (mode === "local-development" && !isLocalHostname(new URL(endpoint).hostname)) {
    throw new VaultConfigurationError("mode-invalid", "Local-development vaults require a loopback S3 endpoint.");
  }
  if (mode === "local-development" && !forcePathStyle) {
    throw new VaultConfigurationError("mode-invalid", "Local-development vaults require path-style addressing.");
  }
  if (mode === "strict-production" && input.credentialSource.kind === "local-development") {
    throw new VaultConfigurationError("credential-source-invalid", "Production vaults require a temporary authenticated credential source.");
  }
  if (mode === "local-development" && input.credentialSource.kind !== "local-development") {
    throw new VaultConfigurationError("credential-source-invalid", "A local-development vault must declare its local credential source explicitly.");
  }
  if (!forcePathStyle && bucket.includes(".")) {
    throw new VaultConfigurationError("bucket-invalid", "Virtual-host vaults refuse dotted bucket names for an exact TLS/CSP origin.");
  }

  const displayName = exactDisplayName(input.credentialSource.displayName);
  if (input.credentialSource.authorityOrigins.length > 8) {
    throw new VaultConfigurationError("credential-source-invalid", "Credential source declares too many authority origins.");
  }
  const authorityOrigins = [...new Set(input.credentialSource.authorityOrigins.map((origin) =>
    exactOrigin(origin, mode, "credential authority", "credential-source-invalid"),
  ))].sort();
  if (mode === "strict-production" && authorityOrigins.length === 0) {
    throw new VaultConfigurationError("credential-source-invalid", "Production vaults require an exact credential authority origin.");
  }

  return Object.freeze({
    mode,
    endpoint,
    region,
    bucket,
    namespace,
    probePrefix,
    forcePathStyle,
    credentialSource: Object.freeze({
      kind: input.credentialSource.kind,
      displayName,
      authorityOrigins: Object.freeze(authorityOrigins),
    }),
  });
}

export function vaultProviderRequirements(config: VaultS3Configuration): VaultProviderRequirements {
  const endpoint = new URL(config.endpoint);
  const objectOrigin = config.forcePathStyle
    ? endpoint.origin
    : `${endpoint.protocol}//${config.bucket}.${endpoint.host}`;
  const cspConnectSrc = Object.freeze([...new Set([
    objectOrigin,
    ...config.credentialSource.authorityOrigins,
  ])].sort());
  return Object.freeze({
    directBrowserOnly: true,
    credentialContract: Object.freeze({
      productionRequiresExpiration: true,
      productionRequiresSessionToken: true,
      persistence: "memory-only",
      resetEvents: Object.freeze(["logout", "account-switch", "vault-disconnect"] as const),
    }),
    cspConnectSrc,
    cors: Object.freeze({
      allowedMethods: Object.freeze(["GET", "PUT"] as const),
      allowedRequestHeaders: Object.freeze([
        "Authorization",
        "Cache-Control",
        "Content-Type",
        "If-Match",
        "If-None-Match",
        "Pragma",
        "Range",
        "x-amz-content-sha256",
        "x-amz-date",
        "x-amz-security-token",
      ]),
      exposedResponseHeaders: Object.freeze([
        "Content-Length",
        "Content-Range",
        "ETag",
        "Last-Modified",
        "x-amz-bucket-region",
        "x-amz-request-id",
      ]),
      credentialsMode: "omit",
    }),
    authorization: Object.freeze({
      authenticatedSubjectRequired: true,
      listPrefix: `${config.namespace}/*`,
      objectPrefix: `${config.namespace}/*`,
      forbiddenByBaseline: Object.freeze(["DeleteObject", "PutObjectAcl", "ListAllMyBuckets"] as const),
    }),
    probeLifecycle: Object.freeze({
      logicalPrefix: `${config.namespace}/${config.probePrefix}`,
      deletionAvailableInRuntime: false,
      cleanup: "provider-lifecycle-or-out-of-band",
    }),
  });
}

function exactEndpoint(value: string, mode: VaultMode, label: string): string {
  const origin = exactOrigin(value, mode, label);
  const url = new URL(origin);
  if (url.pathname !== "/") {
    throw new VaultConfigurationError("endpoint-invalid", `${label} must be an exact origin without a path.`);
  }
  return url.origin;
}

function exactOrigin(
  value: string,
  mode: VaultMode,
  label: string,
  code: "endpoint-invalid" | "credential-source-invalid" = "endpoint-invalid",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultConfigurationError(code, `${label} must be a valid absolute URL.`);
  }
  const localHttp = mode === "local-development" && url.protocol === "http:" && isLocalHostname(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new VaultConfigurationError(code, `${label} must use HTTPS except on loopback in local development.`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new VaultConfigurationError(code, `${label} must be an exact origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}

function exactRegion(value: string): string {
  if (value !== value.trim() || !/^(?:auto|[a-z0-9][a-z0-9-]{0,62})$/u.test(value)) {
    throw new VaultConfigurationError("region-invalid", "S3 region must be a canonical lowercase region or 'auto'.");
  }
  return value;
}

function exactBucket(value: string): string {
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
  if (
    value !== value.trim() ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes("..") ||
    value.includes(".-") ||
    value.includes("-.") ||
    ipv4.test(value)
  ) {
    throw new VaultConfigurationError("bucket-invalid", "S3 bucket name is not a canonical DNS-compatible bucket.");
  }
  return value;
}

function exactNamespace(
  value: string,
  label: string,
  code: "namespace-invalid" | "probe-prefix-invalid",
): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  const segments = value.split("/");
  if (
    value !== value.trim() ||
    bytes === 0 ||
    bytes > MAX_NAMESPACE_BYTES ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    value.includes("%") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    segments.some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9._:=@+-]+$/u.test(segment))
  ) {
    throw new VaultConfigurationError(code, `Vault ${label} is not a canonical relative object prefix.`);
  }
  return value;
}

function exactDisplayName(value: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (value !== value.trim() || bytes < 1 || bytes > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new VaultConfigurationError("credential-source-invalid", "Credential source display name is invalid.");
  }
  return value;
}

function isLocalHostname(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]";
}
