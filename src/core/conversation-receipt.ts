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

export type ConversationReceiptAuthority = Readonly<{
  sessionId: string;
  turnId: string;
  provider: string;
  model?: string;
  requestDigest?: string;
  responseDigest?: string;
}>;

export function createLocalReceipt(args: ConversationReceiptAuthority & Readonly<{ now?: string }>): ConversationReceipt {
  // Snapshot caller-owned fields exactly once before creating the receipt.
  const sessionId = requiredText(args.sessionId, "Conversation session ID", SESSION_ID_MAX);
  const turnId = requiredText(args.turnId, "Conversation turn ID", TURN_ID_MAX);
  const provider = requiredText(args.provider, "Conversation provider ID", PROVIDER_MAX);
  const model = optionalText(args.model, "Conversation model ID", MODEL_MAX);
  const requestDigest = optionalDigest(args.requestDigest, "Conversation request digest");
  const responseDigest = optionalDigest(args.responseDigest, "Conversation response digest");
  const suppliedNow = args.now;
  const createdAt = suppliedNow === undefined
    ? new Date().toISOString()
    : canonicalTimestamp(suppliedNow, "Conversation receipt timestamp");
  return Object.freeze({
    version: 1,
    origin: "local",
    attestation: "none",
    receiptId: `urn:receipt:${randomUuid()}`,
    sessionId,
    turnId,
    createdAt,
    provider,
    ...(model ? { model } : {}),
    ...(requestDigest ? { requestDigest } : {}),
    ...(responseDigest ? { responseDigest } : {}),
    completedAt: createdAt,
  });
}

export function finalizeProviderReceipt(
  receipt: ConversationReceipt,
  authority: ConversationReceiptAuthority,
): ConversationReceipt {
  // Snapshot local authority once before examining provider-controlled data.
  const expectedSessionId = requiredText(authority.sessionId, "Conversation session ID", SESSION_ID_MAX);
  const expectedTurnId = requiredText(authority.turnId, "Conversation turn ID", TURN_ID_MAX);
  const finalizedProvider = requiredText(authority.provider, "Conversation provider ID", PROVIDER_MAX);
  const expectedModel = optionalText(authority.model, "Conversation model ID", MODEL_MAX);
  const authoritativeRequestDigest = authority.requestDigest;
  const authoritativeResponseDigest = authority.responseDigest;

  // Provider output is a runtime boundary. Read one descriptor-safe owned
  // snapshot so accessors, proxies, and later mutation cannot change the
  // identity that is checked and then journaled.
  const source = plainRecord(receipt);
  if (!source || source.version !== 1) throw new TypeError("Conversation receipt version is invalid.");
  const receiptId = requiredText(source.receiptId, "Conversation receipt ID", RECEIPT_ID_MAX);
  const suppliedSessionId = requiredText(source.sessionId, "Conversation session ID", SESSION_ID_MAX);
  const suppliedTurnId = requiredText(source.turnId, "Conversation turn ID", TURN_ID_MAX);
  const suppliedModel = optionalText(source.model, "Conversation model ID", MODEL_MAX);
  if (suppliedSessionId !== expectedSessionId || suppliedTurnId !== expectedTurnId) {
    throw new TypeError("Conversation receipt identity does not match the active turn.");
  }
  if (suppliedModel !== undefined && expectedModel !== undefined && suppliedModel !== expectedModel) {
    throw new TypeError("Conversation receipt model does not match the active inference route.");
  }
  const createdAt = canonicalTimestamp(source.createdAt, "Conversation receipt timestamp");
  const model = expectedModel ?? suppliedModel;
  const finalizedRequestDigest = optionalDigest(
    authoritativeRequestDigest ?? source.requestDigest,
    "Conversation request digest",
  );
  const finalizedResponseDigest = optionalDigest(
    authoritativeResponseDigest ?? source.responseDigest,
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
    sessionId: expectedSessionId,
    turnId: expectedTurnId,
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
  const items = plainArray(value, MAX_TOOL_CALLS);
  if (!items) return undefined;
  const sanitized: Array<Readonly<{ id: string; name: string }>> = [];
  for (const item of items) {
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
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return undefined;
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function plainArray(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorMap: object = descriptors;
    const lengthDescriptor: PropertyDescriptor | undefined = Reflect.get(descriptorMap, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
    const length: unknown = lengthDescriptor.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum) {
      return undefined;
    }
    const snapshot = new Array<unknown>(length);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)) return undefined;
      const index = Number(key);
      const descriptor = descriptors[key];
      if (index >= length || !descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return undefined;
      }
      snapshot[index] = descriptor.value;
    }
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(snapshot, index)) return undefined;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}
