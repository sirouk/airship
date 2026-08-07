import type { ConversationReceipt } from "../receipts/types";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SecurityPosture =
  | "local"
  | "plaintext-remote"
  | "encrypted-unattested"
  | "encrypted-attested";

export type MessageRole = "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: JsonValue;
};

/**
 * An image captured by the client and committed to the canonical transcript.
 * Only inline data URLs are accepted: the inference enclave must not fetch an
 * uncommitted third-party URL after the request has been encrypted.
 */
export type CanonicalImageInput = Readonly<{
  type: "image";
  name: string;
  mediaType: string;
  dataUrl: string;
  sizeBytes: number;
}>;

export type CanonicalMessage = {
  role: MessageRole;
  content: string;
  images?: readonly CanonicalImageInput[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonValue;
  effect: "read" | "write" | "network" | "execute" | "identity";
};

type SessionProfileBindingBase = {
  profileId: string;
  profileRevision: string;
  themeId: string;
  themeDigest: string;
  resolvedSkills: Array<{
    skillId: string;
    digest: string;
    promptOrder: number;
  }>;
  skillSetDigest: string;
  resolutionDigest: string;
};

/** Historical pin shape. Its absent silo fields resolve to safe defaults. */
export type SessionProfileBindingV1 = SessionProfileBindingBase & { version: 1 };

/** Current pin shape. These boundaries are mandatory and signed into the manifest. */
export type SessionProfileBindingV2 = SessionProfileBindingBase & {
  version: 2;
  workspaceBinding:
    | { kind: "active-workspace" }
    | { kind: "workspace-id"; workspaceId: string };
  memoryScope: "session" | "profile" | "workspace";
  approvalMode: "ask-first" | "auto-approve" | "full-access";
  /** The inference evidence floor required when this session was pinned. */
  minimumPosture: SecurityPosture;
};

export type SessionProfileBinding = SessionProfileBindingV1 | SessionProfileBindingV2;

export type SessionForkLineage = Readonly<{
  version: 1;
  kind: "fork";
  sourceSessionId: string;
  /** Selected source conversation boundary, not necessarily the source's later observed journal head. */
  sourceHeadSequence: number;
  sourceHeadDigest: string;
  forkedAt: string;
}>;

/**
 * A fresh destination-session commitment to bounded provider context recovered
 * from an audited source prefix. It is intentionally not a copy of source
 * journal events: source event IDs, timestamps, and turn IDs remain solely in
 * the source session.
 */
export type SessionForkContextSeed = Readonly<{
  version: 1;
  kind: "fork-context";
  forkSessionId: string;
  sourceSessionId: string;
  /** Source journal head observed and rechecked before the fork mutation. */
  sourceHeadSequence: number;
  sourceHeadDigest: string;
  /** Audited prefix whose canonical provider messages produced `messages`. */
  sourceBoundarySequence: number;
  sourceBoundaryDigest: string;
  messages: readonly Readonly<CanonicalMessage>[];
  omittedMessages: number;
  omittedImages: number;
  contextDigest: string;
}>;

/**
 * Immutable provider-context semantics for a session. The window is copied
 * from authoritative runtime/catalog metadata when the session is created;
 * replay never consults a mutable model directory.
 */
export type SessionContextPolicy = Readonly<{
  version: 1;
  contextWindowTokens: number;
  contextWindowSource: Readonly<
    | { kind: "provider-catalog"; field: "contextTokens" | "maxModelTokens" }
    | { kind: "runtime-config"; label: string }
  >;
  compression: Readonly<{
    strategy: "iterative-reference-delta-v1";
    thresholdBasisPoints: number;
    targetRatioBasisPoints: number;
    preserveRecentTurns: number;
    maxSummaryDeltaBytes: number;
    summarizer: Readonly<
      | { mode: "extractive-fallback" }
      | {
          mode: "inference-transport";
          adapterId: "airship/inference-transport-summary-v1";
          onFailure: "extractive-fallback" | "retain-history";
        }
    >;
  }>;
}>;

/**
 * Credential-free identity of the exact inference authority selected for a
 * session. Provider and model IDs alone are ambiguous when a page has multiple
 * accounts, local endpoints, or replacement credentials connected at once.
 *
 * The generation changes whenever a connection ID is rebound. Secrets,
 * refresh material, raw scopes, endpoints, and account identifiers are
 * intentionally absent.
 */
export type SessionInferenceBinding = Readonly<{
  version: 1;
  connectionId: string;
  connectionGeneration: number;
  providerId: string;
  providerLabel: string;
  providerRevision: number;
  authMethod: "oauth-pkce" | "api-key" | "local-none";
  transportBoundary: "e2ee-attestable" | "provider-tls" | "loopback-local";
  modelId: string;
  boundAt: string;
}>;

type SessionManifestBase = {
  systemPrompt: string;
  systemPromptDigest: string;
  providerId: string;
  model: string;
  /** Optional only for historical and deterministic built-in local sessions. */
  inferenceBinding?: SessionInferenceBinding;
  toolManifestDigest: string;
  tools: ToolDefinition[];
  workspaceId: string;
  /** Page-capability observation at creation; live tool results bind their producing tier. */
  capabilityTier: "web-baseline" | "web-enhanced" | "native" | "remote-confidential";
  /** Security posture pinned when the session is created. Older protocol-v1 manifests may omit it. */
  securityPosture?: SecurityPosture;
  /** Immutable profile resolution copied when the session is forked. */
  profile?: SessionProfileBinding;
  /** Immediate immutable ancestor commitment for a fork. History remains in the source session. */
  lineage?: SessionForkLineage;
  /** Optional when the session does not opt into automatic compression. */
  contextPolicy?: SessionContextPolicy;
  createdAt: string;
};

/** Historical manifests predate the separately journaled context-selection event. */
export type SessionManifestV1 = SessionManifestBase & {
  protocolVersion: 1;
  turnContext?: never;
};

/**
 * Current manifests make retrieval semantics critical and explicit. A v1
 * reader must reject this manifest version instead of silently ignoring the
 * `turn.context.selected` event.
 */
export type SessionManifestV2 = SessionManifestBase & {
  protocolVersion: 2;
  turnContext: "required" | "disabled";
};

export type SessionManifest = SessionManifestV1 | SessionManifestV2;

export type InferenceRequest = {
  requestId: string;
  sessionId: string;
  turnId: string;
  model: string;
  systemPrompt: string;
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  idempotencyKey: string;
};

export type InferenceEvent =
  | { type: "text-delta"; text: string }
  | { type: "progress"; phase: "reasoning" }
  | {
      // Private chain-of-thought the provider chose to expose as a stream.
      // It is evidence about how the answer was formed, never answer text,
      // and runTurn journals it as its own `turn.reasoning` record beside the
      // assistant text it preceded.
      type: "reasoning-delta";
      text: string;
    }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | {
      type: "completed";
      finishReason: "stop" | "tool-calls" | "length";
      receipt?: ConversationReceipt;
    };

export interface InferenceTransport {
  readonly id: string;
  readonly posture: SecurityPosture;
  stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
}

export type ToolContext = {
  sessionId: string;
  turnId: string;
  operationId: string;
  signal: AbortSignal;
  /**
   * Immutable page-capability observation recorded when the session began.
   * It is evidence context, not an authorization ceiling: optional runtimes
   * activated later are governed by readiness, approvals, and result-level
   * provenance in the same conversation.
   */
  capabilityTier?: SessionManifest["capabilityTier"];
  /** Live, page-memory output. The terminal tool result remains the durable authority. */
  onOutput?: (chunk: ToolOutputChunk) => void;
};

export type ToolOutputChunk = Readonly<{
  stream: "stdout" | "stderr" | "combined";
  text: string;
}>;

export type ToolExecutionResult = {
  content: string;
  metadata?: JsonValue;
  isError?: boolean;
};

export interface Tool {
  readonly definition: ToolDefinition;
  execute(argumentsValue: JsonValue, context: ToolContext): Promise<ToolExecutionResult>;
}

/**
 * Read access to the session work plan for the turn loop itself, rather than
 * for the model.
 *
 * It is a port and not a call to `list_tasks` on purpose: every tool invocation
 * in this product is reviewed, journalled and bound to an approval ticket, and
 * a system-side read that borrowed the tool path would either forge that record
 * or bypass it. The plan is read here the way the live-environment snapshot is
 * read — beside the tool surface, not through it.
 */
export type TaskPlanEntry = Readonly<{ id: string; content: string; status: string }>;

export interface TaskPlanProvider {
  /** Open work only. Completed items are not worth the context they cost. */
  openTasks(context: Readonly<{ sessionId: string; signal: AbortSignal }>): Promise<readonly TaskPlanEntry[]>;
}

export type ApprovalDecision = "allow" | "deny";

export type ApprovalProvenance = Readonly<{
  mode: "ask-first" | "auto-approve" | "full-access";
  source: "automatic-read" | "human" | "model-review" | "human-fallback" | "bounded-browser-sandbox";
  reason: string;
  reviewRequestId?: string;
  reviewModel?: string;
}>;

/**
 * The journal record of a decision on an effect the *person* proposed from the
 * interface, rather than one the model asked for.
 *
 * It lives here, beside the provenance it carries, because the producer (the
 * shell) and the validator (the session audit) must agree on the string and
 * neither should have to import the other's module to say it.
 */
export const HUMAN_INTENT_EVENT_TYPE = "human.intent.reviewed";

/**
 * The journal record of the inference that named a conversation.
 *
 * Naming is a real provider request made on the conversation's behalf, off the
 * turn's critical path. It used to be issued against a fabricated session id,
 * so its receipt and its cost belonged to nothing and could never be shown
 * beside the conversation they were spent on. This binds them to it.
 */
export const CONVERSATION_NAMED_EVENT_TYPE = "conversation.named";

/**
 * The journal record of one thing a shell session did.
 *
 * Terminal lineage shipped as a bounded record set living only inside
 * `BrowserTerminalManager`, readable from one `<summary>` popover and from
 * nowhere else: a command that rewrote the workspace left no trace in the
 * journal that Proof audits, so the one timeline the product claims —
 * intent → effect → workspace head → receipt — had a hole exactly where the
 * shell is. This is the type that closes it, and it lives here for the same
 * reason `HUMAN_INTENT_EVENT_TYPE` does: the producer (the terminal manager's
 * sink) and the validator (the session audit) must agree on the string without
 * either importing the other.
 *
 * It is deliberately outside the turn protocol. A shell runs beside turns, not
 * inside them, so these events carry no turn or operation identity — the same
 * shape `session.renamed` has.
 */
export const TERMINAL_ACTIVITY_EVENT_TYPE = "terminal.activity.recorded";

export interface ApprovalPolicy {
  review(tool: ToolDefinition, argumentsValue: JsonValue, context: ToolContext): Promise<ApprovalDecision>;
  /** One-shot provenance for the immediately completed decision. */
  takeProvenance?(context: ToolContext): ApprovalProvenance | undefined;
}

/**
 * Where a corpus's vectors were computed. This is a privacy claim, so it is
 * declared once and imported: it was previously written out in five places, and
 * adding a posture updated the provider while leaving lineage, selection, the
 * live environment and the publisher describing the old world.
 *
 * `confidential-remote` may only name a provider whose compute is attested. An
 * ordinary remote embedder puts the corpus in someone else's plaintext and does
 * not belong in this union.
 */
export const EMBEDDING_POSTURES = Object.freeze([
  "deterministic-bootstrap",
  "local-semantic",
  "confidential-remote",
] as const);

export type EmbeddingPosture = (typeof EMBEDDING_POSTURES)[number];

/** Boundary check. The type and the runtime list are the same declaration. */
export function isEmbeddingPosture(value: unknown): value is EmbeddingPosture {
  return typeof value === "string" && (EMBEDDING_POSTURES as readonly string[]).includes(value);
}
