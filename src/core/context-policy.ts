import type { SessionContextPolicy } from "./contracts";

export const INFERENCE_CONTEXT_SUMMARIZER_ID = "airship/inference-transport-summary-v1" as const;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_THRESHOLD = 0.82;
const DEFAULT_TARGET_RATIO = 0.62;
const DEFAULT_PRESERVED_TURNS = 2;
const DEFAULT_MAX_DELTA_BYTES = 12 * 1024;

export type ContextCompressionOptions = Readonly<{
  /** Provider context window. This is pinned by the caller, never guessed from a model name. */
  contextWindowTokens?: number;
  /** Compression starts only between 80% and 85% of the declared window. */
  threshold?: number;
  /** Best-effort post-compression target; recent turns are never dropped to reach it. */
  targetRatio?: number;
  preserveRecentTurns?: number;
  maxSummaryDeltaBytes?: number;
}>;

export function resolveContextCompressionOptions(
  options: ContextCompressionOptions = {},
): Required<ContextCompressionOptions> {
  const contextWindowTokens = integer(
    options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    2_048,
    4_194_304,
    "Context window",
  );
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0.8 || threshold > 0.85) {
    throw new RangeError("Context compression threshold must be between 0.80 and 0.85.");
  }
  const targetRatio = options.targetRatio ?? DEFAULT_TARGET_RATIO;
  if (!Number.isFinite(targetRatio) || targetRatio < 0.4 || targetRatio >= threshold) {
    throw new RangeError("Context compression target ratio must be at least 0.40 and below the threshold.");
  }
  return Object.freeze({
    contextWindowTokens,
    threshold,
    targetRatio,
    preserveRecentTurns: integer(
      options.preserveRecentTurns ?? DEFAULT_PRESERVED_TURNS,
      1,
      32,
      "Preserved turn count",
    ),
    maxSummaryDeltaBytes: integer(
      options.maxSummaryDeltaBytes ?? DEFAULT_MAX_DELTA_BYTES,
      512,
      64 * 1024,
      "Summary delta size",
    ),
  });
}

export function createSessionContextPolicy(args: Readonly<{
  contextWindowTokens: number;
  source: SessionContextPolicy["contextWindowSource"];
  compression?: Omit<ContextCompressionOptions, "contextWindowTokens">;
  summarizer?: SessionContextPolicy["compression"]["summarizer"];
}>): SessionContextPolicy {
  const resolved = resolveContextCompressionOptions({
    ...args.compression,
    contextWindowTokens: args.contextWindowTokens,
  });
  const source = canonicalContextWindowSource(args.source);
  if (!source) throw new TypeError("Session context-window provenance is invalid.");
  const summarizer = canonicalSessionSummarizerPolicy(args.summarizer ?? { mode: "extractive-fallback" });
  if (!summarizer) throw new TypeError("Session context summarizer policy is invalid.");
  return Object.freeze({
    version: 1,
    contextWindowTokens: resolved.contextWindowTokens,
    contextWindowSource: source,
    compression: Object.freeze({
      strategy: "iterative-reference-delta-v1",
      thresholdBasisPoints: Math.round(resolved.threshold * 10_000),
      targetRatioBasisPoints: Math.round(resolved.targetRatio * 10_000),
      preserveRecentTurns: resolved.preserveRecentTurns,
      maxSummaryDeltaBytes: resolved.maxSummaryDeltaBytes,
      summarizer,
    }),
  });
}

export function canonicalSessionContextPolicy(value: unknown): SessionContextPolicy | undefined {
  const candidate = record(value);
  const compression = record(candidate?.compression);
  const source = canonicalContextWindowSource(candidate?.contextWindowSource);
  const summarizer = canonicalSessionSummarizerPolicy(compression?.summarizer);
  if (
    candidate?.version !== 1 ||
    !safeInteger(candidate.contextWindowTokens, 2_048, 4_194_304) ||
    !source ||
    compression?.strategy !== "iterative-reference-delta-v1" ||
    !safeInteger(compression.thresholdBasisPoints, 8_000, 8_500) ||
    !safeInteger(compression.targetRatioBasisPoints, 4_000, (compression.thresholdBasisPoints as number) - 1) ||
    !safeInteger(compression.preserveRecentTurns, 1, 32) ||
    !safeInteger(compression.maxSummaryDeltaBytes, 512, 64 * 1024) ||
    !summarizer
  ) return undefined;
  return Object.freeze({
    version: 1,
    contextWindowTokens: candidate.contextWindowTokens as number,
    contextWindowSource: source,
    compression: Object.freeze({
      strategy: "iterative-reference-delta-v1",
      thresholdBasisPoints: compression.thresholdBasisPoints as number,
      targetRatioBasisPoints: compression.targetRatioBasisPoints as number,
      preserveRecentTurns: compression.preserveRecentTurns as number,
      maxSummaryDeltaBytes: compression.maxSummaryDeltaBytes as number,
      summarizer,
    }),
  });
}

