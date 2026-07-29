const CHUTES_REGISTRATION_SCOPES = ["profile", "chutes:invoke", "billing:read"] as const;
const CHUTES_REQUEST_SCOPES = ["openid", ...CHUTES_REGISTRATION_SCOPES] as const;

export type ChutesOAuthRegistration = Readonly<{
  name: string;
  clientId: string;
  description: string;
  homepageUrl: string;
  redirectUris: readonly string[];
  registrationScopes: readonly string[];
  scopes: readonly string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  public: boolean;
  refreshTokenLifetimeDays: number;
  configured: boolean;
  configurationError?: string;
}>;

export type ChutesOAuthExchangeMode = "local-confidential-bridge" | "public-pkce";

export const CHUTES_LOCAL_REGISTRATION: ChutesOAuthRegistration = Object.freeze({
  name: "Airship",
  clientId: "cid_n2tusjazqmkkwon12jy3bo3u",
  description: "Private, browser-native agent runtime with encrypted Chutes inference.",
  homepageUrl: "http://localhost:4173",
  redirectUris: ["http://localhost:4173/auth/chutes/callback"] as const,
  registrationScopes: CHUTES_REGISTRATION_SCOPES,
  scopes: CHUTES_REQUEST_SCOPES,
  // Chutes production currently registers this localhost app as confidential.
  // The browser still creates and proves S256 PKCE; the same-origin Vite
  // handler adds the process-held secret during token operations. The secret
  // is never compiled into, returned to, or accepted from browser JavaScript.
  tokenEndpointAuthMethod: "client_secret_post" as "none" | "client_secret_post",
  // `public` is Chutes directory visibility, not OAuth client authentication.
  public: true,
  refreshTokenLifetimeDays: 30,
  configured: true,
});

/** Resolve public registration metadata without embedding a production secret. */
export function resolveChutesOAuthRegistration(args: Readonly<{
  development: boolean;
  publicClientId?: string;
  publicOrigin?: string;
  publicBasePath?: string;
}>): ChutesOAuthRegistration {
  if (args.development) return CHUTES_LOCAL_REGISTRATION;
  const clientId = args.publicClientId?.trim() ?? "";
  const origin = normalizePublicOrigin(args.publicOrigin);
  const basePath = normalizePublicBasePath(args.publicBasePath);
  const errors: string[] = [];
  if (!/^cid_[A-Za-z0-9._~-]{3,256}$/u.test(clientId)) {
    errors.push("VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID must identify a Chutes Browser/native PKCE app");
  }
  if (!origin) errors.push("VITE_AIRSHIP_PUBLIC_ORIGIN must be an exact HTTPS origin");
  if (!basePath) errors.push("the production base path must be an absolute URL path");
  const configured = errors.length === 0;
  const homepageUrl = origin && basePath
    ? basePath === "/" ? origin : `${origin}${basePath}`
    : "";
  return Object.freeze({
    name: "Airship",
    clientId,
    description: "Private, browser-native agent runtime with encrypted Chutes inference.",
    homepageUrl,
    redirectUris: origin && basePath
      ? Object.freeze([`${origin}${basePath}auth/chutes/callback`])
      : Object.freeze([]),
    registrationScopes: CHUTES_REGISTRATION_SCOPES,
    scopes: CHUTES_REQUEST_SCOPES,
    tokenEndpointAuthMethod: "none",
    public: true,
    refreshTokenLifetimeDays: 30,
    configured,
    ...(configured ? {} : { configurationError: `Production Chutes sign-in is disabled: ${errors.join("; ")}.` }),
  });
}

export const CHUTES_ACTIVE_REGISTRATION = resolveChutesOAuthRegistration({
  development: import.meta.env.DEV,
  publicClientId: import.meta.env.VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID,
  publicOrigin: import.meta.env.VITE_AIRSHIP_PUBLIC_ORIGIN,
  publicBasePath: import.meta.env.BASE_URL,
});

/** Validate the registered origin and deployment base path. */
export function chutesOAuthLocationState(
  homepageUrl: string,
  currentLocation: string,
): Readonly<{ available: boolean; reason?: string }> {
  try {
    const homepage = new URL(homepageUrl);
    const current = new URL(currentLocation);
    if (homepage.origin !== current.origin) {
      return { available: false, reason: `Sign-in is registered for ${homepage.origin}. Open Airship there before continuing.` };
    }
    const homepagePath = homepage.pathname === "/" ? "/" : homepage.pathname.replace(/\/+$/u, "");
    const pathMatches = homepagePath === "/"
      || current.pathname === homepagePath
      || current.pathname.startsWith(`${homepagePath}/`);
    if (!pathMatches) {
      return { available: false, reason: `Sign-in is registered for ${homepage.href}. Open that Airship deployment before continuing.` };
    }
    return { available: true };
  } catch {
    return { available: false, reason: "The configured OAuth homepage is invalid; sign-in remains disabled." };
  }
}

/** Resolve the honest token boundary for this registration. */
export function chutesOAuthExchangeMode(
  registration: ChutesOAuthRegistration,
): ChutesOAuthExchangeMode {
  if (registration.tokenEndpointAuthMethod === "none") return "public-pkce";
  if (registration === CHUTES_LOCAL_REGISTRATION) return "local-confidential-bridge";
  throw new Error("Confidential Chutes OAuth is supported only by Airship's localhost handler.");
}

function normalizePublicOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function normalizePublicBasePath(value: string | undefined): string | undefined {
  const candidate = value?.trim() || "/";
  if (!candidate.startsWith("/") || candidate.includes("?") || candidate.includes("#")) return undefined;
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}
