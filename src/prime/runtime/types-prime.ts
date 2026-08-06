/**
 * Prime runtime contracts — the single frozen source of truth every
 * prime module codes against. Runtime authorities (session/registry),
 * harness stores, kernel adapters, and subagent orchestration import
 * from here and never define competing copies. Field names in these
 * types are binding across the whole port.
 */

import type { Api, Model, Usage } from "../ai/types";
import type { Agent } from "../agent";
import type { KernelBudgets, KernelJobResult, KernelJobSpec } from "../kernel/kernel-contract";
import type { PrimeKernelHost } from "../kernel/kernel-host";

export type PrimeAgentRole = "root" | "subagent";

export const MAX_AGENT_NAME_CHARS = 64;
export const MAX_AGENT_MESSAGE_CHARS = 16_384;
export const MAX_PENDING_AGENT_MESSAGES = 20;
export const PRIME_MESSAGE_BURST_CAPACITY = 3;
export const PRIME_MESSAGE_REFILL_MS = 1_000;
export const DEFAULT_RLM_MAX_DEPTH = 1;
export const MAX_SPAWN_PROMPT_CHARS = 16 * 1_024;

export function canonicalPrimeAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AGENT_NAME_CHARS) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) return undefined;
  return trimmed;
}

/** Default rlm-style spawn name: subagent-<promptslug>-<8hex>. */
export function deriveDefaultSubagentName(prompt: string, randomHex8: string): string {
  const slugBase = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const slug = slugBase.length > 0 ? slugBase : "task";
  return `subagent-${slug}-${randomHex8}`;
}

/** The admission handle returned by a spawn. Never carries the answer. */
export type PrimeSubagentHandle = Readonly<{
  id: string;
  name: string;
  role: PrimeAgentRole;
  parentId?: string;
  depth: number;
  model: Model<Api>;
  sessionPath: string;
  status: "running" | "idle" | "stopped" | "failed";
}>;

export type PrimeAgentMessageReceipt = Readonly<{
  delivered: boolean;
  queued: boolean;
  messageId: string;
  reason?: string;
}>;

export type PrimeAgentMessage = Readonly<{
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  content: string;
  timestamp: number;
}>;

/**
 * Family-reach surface used by agent_message/agent_observe: parent,
 * siblings, direct children only (nuclear family), identical to upstream.
 */
export type PrimeAgentRouter = Readonly<{
  reachableAgents(fromId: string): PrimeSubagentHandle[];
  send(message: { fromId: string; toId: string; content: string }): Promise<PrimeAgentMessageReceipt>;
  recentMessages(agentId: string, limit: number, maxChars: number): PrimeAgentMessage[];
}>;

/**
 * What a parent needs of one agent（root or child）without owning its loop.
 */
export type PrimeAgentRuntime = Readonly<{
  handle: PrimeSubagentHandle;
  agent: Agent;
  kernel: PrimeKernelHost;
  execKernel(spec: KernelJobSpec): Promise<KernelJobResult>;
  usage(): Usage;
  stop(reason: string): Promise<void>;
}>;

export type PrimeRuntimeEvent =
  | Readonly<{ type: "subagent-admitted"; handle: PrimeSubagentHandle }>
  | Readonly<{ type: "subagent-update"; handle: PrimeSubagentHandle }>
  | Readonly<{ type: "subagent-reply"; handle: PrimeSubagentHandle; message: PrimeAgentMessage }>
  | Readonly<{
      type: "subagent-terminal";
      handle: PrimeSubagentHandle;
      reason: "replied" | "completed_without_reply" | "failed" | "stopped";
      preview?: string;
    }>
  | Readonly<{ type: "kernel-crash"; agentId: string; result: KernelJobResult }>;

// ---- harness contracts (consumed by harness store refinements) ----

export const PRIME_HARNESS_KINDS = Object.freeze(["prompt", "memory", "skill", "subagent"] as const);
export type PrimeHarnessKind = (typeof PRIME_HARNESS_KINDS)[number];

export const PRIME_HARNESS_SCOPES = Object.freeze(["local", "global"] as const);
export type PrimeHarnessScope = (typeof PRIME_HARNESS_SCOPES)[number];

export type PrimeHarnessEntry = Readonly<{
  id: string;
  kind: PrimeHarnessKind;
  scope: PrimeHarnessScope;
  title: string;
  content: string;
  path?: string;
  reference?: { type: "python"; import: string; callable?: string; callPattern?: string };
  arguments?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  source: "agent" | "refine";
  createdAt: number;
  updatedAt: number;
  version: number;
}>;

export type PrimeHarnessRefinement = Readonly<{
  id: string;
  summary: string;
  rationale: string;
  expectedOutcome?: string;
  edits: ReadonlyArray<{
    action: "create" | "update" | "delete";
    id: string;
    kind: PrimeHarnessKind;
    before?: PrimeHarnessEntry;
    after?: PrimeHarnessEntry;
  }>;
  appliedAt: number;
  source: "agent" | "auto";
}>;

export type PrimeHarnessOverview = Readonly<{
  entries: ReadonlyArray<Pick<PrimeHarnessEntry, "id" | "kind" | "scope" | "title">>;
  refinements: ReadonlyArray<Pick<PrimeHarnessRefinement, "id" | "summary" | "appliedAt">>;
  snapshotId: string;
}>;

export type PrimeHarnessSnapshot = Readonly<{
  entries: PrimeHarnessEntry[];
  refinements: PrimeHarnessRefinement[];
  snapshotId: string;
  takenAt: number;
}>;

/**
 * The harness persistence contract. Mutations must fail closed with a
 * named optimistic-concurrency error when the observed version no longer
 * matches the stored one.
 */
export interface PrimeHarnessStore {
  list(scope?: PrimeHarnessScope): Promise<PrimeHarnessEntry[]>;
  get(scope: PrimeHarnessScope, id: string): Promise<PrimeHarnessEntry | undefined>;
  create(scope: PrimeHarnessScope, entry: Omit<PrimeHarnessEntry, "version">): Promise<PrimeHarnessEntry>;
  update(scope: PrimeHarnessScope, entry: PrimeHarnessEntry, expectedVersion: number): Promise<PrimeHarnessEntry>;
  delete(scope: PrimeHarnessScope, id: string): Promise<void>;
  appendRefinement(refinement: Omit<PrimeHarnessRefinement, "appliedAt">): Promise<PrimeHarnessRefinement>;
  refinements(limit?: number): Promise<PrimeHarnessRefinement[]>;
  rollback(refinementId: string): Promise<PrimeHarnessRefinement>;
  snapshot(): Promise<PrimeHarnessSnapshot>;
  restore(snapshot: PrimeHarnessSnapshot): Promise<void>;
  snapshotId(): Promise<string>;
}

