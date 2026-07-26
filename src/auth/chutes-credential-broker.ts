import {
  CHUTES_LOCAL_REGISTRATION,
  refreshChutesOAuthToken,
  revokeChutesToken,
  type ChutesOAuthTokenSet,
} from "./chutes-oauth";
import {
  parseChutesCredential,
  type ChutesCredentialKind,
} from "./connection";
import { sha256 } from "../core/hash";

const DEFAULT_MINIMUM_VALIDITY_MS = 30_000;
const MAX_MINIMUM_VALIDITY_MS = 5 * 60_000;
const MAX_OAUTH_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_REFRESH_TOKEN_BYTES = 4 * 1024;
const SCOPE_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/u;

export type ChutesCredentialBrokerErrorCode =
  | "disconnected"
  | "wrong-kind"
  | "missing-scope"
  | "expired"
  | "refresh-unavailable"
  | "refresh-failed"
  | "refresh-invalidated";

export class ChutesCredentialBrokerError extends Error {
  constructor(
    readonly code: ChutesCredentialBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChutesCredentialBrokerError";
  }
}

export type ChutesCredentialMetadata =
  | Readonly<{
      status: "disconnected";
      revision: number;
    }>
  | Readonly<{
      status: "connected";
      revision: number;
      credentialKind: "inference-api-key";
      installedAt: number;
      scopes: readonly [];
      expiresAt: undefined;
      refreshable: false;
    }>
  | Readonly<{
      status: "connected";
      revision: number;
      credentialKind: "oauth-user-token";
      installedAt: number;
      scopes: readonly string[];
      expiresAt: number;
      refreshable: boolean;
    }>;

export type ChutesBearerRequest = Readonly<{
  /** Refuse a credential of the other class instead of silently reusing it. */
  expectedKind?: ChutesCredentialKind;
  /** OAuth scopes this specific operation requires. API keys cannot satisfy scopes. */
  requiredScopes?: readonly string[];
  /** Refresh before fewer than this many milliseconds remain. */
  minimumValidityMs?: number;
  /** Aborts only this waiter; it never cancels a refresh shared by another caller. */
  signal?: AbortSignal;
}>;

export type ChutesCredentialBrokerOptions = Readonly<{
  clientId?: string;
  requiredOAuthScopes?: readonly string[];
  minimumValidityMs?: number;
  now?: () => number;
  /** Trusted token-endpoint adapter. It is the only collaborator given a refresh token. */
  refresh?: typeof refreshChutesOAuthToken;
  /** Trusted revocation adapter, given the same tokens as `refresh` and nothing else. */
  revoke?: typeof revokeChutesToken;
}>;

type ApiKeyState = {
  kind: "inference-api-key";
  bearer: string;
  installedAt: number;
  revision: number;
};

type OAuthState = {
  kind: "oauth-user-token";
  bearer: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: readonly string[];
  installedAt: number;
  revision: number;
};

type CredentialState = ApiKeyState | OAuthState;

type RefreshTask = {
  state: OAuthState;
  revision: number;
  controller: AbortController;
  promise: Promise<void>;
};

/**
 * One page-memory authority for Chutes bearer material.
 *
 * Refresh tokens never leave this object except for the trusted token-endpoint
 * adapter. There is intentionally no token snapshot, export, persistence, or
 * serialization API. Create one broker per page/runtime and clear it on logout.
 */
export class ChutesCredentialBroker {
  #state?: CredentialState;
  #revision = 0;
  #refreshTask?: RefreshTask;
  readonly #retiredRefreshTokenDigests = new Set<string>();
  readonly #clientId: string;
  readonly #requiredOAuthScopes: readonly string[];
  readonly #minimumValidityMs: number;
  readonly #now: () => number;
  readonly #refresh: typeof refreshChutesOAuthToken;
  readonly #revoke: typeof revokeChutesToken;

