/**
 * A Google OAuth *Web* client ID. It is a public deployment identifier, never
 * a secret. Build-time default selection and runtime authorizer construction
 * share this predicate so an unreachable Drive provider cannot be selected.
 */
const GOOGLE_OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{12,256}\.apps\.googleusercontent\.com$/u;

export function isDeployableGoogleOAuthClientId(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const clientId = value.trim();
  // Bound before the regex so a pathological build-time value cannot be scanned.
  return clientId.length <= 512 && GOOGLE_OAUTH_CLIENT_ID_PATTERN.test(clientId);
}
