import {
  constantTimeEqual,
  createOAuthState,
  createPkceChallenge,
  requireOAuthState,
  requirePkceVerifier,
  type CryptoSource,
} from "./pkce";
import type { AuthorizationCodePkceRegistration } from "./registrations";
import { exchangeProviderTokenForm, type ProviderTokenSet } from "./token-set";
import { ProviderOAuthError, type ProviderOAuthTransport } from "./transport";

/**
 * Authorization code + S256 PKCE where the code is pasted back by hand.
 *
 * Neither registered redirect is served by Airship. OpenAI's
 * `http://localhost:1455/auth/callback` is not listening, so the browser stops on a
 * connection error with the code still in the address bar; Anthropic's console
 * callback renders the code on screen. Both end with the user copying something back
 * into the page, so the parser accepts every shape a user can plausibly paste rather
 * than demanding one.
 */

/**
 * The attempt lives longer than a redirect flow's would because a human has to switch
 * tabs, sign in, and copy a value. The provider still enforces its own, shorter code
 * lifetime, so this bound only stops a stale verifier from being reused.
 */
export const MAX_AUTHORIZATION_ATTEMPT_AGE_MS = 15 * 60 * 1_000;
const MAX_PASTE_LENGTH = 8 * 1_024;
const MAX_CODE_LENGTH = 4 * 1_024;
/** Printable ASCII only; the delimiters are stripped by the parser before this runs. */
const CODE_PATTERN = /^[!-~]{1,4096}$/u;
const CODE_DELIMITERS = /[#&?]/u;
const PASTED_STATE_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;

export type ProviderPkceAttempt = Readonly<{
  provider: AuthorizationCodePkceRegistration["provider"];
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}>;

export type PastedAuthorizationCode = Readonly<{
  code: string;
  /** Present only when the pasted value carried one; absence is reported, not faked. */
  state?: string;
  source: "redirect-url" | "query-fragment" | "code-and-state" | "bare-code";
  /**
   * `origin + pathname` of the address this was read out of, recorded for and
   * only for `source: "redirect-url"`.
   *
   * Parsing is deliberately not the place that decides whether the address was
   * the right one — it has no registration — so the address travels with the
   * code and `consumeProviderAuthorizationCode` compares it against the
   * registered callback. A code lifted from a look-alike page is then refused
   * before it is exchanged, instead of relying on PKCE and the state check to
   * make the paste harmless after the fact.
   */
  callbackUri?: string;
}>;

export type ProviderAuthorizationCode = Readonly<{
  provider: AuthorizationCodePkceRegistration["provider"];
  code: string;
  verifier: string;
  redirectUri: string;
  state: string;
  /**
   * Whether the pasted value actually carried a state that matched this attempt. A
   * bare code cannot be checked, and the UI must be able to say so instead of
   * implying a verification that never happened.
   */
  stateVerified: boolean;
}>;

export async function createProviderAuthorizationRequest(args: Readonly<{
  registration: AuthorizationCodePkceRegistration;
  now?: number;
  crypto?: CryptoSource;
}>): Promise<Readonly<{ url: URL; attempt: ProviderPkceAttempt }>> {
  const registration = args.registration;
  const cryptoSource = args.crypto ?? globalThis.crypto;
  const pkce = await createPkceChallenge(registration.provider, cryptoSource);
  const state = createOAuthState(registration.provider, cryptoSource);

  const url = new URL(registration.authorizationEndpoint);
  for (const [key, value] of Object.entries(registration.authorizationParameters)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration.clientId);
  url.searchParams.set("redirect_uri", registration.redirectUri);
  url.searchParams.set("scope", registration.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);

  return Object.freeze({
    url,
    attempt: Object.freeze({
      provider: registration.provider,
      state,
      verifier: pkce.verifier,
      redirectUri: registration.redirectUri,
      createdAt: args.now ?? Date.now(),
    }),
  });
}

/**
 * Accept a full redirect URL, a `code=…` fragment, a `code#state` pair, or a bare
 * code. Anything else fails closed rather than being guessed at.
 */
export function parsePastedAuthorizationCode(
  raw: string,
  provider: AuthorizationCodePkceRegistration["provider"],
): PastedAuthorizationCode {
  if (typeof raw !== "string") throw invalidPaste(provider, "no value was pasted");
  const value = raw.trim();
  if (!value) throw invalidPaste(provider, "no value was pasted");
  if (value.length > MAX_PASTE_LENGTH) throw invalidPaste(provider, "the pasted value is too long");
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidPaste(provider, "the pasted value contains control characters");
  }

  if (/^https?:\/\//iu.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalidPaste(provider, "the pasted address could not be read");
    }
    // A provider may answer on the query string or on the fragment; the fragment is
    // read only when the query carries nothing, so a query answer always wins.
    const fromQuery = readCodeParameters(url.searchParams, provider);
    const fromFragment = readCodeParameters(
      new URLSearchParams(url.hash.replace(/^#/u, "")),
      provider,
    );
    const found = fromQuery ?? fromFragment;
    if (!found) throw invalidPaste(provider, "that address contains no authorization code");
    return freezeParsed(
      provider,
      found.code,
      found.state,
      "redirect-url",
      `${url.origin}${url.pathname}`,
    );
  }

  if (/(^|[?#&])code=/u.test(value)) {
    const found = readCodeParameters(
      new URLSearchParams(value.replace(/^[?#]/u, "")),
      provider,
    );
    if (!found) throw invalidPaste(provider, "that fragment contains no authorization code");
    return freezeParsed(provider, found.code, found.state, "query-fragment");
  }

  // Anthropic's console renders `code#state`; splitting on the first `#` keeps the
  // state available for verification instead of discarding it as part of the code.
  const separator = value.indexOf("#");
  if (separator > 0) {
    return freezeParsed(
      provider,
      value.slice(0, separator),
      value.slice(separator + 1),
      "code-and-state",
    );
  }
  return freezeParsed(provider, value, undefined, "bare-code");
}

/**
 * Bind a pasted code to the attempt that started it: bounded age, state verified
 * whenever one was supplied, and the verifier returned for the exchange.
 */
export function consumeProviderAuthorizationCode(args: Readonly<{
  registration: AuthorizationCodePkceRegistration;
  attempt: ProviderPkceAttempt;
  pasted: string | PastedAuthorizationCode;
  now?: number;
  maxAgeMs?: number;
}>): ProviderAuthorizationCode {
  const registration = args.registration;
  const attempt = args.attempt;
  if (attempt.provider !== registration.provider) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider: registration.provider,
      message: "The pending sign-in belongs to a different provider.",
    });
  }
  const now = args.now ?? Date.now();
  const maxAgeMs = args.maxAgeMs ?? MAX_AUTHORIZATION_ATTEMPT_AGE_MS;
  if (now < attempt.createdAt || now - attempt.createdAt > maxAgeMs) {
    throw new ProviderOAuthError({
      code: "authorization-expired",
      provider: registration.provider,
      message: `The ${registration.displayName} sign-in attempt expired. Start it again.`,
    });
  }
  const state = requireOAuthState(attempt.state, registration.provider);
  const verifier = requirePkceVerifier(attempt.verifier, registration.provider);
  const pasted = typeof args.pasted === "string"
    ? parsePastedAuthorizationCode(args.pasted, registration.provider)
    : args.pasted;
  // A whole address was pasted, so the address itself is evidence and is
  // checked. PKCE and the state comparison below already make a code from a
  // foreign page useless, but they only do so *after* it has been sent to the
  // token endpoint; this refuses the paste before that, which is the difference
  // between a mitigated phish and one that never started. The check runs on the
  // parsed value rather than inside the parser so that a caller which parsed
  // separately cannot skip it.
  if (pasted.source === "redirect-url") {
    const expected = registeredCallback(registration);
    if (pasted.callbackUri !== expected) {
      throw new ProviderOAuthError({
        code: "invalid-input",
        provider: registration.provider,
        // The registered callback is compiled-in and safe to name; the pasted
        // address is not repeated back, because it carries the code.
        message: `That address is not the registered ${registration.displayName} callback (${expected}), so the code in it was not sent anywhere.`,
      });
    }
  }
  if (pasted.state !== undefined && !constantTimeEqual(pasted.state, state)) {
    throw new ProviderOAuthError({
      code: "state-mismatch",
      provider: registration.provider,
      message: `The ${registration.displayName} authorization state did not match this sign-in attempt.`,
    });
  }
  return Object.freeze({
    provider: registration.provider,
    code: pasted.code,
    verifier,
    redirectUri: attempt.redirectUri,
    state,
    stateVerified: pasted.state !== undefined,
  });
}

/** Exchange the bound code for a token set over the injected transport. */
export async function exchangeProviderAuthorizationCode(args: Readonly<{
  registration: AuthorizationCodePkceRegistration;
  authorization: ProviderAuthorizationCode;
  transport: ProviderOAuthTransport;
  now?: number;
  signal?: AbortSignal;
}>): Promise<ProviderTokenSet> {
  const registration = args.registration;
  if (args.authorization.provider !== registration.provider) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider: registration.provider,
      message: "The authorization code belongs to a different provider.",
    });
  }
  if (args.authorization.redirectUri !== registration.redirectUri) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider: registration.provider,
      message: "The authorization redirect does not match the registered callback.",
    });
  }
  return await exchangeProviderTokenForm({
    registration,
    form: {
      grant_type: "authorization_code",
      code: args.authorization.code,
      redirect_uri: registration.redirectUri,
      client_id: registration.clientId,
      code_verifier: args.authorization.verifier,
      // Anthropic validates the state on the token call as well; providers that do
      // not expect it must not receive an unexpected parameter.
      ...(registration.echoStateInTokenRequest ? { state: args.authorization.state } : {}),
    },
    transport: args.transport,
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

/**
 * The registered callback reduced to the two parts a pasted address can be
 * compared on. Query and fragment are where the answer lives, so they are not
 * part of the identity; scheme, host, port and path are.
 */
function registeredCallback(registration: AuthorizationCodePkceRegistration): string {
  let parsed: URL;
  try {
    parsed = new URL(registration.redirectUri);
  } catch {
    throw new ProviderOAuthError({
      code: "configuration",
      provider: registration.provider,
      message: `The ${registration.displayName} registration has no readable redirect URI.`,
    });
  }
  return `${parsed.origin}${parsed.pathname}`;
}

function readCodeParameters(
  parameters: URLSearchParams,
  provider: AuthorizationCodePkceRegistration["provider"],
): Readonly<{ code: string; state?: string }> | undefined {
  const error = parameters.get("error");
  if (error) {
    const safe = /^[a-z][a-z0-9_-]{2,63}$/u.test(error) ? error : "provider_error";
    throw new ProviderOAuthError({
      code: "provider-error",
      provider,
      message: `Authorization failed at the provider (${safe}).`,
      providerCode: safe,
    });
  }
  const code = parameters.get("code")?.trim();
  if (!code) return undefined;
  const state = parameters.get("state")?.trim();
  return state ? { code, state } : { code };
}

function freezeParsed(
  provider: AuthorizationCodePkceRegistration["provider"],
  rawCode: string,
  rawState: string | undefined,
  source: PastedAuthorizationCode["source"],
  callbackUri?: string,
): PastedAuthorizationCode {
  const callback = callbackUri === undefined ? {} : { callbackUri };
  const code = rawCode.trim();
  if (
    code.length === 0
    || code.length > MAX_CODE_LENGTH
    || !CODE_PATTERN.test(code)
    || CODE_DELIMITERS.test(code)
  ) {
    throw invalidPaste(provider, "the authorization code is not in a usable format");
  }
  const state = rawState?.trim();
  if (state !== undefined && state.length > 0) {
    // A pasted state is only checked for shape here. Whether it is *our* state is
    // decided by the constant-time comparison in `consumeProviderAuthorizationCode`,
    // so a wrong value is reported as a mismatch rather than as a malformed paste.
    if (!PASTED_STATE_PATTERN.test(state)) {
      throw invalidPaste(provider, "the returned state is not in a usable format");
    }
    return Object.freeze({ code, state, source, ...callback });
  }
  return Object.freeze({ code, source, ...callback });
}

function invalidPaste(
  provider: AuthorizationCodePkceRegistration["provider"],
  reason: string,
): ProviderOAuthError {
  return new ProviderOAuthError({
    code: "invalid-input",
    provider,
    // The pasted value is never quoted back: it is, or contains, a one-time code.
    message: `The pasted authorization value could not be used because ${reason}.`,
  });
}
