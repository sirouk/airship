import type {
  CanonicalMessage,
  JsonValue,
  SessionForkContextSeed,
  SessionForkLineage,
  ToolCall,
} from "./contracts";
import { sha256, stableStringify } from "./hash";
import { canonicalImageInputs } from "./multimodal";

export const FORK_CONTEXT_EVENT_TYPE = "session.fork.context.seeded";
export const MAX_FORK_CONTEXT_MESSAGES = 256;
export const MAX_FORK_CONTEXT_BYTES = 768 * 1024;

const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const UNSAFE_IDENTIFIER = /[\u0000-\u001F\u007F]/u;
const ENCODER = new TextEncoder();
const SEED_FIELDS = new Set([
  "version",
  "kind",
  "forkSessionId",
  "sourceSessionId",
  "sourceHeadSequence",
  "sourceHeadDigest",
  "sourceBoundarySequence",
  "sourceBoundaryDigest",
  "messages",
  "omittedMessages",
  "omittedImages",
  "contextDigest",
]);
const MESSAGE_FIELDS = new Set(["role", "content", "images", "toolCallId", "toolCalls"]);
const TOOL_CALL_FIELDS = new Set(["id", "name", "arguments"]);

export type CreateForkContextSeedInput = Readonly<{
  forkSessionId: string;
  sourceSessionId: string;
  sourceHeadSequence: number;
  sourceHeadDigest: string;
  sourceBoundarySequence: number;
  sourceBoundaryDigest: string;
  messages: readonly CanonicalMessage[];
}>;

export type PreparedForkContext = Readonly<{
  messages: readonly Readonly<CanonicalMessage>[];
  omittedMessages: number;
  omittedImages: number;
}>;

export type ForkContextScope = Readonly<{
  sessionId: string;
  lineage?: SessionForkLineage;
}>;

/** Seal a bounded, whole-turn suffix of an already audited source context. */
export async function createForkContextSeed(
  input: CreateForkContextSeedInput,
): Promise<SessionForkContextSeed> {
  return sealForkContextSeed(input, prepareForkContext(input.messages));
}

/** Preflight all shape and size work before a destination session is created. */
export function prepareForkContext(
  messages: readonly CanonicalMessage[],
): PreparedForkContext {
  return boundWholeTurns(messages);
}

export async function sealForkContextSeed(
  input: Omit<CreateForkContextSeedInput, "messages">,
  bounded: PreparedForkContext,
): Promise<SessionForkContextSeed> {
  assertIdentifier(input.forkSessionId, "Fork session ID");
  assertIdentifier(input.sourceSessionId, "Source session ID");
  assertSourceCommitments(input);
  const canonical = canonicalMessages(bounded.messages);
  if (
    !canonical ||
    !validConversationShape(canonical) ||
    !Number.isSafeInteger(bounded.omittedMessages) ||
    bounded.omittedMessages < 0 ||
    !Number.isSafeInteger(bounded.omittedImages) ||
    bounded.omittedImages < 0
  ) throw new TypeError("Prepared fork context is invalid.");
  const unsigned = {
    version: 1 as const,
    kind: "fork-context" as const,
    forkSessionId: input.forkSessionId,
    sourceSessionId: input.sourceSessionId,
    sourceHeadSequence: input.sourceHeadSequence,
    sourceHeadDigest: input.sourceHeadDigest,
    sourceBoundarySequence: input.sourceBoundarySequence,
    sourceBoundaryDigest: input.sourceBoundaryDigest,
    messages: canonical,
    omittedMessages: bounded.omittedMessages,
    omittedImages: bounded.omittedImages,
  };
  if (canonicalBytes(unsigned) > MAX_FORK_CONTEXT_BYTES) {
    throw new RangeError("The prepared fork context exceeds the bounded seed contract.");
  }
  const contextDigest = await sha256(stableStringify(unsigned as unknown as JsonValue));
  return deepFreeze({ ...unsigned, contextDigest });
}

