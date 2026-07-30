import type { ProviderOAuthId } from "./registrations";
import { ProviderOAuthError } from "./transport";

/**
 * S256 PKCE primitives shared by every provider flow.
 *
 * `plain` is not implemented anywhere in this package: a downgrade has to be
 * impossible, not merely discouraged.
 */

/** 48 random bytes → a 64-character verifier, well above RFC 7636's 43 minimum. */
export const PKCE_VERIFIER_BYTES = 48;
/** 32 random bytes → a 43-character state value. */
export const PKCE_STATE_BYTES = 32;
/**
 * RFC 7636 §4.1's unreserved-character verifier.
 *
 * Exported because src/auth/chutes-oauth.ts — the one sign-in this build ships —
 * had re-spelled this regex inline, so tightening it here reached every provider
 * flow except the only one a user can actually run.
 */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const STATE_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/u;

export type PkceChallenge = Readonly<{
  verifier: string;
  challenge: string;
  method: "S256";
}>;

export type CryptoSource = Pick<Crypto, "getRandomValues" | "subtle">;

export async function createPkceChallenge(
  provider: ProviderOAuthId,
  cryptoSource: CryptoSource = globalThis.crypto,
): Promise<PkceChallenge> {
  requireCrypto(provider, cryptoSource);
  const verifier = randomBase64Url(PKCE_VERIFIER_BYTES, cryptoSource);
  const digest = await cryptoSource.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Object.freeze({
    verifier,
    challenge: bytesToBase64Url(new Uint8Array(digest)),
    method: "S256" as const,
  });
}

export function createOAuthState(
  provider: ProviderOAuthId,
  cryptoSource: CryptoSource = globalThis.crypto,
): string {
  requireCrypto(provider, cryptoSource);
  return randomBase64Url(PKCE_STATE_BYTES, cryptoSource);
}

export function requirePkceVerifier(value: string, provider: ProviderOAuthId): string {
  if (!PKCE_VERIFIER_PATTERN.test(value)) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider,
      message: "The PKCE verifier is not a valid RFC 7636 code verifier.",
    });
  }
  return value;
}

export function requireOAuthState(value: string, provider: ProviderOAuthId): string {
  if (!STATE_PATTERN.test(value)) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider,
      message: "The OAuth state value is invalid.",
    });
  }
  return value;
}

/**
 * Compare two states without leaking a match position through timing. Both values are
 * page-local here, but the comparison is cheap and the habit is what keeps it correct
 * if a state ever becomes attacker-supplied.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function requireCrypto(
  provider: ProviderOAuthId,
  cryptoSource: CryptoSource | undefined,
): asserts cryptoSource is CryptoSource {
  if (!cryptoSource?.getRandomValues || !cryptoSource.subtle) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider,
      message: "Web Crypto is required to start an OAuth sign-in.",
    });
  }
}

/**
 * Exported, rather than private, because Chutes sign-in had a byte-identical
 * copy of both of these and of `constantTimeEqual`. It also hardcoded 48 and 32
 * where the constants above are declared, so `PKCE_VERIFIER_BYTES` had no
 * importer at all and raising it would have hardened every flow except the
 * shipping one. The Chutes flow needs the primitives without the
 * `ProviderOAuthId`-shaped error type, so the primitives are what is shared.
 */
export function randomBase64Url(length: number, cryptoSource: Pick<Crypto, "getRandomValues">): string {
  const bytes = new Uint8Array(length);
  cryptoSource.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
