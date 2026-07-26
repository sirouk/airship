export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/**
 * A Google OAuth *Web* client ID. It is a public deployment identifier, never a
 * secret, so a build may legitimately embed it. This is the single source of the
 * shape: build-time default selection and runtime authorizer construction must
 * agree, otherwise a deployment can ship a default provider whose authorizer
 * throws "Google OAuth client ID is invalid." at construction.
 */
const GOOGLE_OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{12,256}\.apps\.googleusercontent\.com$/u;
export const GOOGLE_ACCOUNT_SCOPES = Object.freeze(["openid", "email", "profile", GOOGLE_DRIVE_FILE_SCOPE] as const);
const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const MAX_GOOGLE_USERINFO_BYTES = 64 * 1024;
const GOOGLE_AUTHORIZATION_TIMEOUT_MS = 2 * 60_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * True only when this build can actually open the Google connect flow. Callers
 * that pick a default vault provider must consult this instead of assuming
 * Drive: an unconfigured build cannot connect to Drive at all, so offering it
 * as the default would present a provider that is structurally unreachable.
 */
export function isDeployableGoogleOAuthClientId(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const clientId = value.trim();
  // Bound before the regex so a pathological build-time value cannot be scanned.
  return clientId.length <= 512 && GOOGLE_OAUTH_CLIENT_ID_PATTERN.test(clientId);
}

export type GoogleAccessToken = Readonly<{
  accessToken: string;
  expiresAt: number;
  grantedScopes: readonly string[];
}>;

export interface GoogleAccessTokenProvider {
  /** Returns a still-usable token already granted by an explicit user action. */
  getAccessToken(signal?: AbortSignal): Promise<GoogleAccessToken>;
  reset?(): void;
}

/**
 * Page-memory token holder. It deliberately cannot refresh or persist a token:
 * Google Identity Services' browser token flow requires another user gesture
 * after expiry. UI code must call `replace()` from the GIS callback.
 */
export class MemoryOnlyGoogleAccessTokenProvider implements GoogleAccessTokenProvider {
  #token?: GoogleAccessToken;

  replace(response: { accessToken: string; expiresInSeconds: number; grantedScopes: readonly string[] }, now = Date.now()): void {
    const accessToken = boundedToken(response.accessToken);
    if (!Number.isFinite(response.expiresInSeconds) || response.expiresInSeconds < 30 || response.expiresInSeconds > 86_400) {
      throw new Error("Google access-token lifetime is invalid.");
    }
    const grantedScopes = Object.freeze([...new Set(response.grantedScopes.map(canonicalScope))].sort());
    if (!grantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) {
      throw new Error("Google authorization did not grant the Drive file scope.");
    }
    this.#token = Object.freeze({
      accessToken,
      expiresAt: now + response.expiresInSeconds * 1_000,
      grantedScopes,
    });
  }

  async getAccessToken(signal?: AbortSignal): Promise<GoogleAccessToken> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Google Drive request was aborted.", "AbortError");
    const token = this.#token;
    // Leave enough time for a bounded upload. Never attempt a silent refresh.
    if (!token || token.expiresAt - Date.now() < 30_000) {
      throw new GoogleDriveAuthorizationRequiredError();
    }
    return token;
  }

  reset(): void {
    this.#token = undefined;
  }
}

export class GoogleDriveAuthorizationRequiredError extends Error {
  constructor(message = "Google Drive authorization is required. Continue with Google from a user gesture.") {
    super(message);
    this.name = "GoogleDriveAuthorizationRequiredError";
  }
}

export type GoogleIdentityTokenResponse = Readonly<{
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}>;

type GoogleTokenClient = { requestAccessToken(options?: { prompt?: "" | "consent" | "select_account" }): void };

type GoogleIdentityNamespace = {
  accounts: { oauth2: {
    initTokenClient(options: {
      client_id: string;
      scope: string;
      callback(response: GoogleIdentityTokenResponse): void;
      error_callback?(error: { type?: string; message?: string }): void;
    }): GoogleTokenClient;
  }};
};