/** Parse and clone only the exact bounded seed contract. */
export function canonicalForkContextSeed(value: unknown): SessionForkContextSeed | undefined {
  const raw = plainRecord(value);
  if (
    !raw ||
    Object.keys(raw).some((field) => !SEED_FIELDS.has(field)) ||
    raw.version !== 1 ||
    raw.kind !== "fork-context" ||
    !safeIdentifier(raw.forkSessionId) ||
    !safeIdentifier(raw.sourceSessionId) ||
    !Number.isSafeInteger(raw.sourceHeadSequence) ||
    !Number.isSafeInteger(raw.sourceBoundarySequence) ||
    (raw.sourceHeadSequence as number) < (raw.sourceBoundarySequence as number) ||
    (raw.sourceBoundarySequence as number) <= 0 ||
    !DIGEST_PATTERN.test(String(raw.sourceHeadDigest)) ||
    !DIGEST_PATTERN.test(String(raw.sourceBoundaryDigest)) ||
    ((raw.sourceHeadSequence as number) === (raw.sourceBoundarySequence as number) &&
      raw.sourceHeadDigest !== raw.sourceBoundaryDigest) ||
    !Number.isSafeInteger(raw.omittedMessages) ||
    (raw.omittedMessages as number) < 0 ||
    !Number.isSafeInteger(raw.omittedImages) ||
    (raw.omittedImages as number) < 0 ||
    !DIGEST_PATTERN.test(String(raw.contextDigest)) ||
    !Array.isArray(raw.messages) ||
    raw.messages.length > MAX_FORK_CONTEXT_MESSAGES
  ) return undefined;

  const messages = canonicalMessages(raw.messages);
  if (!messages || !validConversationShape(messages)) return undefined;
  const unsigned = {
    version: 1 as const,
    kind: "fork-context" as const,
    forkSessionId: raw.forkSessionId as string,
    sourceSessionId: raw.sourceSessionId as string,
    sourceHeadSequence: raw.sourceHeadSequence as number,
    sourceHeadDigest: raw.sourceHeadDigest as string,
    sourceBoundarySequence: raw.sourceBoundarySequence as number,
    sourceBoundaryDigest: raw.sourceBoundaryDigest as string,
    messages,
    omittedMessages: raw.omittedMessages as number,
    omittedImages: raw.omittedImages as number,
  };
  if (canonicalBytes(unsigned) > MAX_FORK_CONTEXT_BYTES) return undefined;
  return deepFreeze({ ...unsigned, contextDigest: raw.contextDigest as string });
}

export async function verifyForkContextSeed(seed: SessionForkContextSeed): Promise<boolean> {
  const canonical = canonicalForkContextSeed(seed);
  if (!canonical) return false;
  const { contextDigest, ...unsigned } = canonical;
  return await sha256(stableStringify(unsigned as unknown as JsonValue)) === contextDigest;
}

export function forkContextSeedMatchesScope(
  seed: SessionForkContextSeed,
  scope: ForkContextScope,
): boolean {
  const lineage = scope.lineage;
  return Boolean(
    lineage &&
    lineage.version === 1 &&
    lineage.kind === "fork" &&
    seed.forkSessionId === scope.sessionId &&
    seed.sourceSessionId === lineage.sourceSessionId &&
    seed.sourceBoundarySequence === lineage.sourceHeadSequence &&
    seed.sourceBoundaryDigest === lineage.sourceHeadDigest &&
    seed.sourceHeadSequence >= seed.sourceBoundarySequence &&
    (seed.sourceHeadSequence !== seed.sourceBoundarySequence ||
      seed.sourceHeadDigest === seed.sourceBoundaryDigest),
  );
}

function boundWholeTurns(messages: readonly CanonicalMessage[]): Readonly<{
  messages: readonly Readonly<CanonicalMessage>[];
  omittedMessages: number;
  omittedImages: number;
}> {
  const canonical = canonicalMessages(messages);
  if (!canonical || !validConversationShape(canonical)) {
    throw new TypeError("The audited source did not materialize canonical completed-turn context.");
  }
  const groups = wholeTurnGroups(canonical);
  const selected: CanonicalMessage[][] = [];
  let selectedCount = 0;
  let stopped = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (stopped || selectedCount + group.length > MAX_FORK_CONTEXT_MESSAGES) {
      stopped = true;
      continue;
    }
    const candidate = [group, ...selected].flat();
    if (canonicalBytes({ messages: candidate }) > MAX_FORK_CONTEXT_BYTES - 4_096) {
      stopped = true;
      continue;
    }
    selected.unshift(group);
    selectedCount += group.length;
  }
  let bounded = selected.flat();
  if (canonical.length > 0 && bounded.length === 0) {
    const newest = groups.at(-1) ?? [];
    const withoutImages = newest.map(({ images: _images, ...message }) => message as CanonicalMessage);
    if (
      withoutImages.length > MAX_FORK_CONTEXT_MESSAGES ||
      canonicalBytes({ messages: withoutImages }) > MAX_FORK_CONTEXT_BYTES - 4_096
    ) {
      throw new RangeError("The most recent completed source turn exceeds the bounded fork-context contract.");
    }
    bounded = withoutImages;
  }
  const retainedImages = bounded.reduce((count, message) => count + (message.images?.length ?? 0), 0);
  const totalImages = canonical.reduce((count, message) => count + (message.images?.length ?? 0), 0);
  return deepFreeze({
    messages: bounded,
    omittedMessages: canonical.length - bounded.length,
    omittedImages: totalImages - retainedImages,
  });
}

