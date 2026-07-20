import type { S3CredentialProvider, S3TemporaryCredentials } from "./s3-object-store";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_ATTEMPTS = 3;
const EARLY_REFRESH_MS = 5 * 60_000;
const MINIMUM_FALLBACK_TTL_MS = 60_000;

export type CognitoIdentityCredentialProviderOptions = {
  region: string;
  identityPoolId: string;
  loginProvider: string;
  getIdToken(): Promise<string>;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

export class CognitoIdentityError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CognitoIdentityError";
  }
}

/**
 * Dependency-free Cognito Identity enhanced-flow provider for public clients.
 * OIDC and AWS session credentials remain in memory. Call reset() on logout or
 * account change; never share one instance across authenticated subjects.
 */
export class CognitoIdentityCredentialProvider implements S3CredentialProvider {
  private readonly endpoint: URL;
  private readonly identityPoolId: string;
  private readonly loginProvider: string;
  private readonly getIdToken: () => Promise<string>;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private cachedIdentityId?: string;
  private cachedCredentials?: S3TemporaryCredentials;
  private refreshAt = 0;
  private refreshPromise?: Promise<S3TemporaryCredentials>;
  private refreshGeneration = 0;

  constructor(options: CognitoIdentityCredentialProviderOptions) {
    const region = validateRegion(options.region);
    this.identityPoolId = validateIdentityPoolId(options.identityPoolId, region);
    this.loginProvider = boundedValue(options.loginProvider.trim(), "Cognito login provider", 2_048);
    this.getIdToken = options.getIdToken;
    this.endpoint = options.endpoint
      ? validateEndpoint(options.endpoint)
      : new URL(`https://cognito-identity.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}/`);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  get identityId(): string | undefined {
    return this.cachedIdentityId;
  }

  async initialize(signal?: AbortSignal): Promise<string> {
    await this.getCredentials(signal);
    if (!this.cachedIdentityId) throw new Error("Cognito did not initialize an identity ID.");
    return this.cachedIdentityId;
  }

  reset(): void {
    this.cachedIdentityId = undefined;
    this.cachedCredentials = undefined;
    this.refreshAt = 0;
    this.refreshPromise = undefined;
    this.refreshGeneration += 1;
  }

  async getCredentials(signal?: AbortSignal): Promise<S3TemporaryCredentials> {
    throwIfAborted(signal);
    const cached = this.cachedCredentials;
    if (cached && this.now().getTime() < this.refreshAt) return { ...cached };

    if (!this.refreshPromise) {
      const generation = ++this.refreshGeneration;
      const pending = this.refreshWithFallback(generation);
      this.refreshPromise = (async () => {
        try {
          return await pending;
        } finally {
          if (this.refreshGeneration === generation) this.refreshPromise = undefined;
        }
      })();
    }
    return { ...(await waitFor(this.refreshPromise, signal)) };
  }

  private async refreshWithFallback(generation: number): Promise<S3TemporaryCredentials> {
    try {
      return await this.refresh(generation);
    } catch (error) {
      this.assertGeneration(generation);
      const cached = this.cachedCredentials;
      const expiration = cached?.expiration ? Date.parse(cached.expiration) : Number.NaN;
      if (cached && Number.isFinite(expiration) && expiration > this.now().getTime() + MINIMUM_FALLBACK_TTL_MS) {
        return cached;
      }
      throw error;
    }
  }

  private async refresh(generation: number): Promise<S3TemporaryCredentials> {
    const token = boundedValue((await this.getIdToken()).trim(), "OIDC ID token", MAX_TOKEN_BYTES);
    this.assertGeneration(generation);
    const logins = { [this.loginProvider]: token };
    if (!this.cachedIdentityId) {
      const identity = await this.call("GetId", { IdentityPoolId: this.identityPoolId, Logins: logins });
      this.assertGeneration(generation);
      this.cachedIdentityId = parseIdentityId(identity, this.identityPoolId.split(":", 1)[0]!);
    }
    const response = await this.call("GetCredentialsForIdentity", {
      IdentityId: this.cachedIdentityId,
      Logins: logins,
    });
    this.assertGeneration(generation);
    const credentials = parseCredentials(response);
    const expiration = Date.parse(credentials.expiration!);
    const jitter = randomInteger(0, 60_000);
    this.refreshAt = Math.max(this.now().getTime(), expiration - EARLY_REFRESH_MS - jitter);
    this.cachedCredentials = credentials;
    return credentials;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.refreshGeneration) {
      throw new DOMException("Cognito credential refresh was invalidated by an account reset.", "AbortError");
    }
  }