/** Thin, dependency-free wrapper around the official GIS browser token client. */
export class GoogleIdentityServicesAuthorizer {
  readonly scope = GOOGLE_ACCOUNT_SCOPES.join(" ");
  /**
   * Always the trimmed form. The predicate tolerates a build-time value with
   * surrounding whitespace, so the accepted value and the value actually sent as
   * `client_id` must be normalized at the same boundary; otherwise a padded id
   * would construct here and then fail opaquely inside Google's token client.
   */
  readonly #clientId: string;
  #client?: GoogleTokenClient;
  #pending?: {
    resolve(value: GoogleAccessToken): void;
    reject(reason: unknown): void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  };

  constructor(
    clientId: string,
    private readonly provider: MemoryOnlyGoogleAccessTokenProvider,
    private readonly loadIdentityServices: () => Promise<GoogleIdentityNamespace> = defaultGoogleIdentityServices,
  ) {
    if (!isDeployableGoogleOAuthClientId(clientId)) {
      throw new Error("Google OAuth client ID is invalid.");
    }
    this.#clientId = clientId.trim();
  }

  /** Load GIS when the connection surface opens, before a click is required. */
  async prepare(): Promise<void> {
    await this.tokenClient();
  }

  /** Must be invoked synchronously from a click/tap handler after `prepare()`. */
  authorize(options: { selectAccount?: boolean } = {}): Promise<GoogleAccessToken> {
    if (this.#pending) throw new Error("Google authorization is already in progress.");
    const client = this.#client;
    if (!client) throw new Error("Prepare Google Identity Services before requesting access.");
    return new Promise<GoogleAccessToken>((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          if (this.#pending !== pending) return;
          this.#pending = undefined;
          reject(new GoogleDriveAuthorizationRequiredError("Google authorization did not finish. Close any stale account window and try again."));
        }, GOOGLE_AUTHORIZATION_TIMEOUT_MS),
      };
      this.#pending = pending;
      try {
        client.requestAccessToken({ prompt: options.selectAccount ? "select_account" : "" });
      } catch (error) {
        this.#pending = undefined;
        globalThis.clearTimeout(pending.timer);
        reject(new GoogleDriveAuthorizationRequiredError(
          error instanceof Error ? boundedMessage(error.message) : "Google authorization could not open.",
        ));
      }
    });
  }

  /**
   * Replace an expired page-memory grant from an explicit user gesture.
   *
   * GIS does not issue a browser refresh token, so this intentionally invokes
   * the token client again instead of attempting background refresh or storing
   * authority anywhere durable. The existing account is preferred; GIS can
   * still show consent when Google determines that it is required.
   */
  reauthorize(): Promise<GoogleAccessToken> {
    return this.authorize({ selectAccount: false });
  }

  reset(): void {
    if (this.#pending) {
      globalThis.clearTimeout(this.#pending.timer);
      this.#pending.reject(new GoogleDriveAuthorizationRequiredError("Google authorization was cleared."));
    }
    this.#pending = undefined;
    this.#client = undefined;
    this.provider.reset();
  }

  private async tokenClient(): Promise<GoogleTokenClient> {
    if (this.#client) return this.#client;
    const google = await this.loadIdentityServices();
    this.#client = google.accounts.oauth2.initTokenClient({
      client_id: this.#clientId,
      scope: this.scope,
      callback: (response) => {
        const pending = this.#pending;
        this.#pending = undefined;
        if (!pending) return;
        globalThis.clearTimeout(pending.timer);
        try {
          if (response.error || !response.access_token || !response.expires_in) {
            throw new GoogleDriveAuthorizationRequiredError(
              response.error_description ? boundedMessage(response.error_description) : "Google did not grant Drive access.",
            );
          }
          this.provider.replace({
            accessToken: response.access_token,
            expiresInSeconds: response.expires_in,
            grantedScopes: (response.scope ?? "").split(/\s+/u).filter(Boolean),
          });
          void this.provider.getAccessToken().then(pending.resolve, pending.reject);
        } catch (error) {
          pending.reject(error);
        }
      },
      error_callback: (error) => {
        const pending = this.#pending;
        this.#pending = undefined;
        if (pending) globalThis.clearTimeout(pending.timer);
        pending?.reject(new GoogleDriveAuthorizationRequiredError(boundedMessage(error.message ?? error.type ?? "Google authorization was interrupted.")));
      },
    });
    return this.#client;
  }
}

export type GoogleAccountIdentity = Readonly<{
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  pictureUrl?: string;
}>;