function wholeTurnGroups(messages: readonly CanonicalMessage[]): CanonicalMessage[][] {
  const groups: CanonicalMessage[][] = [];
  let current: CanonicalMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(structuredClone(message));
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function canonicalMessages(value: readonly unknown[]): CanonicalMessage[] | undefined {
  const messages: CanonicalMessage[] = [];
  for (const candidate of value) {
    const message = plainRecord(candidate);
    if (
      !message ||
      Object.keys(message).some((field) => !MESSAGE_FIELDS.has(field)) ||
      !["user", "assistant", "tool"].includes(String(message.role)) ||
      typeof message.content !== "string"
    ) return undefined;
    if (message.role === "user") {
      if (message.toolCallId !== undefined || message.toolCalls !== undefined) return undefined;
      const images = canonicalImageInputs(message.images);
      if (
        !images ||
        (message.images !== undefined && stableStringify(message.images as JsonValue) !==
          stableStringify(images as unknown as JsonValue))
      ) return undefined;
      messages.push({ role: "user", content: message.content, ...(images.length ? { images: [...images] } : {}) });
      continue;
    }
    if (message.role === "assistant") {
      if (message.images !== undefined || message.toolCallId !== undefined) return undefined;
      const toolCalls = canonicalToolCalls(message.toolCalls);
      if (!toolCalls) return undefined;
      messages.push({ role: "assistant", content: message.content, ...(toolCalls.length ? { toolCalls } : {}) });
      continue;
    }
    if (message.images !== undefined || message.toolCalls !== undefined || !safeIdentifier(message.toolCallId)) {
      return undefined;
    }
    messages.push({ role: "tool", content: message.content, toolCallId: message.toolCallId as string });
  }
  return messages;
}

function canonicalToolCalls(value: unknown): ToolCall[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const calls: ToolCall[] = [];
  for (const candidate of value) {
    const call = plainRecord(candidate);
    if (
      !call ||
      Object.keys(call).some((field) => !TOOL_CALL_FIELDS.has(field)) ||
      !safeIdentifier(call.id) ||
      !safeIdentifier(call.name, 256) ||
      !isJsonValue(call.arguments)
    ) return undefined;
    calls.push({ id: call.id as string, name: call.name as string, arguments: structuredClone(call.arguments) });
  }
  return calls;
}

function validConversationShape(messages: readonly CanonicalMessage[]): boolean {
  const allCallIds = new Set<string>();
  let unresolved = new Set<string>();
  let phase: "start" | "await-assistant" | "await-tools" | "after-tools" | "after-assistant" = "start";
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      if (phase !== "start" && phase !== "after-assistant") return false;
      phase = "await-assistant";
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      const summaryPrelude = index === 0 && phase === "start" && calls.length === 0;
      if (!summaryPrelude && phase !== "await-assistant" && phase !== "after-tools") return false;
      unresolved = new Set<string>();
      for (const call of calls) {
        if (allCallIds.has(call.id) || unresolved.has(call.id)) return false;
        allCallIds.add(call.id);
        unresolved.add(call.id);
      }
      phase = calls.length > 0 ? "await-tools" : "after-assistant";
      continue;
    }
    if (phase !== "await-tools" || !message.toolCallId || !unresolved.delete(message.toolCallId)) return false;
    if (unresolved.size === 0) phase = "after-tools";
  }
  return unresolved.size === 0 && (phase === "start" || phase === "after-assistant");
}

function assertSourceCommitments(input: Omit<CreateForkContextSeedInput, "messages">): void {
  if (
    !Number.isSafeInteger(input.sourceHeadSequence) ||
    !Number.isSafeInteger(input.sourceBoundarySequence) ||
    input.sourceBoundarySequence <= 0 ||
    input.sourceHeadSequence < input.sourceBoundarySequence ||
    !DIGEST_PATTERN.test(input.sourceHeadDigest) ||
    !DIGEST_PATTERN.test(input.sourceBoundaryDigest) ||
    (input.sourceHeadSequence === input.sourceBoundarySequence && input.sourceHeadDigest !== input.sourceBoundaryDigest)
  ) throw new TypeError("Fork source commitments are invalid.");
}

function assertIdentifier(value: string, label: string): void {
  if (!safeIdentifier(value)) throw new TypeError(`${label} is invalid.`);
}

function safeIdentifier(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !UNSAFE_IDENTIFIER.test(value);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    nodes += 1;
    if (nodes > 100_000 || candidate.depth > 64) return false;
    if (
      candidate.value === null ||
      typeof candidate.value === "string" ||
      typeof candidate.value === "boolean"
    ) continue;
    if (typeof candidate.value === "number") {
      if (!Number.isFinite(candidate.value)) return false;
      continue;
    }
    if (!candidate.value || typeof candidate.value !== "object" || seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    if (Array.isArray(candidate.value)) {
      for (const child of candidate.value) pending.push({ value: child, depth: candidate.depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(candidate.value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const child of Object.values(candidate.value)) {
      pending.push({ value: child, depth: candidate.depth + 1 });
    }
  }
  return true;
}

function canonicalBytes(value: unknown): number {
  return ENCODER.encode(stableStringify(value as JsonValue)).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
