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

// ---- harness contracts ----
//
// The harness layer's own module (src/prime/harness/types.ts,
// src/prime/harness/store.ts) is the single source of truth for these
// shapes; these aliases exist so contracts elsewhere never define
// competing copies.

export {
  HARNESS_ENTRY_KINDS as PRIME_HARNESS_KINDS,
  HARNESS_SCOPES as PRIME_HARNESS_SCOPES,
} from "../harness/types";
export type {
  HarnessEntry as PrimeHarnessEntry,
  HarnessEntryKind as PrimeHarnessKind,
  HarnessRefinementEvent as PrimeHarnessRefinement,
  HarnessScope as PrimeHarnessScope,
  HarnessSnapshot as PrimeHarnessSnapshot,
} from "../harness/types";
export type { HarnessStore as PrimeHarnessStore } from "../harness/store";
