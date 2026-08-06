/**
 * Ports for subagent orchestration (RLM recursion).
 *
 * This module is the *port* side of `registry.ts`: everything here is an
 * interface the registry depends on but deliberately does not implement.
 * The parent session authority wires the implementations in later:
 *
 *   - {@link PrimeAgentRuntimeFactory} turns an admission record into a live
 *     child runtime bundle (the frozen `PrimeAgentRuntime` from
 *     ../runtime/types-prime, plus the child's message sink and optional
 *     recorder). The factory is invoked *after* admission resolves, so a
 *     slow or never-resolving factory can never block `spawn` — that is the
 *     busy-wait prohibition from the port manifest.
 *   - {@link PrimeAgentMessageSink} is one agent's intake queue. `accept`
 *     answering "delivered" is what receipts call "delivered" (the target
 *     session took the message into context or its live queue); "queued"
 *     means it waits behind current work.
 *   - {@link PrimeAgentRecorder} backs agent_observe snapshots; the parent
 *     session will later back it with journal-scoped reads, which is why
 *     the contract is synchronous and strictly bounded.
 *   - {@link PrimeAgentLedger} receives spawn/reply/terminal/message
 *     evidence entries; the parent session pipes these into the
 *     `prime.agent_message.*` / `prime.subagent.*` journal vocabulary, so
 *     the registry keeps the evidence chain append-only and transport-free.
 *   - {@link PrimeSubagentHarnessStore} is the chat-scoped persistence slot
 *     for `setRlmMaxDepth` (mirrors prime-agent's `rlm_max_depth_state`
 *     custom entry) under the reserved entry id
 *     {@link SUBAGENT_MAX_DEPTH_ENTRY_ID}. Reads are synchronous because
 *     the depth gate resolves synchronously inside `spawn`.
 *
 * Layering: this file type-imports from ../runtime/types-prime (the frozen
 * contracts), ../ai/types, and ../agent only. It must not import from
 * src/core or src/sessions — the parent session is the sole bridge there.
 */

import type { Api, Model, Usage } from "../ai/types";
import type {
  PrimeAgentMessage,
  PrimeAgentMessageReceipt,
  PrimeAgentRole,
  PrimeAgentRouter,
  PrimeAgentRuntime,
  PrimeRuntimeEvent,
  PrimeSubagentHandle,
} from "../runtime/types-prime";

// The frozen contracts are re-exported so sibling modules (and tests) can
// import one module for both the frozen shapes and the registry's own
// ports, without ever duplicating a definition by hand.
export type {
  PrimeAgentMessage,
  PrimeAgentMessageReceipt,
  PrimeAgentRole,
  PrimeAgentRouter,
  PrimeAgentRuntime,
  PrimeRuntimeEvent,
  PrimeSubagentHandle,
} from "../runtime/types-prime";

/** Reserved harness-store kind for subagent-orchestration state entries. */
export const SUBAGENT_HARNESS_KIND = "subagent";

/**
 * Reserved harness-store entry id holding the chat-scoped RLM max-depth
 * override. Mirrors prime-agent's per-session `rlm_max_depth_state` custom
 * entry; chat scope (not global settings) wins the precedence race.
 */
export const SUBAGENT_MAX_DEPTH_ENTRY_ID = "subagent:max-depth";

/** Where the effective max depth came from; mirrors prime-agent's source vocabulary minus "inherited". */
export type PrimeMaxDepthSource = "default" | "env" | "global" | "chat";

export type PrimeMaxDepthStatus = Readonly<{
  maxDepth: number;
  source: PrimeMaxDepthSource;
}>;

/** Persisted shape of the chat-scoped max-depth entry (mirrors prime-agent's {maxDepth}). */
export interface PrimePersistedMaxDepthState {
  maxDepth: number;
}

/**
 * One agent's message intake. Owned by whatever runs that agent's turn
 * queue: the parent session for the owning node, the runtime factory's
 * child session for spawned subagents.
 */
export interface PrimeAgentMessageSink {
  /**
   * Take one message. "delivered" means the target session's queue accepted
   * it into context now; "queued" means accepted for later delivery. Any
   * other outcome must be a thrown descriptive error, never a silent drop.
   */
  accept(message: PrimeAgentMessage): Promise<"delivered" | "queued">;
  /**
   * Undelivered backlog depth. The router consults this BEFORE accepting so
   * the pending bound (max 20) refuses with a capacity error instead of
   * growing an unbounded queue behind a wedged session.
   */
  pendingCount(): number;
}

/**
 * Bounded, synchronous, read-only snapshot source for agent_observe.
 * Synchronous because the frozen `PrimeAgentRouter.recentMessages` contract
 * is synchronous; bounded because observe previews must never become a
 * transcript dump channel.
 */
export interface PrimeAgentRecorder {
  recentMessages(limit: number, maxChars: number): PrimeAgentMessage[];
}

/** Everything the runtime factory hands back per spawned child. */
export type PrimeAgentRuntimeBundle = Readonly<{
  runtime: PrimeAgentRuntime;
  sink: PrimeAgentMessageSink;
  recorder?: PrimeAgentRecorder;
}>;

