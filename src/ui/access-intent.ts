/**
 * The only URL-carried instruction the Connection route accepts.
 *
 * Credentials never travel here. The values are bounded navigation hints plus
 * the opaque conversation address to re-check after an authority is installed.
 * A caller must still prove that the live provider route exactly resolves the
 * conversation's immutable pin before it may resume it.
 */
export const CONNECT_LANE_IDS = Object.freeze([
  "chutes",
  "codex",
  "claude",
  "grok",
  "local",
  "companion",
] as const);

export type ConnectLaneId = (typeof CONNECT_LANE_IDS)[number];
export type AccessReconnectMethod = "oauth-pkce" | "api-key" | "local-none";

export type AccessReconnectIntent = Readonly<{
  lane: ConnectLaneId;
  method: AccessReconnectMethod;
  model: string;
  connectionId: string;
  connectionGeneration: number;
  returnSessionId: string;
}>;

export type ReconnectRouteDisposition = "exact" | "replacement" | "unrelated";

export type HeldReconnectRoute = Readonly<{
  lane?: ConnectLaneId;
  method: AccessReconnectMethod;
  model: string;
  connectionId: string;
  connectionGeneration: number;
}>;

const ACCESS_ROUTES = Object.freeze(new Set(["access", "connection"]));
const ACCESS_METHODS = Object.freeze(new Set<AccessReconnectMethod>([
  "oauth-pkce",
  "api-key",
  "local-none",
]));
const ACCESS_PARAMETERS = Object.freeze(new Set([
  "lane",
  "method",
  "model",
  "connection",
  "generation",
  "return",
]));
const MAX_MODEL_ID_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 512;

/** Canonical address for a validated reconnect instruction. */
export function accessReconnectHash(intent: AccessReconnectIntent): string {
  const normalized = validateAccessReconnectIntent(intent);
  const parameters = new URLSearchParams({
    lane: normalized.lane,
    method: normalized.method,
    model: normalized.model,
    connection: normalized.connectionId,
    generation: String(normalized.connectionGeneration),
    return: normalized.returnSessionId,
  });
  return `#connection?${parameters.toString()}`;
}

/**
 * Parses only one complete, unambiguous reconnect instruction.
 *
 * Unknown, duplicate, missing, or malformed fields reduce to no instruction;
 * the Connection route remains usable, but no later provider activation can be
 * redirected by a partly understood URL.
 */