/** Page-memory account context, not a server-issued Airship session. */
export async function readGoogleAccountIdentity(
  provider: GoogleAccessTokenProvider,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<GoogleAccountIdentity> {
  const token = await provider.getAccessToken(signal);
  for (const scope of ["openid", "email", "profile"]) {
    if (!token.grantedScopes.includes(scope)) throw new Error(`Google authorization did not grant ${scope} account context.`);
  }
  const response = await fetchImplementation("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new GoogleDriveAuthorizationRequiredError(`Google account lookup failed (${response.status}).`);
  let raw: unknown;
  try { raw = JSON.parse(utf8Decoder.decode(await boundedResponseBytes(response, MAX_GOOGLE_USERINFO_BYTES, signal))); }
  catch { throw new Error("Google account lookup returned invalid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Google account lookup returned invalid identity data.");
  const value = raw as Record<string, unknown>;
  if (typeof value.sub !== "string" || !/^[A-Za-z0-9_-]{6,256}$/u.test(value.sub)) throw new Error("Google account subject is invalid.");
  if (typeof value.email !== "string" || value.email.length > 320 || !value.email.includes("@")) throw new Error("Google account email is invalid.");
  return Object.freeze({
    subject: value.sub,
    email: value.email,
    emailVerified: value.email_verified === true,
    displayName: typeof value.name === "string" && value.name.length <= 200 ? value.name : undefined,
    pictureUrl: safeGooglePicture(value.picture),
  });
}

let gisPromise: Promise<GoogleIdentityNamespace> | undefined;

function defaultGoogleIdentityServices(): Promise<GoogleIdentityNamespace> {
  if (gisPromise) return gisPromise;
  const attempt = new Promise<GoogleIdentityNamespace>((resolve, reject) => {
    const existing = (globalThis as typeof globalThis & { google?: GoogleIdentityNamespace }).google;
    if (existing?.accounts?.oauth2) { resolve(existing); return; }
    if (typeof document === "undefined") { reject(new Error("Google Identity Services requires a browser document.")); return; }
    const script = document.createElement("script");
    script.src = trustedGoogleIdentityScriptUrl() as string;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const loaded = (globalThis as typeof globalThis & { google?: GoogleIdentityNamespace }).google;
      loaded?.accounts?.oauth2 ? resolve(loaded) : reject(new Error("Google Identity Services loaded without the OAuth API."));
    };
    script.onerror = () => reject(new Error("Google Identity Services could not be loaded."));
    document.head.append(script);
  });
  // A transient CSP/network failure must not poison this page forever. A later
  // explicit retry gets one fresh loader attempt; concurrent callers still
  // share the same in-flight promise.
  const guarded = attempt.catch((error) => {
    if (gisPromise === guarded) gisPromise = undefined;
    throw error;
  });
  gisPromise = guarded;
  return guarded;
}

type GoogleIdentityScriptPolicy = Readonly<{ createScriptURL(value: string): unknown }>;

function trustedGoogleIdentityScriptUrl(): string | object {
  const candidate = new URL(GOOGLE_IDENTITY_SCRIPT_URL);
  const trustedGlobal = globalThis as typeof globalThis & {
    trustedTypes?: {
      createPolicy(
        name: string,
        rules: { createScriptURL(value: string): string },
      ): GoogleIdentityScriptPolicy;
    };
    __airshipGoogleIdentityPolicy?: GoogleIdentityScriptPolicy;
  };
  const factory = trustedGlobal.trustedTypes;
  if (!factory) return candidate.href;
  trustedGlobal.__airshipGoogleIdentityPolicy ??= factory.createPolicy(
    "airship-google-identity",
    {
      createScriptURL(value) {
        const url = new URL(value);
        if (
          url.href !== GOOGLE_IDENTITY_SCRIPT_URL ||
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          throw new TypeError("Airship refused an unapproved Google Identity Services script.");
        }
        return url.href;
      },
    },
  );
  return trustedGlobal.__airshipGoogleIdentityPolicy.createScriptURL(candidate.href) as object;
}

function boundedToken(value: string): string {
  const token = value.trim();
  if (token.length < 16 || token.length > 8_192 || /[\r\n]/u.test(token)) throw new Error("Google access token is invalid.");
  return token;
}

function canonicalScope(value: string): string {
  const scope = value.trim();
  if (!scope || scope.length > 512 || /\s/u.test(scope)) throw new Error("Google authorization scope is invalid.");
  return scope;
}

function boundedMessage(value: string): string {
  const message = value.replace(/[\r\n]+/gu, " ").trim();
  return message.slice(0, 240) || "Google authorization did not complete.";
}

function safeGooglePicture(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function boundedResponseBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Google account lookup response exceeded the client limit.");
    }
  }
  if (!response.body) throw new Error("Google account lookup returned an empty body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("Google account lookup response exceeded the client limit.").catch(() => undefined);
        throw new Error("Google account lookup response exceeded the client limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* an aborted body may retain its reader */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Google account lookup was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Google account lookup was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