/**
 * The admission record the runtime factory consumes. `prompt` is the raw
 * model-facing task text; `taskPrompt` is the wire form
 * `"[task from parent]\n\n<prompt>"` that prime-agent delivers as the
 * child's initial agent_message. `spawnMessage` is the fully addressed
 * envelope (id `spawn:<childId>`) the registry pumps into the child's sink.
 */
export type PrimeSubagentSpawnInput = Readonly<{
  childId: string;
  fromId: string;
  fromName: string;
  prompt: string;
  taskPrompt: string;
  name: string;
  slug: string;
  model: Model<Api>;
  depth: number;
  sessionPath: string;
  spawnMessage: PrimeAgentMessage;
}>;

/**
 * The host's runtime factory: build the child runtime from an admission.
 * Implementations must NOT run the task inline — they return the bundle and
 * the registry starts the run by delivering `spawnMessage` into the sink.
 */
export interface PrimeAgentRuntimeFactory {
  create(input: PrimeSubagentSpawnInput): Promise<PrimeAgentRuntimeBundle>;
}

/** Ledger event kinds; the producer and the validator must agree on these strings. */
export const SUBAGENT_LEDGER_KINDS = Object.freeze(["spawn", "reply", "terminal", "message"] as const);

export type PrimeAgentLedgerKind = (typeof SUBAGENT_LEDGER_KINDS)[number];

export type PrimeAgentLedgerEntry = Readonly<{
  kind: PrimeAgentLedgerKind;
  agentIds: readonly string[];
  detail?: Readonly<Record<string, unknown>>;
  at: number;
}>;

/**
 * Append-only evidence sink for subagent orchestration. The parent session
 * adapts entries into journal drafts; `append` may be asynchronous for
 * journal-backed implementations and the registry always awaits it, because
 * evidence ordering (spawn before terminal) must survive transport delays.
 */
export interface PrimeAgentLedger {
  append(entry: PrimeAgentLedgerEntry): void | Promise<void>;
}

/**
 * Chat-scoped persistence for the RLM max-depth override. Synchronous read
 * because the depth gate resolves synchronously inside `spawn`; the host
 * keeps an in-memory materialization of its journal behind this port.
 * Malformed reads must be treated as absent by the registry (fail-open on
 * corrupt state would otherwise brick every spawn in the chat).
 */
export interface PrimeSubagentHarnessStore {
  read(kind: string, id: string): unknown;
  write(kind: string, id: string, value: unknown): void | Promise<void>;
}

/**
 * Identity of the node that owns a registry (the session whose kernel calls
 * `rlm(...)`), plus the optional extra nodes the host attaches so the
 * nuclear-family walk can see parents, sibling roots, and deeper relatives.
 * `sink` is required on the owner (host-synthesized terminal notices are
 * delivered there) and optional on attached nodes (observation-only nodes
 * simply cannot be messaged; the router says so descriptively).
 */
export type PrimeAgentNodeAttachment = Readonly<{
  id: string;
  name: string;
  role: PrimeAgentRole;
  parentId?: string;
  depth: number;
  model: Model<Api>;
  sessionPath: string;
  sink?: PrimeAgentMessageSink;
  recorder?: PrimeAgentRecorder;
}>;

/** Spawn-time options; anything beyond name/model/depth is a TypeError in `spawn`. */
export interface PrimeSubagentSpawnOptions {
  name?: string;
  model?: string;
  depth?: number;
}

/**
 * Resolves an explicit model selector against the authenticated catalog.
 * Injected because only the parent session knows which providers are
 * authenticated; when absent, `spawn` refuses explicit selectors
 * (fail-closed) and always inherits the owner model.
 */
export type PrimeSubagentModelResolver = (
  requested: string | undefined,
  inherited: Model<Api>,
) => Model<Api> | Promise<Model<Api>>;

/** Constructor dependencies for the registry: every clock, coin, and catalog is injected. */
export interface PrimeAgentRegistryDeps {
  factory: PrimeAgentRuntimeFactory;
  owner: PrimeAgentNodeAttachment;
  ledger?: PrimeAgentLedger;
  harnessStore?: PrimeSubagentHarnessStore;
  /** Global max-depth setting (airship settings layer); chat-scope and env beat/lose per precedence. */
  globalMaxDepth?: number;
  /**
   * Injected environment map — the browser host has no process.env, so the
   * host passes its env snapshot through here. `RLM_MAX_DEPTH` is read from
   * this map only.
   */
  env?: Readonly<Record<string, string | undefined>>;
  modelResolver?: PrimeSubagentModelResolver;
  now?: () => number;
  /** Deterministic id source for tests; defaults to crypto.randomUUID(). */
  randomId?: () => string;
}

/** Router-side helper: the receipt plus the delivered/queued distinction the frozen shape flattens. */
export interface PrimeAgentRouteResult {
  receipt: PrimeAgentMessageReceipt;
}

/** Internal role labels used by the family walk; re-exported for tests. */
export type PrimeFamilyRelationship = "parent" | "sibling" | "child";

/** Usage view exposed by the registry (undefined before a runtime provides any). */
export type PrimeUsageView = Usage | undefined;