export function parseAccessReconnectIntent(hash: string): AccessReconnectIntent | undefined {
  const withoutHash = hash.replace(/^#/u, "");
  const separator = withoutHash.indexOf("?");
  if (separator < 0 || withoutHash.indexOf("?", separator + 1) >= 0) return undefined;
  if (!ACCESS_ROUTES.has(withoutHash.slice(0, separator))) return undefined;
  const parameters = new URLSearchParams(withoutHash.slice(separator + 1));
  if ([...parameters.keys()].some((key) => !ACCESS_PARAMETERS.has(key))) return undefined;
  for (const key of ACCESS_PARAMETERS) {
    if (parameters.getAll(key).length > 1) return undefined;
  }
  const lane = parameters.get("lane");
  const method = parameters.get("method");
  const model = boundedText(parameters.get("model"), MAX_MODEL_ID_LENGTH);
  const connectionId = boundedConnectionId(parameters.get("connection"));
  const connectionGeneration = positiveGeneration(parameters.get("generation"));
  const returnSessionId = addressableSessionId(parameters.get("return"));
  if (
    !isConnectLaneId(lane)
    || method === null
    || !isAccessReconnectMethod(method)
    || !model
    || !connectionId
    || connectionGeneration === undefined
    || !returnSessionId
  ) return undefined;
  return Object.freeze({
    lane,
    method,
    model,
    connectionId,
    connectionGeneration,
    returnSessionId,
  });
}

/** Canonicalizes a legacy `#access` link without dropping a valid instruction. */
export function canonicalAccessHash(hash: string): string {
  const intent = parseAccessReconnectIntent(hash);
  return intent ? accessReconnectHash(intent) : "#connection";
}

/** The Connection lane that owns a provider/transport identifier. */
export function accessLaneForProvider(providerId: string): ConnectLaneId | undefined {
  const normalized = providerId.trim().toLowerCase();
  if (!normalized || normalized.length > 256) return undefined;
  if (/^chutes(?:[^a-z0-9]|$)/u.test(normalized)) return "chutes";
  if (/^(?:openai|codex)(?:[^a-z0-9]|$)/u.test(normalized)) return "codex";
  if (/^(?:anthropic|claude)(?:[^a-z0-9]|$)/u.test(normalized)) return "claude";
  if (/^(?:xai|grok)(?:[^a-z0-9]|$)/u.test(normalized)) return "grok";
  if (/^(?:ollama|lm-studio|local)(?:[^a-z0-9]|$)/u.test(normalized)) return "local";
  return undefined;
}

export function reconnectMethodTab(method?: AccessReconnectMethod): "oauth" | "api-key" | undefined {
  if (method === "oauth-pkce") return "oauth";
  if (method === "api-key") return "api-key";
  return undefined;
}

/**
 * Classifies a held route without weakening the session-layer proof.
 *
 * `exact` is only an affordance decision: the journal/profile/audit/head
 * checks still run before continuation. A same-lane route with any different
 * immutable field is a replacement, never a continuation candidate.
 */
export function reconnectRouteDisposition(
  intent: AccessReconnectIntent,
  route: HeldReconnectRoute,
): ReconnectRouteDisposition {
  if (route.lane !== intent.lane) return "unrelated";
  return route.method === intent.method
    && route.model === intent.model
    && route.connectionId === intent.connectionId
    && route.connectionGeneration === intent.connectionGeneration
    ? "exact"
    : "replacement";
}

/** Exact equality for the URL instruction that still owns a return transaction. */
export function reconnectIntentsEqual(
  left: AccessReconnectIntent | undefined,
  right: AccessReconnectIntent | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.lane === right.lane
    && left.method === right.method
    && left.model === right.model
    && left.connectionId === right.connectionId
    && left.connectionGeneration === right.connectionGeneration
    && left.returnSessionId === right.returnSessionId;
}

function validateAccessReconnectIntent(intent: AccessReconnectIntent): AccessReconnectIntent {
  if (!isConnectLaneId(intent.lane)) throw new TypeError("The reconnect lane is invalid.");
  if (!isAccessReconnectMethod(intent.method)) {
    throw new TypeError("The reconnect authentication method is invalid.");
  }
  const model = boundedText(intent.model, MAX_MODEL_ID_LENGTH);
  const connectionId = boundedConnectionId(intent.connectionId);
  const connectionGeneration = positiveGeneration(intent.connectionGeneration);
  const returnSessionId = addressableSessionId(intent.returnSessionId);
  if (!model) throw new TypeError("The reconnect model is invalid.");
  if (!connectionId) throw new TypeError("The reconnect connection is invalid.");
  if (connectionGeneration === undefined) throw new TypeError("The reconnect connection generation is invalid.");
  if (!returnSessionId) throw new TypeError("The reconnect conversation is invalid.");
  return Object.freeze({
    lane: intent.lane,
    method: intent.method,
    model,
    connectionId,
    connectionGeneration,
    returnSessionId,
  });
}

function isConnectLaneId(value: unknown): value is ConnectLaneId {
  return typeof value === "string" && (CONNECT_LANE_IDS as readonly string[]).includes(value);
}

function isAccessReconnectMethod(value: string): value is AccessReconnectMethod {
  return ACCESS_METHODS.has(value as AccessReconnectMethod);
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function addressableSessionId(value: unknown): string | undefined {
  const bounded = boundedText(value, MAX_SESSION_ID_LENGTH);
  return bounded && !/[/?#]/u.test(bounded) ? bounded : undefined;
}

function boundedConnectionId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:/-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function positiveGeneration(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
