import type { SecurityPosture } from "../core/contracts";

const MAX_CHUTES_CREDENTIAL_LENGTH = 16 * 1_024;

export const CHUTES_CAPABILITIES = ["identity", "account", "billing", "invoke"] as const;

export type ChutesCapability = (typeof CHUTES_CAPABILITIES)[number];
export type ChutesCredentialKind = "oauth-user-token" | "inference-api-key";
export type ChutesConnectionKind = "disconnected" | "chutes-oauth" | "chutes-api-key";

/** Short-lived return value. Keep it in a local variable/ref and never serialize it. */
export type EphemeralChutesCredential = Readonly<{
  kind: ChutesCredentialKind;
  value: string;
}>;

export type DisconnectedConnection = Readonly<{
  version: 1;
  kind: "disconnected";
}>;

type ActiveChutesConnectionBase = Readonly<{
  version: 1;
  provider: "chutes";
  model: string;
  connectedAt: string;
  posture: Extract<SecurityPosture, "encrypted-unattested" | "encrypted-attested">;
  source: "manual-import";
  /** Proved only by a successful protected invocation, never by key shape or public discovery. */
  invokeAuthorization: "unverified" | "verified";
  lastInvokeAt?: string;
}>;

export type ChutesOAuthConnection = ActiveChutesConnectionBase & Readonly<{
  kind: "chutes-oauth";
  credentialKind: "oauth-user-token";
}>;

export type ChutesApiKeyConnection = ActiveChutesConnectionBase & Readonly<{
  kind: "chutes-api-key";
  credentialKind: "inference-api-key";
}>;

export type ActiveChutesConnection = ChutesOAuthConnection | ChutesApiKeyConnection;
export type ChutesConnection = DisconnectedConnection | ActiveChutesConnection;

export type ConnectionCapabilities = Readonly<Record<ChutesCapability, boolean>>;

export type CapabilityMatrixRow = Readonly<{
  capability: ChutesCapability;
  label: string;
  oauth: boolean;
  apiKey: boolean;
  detail: string;
}>;

/**
 * Client capabilities exposed by current Chutes credentials. Chutes remains
 * authoritative and can reject any operation for a particular key.
 */
export const CHUTES_CAPABILITY_MATRIX: readonly CapabilityMatrixRow[] = Object.freeze([
  Object.freeze({
    capability: "identity",
    label: "Identity",
    oauth: true,
    apiKey: true,
    detail: "User identity and profile surfaces.",
  }),
  Object.freeze({
    capability: "account",
    label: "Account",
    oauth: true,
    apiKey: true,
    detail: "Self-service account standing and quota reads.",
  }),
  Object.freeze({
    capability: "billing",
    label: "Billing read",
    oauth: true,
    apiKey: true,
    detail: "Balance, subscription, and usage telemetry; never payment mutation.",
  }),
  Object.freeze({
    capability: "invoke",
    label: "Inference",
    oauth: true,
    apiKey: true,
    detail: "Model discovery and invocation, subject to provider scope and balance.",
  }),
]);

export const DISCONNECTED_CHUTES_CONNECTION: DisconnectedConnection = Object.freeze({
  version: 1,
  kind: "disconnected",
});

export function parseChutesCredential(rawValue: string): EphemeralChutesCredential {
  if (typeof rawValue !== "string") throw new TypeError("A Chutes credential is required.");
  const value = rawValue.trim();
  if (!value) throw new TypeError("A Chutes credential is required.");
  if (value.length > MAX_CHUTES_CREDENTIAL_LENGTH || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError("The Chutes credential has an invalid format.");
  }
  const kind = value.startsWith("cak_")
    ? "oauth-user-token"
    : value.startsWith("cpk_")
      ? "inference-api-key"
      : undefined;
  if (!kind) {
    throw new TypeError("Use a cak_ Chutes OAuth user token or a cpk_ inference API key.");
  }
  if (value.length === 4) throw new TypeError("The Chutes credential is incomplete.");
  return Object.freeze({ kind, value });
}

export function createChutesConnection(args: Readonly<{
  credentialKind: ChutesCredentialKind;
  model: string;
  posture: ActiveChutesConnection["posture"];
  connectedAt?: string;
}>): ActiveChutesConnection {
  const model = boundedValue(args.model, "Chutes model", 512);
  const connectedAt = canonicalTimestamp(args.connectedAt ?? new Date().toISOString());
  if (args.posture !== "encrypted-unattested" && args.posture !== "encrypted-attested") {
    throw new TypeError("The Chutes transport posture is invalid.");
  }
  if (args.credentialKind === "oauth-user-token") {
    return Object.freeze({
      version: 1,
      kind: "chutes-oauth",
      credentialKind: args.credentialKind,
      provider: "chutes",
      model,
      posture: args.posture,
      source: "manual-import",
      invokeAuthorization: "unverified",
      connectedAt,
    });
  }
  if (args.credentialKind === "inference-api-key") {
    return Object.freeze({
      version: 1,
      kind: "chutes-api-key",
      credentialKind: args.credentialKind,
      provider: "chutes",
      model,
      posture: args.posture,
      source: "manual-import",
      invokeAuthorization: "unverified",
      connectedAt,
    });
  }
  throw new TypeError("The Chutes credential kind is invalid.");
}

export function connectionCapabilities(connection: ChutesConnection): ConnectionCapabilities {
  const oauth = connection.kind === "chutes-oauth";
  const apiKey = connection.kind === "chutes-api-key";
  return Object.freeze({
    identity: oauth || apiKey,
    account: oauth || apiKey,
    billing: oauth || apiKey,
    invoke: oauth || apiKey,
  });
}

export function isChutesConnected(connection: ChutesConnection): connection is ActiveChutesConnection {
  return connection.kind !== "disconnected";
}

export function withChutesModel(connection: ActiveChutesConnection, modelValue: string): ActiveChutesConnection {
  const model = boundedValue(modelValue, "Chutes model", 512);
  if (model === connection.model) return connection;
  const { lastInvokeAt: _lastInvokeAt, ...metadata } = connection;
  return Object.freeze({ ...metadata, model, invokeAuthorization: "unverified" });
}

export function withVerifiedInvocation(
  connection: ActiveChutesConnection,
  verifiedAtValue = new Date().toISOString(),
): ActiveChutesConnection {
  const lastInvokeAt = canonicalTimestamp(verifiedAtValue);
  if (connection.invokeAuthorization === "verified" && connection.lastInvokeAt === lastInvokeAt) {
    return connection;
  }
  return Object.freeze({ ...connection, invokeAuthorization: "verified", lastInvokeAt });
}

export function connectionLabel(connection: ChutesConnection): string {
  if (connection.kind === "chutes-oauth") return "Chutes OAuth user token";
  if (connection.kind === "chutes-api-key") return "Chutes inference API key";
  return "Disconnected";
}

function boundedValue(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function canonicalTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("The connection timestamp is invalid.");
  const canonical = new Date(timestamp).toISOString();
  if (canonical !== value) throw new TypeError("The connection timestamp must be canonical ISO 8601.");
  return canonical;
}