  constructor(options: ChutesCredentialBrokerOptions = {}) {
    this.#clientId = validateClientId(options.clientId ?? CHUTES_LOCAL_REGISTRATION.clientId);
    this.#requiredOAuthScopes = normalizeScopes(
      options.requiredOAuthScopes ?? CHUTES_LOCAL_REGISTRATION.registrationScopes,
      "required OAuth scopes",
    );
    this.#minimumValidityMs = normalizeMinimumValidity(
      options.minimumValidityMs ?? DEFAULT_MINIMUM_VALIDITY_MS,
    );
    this.#now = options.now ?? Date.now;
    this.#refresh = options.refresh ?? refreshChutesOAuthToken;
    this.#revoke = options.revoke ?? revokeChutesToken;
  }

  metadata(): ChutesCredentialMetadata {
    const state = this.#state;
    if (!state) return Object.freeze({ status: "disconnected", revision: this.#revision });
    if (state.kind === "inference-api-key") {
      return Object.freeze({
        status: "connected",
        revision: state.revision,
        credentialKind: state.kind,
        installedAt: state.installedAt,
        scopes: Object.freeze([]) as readonly [],
        expiresAt: undefined,
        refreshable: false,
      });
    }
    return Object.freeze({
      status: "connected",
      revision: state.revision,
      credentialKind: state.kind,
      installedAt: state.installedAt,
      scopes: Object.freeze([...state.scopes]),
      expiresAt: state.expiresAt,
      refreshable: state.refreshToken !== undefined,
    });
  }

  installApiKey(rawCredential: string): ChutesCredentialMetadata {
    const parsed = parseChutesCredential(rawCredential);
    if (parsed.kind !== "inference-api-key") {
      throw new TypeError("The Chutes credential broker expected a cpk_ inference API key.");
    }
    const now = this.#readNow();
    this.#replaceState({
      kind: parsed.kind,
      bearer: parsed.value,
      installedAt: now,
      revision: this.#revision + 1,
    });
    return this.metadata();
  }

  installOAuthTokenSet(tokenSet: ChutesOAuthTokenSet): ChutesCredentialMetadata {
    const now = this.#readNow();
    const normalized = normalizeOAuthTokenSet(tokenSet, now);
    requireScopes(normalized.scopes, this.#requiredOAuthScopes);
    this.#replaceState({
      kind: "oauth-user-token",
      bearer: normalized.accessToken,
      ...(normalized.refreshToken ? { refreshToken: normalized.refreshToken } : {}),
      expiresAt: normalized.expiresAt,
      scopes: normalized.scopes,
      installedAt: now,
      revision: this.#revision + 1,
    });
    return this.metadata();
  }

  /**
   * Drop page-memory custody and ask the provider to drop the grant too.
   *
   * Dropping page memory alone leaves a refresh token that leaked through XSS
   * or an extension valid at the IdP for the rest of its lifetime. The
   * revocation is fired detached with its own deadline so teardown stays
   * synchronous and cannot be delayed or failed by the network; its outcome is
   * deliberately not reported as proof that the provider session ended.
   */
  clear(): ChutesCredentialMetadata {
    const released = this.#state;
    this.#replaceState(undefined);
    if (released?.kind === "oauth-user-token") {
      const clientId = this.#clientId;
      const revoke = this.#revoke;
      const tokens = [
        ...(released.refreshToken
          ? [{ token: released.refreshToken, tokenTypeHint: "refresh_token" as const }]
          : []),
        { token: released.bearer, tokenTypeHint: "access_token" as const },
      ];
      void (async () => {
        for (const entry of tokens) {
          await revoke({ ...entry, clientId }).catch(() => undefined);
        }
      })();
    }
    return this.metadata();
  }

  async getBearerToken(request: ChutesBearerRequest = {}): Promise<string> {
    throwIfAborted(request.signal);
    const requiredScopes = normalizeScopes(request.requiredScopes ?? [], "operation scopes");
    const minimumValidityMs = normalizeMinimumValidity(
      request.minimumValidityMs ?? this.#minimumValidityMs,
    );
    let state = this.#requireCompatibleState(request.expectedKind, requiredScopes);
    if (state.kind === "inference-api-key") return state.bearer;

    const now = this.#readNow();
    if (state.expiresAt <= now) {
      if (!state.refreshToken) {
        this.#invalidateIfCurrent(state);
        throw brokerError("expired", "The Chutes OAuth session expired and cannot be refreshed.");
      }
    } else if (state.expiresAt - now > minimumValidityMs) {
      return state.bearer;
    }

    if (!state.refreshToken) {
      throw brokerError("refresh-unavailable", "The Chutes OAuth session is too close to expiry and has no refresh grant.");
    }

    const task = this.#refreshTaskFor(state);
    await waitFor(task.promise, request.signal);

    // Every waiter revalidates its own kind, scopes, and lifetime against the
    // newly installed generation; the shared task never grants by implication.
    state = this.#requireCompatibleState(request.expectedKind, requiredScopes);
    if (state.kind !== "oauth-user-token") {
      throw brokerError("wrong-kind", "The Chutes credential changed class during OAuth refresh.");
    }
    if (state.expiresAt - this.#readNow() <= minimumValidityMs) {
      this.#invalidateIfCurrent(state);
      throw brokerError("expired", "The refreshed Chutes OAuth session has insufficient lifetime.");
    }
    return state.bearer;
  }

  #refreshTaskFor(state: OAuthState): RefreshTask {
    const existing = this.#refreshTask;
    if (existing && existing.state === state && existing.revision === state.revision) return existing;
    if (existing) {
      // A task for any other generation cannot be joined or allowed to commit.
      existing.controller.abort();
    }

    const controller = new AbortController();
    const task: RefreshTask = {
      state,
      revision: state.revision,
      controller,
      promise: Promise.resolve(),
    };
    task.promise = this.#rotateOAuth(task).finally(() => {
      if (this.#refreshTask === task) this.#refreshTask = undefined;
    });
    this.#refreshTask = task;
    return task;
  }

  async #rotateOAuth(task: RefreshTask): Promise<void> {
    const oldRefreshToken = task.state.refreshToken;
    if (!oldRefreshToken) {
      this.#invalidateIfCurrent(task.state);
      throw brokerError("refresh-unavailable", "The Chutes OAuth session has no refresh grant.");
    }

    let refreshed: ChutesOAuthTokenSet;
    try {
      refreshed = await this.#refresh({
        clientId: this.#clientId,
        refreshToken: oldRefreshToken,
        signal: task.controller.signal,
        now: this.#readNow(),
      });
    } catch {
      if (!this.#isCurrent(task.state, task.revision)) {
        throw brokerError("refresh-invalidated", "The Chutes OAuth refresh was invalidated by a newer credential state.");
      }
      this.#invalidateIfCurrent(task.state);
      throw brokerError("refresh-failed", "The Chutes OAuth refresh failed; the memory-only session was cleared.");
    }

    if (!this.#isCurrent(task.state, task.revision)) {
      throw brokerError("refresh-invalidated", "The Chutes OAuth refresh result belongs to a stale credential state.");
    }

    try {
      const now = this.#readNow();
      const normalized = normalizeOAuthTokenSet(refreshed, now);
      if (!normalized.refreshToken || normalized.refreshToken === oldRefreshToken) {
        throw new Error("Refresh-token rotation was not proved.");
      }
      const [oldRefreshTokenDigest, nextRefreshTokenDigest] = await Promise.all([
        sha256(oldRefreshToken),
        sha256(normalized.refreshToken),
      ]);
      if (!this.#isCurrent(task.state, task.revision)) {
        throw brokerError("refresh-invalidated", "The Chutes OAuth refresh result belongs to a stale credential state.");
      }
      if (
        nextRefreshTokenDigest === oldRefreshTokenDigest
        || this.#retiredRefreshTokenDigests.has(nextRefreshTokenDigest)
      ) {
        throw new Error("A retired refresh-token grant was replayed.");
      }
      requireScopes(normalized.scopes, this.#requiredOAuthScopes);
      if (normalized.expiresAt - now <= this.#minimumValidityMs) {
        throw new Error("The refreshed access token has insufficient lifetime.");
      }
      const nextRevision = this.#revision + 1;
      this.#state = {
        kind: "oauth-user-token",
        bearer: normalized.accessToken,
        refreshToken: normalized.refreshToken,
        expiresAt: normalized.expiresAt,
        scopes: normalized.scopes,
        installedAt: task.state.installedAt,
        revision: nextRevision,
      };
      this.#retiredRefreshTokenDigests.add(oldRefreshTokenDigest);
      this.#revision = nextRevision;
    } catch {
      if (!this.#isCurrent(task.state, task.revision)) {
        throw brokerError("refresh-invalidated", "The Chutes OAuth refresh result belongs to a stale credential state.");
      }
      this.#invalidateIfCurrent(task.state);
      throw brokerError("refresh-failed", "The Chutes OAuth refresh response failed closed; the memory-only session was cleared.");
    }
  }

  #requireCompatibleState(
    expectedKind: ChutesCredentialKind | undefined,
    requiredScopes: readonly string[],
  ): CredentialState {
    const state = this.#state;
    if (!state) throw brokerError("disconnected", "No Chutes credential is installed in page memory.");
    if (expectedKind && state.kind !== expectedKind) {
      throw brokerError("wrong-kind", "The installed Chutes credential is not authorized for this credential class.");
    }
    if (requiredScopes.length > 0) {
      if (state.kind !== "oauth-user-token") {
        throw brokerError("missing-scope", "An inference API key cannot satisfy OAuth scope requirements.");
      }
      requireScopes(state.scopes, requiredScopes);
    }
    return state;
  }

  #replaceState(state: CredentialState | undefined): void {
    const task = this.#refreshTask;
    this.#refreshTask = undefined;
    this.#revision += 1;
    this.#state = state ? { ...state, revision: this.#revision } : undefined;
    this.#retiredRefreshTokenDigests.clear();
    task?.controller.abort();
  }

  #invalidateIfCurrent(state: CredentialState): void {
    if (this.#state !== state) return;
    this.#replaceState(undefined);
  }

  #isCurrent(state: CredentialState, revision: number): boolean {
    return this.#state === state && this.#revision === revision && state.revision === revision;
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("The credential broker clock is invalid.");
    return now;
  }
}

