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
 *     the contract is bounded in both time (sync signature) and size.
 *   - {@link PrimeAgentLedger} receives spawn/reply/terminal/message
 *     evidence entries; the parent session pipes these into the
 *     `prime.agent_message.*` / `prime.subagent.*` journal vocabulary, so
 *     the registry keeps the evidence chain append-only and transport-free.
 *   - The chat-scoped {@link PrimeHarnessStore} slot for `setRlmMaxDepth`:
 *     the registry persists the override as a harness entry of kind
 *     "subagent" under the reserved id {@link SUBAGENT_MAX_DEPTH_ENTRY_ID}
 *     (scope "local"), mirroring prime-agent's per-session
 *     `rlm_max_depth_state` custom entry.
 *
 * Layering: type-imports from ../runtime/types-prime (the frozen contracts),
 * ../ai/types only. It must not import from src/core or src/sessions — the
 * parent session is the sole bridge there.
 */

import type { Api, Model, Usage } from "../ai/types";
import type {
  PrimeAgentMessage,
  PrimeAgentMessageReceipt,
  PrimeAgentRole,
  PrimeAgentRouter,
  PrimeAgentRuntime,
  PrimeHarnessEntry,
  PrimeHarnessStore,
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
  PrimeHarnessEntry,
  PrimeHarnessStore,
  PrimeRuntimeEvent,
  PrimeSubagentHandle,
} from "../runtime/types-prime";

// Behavioral constants are frozen in ../runtime/types-prime (the producer
// and the validator must agree on a single number); re-export them so the
// port's own modules never define competing copies.
export {
  canonicalPrimeAgentName,
  DEFAULT_RLM_MAX_DEPTH,
  deriveDefaultSubagentName,
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_PENDING_AGENT_MESSAGES,
  MAX_SPAWN_PROMPT_CHARS,
  PRIME_MESSAGE_BURST_CAPACITY,
  PRIME_MESSAGE_REFILL_MS,
} from "../runtime/types-prime";

/**
 * Reserved harness-store entry id (kind "subagent", scope "local") holding
 * the chat-scoped RLM max-depth override; chat scope wins the precedence
 * race, per prime-agent's chat > global > env > default ordering.
 */
export const SUBAGENT_MAX_DEPTH_ENTRY_ID = "subagent:max-depth";

/** Harness scope the chat-scoped max-depth entry lives in. */
export const SUBAGENT_MAX_DEPTH_SCOPE = "local";

/** Where the effective max depth came from; mirrors prime-agent's source vocabulary minus "inherited". */
export type PrimeMaxDepthSource = "default" | "env" | "global" | "chat";

export type PrimeMaxDepthStatus = Readonly<{
  maxDepth: number;
  source: PrimeMaxDepthSource;
}>;

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
   * the pending bound (max 20) refuses with
   * a capacity error instead of growing an unbounded queue behind a wedged
   * session.
   */
  pendingCount(): number;
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

/** Constructor dependencies for the registry: every clock, coin, catalog, and env map is injected. */
export interface PrimeAgentRegistryDeps {
  factory: PrimeAgentRuntimeFactory;
  owner: PrimeAgentNodeAttachment;
  ledger?: PrimeAgentLedger;
  harnessStore?: PrimeHarnessStore;
  /** Global max-depth setting (airship settings layer); chat-scope beats it, env loses to it. */
  globalMaxDepth?: number;
  /**
   * Injected environment map — the browser host has no process.env, so the
   * host passes its env snapshot through here. `RLM_MAX_DEPTH` is read from
   * this map only.
   */
  env?: Readonly<Record<string, string | undefined>>;
  modelResolver?: PrimeSubagentModelResolver;
  now?: () => number;
  /** Deterministic id source for tests; defaults to randomUuid from core/id. */
  randomId?: () => string;
}

/** Internal role labels used by the family walk; re-exported for tests. */
export type PrimeFamilyRelationship = "parent" | "sibling" | "child";

/** Usage view exposed by the registry (undefined before a runtime provides any). */
export type PrimeUsageView = Usage | undefined;
