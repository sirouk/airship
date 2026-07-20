export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_ACCOUNT_SCOPES = Object.freeze(["openid", "email", "profile", GOOGLE_DRIVE_FILE_SCOPE] as const);

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
  #client?: GoogleTokenClient;
  #pending?: { resolve(value: GoogleAccessToken): void; reject(reason: unknown): void };

  constructor(
    private readonly clientId: string,
    private readonly provider: MemoryOnlyGoogleAccessTokenProvider,
    private readonly loadIdentityServices: () => Promise<GoogleIdentityNamespace> = defaultGoogleIdentityServices,
  ) {
    if (!/^[A-Za-z0-9._-]{12,256}\.apps\.googleusercontent\.com$/u.test(clientId)) {
      throw new Error("Google OAuth client ID is invalid.");
    }
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
      this.#pending = { resolve, reject };
      client.requestAccessToken({ prompt: options.selectAccount ? "select_account" : "" });
    });
  }

  reset(): void {
    this.#pending?.reject(new GoogleDriveAuthorizationRequiredError("Google authorization was cleared."));
    this.#pending = undefined;
    this.#client = undefined;
    this.provider.reset();
  }

  private async tokenClient(): Promise<GoogleTokenClient> {
    if (this.#client) return this.#client;
    const google = await this.loadIdentityServices();
    this.#client = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: this.scope,
      callback: (response) => {
        const pending = this.#pending;
        this.#pending = undefined;
        if (!pending) return;
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
    signal,
  });
  if (!response.ok) throw new GoogleDriveAuthorizationRequiredError(`Google account lookup failed (${response.status}).`);
  let raw: unknown;
  try { raw = await response.json(); }
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
  gisPromise ??= new Promise((resolve, reject) => {
    const existing = (globalThis as typeof globalThis & { google?: GoogleIdentityNamespace }).google;
    if (existing?.accounts?.oauth2) { resolve(existing); return; }
    if (typeof document === "undefined") { reject(new Error("Google Identity Services requires a browser document.")); return; }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const loaded = (globalThis as typeof globalThis & { google?: GoogleIdentityNamespace }).google;
      loaded?.accounts?.oauth2 ? resolve(loaded) : reject(new Error("Google Identity Services loaded without the OAuth API."));
    };
    script.onerror = () => reject(new Error("Google Identity Services could not be loaded."));
    document.head.append(script);
  });
  return gisPromise;
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
