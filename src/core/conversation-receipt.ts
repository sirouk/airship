import { randomUuid } from "./id";

const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const RECEIPT_ID_MAX = 2_048;
const SESSION_ID_MAX = 512;
const TURN_ID_MAX = 512;
const PROVIDER_MAX = 256;
const MODEL_MAX = 512;
const TIMING_KEY_MAX = 128;
const MAX_TIMINGS = 128;
const MAX_TOOL_CALLS = 512;
const TOOL_CALL_TEXT_MAX = 512;
const HAS_UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/u;

export type ConversationReceipt = Readonly<{
  version: 1;
  origin: "local" | "provider";
  attestation: "none";
  receiptId: string;
  sessionId: string;
  turnId: string;
  createdAt: string;
  provider: string;
  model?: string;
  requestDigest?: string;
  responseDigest?: string;
  startedAt?: string;
  completedAt?: string;
  timings?: Readonly<Record<string, number>>;
  toolCalls?: readonly Readonly<{ id: string; name: string }>[];
}>;

export function createLocalReceipt(args: Readonly<{
  sessionId: string;
  turnId: string;
  provider: string;
  model?: string;
  requestDigest?: string;
  responseDigest?: string;
  now?: string;
}>): ConversationReceipt {
  const createdAt = args.now ?? new Date().toISOString();
  return Object.freeze({
    version: 1,
    origin: "local",
    attestation: "none",
    receiptId: `urn:receipt:${randomUuid()}`,
    sessionId: args.sessionId,
    turnId: args.turnId,
    createdAt,
    provider: args.provider,
    ...(args.model ? { model: args.model } : {}),
    ...(args.requestDigest ? { requestDigest: args.requestDigest } : {}),
    ...(args.responseDigest ? { responseDigest: args.responseDigest } : {}),
    completedAt: createdAt,
  });
}

export function finalizeProviderReceipt(
  receipt: ConversationReceipt,
  provider: string,
  requestDigest?: string,
  responseDigest?: string,
): ConversationReceipt {
  // Provider output is a runtime boundary. Reject exotic prototypes and
  // accessors before reading a single field so receipt materialization cannot
  // execute provider-controlled code.
  const source = plainRecord(receipt);
  if (!source || source.version !== 1) throw new TypeError("Conversation receipt version is invalid.");
  const receiptId = requiredText(source.receiptId, "Conversation receipt ID", RECEIPT_ID_MAX);
  const sessionId = requiredText(source.sessionId, "Conversation session ID", SESSION_ID_MAX);
  const turnId = requiredText(source.turnId, "Conversation turn ID", TURN_ID_MAX);
  const createdAt = canonicalTimestamp(source.createdAt, "Conversation receipt timestamp");
  const finalizedProvider = requiredText(provider, "Conversation provider ID", PROVIDER_MAX);
  const model = optionalText(source.model, "Conversation model ID", MODEL_MAX);
  const finalizedRequestDigest = optionalDigest(
    requestDigest ?? source.requestDigest,
    "Conversation request digest",
  );
  const finalizedResponseDigest = optionalDigest(
    responseDigest ?? source.responseDigest,
    "Conversation response digest",
  );
  const startedAt = optionalTimestamp(source.startedAt, "Conversation receipt start timestamp");
  const completedAt = optionalTimestamp(
    source.completedAt ?? new Date().toISOString(),
    "Conversation receipt completion timestamp",
  );
  const timings = sanitizeReceiptTimings(source.timings);
  const toolCalls = sanitizeReceiptToolCalls(source.toolCalls);
  return Object.freeze({
    version: 1,
    origin: "provider",
    attestation: "none",
    receiptId,
    sessionId,
    turnId,
    createdAt,
    provider: finalizedProvider,
    ...(model ? { model } : {}),
    ...(finalizedRequestDigest ? { requestDigest: finalizedRequestDigest } : {}),
    ...(finalizedResponseDigest ? { responseDigest: finalizedResponseDigest } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(timings ? { timings } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  });
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || HAS_UNSAFE_CONTROL.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label, maximum);
}

function boundedTextOrUndefined(value: unknown, maximum: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !HAS_UNSAFE_CONTROL.test(value)
    ? value
    : undefined;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128) {
    throw new TypeError(`${label} is invalid.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO 8601.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return canonicalTimestamp(value, label);
}

function optionalDigest(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function sanitizeReceiptTimings(value: unknown): Readonly<Record<string, number>> | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (entries.length > MAX_TIMINGS) return undefined;
  const sanitized: Record<string, number> = {};
  for (const [key, metric] of entries) {
    if (
      typeof key !== "string"
      || key.length === 0
      || key.length > TIMING_KEY_MAX
      || HAS_UNSAFE_CONTROL.test(key)
      || typeof metric !== "number"
      || !Number.isFinite(metric)
      || metric < 0
    ) {
      return undefined;
    }
    sanitized[key] = metric;
  }
  return entries.length === 0 ? undefined : Object.freeze(sanitized);
}

function sanitizeReceiptToolCalls(
  value: unknown,
): readonly Readonly<{ id: string; name: string }>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_TOOL_CALLS) return undefined;
  const sanitized: Array<Readonly<{ id: string; name: string }>> = [];
  for (const item of value) {
    const record = plainRecord(item);
    const id = boundedTextOrUndefined(record?.id, TOOL_CALL_TEXT_MAX);
    const name = boundedTextOrUndefined(record?.name, TOOL_CALL_TEXT_MAX);
    if (!record || !id || !name) continue;
    sanitized.push(Object.freeze({ id, name }));
  }
  return sanitized.length === 0 ? undefined : Object.freeze(sanitized);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => "get" in descriptor || "set" in descriptor)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