export function contextCompressionOptionsFromPolicy(
  policy: SessionContextPolicy,
): Required<ContextCompressionOptions> {
  const canonical = canonicalSessionContextPolicy(policy);
  if (!canonical) throw new TypeError("The session context policy is invalid.");
  return resolveContextCompressionOptions({
    contextWindowTokens: canonical.contextWindowTokens,
    threshold: canonical.compression.thresholdBasisPoints / 10_000,
    targetRatio: canonical.compression.targetRatioBasisPoints / 10_000,
    preserveRecentTurns: canonical.compression.preserveRecentTurns,
    maxSummaryDeltaBytes: canonical.compression.maxSummaryDeltaBytes,
  });
}

/** Compare only canonical pinned semantics; malformed runtime data never matches. */
export function sessionContextPoliciesMatch(
  actual: SessionContextPolicy | undefined,
  expected: SessionContextPolicy | undefined,
): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  const left = canonicalSessionContextPolicy(actual);
  const right = canonicalSessionContextPolicy(expected);
  if (!left || !right) return false;
  return left.version === right.version &&
    left.contextWindowTokens === right.contextWindowTokens &&
    contextWindowSourcesMatch(left.contextWindowSource, right.contextWindowSource) &&
    left.compression.strategy === right.compression.strategy &&
    left.compression.thresholdBasisPoints === right.compression.thresholdBasisPoints &&
    left.compression.targetRatioBasisPoints === right.compression.targetRatioBasisPoints &&
    left.compression.preserveRecentTurns === right.compression.preserveRecentTurns &&
    left.compression.maxSummaryDeltaBytes === right.compression.maxSummaryDeltaBytes &&
    summarizerPoliciesMatch(left.compression.summarizer, right.compression.summarizer);
}

function canonicalSessionSummarizerPolicy(
  value: unknown,
): SessionContextPolicy["compression"]["summarizer"] | undefined {
  const candidate = record(value);
  if (candidate?.mode === "extractive-fallback") {
    return Object.freeze({ mode: "extractive-fallback" });
  }
  if (
    candidate?.mode === "inference-transport" &&
    candidate.adapterId === INFERENCE_CONTEXT_SUMMARIZER_ID &&
    (candidate.onFailure === "extractive-fallback" || candidate.onFailure === "retain-history")
  ) {
    return Object.freeze({
      mode: "inference-transport",
      adapterId: INFERENCE_CONTEXT_SUMMARIZER_ID,
      onFailure: candidate.onFailure,
    });
  }
  return undefined;
}

function canonicalContextWindowSource(value: unknown): SessionContextPolicy["contextWindowSource"] | undefined {
  const source = record(value);
  if (source?.kind === "provider-catalog" && (source.field === "contextTokens" || source.field === "maxModelTokens")) {
    return Object.freeze({ kind: "provider-catalog", field: source.field });
  }
  if (
    source?.kind === "runtime-config" &&
    boundedSafeString(source.label, 256)
  ) {
    return Object.freeze({ kind: "runtime-config", label: source.label as string });
  }
  return undefined;
}

function contextWindowSourcesMatch(
  left: SessionContextPolicy["contextWindowSource"],
  right: SessionContextPolicy["contextWindowSource"],
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "provider-catalog" && right.kind === "provider-catalog"
    ? left.field === right.field
    : left.kind === "runtime-config" && right.kind === "runtime-config" && left.label === right.label;
}

function summarizerPoliciesMatch(
  left: SessionContextPolicy["compression"]["summarizer"],
  right: SessionContextPolicy["compression"]["summarizer"],
): boolean {
  if (left.mode !== right.mode) return false;
  return left.mode === "extractive-fallback" && right.mode === "extractive-fallback" ||
    left.mode === "inference-transport" && right.mode === "inference-transport" &&
      left.adapterId === right.adapterId && left.onFailure === right.onFailure;
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside its bounded range.`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function boundedSafeString(value: unknown, maximum: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