function normalizeOAuthTokenSet(tokenSet: ChutesOAuthTokenSet, now: number): ChutesOAuthTokenSet {
  if (!tokenSet || typeof tokenSet !== "object") throw new TypeError("A Chutes OAuth token set is required.");
  const parsed = parseChutesCredential(tokenSet.accessToken);
  if (parsed.kind !== "oauth-user-token") {
    throw new TypeError("The Chutes OAuth token set must contain a cak_ access token.");
  }
  if (
    !Number.isSafeInteger(tokenSet.expiresAt)
    || tokenSet.expiresAt <= now
    || tokenSet.expiresAt - now > MAX_OAUTH_LIFETIME_MS
  ) {
    throw new TypeError("The Chutes OAuth token expiry is invalid.");
  }
  const scopes = normalizeScopes(tokenSet.scopes, "OAuth token scopes");
  const refreshToken = tokenSet.refreshToken === undefined
    ? undefined
    : normalizeRefreshToken(tokenSet.refreshToken);
  return Object.freeze({
    accessToken: parsed.value,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: tokenSet.expiresAt,
    scopes,
  });
}

function normalizeRefreshToken(value: string): string {
  if (
    typeof value !== "string"
    || !value.startsWith("crt_")
    || value.length <= 4
    || new TextEncoder().encode(value).byteLength > MAX_REFRESH_TOKEN_BYTES
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new TypeError("The Chutes OAuth refresh token is invalid.");
  }
  return value;
}

function normalizeScopes(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`The Chutes ${label} are invalid.`);
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const scope of values) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw new TypeError(`The Chutes ${label} are invalid.`);
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  }
  return Object.freeze(scopes);
}

function requireScopes(granted: readonly string[], required: readonly string[]): void {
  const available = new Set(granted);
  if (required.some((scope) => !available.has(scope))) {
    throw brokerError("missing-scope", "The Chutes OAuth grant is missing a required operation scope.");
  }
}

function normalizeMinimumValidity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MINIMUM_VALIDITY_MS) {
    throw new TypeError("The Chutes bearer minimum-validity window is invalid.");
  }
  return value;
}

function validateClientId(value: string): string {
  const clientId = value.trim();
  if (!/^cid_[A-Za-z0-9._~-]{3,256}$/u.test(clientId)) {
    throw new TypeError("The Chutes OAuth client ID is invalid.");
  }
  return clientId;
}

function brokerError(code: ChutesCredentialBrokerErrorCode, message: string): ChutesCredentialBrokerError {
  return new ChutesCredentialBrokerError(code, message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The credential request was aborted.", "AbortError");
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("The credential request was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
