/**
 * The only URL-carried instruction the Connection route accepts.
 *
 * Credentials and endpoint URLs never travel here. The values are bounded
 * navigation hints plus the opaque conversation address to re-check after an
 * authority is installed. A caller must still resolve the journal's immutable
 * provider and connection pin before it may resume the conversation.
 */
export type AccessReconnectMethod = "oauth-pkce" | "api-key" | "local-none";

export type AccessReconnectIntent = Readonly<{
  providerId: string;
  method: AccessReconnectMethod;
  model: string;
  connectionId: string;
  connectionGeneration: number;
  returnSessionId: string;
}>;

export type ReconnectRouteDisposition = "exact" | "replacement" | "unrelated";

export type HeldReconnectRoute = Readonly<{
  providerId?: string;
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
const ACCESS_PARAMETER_ALIASES = Object.freeze({
  providerId: ["providerId", "provider"],
  method: ["method"],
  model: ["model"],
  connectionId: ["connectionId", "connection"],
  connectionGeneration: ["connectionGeneration", "generation"],
  returnSessionId: ["returnSessionId", "return"],
} as const);
const LEGACY_LANE_PARAMETER = "lane";
const ACCESS_PARAMETERS: ReadonlySet<string> = Object.freeze(new Set([
  ...Object.values(ACCESS_PARAMETER_ALIASES).flat(),
  LEGACY_LANE_PARAMETER,
]));
const LEGACY_PROVIDER_IDS = Object.freeze(new Map<string, string>([
  ["codex", "openai"],
  ["claude", "anthropic"],
  ["grok", "xai"],
  ["chutes", "chutes"],
  ["companion", "companion"],
]));
const MAX_MODEL_ID_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 512;
const AMBIGUOUS_PARAMETER = Symbol("ambiguous access parameter");

/** Canonical address for a validated reconnect instruction. */
export function accessReconnectHash(intent: AccessReconnectIntent): string {
  const normalized = validateAccessReconnectIntent(intent);
  const parameters = new URLSearchParams({
    providerId: normalized.providerId,
    method: normalized.method,
    model: normalized.model,
    connectionId: normalized.connectionId,
    connectionGeneration: String(normalized.connectionGeneration),
    returnSessionId: normalized.returnSessionId,
  });
  return `#connection?${parameters.toString()}`;
}

/**
 * Parses only one complete, unambiguous reconnect instruction.
 *
 * Unknown, duplicate, missing, or malformed fields reduce to no instruction;
 * the Connection route remains usable, but no provider activation can be
 * redirected by a partly understood URL. Legacy vendor lanes are accepted
 * only when they identify one provider. The old `local` lane fails closed
 * because it cannot distinguish Ollama, LM Studio, or a custom endpoint.
 */
export function parseAccessReconnectIntent(hash: string): AccessReconnectIntent | undefined {
  const withoutHash = hash.replace(/^#/u, "");
  const separator = withoutHash.indexOf("?");
  if (separator < 0 || withoutHash.indexOf("?", separator + 1) >= 0) return undefined;
  if (!ACCESS_ROUTES.has(withoutHash.slice(0, separator))) return undefined;
  const parameters = new URLSearchParams(withoutHash.slice(separator + 1));
  if ([...parameters.keys()].some((key) => !ACCESS_PARAMETERS.has(key))) return undefined;

  const currentProvider = uniqueParameter(parameters, ACCESS_PARAMETER_ALIASES.providerId);
  const legacyLane = uniqueParameter(parameters, [LEGACY_LANE_PARAMETER]);
  const method = uniqueParameter(parameters, ACCESS_PARAMETER_ALIASES.method);
  const modelValue = uniqueParameter(parameters, ACCESS_PARAMETER_ALIASES.model);
  const connectionIdValue = uniqueParameter(parameters, ACCESS_PARAMETER_ALIASES.connectionId);
  const generationValue = uniqueParameter(parameters, ACCESS_PARAMETER_ALIASES.connectionGeneration);
  const returnSessionIdValue = uniqueParameter(parameters, ACCESS_PARAMETER_ALIASES.returnSessionId);
  if (
    currentProvider === AMBIGUOUS_PARAMETER
    || legacyLane === AMBIGUOUS_PARAMETER
    || method === AMBIGUOUS_PARAMETER
    || modelValue === AMBIGUOUS_PARAMETER
    || connectionIdValue === AMBIGUOUS_PARAMETER
    || generationValue === AMBIGUOUS_PARAMETER
    || returnSessionIdValue === AMBIGUOUS_PARAMETER
    || (currentProvider !== null && legacyLane !== null)
  ) return undefined;

  const providerId = currentProvider !== null
    ? boundedProviderId(currentProvider)
    : legacyLane !== null
      ? boundedProviderId(LEGACY_PROVIDER_IDS.get(legacyLane) ?? "")
      : undefined;
  const model = boundedText(modelValue, MAX_MODEL_ID_LENGTH);
  const connectionId = boundedConnectionId(connectionIdValue);
  const connectionGeneration = positiveGeneration(generationValue);
  const returnSessionId = addressableSessionId(returnSessionIdValue);
  if (
    !providerId
    || method === null
    || !isAccessReconnectMethod(method)
    || !model
    || !connectionId
    || connectionGeneration === undefined
    || !returnSessionId
  ) return undefined;
  return Object.freeze({
    providerId,
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

export function reconnectMethodTab(method?: AccessReconnectMethod): "oauth" | "api-key" | undefined {
  if (method === "oauth-pkce") return "oauth";
  if (method === "api-key") return "api-key";
  return undefined;
}

/**
 * Classifies a held route without weakening the exact session authority match.
 *
 * `exact` is only an affordance decision: the journal/profile/integrity/head
 * checks still run before continuation. A same-provider route with any
 * different immutable field is a replacement, never a continuation candidate.
 */
export function reconnectRouteDisposition(
  intent: AccessReconnectIntent,
  route: HeldReconnectRoute,
): ReconnectRouteDisposition {
  if (route.providerId !== intent.providerId) return "unrelated";
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
    && left.providerId === right.providerId
    && left.method === right.method
    && left.model === right.model
    && left.connectionId === right.connectionId
    && left.connectionGeneration === right.connectionGeneration
    && left.returnSessionId === right.returnSessionId;
}

function validateAccessReconnectIntent(intent: AccessReconnectIntent): AccessReconnectIntent {
  const providerId = boundedProviderId(intent.providerId);
  if (!providerId) throw new TypeError("The reconnect provider is invalid.");
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
    providerId,
    method: intent.method,
    model,
    connectionId,
    connectionGeneration,
    returnSessionId,
  });
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

function boundedProviderId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:/-]{0,127}$/u.test(value)
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

function uniqueParameter(
  parameters: URLSearchParams,
  aliases: readonly string[],
): string | null | typeof AMBIGUOUS_PARAMETER {
  const values = aliases.flatMap((alias) => parameters.getAll(alias));
  if (values.length > 1) return AMBIGUOUS_PARAMETER;
  return values[0] ?? null;
}
