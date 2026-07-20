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

export type SessionProfileBinding = {
  version: 1;
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

export type SessionForkLineage = Readonly<{
  version: 1;
  kind: "fork";
  sourceSessionId: string;
  sourceHeadSequence: number;
  sourceHeadDigest: string;
  forkedAt: string;
}>;

export type SessionManifest = {
  protocolVersion: 1;
  systemPrompt: string;
  systemPromptDigest: string;
  providerId: string;
  model: string;
  toolManifestDigest: string;
  tools: ToolDefinition[];
  workspaceId: string;
  capabilityTier: "web-baseline" | "web-enhanced" | "native" | "remote-confidential";
  /** Security posture pinned when the session is created. Older protocol-v1 manifests may omit it. */
  securityPosture?: SecurityPosture;
  /** Immutable profile resolution copied when the session is forked. */
  profile?: SessionProfileBinding;
  /** Immediate immutable ancestor commitment for a fork. History remains in the source session. */
  lineage?: SessionForkLineage;
  createdAt: string;
};

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
};

export type ToolExecutionResult = {
  content: string;
  metadata?: JsonValue;
  isError?: boolean;
};

export interface Tool {
  readonly definition: ToolDefinition;
  execute(argumentsValue: JsonValue, context: ToolContext): Promise<ToolExecutionResult>;
}

export type ApprovalDecision = "allow" | "deny";

export type ApprovalProvenance = Readonly<{
  mode: "ask-first" | "auto-approve" | "full-access";
  source: "automatic-read" | "human" | "model-review" | "human-fallback" | "bounded-browser-sandbox";
  reason: string;
  reviewRequestId?: string;
  reviewModel?: string;
}>;

export interface ApprovalPolicy {
  review(tool: ToolDefinition, argumentsValue: JsonValue, context: ToolContext): Promise<ApprovalDecision>;
  /** One-shot provenance for the immediately completed decision. */
  takeProvenance?(context: ToolContext): ApprovalProvenance | undefined;
}