  private async call(operation: "GetId" | "GetCredentialsForIdentity", body: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": `AWSCognitoIdentityService.${operation}`,
          },
          body: JSON.stringify(body),
          cache: "no-store",
          credentials: "omit",
          mode: "cors",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
      } catch (cause) {
        if (attempt + 1 < MAX_ATTEMPTS) {
          await delay(fullJitter(attempt));
          continue;
        }
        throw new CognitoIdentityError(
          `Cognito ${operation} failed before a response was available.`,
          "NetworkError",
          true,
          undefined,
          { cause },
        );
      }

      const text = await boundedText(response);
      const parsed = parseJson(text);
      if (response.ok) return parsed;
      const code = errorCode(response, parsed);
      const retryable = code === "InternalErrorException" || code === "TooManyRequestsException" || response.status >= 500;
      if (retryable && attempt + 1 < MAX_ATTEMPTS) {
        await delay(retryAfterMs(response.headers.get("retry-after"), attempt, this.now()));
        continue;
      }
      throw new CognitoIdentityError(
        `Cognito ${operation} failed (${response.status}) [${code}].`,
        code,
        retryable,
        response.headers.get("x-amzn-requestid") ?? undefined,
      );
    }
    throw new Error("Cognito retry loop exhausted unexpectedly.");
  }
}

function parseIdentityId(value: unknown, region: string): string {
  const record = objectRecord(value, "Cognito GetId response");
  const identityId = boundedValue(record.IdentityId, "Cognito identity ID", 256);
  if (!new RegExp(`^${escapeRegex(region)}:${UUID_PATTERN}$`, "u").test(identityId)) {
    throw new Error("Cognito returned an identity ID for an unexpected region or format.");
  }
  return identityId;
}

function parseCredentials(value: unknown): S3TemporaryCredentials {
  const response = objectRecord(value, "Cognito credential response");
  const record = objectRecord(response.Credentials, "Cognito credentials");
  const accessKeyId = boundedValue(record.AccessKeyId, "Cognito access key ID", 256);
  const secretAccessKey = boundedValue(record.SecretKey, "Cognito secret key", 4_096);
  const sessionToken = boundedValue(record.SessionToken, "Cognito session token", 16_384);
  const expiration = parseExpiration(record.Expiration);
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

function parseExpiration(value: unknown): string {
  const milliseconds = typeof value === "number" ? value * 1_000 : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("Cognito returned an invalid credential expiry.");
  return new Date(milliseconds).toISOString();
}

function validateRegion(value: string): string {
  const region = boundedValue(value, "AWS region", 64);
  if (!/^[a-z]{2,8}(?:-[a-z0-9]+)+-\d$/u.test(region)) throw new Error("AWS region is invalid.");
  return region;
}

function validateIdentityPoolId(value: string, region: string): string {
  const pool = boundedValue(value, "Cognito identity pool ID", 256);
  if (!new RegExp(`^${escapeRegex(region)}:${UUID_PATTERN}$`, "u").test(pool)) {
    throw new Error("Cognito identity pool ID does not match the configured region.");
  }
  return pool;
}

function boundedValue(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value || /[\r\n]/u.test(value) || new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Cognito response exceeds the client limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let output = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel("Cognito response exceeds the client limit.");
        throw new Error("Cognito response exceeds the client limit.");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function parseJson(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cognito returned malformed JSON.");
  }
}

function errorCode(response: Response, parsed: unknown): string {
  const header = response.headers.get("x-amzn-errortype")?.split(":", 1)[0];
  if (header) return header;
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const raw = typeof record?.__type === "string" ? record.__type : "UnknownError";
  return raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw;
}

function retryAfterMs(value: string | null, attempt: number, now: Date): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, seconds * 1_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, Math.min(2_000, date - now.getTime()));
  }
  return fullJitter(attempt);
}

function fullJitter(attempt: number): number {
  return randomInteger(0, Math.min(2_000, 100 * 2 ** attempt));
}

function randomInteger(minimum: number, maximum: number): number {
  if (maximum <= minimum) return minimum;
  const value = crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;
  return minimum + Math.floor(value * (maximum - minimum + 1));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validateEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new Error("Cognito endpoint must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  endpoint.pathname = "/";
  return endpoint;
}

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
