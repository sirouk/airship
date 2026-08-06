/**
 * Subagent orchestration for the prime port — the RLM recursion layer.
 *
 * Ported 1:1 in semantics from prime-agent `_startRlmChildRun`,
 * `agent-messages.ts`, and `agent-observe.ts`; adapted in transport from a
 * daemon/cross-process bus to airship's single-process registry +
 * per-agent sink queues, per the port-manifest §3.5 "transport collapses"
 * verdict. The semantic crown jewels that MUST NOT drift:
 *
 *   - Admission only (invariant 25): `spawn` validates, depth-gates,
 *     reserves the name, records, emits `subagent-admitted`, and returns the
 *     handle. The runtime factory is invoked inside a detached task whose
 *     answer is NEVER awaited by the spawn promise, so the parent never
 *     waits silently at spawn time.
 *   - Completion contract (invariant 26): a child either explicitly replies
 *     via `route.send` to its parent (emitted as `subagent-reply`, terminal
 *     reason "replied"), or when its turn loop ends the registry
 *     synthesizes `subagent-terminal` with reason
 *     "completed_without_reply" and a bounded last-assistant-text preview;
 *     failure names "failed"; `stop` names "stopped". For every non-reply
 *     terminal the registry also delivers a fixed-text notice into the
 *     owning session's sink: the parent ALWAYS hears finality, even when
 *     the child never spoke.
 *   - Nuclear-family reach (invariant 26): the router resolves targets only
 *     among parent, siblings, and direct children of the sender; anything
 *     else fails closed with the family-reach error text prime-agent uses.
 *
 * The registry is scoped to one owning node (the session whose kernel calls
 * `rlm(...)`), because the frozen `spawn(prompt, {name?, model?, depth?})`
 * signature carries no fromId: the owner IS the from. Extra nodes — the
 * owner's own parent, sibling roots, deeper relatives — are wired via
 * `attachNode` by the session authority so family walks stay correct in a
 * multi-level tree without weakening the singleton spawn scope.
 */

import type { AssistantMessage, Usage } from "../ai/types";
import type { AgentEvent, AgentMessage } from "../agent";
import {
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
import type {
  PrimeAgentMessage,
  PrimeAgentMessageReceipt,
  PrimeAgentRouter,
  PrimeAgentRuntime,
  PrimeRuntimeEvent,
  PrimeSubagentHandle,
} from "../runtime/types-prime";
import type {
  PrimeAgentLedger,
  PrimeAgentLedgerEntry,
  PrimeAgentNodeAttachment,
  PrimeAgentRecorder,
  PrimeAgentRegistryDeps,
  PrimeAgentRuntimeBundle,
  PrimeAgentRuntimeFactory,
  PrimeHarnessEntry,
  PrimeHarnessStore,
  PrimeMaxDepthStatus,
  PrimeSubagentModelResolver,
  PrimeSubagentSpawnInput,
  PrimeSubagentSpawnOptions,
  PrimeUsageView,
} from "./types";
import { SUBAGENT_MAX_DEPTH_ENTRY_ID, SUBAGENT_MAX_DEPTH_SCOPE } from "./types";

/** Terminal-preview bound so completed_without_reply notices cannot smuggle whole transcripts into the parent. */
export const MAX_PREVIEW_CHARS = 512;
/** Observe clamp bounds; mirror prime-agent normalizeObserveLimit / normalizeObserveMaxChars. */
export const OBSERVE_MAX_LIMIT = 50;
export const OBSERVE_MIN_MAX_CHARS = 80;
export const OBSERVE_MAX_MAX_CHARS = 2_000;
/** The one sentence the family walk and prime-agent must agree on. */
export const AGENT_FAMILY_REACH_ERROR = "Agent reach is limited to parent, siblings, and children";

/** Allowed spawn option keys; anything else is a descriptive TypeError (unsupported rlm.run kwargs). */
const SPAWN_OPTION_KEYS = Object.freeze(["name", "model", "depth"] as const);

type ChildStatus = PrimeSubagentHandle["status"];
type TerminalReason = "replied" | "completed_without_reply" | "failed" | "stopped";

interface ChildEntry {
  readonly id: string;
  readonly name: string;
  readonly parentId: string;
  readonly depth: number;
  readonly model: PrimeSubagentHandle["model"];
  readonly sessionPath: string;
  readonly prompt: string;
  readonly createdAt: number;
  status: ChildStatus;
  bundle?: PrimeAgentRuntimeBundle;
  unsubscribeEvents?: () => void;
  settled: boolean;
  stopRequested: boolean;
  stopReason?: string;
  replied: boolean;
  replyPreview?: string;
  lastAssistantText?: string;
  usage?: Usage;
}

/**
 * Catalog node: owner, spawned child, or host-attached relative. Sinks and
 * recorders live here (not on the frozen runtime type) so messaging and
 * observation work uniformly for every agent the registry knows.
 */
interface CatalogNode {
  readonly id: string;
  readonly name: string;
  readonly role: PrimeSubagentHandle["role"];
  readonly parentId?: string;
  readonly depth: number;
  readonly model: PrimeSubagentHandle["model"];
  readonly sessionPath: string;
  sink?: PrimeAgentRegistryDeps["owner"]["sink"];
  recorder?: PrimeAgentRecorder;
  status: ChildStatus;
}

/** Token bucket per sender, ported 1:1 from prime-agent AgentSessionMessageRateLimiter. */
class MessageRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly now: () => number,
  ) {}

  tryConsume(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const refilledTokens = Math.floor(elapsed / this.refillMs);
    if (refilledTokens > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refilledTokens);
      bucket.updatedAt += refilledTokens * this.refillMs;
    }
    if (bucket.tokens <= 0) {
      this.buckets.set(key, bucket);
      return { ok: false, retryAfterMs: Math.max(1, bucket.updatedAt + this.refillMs - now) };
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { ok: true };
  }
}

/**
 * Fail-closed guard for the frozen spawn signature: the kernel passes
 * through arbitrary kwargs and prime-agent's rule is that anything beyond
 * name/model (plus depth in this port's contract) is a hard complaint, not
 * a silent ignore.
 */
function assertSupportedSpawnOptions(options: Record<string, unknown>): void {
  const unsupported = Object.keys(options).filter((key) => !(SPAWN_OPTION_KEYS as readonly string[]).includes(key));
  if (unsupported.length > 0) {
    throw new TypeError(`Unsupported rlm.run kwargs: ${unsupported.sort().join(", ")}`);
  }
}

/**
 * Name normalization: the error text stays upstream-descriptive per rule,
 * while the charset verdict itself delegates to canonicalPrimeAgentName so
 * this port and every other prime module accept exactly the same names.
 */
function normalizeSpawnName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("rlm.run name must be a string");
  const name = value.trim();
  if (!name) throw new Error("rlm.run name must not be empty");
  if (name.length > MAX_AGENT_NAME_CHARS) {
    throw new Error(`rlm.run name must be at most ${MAX_AGENT_NAME_CHARS} characters`);
  }
  if (canonicalPrimeAgentName(name) === undefined) {
    throw new Error(`rlm.run name contains unsupported characters: use letters, digits, ".", "-" and "_" and start with a letter or digit`);
  }
  return name;
}

function normalizeSpawnModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("rlm.run model must be a string");
  const model = value.trim();
  if (!model) throw new Error("rlm.run model must not be empty");
  return model;
}

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("rlm.run depth must be a non-negative integer");
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Env parse; mirrors prime-agent parseDepth: digits-only strings, anything else is a named error. */
function parseEnvDepth(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!isNonNegativeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function readAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function boundedPreview(text: string): string {
  return text.length <= MAX_PREVIEW_CHARS ? text : text.slice(0, MAX_PREVIEW_CHARS);
}

export class PrimeAgentRegistry {
  private readonly factory: PrimeAgentRuntimeFactory;
  private readonly ledger?: PrimeAgentLedger;
  private readonly harnessStore?: PrimeHarnessStore;
  private readonly globalMaxDepth?: number;
  private readonly env?: Readonly<Record<string, string | undefined>>;
  private readonly modelResolver?: PrimeSubagentModelResolver;
  private readonly now: () => number;
  private readonly randomId: () => string;

  private readonly nodes = new Map<string, CatalogNode>();
  private readonly children = new Map<string, ChildEntry>();
  private readonly pendingNames = new Set<string>();
  private readonly listeners = new Set<(event: PrimeRuntimeEvent) => void>();
  private readonly rateLimiter: MessageRateLimiter;
  private readonly owner: CatalogNode;
  private chatMaxDepth?: number;

  /** Frozen router surface; built once so callers can hold the reference. */
  readonly route: PrimeAgentRouter;

  constructor(deps: PrimeAgentRegistryDeps) {
    this.factory = deps.factory;
    this.ledger = deps.ledger;
    this.harnessStore = deps.harnessStore;
    this.globalMaxDepth = deps.globalMaxDepth;
    this.env = deps.env;
    this.modelResolver = deps.modelResolver;
    this.now = deps.now ?? (() => Date.now());
    this.randomId = deps.randomId ?? (() => globalThis.crypto.randomUUID());
    this.rateLimiter = new MessageRateLimiter(PRIME_MESSAGE_BURST_CAPACITY, PRIME_MESSAGE_REFILL_MS, this.now);
    if (!deps.owner.sink) {
      // Fail closed: without an owner sink the host-synthesized terminal
      // notices (the "parent always hears finality" contract) would have
      // nowhere to go and dead children would look alive forever.
      throw new Error("PrimeAgentRegistry requires owner.sink so terminal notices always reach the parent session");
    }
    this.owner = this.materializeNode(deps.owner, "running");
    this.nodes.set(this.owner.id, this.owner);
    this.route = Object.freeze({
      reachableAgents: (fromId) => this.reachableAgents(fromId),
      send: (message) => this.sendMessage(message),
      recentMessages: (agentId, limit, maxChars) => this.recentMessages(agentId, limit, maxChars),
    });
  }

  // ============================ admission (spawn) ============================

  /**
   * Admit a subagent run. Resolves at ADMISSION with the handle and never
   * with the answer: validation, the depth gate, the name reservation, the
   * model resolution, the admission record, and the `subagent-admitted`
   * event all happen before the detached task below touches the runtime
   * factory.
   */
  async spawn(prompt: string, options: PrimeSubagentSpawnOptions = {}): Promise<PrimeSubagentHandle> {
    assertSupportedSpawnOptions(options as Record<string, unknown>);
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("rlm.run prompt must be a non-empty string");
    }
    if (prompt.length > MAX_SPAWN_PROMPT_CHARS) {
      throw new Error(`rlm.run prompt is too long: ${prompt.length} chars exceeds ${MAX_SPAWN_PROMPT_CHARS}`);
    }
    const requestedName = normalizeSpawnName(options.name);
    const requestedModel = normalizeSpawnModel(options.model);
    const currentDepth = normalizeSpawnDepth(options.depth) ?? this.owner.depth;
    const depthStatus = await this.resolveMaxDepth();
    if (currentDepth >= depthStatus.maxDepth) {
      throw new Error(
        `RLM recursion depth limit reached (RLM_DEPTH=${currentDepth}, RLM_MAX_DEPTH=${depthStatus.maxDepth})`,
      );
    }

    const childDepth = currentDepth + 1;
    const name = requestedName ?? deriveDefaultSubagentName(prompt, this.randomHex(8));
    this.assertNameAvailable(name, childDepth);
    if (this.pendingNames.has(name)) {
      throw new Error(
        `Agent name "${name}" is unavailable: an agent of that name already exists at depth ${childDepth} under this parent`,
      );
    }
    // Pending reservation wraps the awaited model resolution so two spawns
    // racing on the same tick cannot both pass the catalog check first.
    this.pendingNames.add(name);
    try {
      const model = await this.resolveSpawnModel(requestedModel);
      this.assertNameAvailable(name, childDepth);

      const childId = `sub-${this.randomHex(8)}`;
      const sessionPath = `${this.owner.sessionPath}/${childId}`;
      const entry: ChildEntry = {
        id: childId,
        name,
        parentId: this.owner.id,
        depth: childDepth,
        model,
        sessionPath,
        prompt,
        createdAt: this.now(),
        status: "running",
        settled: false,
        stopRequested: false,
        replied: false,
      };
      this.children.set(childId, entry);
      this.nodes.set(childId, {
        id: childId,
        name,
        role: "subagent",
        parentId: this.owner.id,
        depth: childDepth,
        model,
        sessionPath,
        status: "running",
      });
      this.emit({ type: "subagent-admitted", handle: this.handleSnapshot(childId) });
      await this.appendLedger({ kind: "spawn", agentIds: [this.owner.id, childId], detail: { name, depth: childDepth }, at: this.now() });

      const spawnInput = this.materializeSpawnInput(entry, prompt);
      // Deliberately detached: the factory, the child's whole run, and its
      // settlement must never hold the spawn promise hostage. Every failure
      // path inside settles the run instead of rejecting into the void,
      // because an unhandled rejection here would surface as a host crash
      // while the child silently stayed "running".
      void this.detachedSpawnExecution(entry, spawnInput);
      return this.handleSnapshot(childId);
    } finally {
      this.pendingNames.delete(name);
    }
  }

  /** Everything the registry itself spawned; completed children stay listed until reaped. */
  list(): PrimeSubagentHandle[] {
    return [...this.children.keys()].map((id) => this.handleSnapshot(id));
  }

  /** The live runtime for one spawned child, by id or name; the owner has no runtime here (its loop is host-owned). */
  get(idOrName: string): PrimeAgentRuntime | undefined {
    const entry = this.childByRef(idOrName);
    return entry?.bundle?.runtime;
  }

  /** Registry event stream; listener failures are contained (events are a side channel, never the spine). */
  onEvent(listener: (event: PrimeRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Drain completed children: best-effort `stop` on their runtimes, drop
   * their catalog records and event subscriptions, return the count reaped.
   * Running children are architecturally out of scope — reaping a running
   * child is what `stop` is for.
   */
  async reapCompleted(): Promise<number> {
    let count = 0;
    for (const entry of [...this.children.values()]) {
      if (entry.status === "running") continue;
      entry.unsubscribeEvents?.();
      if (entry.bundle) {
        await entry.bundle.runtime.stop("reaped").catch(() => undefined);
      }
      this.children.delete(entry.id);
      this.nodes.delete(entry.id);
      count += 1;
    }
    return count;
  }

  /**
   * Stop one running child (by id or name). A stop requested before the
   * factory comes back is remembered and applied the moment the bundle
   * arrives; either way the run settles exactly once with terminal reason
   * "stopped".
   */
  async stop(idOrName: string, reason = "stopped by parent"): Promise<boolean> {
    const entry = this.childByRef(idOrName);
    if (!entry) return false;
    if (entry.settled || entry.status !== "running") return false;
    entry.stopRequested = true;
    entry.stopReason = reason;
    if (entry.bundle) {
      await entry.bundle.runtime.stop(reason).catch(() => undefined);
      this.settleStopped(entry, reason);
    }
    return true;
  }

  /**
   * Usage folded for the parent session's attribution: live from the runtime
   * while running, latched at settlement afterwards. The registry EXPOSES
   * this; the parent session records the attribution — the registry must
   * never write into the parent account.
   */
  usageOf(handleId: string): PrimeUsageView {
    const entry = this.childByRef(handleId);
    if (!entry) return undefined;
    if (entry.usage) return entry.usage;
    return this.captureUsage(entry);
  }

  // ========================== depth configuration ==========================

  /**
   * Chat-scoped max-depth override: persisted through the frozen harness
   * store under the reserved `subagent:max-depth` entry (kind "subagent",
   * scope "local") with optimistic-concurrency semantics, then effective
   * immediately in memory either way.
   */
  async setRlmMaxDepth(maxDepth: number): Promise<void> {
    if (!isNonNegativeInteger(maxDepth)) {
      throw new Error("RLM max depth must be a non-negative integer.");
    }
    if (this.harnessStore) {
      const existing = await this.harnessStore.get(SUBAGENT_MAX_DEPTH_SCOPE, "subagent", SUBAGENT_MAX_DEPTH_ENTRY_ID);
      if (existing) {
        await this.harnessStore.update(
          SUBAGENT_MAX_DEPTH_SCOPE,
          "subagent",
          SUBAGENT_MAX_DEPTH_ENTRY_ID,
          { content: String(maxDepth), metadata: { maxDepth } },
          { expectedVersion: existing.version },
        );
      } else {
        await this.harnessStore.create(SUBAGENT_MAX_DEPTH_SCOPE, {
          id: SUBAGENT_MAX_DEPTH_ENTRY_ID,
          kind: "subagent",
          title: "RLM max depth (chat-scoped override)",
          content: String(maxDepth),
          metadata: { maxDepth },
        });
      }
    }
    this.chatMaxDepth = maxDepth;
  }

  /**
   * Effective max depth with precedence chat > global setting > env
   * (RLM_MAX_DEPTH numeric string) > default(1). A malformed env value is the
   * named parse error prime-agent throws; a corrupt harness entry is treated
   * as absent so a bad persisted record cannot brick every spawn in the chat.
   */
  async getMaxDepthStatus(): Promise<PrimeMaxDepthStatus> {
    return this.resolveMaxDepth();
  }

  // ============================ host integration ===========================

  /**
   * Wire an extra family node (the owner's parent, sibling roots, deeper
   * relatives). Spawned children never need manual attachment — admission
   * does it. Id and name collisions fail closed with the same unavailable
   * text as spawn, because a duplicate handle would make name routing a
   * coin flip.
   */
  attachNode(node: PrimeAgentNodeAttachment): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Agent id "${node.id}" is already registered in this agent family`);
    }
    this.assertNameAvailable(node.name, node.depth);
    const materialized = this.materializeNode(node, "idle");
    this.nodes.set(materialized.id, materialized);
  }

  // ============================ internal: spawn ============================

  private materializeSpawnInput(entry: ChildEntry, prompt: string): PrimeSubagentSpawnInput {
    const taskPrompt = `[task from parent]\n\n${prompt}`;
    const spawnMessage: PrimeAgentMessage = Object.freeze({
      id: `spawn:${entry.id}`,
      fromId: this.owner.id,
      fromName: this.owner.name,
      toId: entry.id,
      toName: entry.name,
      content: taskPrompt,
      timestamp: this.now(),
    });
    const slug = prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return {
      childId: entry.id,
      fromId: this.owner.id,
      fromName: this.owner.name,
      prompt,
      taskPrompt,
      name: entry.name,
      slug: slug.length > 0 ? slug : "task",
      model: entry.model,
      depth: entry.depth,
      sessionPath: entry.sessionPath,
      spawnMessage,
    };
  }

  /**
   * The run itself: factory without being awaited by spawn, task delivery
   * through the sink, event mapping, settlement. A factory throw settles
   * "stopped" — the registry owns orchestration even when the host cannot
   * start the child — and never an unhandled rejection.
   */
  private async detachedSpawnExecution(entry: ChildEntry, input: PrimeSubagentSpawnInput): Promise<void> {
    try {
      const bundle = await this.factory.create(input);
      if (entry.stopRequested) {
        await bundle.runtime.stop(entry.stopReason ?? "stopped by parent").catch(() => undefined);
        this.settleStopped(entry, entry.stopReason ?? "stopped by parent");
        return;
      }
      entry.bundle = bundle;
      const node = this.nodes.get(entry.id);
      if (node) {
        node.sink = bundle.sink;
        node.recorder = bundle.recorder;
      }
      entry.unsubscribeEvents = bundle.runtime.agent.subscribe((event) => this.onChildAgentEvent(entry, event));
      // Task delivery is plumbing, not conversation: it bypasses the rate
      // limiter and the pending bound on purpose (a child must always
      // receive its spawn task), but it still lands in the ledger.
      const delivery = await bundle.sink.accept(input.spawnMessage);
      await this.appendLedger({
        kind: "message",
        agentIds: [this.owner.id, entry.id],
        detail: { messageId: input.spawnMessage.id, deliveryStatus: delivery, task: true },
        at: this.now(),
      });
      this.emit({ type: "subagent-update", handle: this.handleSnapshot(entry.id) });
    } catch (error) {
      this.settleStopped(entry, error instanceof Error ? error.message : String(error));
    }
  }

  private onChildAgentEvent(entry: ChildEntry, event: AgentEvent): void {
    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const text = readAssistantText(event.message);
      if (text) entry.lastAssistantText = text;
    }
    if (event.type === "agent_end" && !entry.settled) {
      this.settleFromAgentEnd(entry, event.messages);
      return;
    }
    this.emit({ type: "subagent-update", handle: this.handleSnapshot(entry.id) });
  }

  /** Turn-end settlement: the completion contract for children whose loop finished. */
  private settleFromAgentEnd(entry: ChildEntry, messages: readonly AgentMessage[]): void {
    if (entry.stopRequested) {
      this.settleStopped(entry, entry.stopReason ?? "stopped by parent");
      return;
    }
    let lastAssistant: AssistantMessage | undefined;
    for (const message of messages) {
      if (isAssistantMessage(message)) lastAssistant = message;
    }
    if (lastAssistant) {
      const text = readAssistantText(lastAssistant);
      if (text) entry.lastAssistantText = text;
    }
    const errorMessage = entry.bundle?.runtime.agent.state.errorMessage;
    if (lastAssistant && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")) {
      this.settleFailed(entry, lastAssistant.errorMessage ?? errorMessage ?? "unknown error");
      return;
    }
    if (errorMessage) {
      this.settleFailed(entry, errorMessage);
      return;
    }
    if (entry.replied) {
      this.settle(entry, "replied", entry.replyPreview);
      return;
    }
    this.settle(entry, "completed_without_reply", entry.lastAssistantText);
  }

  private settleStopped(entry: ChildEntry, reason: string): void {
    this.settle(entry, "stopped", reason);
  }

  private settleFailed(entry: ChildEntry, error: string): void {
    this.settle(entry, "failed", error);
  }

  private settle(entry: ChildEntry, reason: TerminalReason, preview?: string): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.status = reason === "failed" ? "failed" : reason === "stopped" ? "stopped" : "idle";
    entry.usage = entry.usage ?? this.captureUsage(entry);
    const node = this.nodes.get(entry.id);
    if (node) node.status = entry.status;
    const bounded = preview ? boundedPreview(preview) : undefined;
    const terminal: PrimeRuntimeEvent = bounded
      ? { type: "subagent-terminal", handle: this.handleSnapshot(entry.id), reason, preview: bounded }
      : { type: "subagent-terminal", handle: this.handleSnapshot(entry.id), reason };
    this.emit(terminal);
    void this.appendLedger({
      kind: "terminal",
      agentIds: [this.owner.id, entry.id],
      detail: { reason, ...(bounded ? { preview: bounded } : {}) },
      at: this.now(),
    });
    if (reason !== "replied") {
      // The parent always hears finality: a host-synthesized notice straight
      // into the owner's sink, deliberately bypassing the rate limiter (this
      // is the host speaking for the child, not conversation). Sink failures
      // are swallowed because delivery — not finality — is what failed:
      // finality already went out as the terminal event above.
      const notice = this.materializeTerminalNotice(entry, reason, bounded);
      void this.owner.sink?.accept(notice).catch(() => undefined);
    }
  }

  /** The fixed notice text prime-agent uses for its terminal/failure cards. */
  private materializeTerminalNotice(
    entry: ChildEntry,
    reason: Exclude<TerminalReason, "replied">,
    preview?: string,
  ): PrimeAgentMessage {
    const content =
      reason === "failed"
        ? `RLM child ${entry.name} (${entry.id}) failed: ${preview ?? "unknown error"}`
        : reason === "stopped"
          ? `RLM child ${entry.name} (${entry.id}) was stopped: ${preview ?? "no reason given"}`
          : `RLM child ${entry.name} (${entry.id}) completed without sending a reply${preview ? `. Last assistant text: ${preview}` : ""}`;
    return Object.freeze({
      id: `agentmsg_${this.randomId()}`,
      fromId: entry.id,
      fromName: entry.name,
      toId: this.owner.id,
      toName: this.owner.name,
      content,
      timestamp: this.now(),
    });
  }

  // ============================ internal: router ===========================

  /** Nuclear-family walk: parent, siblings (same parent; roots share none), direct children. */
  private reachableAgents(fromId: string): PrimeSubagentHandle[] {
    const from = this.nodes.get(fromId) ?? this.nodeByName(fromId);
    if (!from) {
      throw new Error(`Agent "${fromId}" is not registered in this agent family`);
    }
    const out: CatalogNode[] = [];
    if (from.parentId !== undefined) {
      const parent = this.nodes.get(from.parentId);
      if (parent) out.push(parent);
    }
    for (const node of this.nodes.values()) {
      if (node.id !== from.id && node.parentId === from.parentId) out.push(node);
    }
    for (const node of this.nodes.values()) {
      if (node.parentId === from.id) out.push(node);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name)).map((node) => this.nodeSnapshot(node));
  }

  private async sendMessage(input: { fromId: string; toId: string; content: string }): Promise<PrimeAgentMessageReceipt> {
    const { fromId, toId, content } = input;
    const from = this.nodes.get(fromId) ?? this.nodeByName(fromId);
    if (!from) {
      throw new Error(`Agent "${fromId}" is not registered in this agent family`);
    }
    const text = content.trim();
    if (!text) {
      throw new Error("Agent session message cannot be empty");
    }
    if (text.length > MAX_AGENT_MESSAGE_CHARS) {
      throw new Error(`Agent session message is too long: ${text.length} chars exceeds ${MAX_AGENT_MESSAGE_CHARS}`);
    }
    const target = this.resolveReachableTarget(from, toId);
    if (!target.sink) {
      // Optional degradation is NAMED, never phantom: an attached node with
      // no live queue is observable but not addressable.
      throw new Error(`Agent "${toId}" (${target.name}) has no live message sink`);
    }
    const pending = target.sink.pendingCount();
    if (pending >= MAX_PENDING_AGENT_MESSAGES) {
      throw new Error(
        `Target session has too many pending messages: ${pending} unfinished, limit is ${MAX_PENDING_AGENT_MESSAGES}`,
      );
    }
    const messageId = `agentmsg_${this.randomId()}`;
    const grant = this.rateLimiter.tryConsume(from.id);
    if (!grant.ok) {
      return {
        delivered: false,
        queued: false,
        messageId,
        reason: `Rate limit exceeded for sender "${from.name}" (${from.id}): retry after ${grant.retryAfterMs}ms`,
      };
    }
    const message: PrimeAgentMessage = Object.freeze({
      id: messageId,
      fromId: from.id,
      fromName: from.name,
      toId: target.id,
      toName: target.name,
      content: text,
      timestamp: this.now(),
    });
    const status = await target.sink.accept(message);
    await this.appendLedger({
      kind: "message",
      agentIds: [from.id, target.id],
      detail: { messageId, deliveryStatus: status },
      at: this.now(),
    });
    if (from.parentId !== undefined && from.parentId === target.id) {
      this.recordReply(from.id, message);
    }
    return { delivered: status === "delivered", queued: status === "queued", messageId };
  }

  /** agent_observe: bounded snapshots, family-scoped from the owner's point of view (the owner itself is observable). */
  private recentMessages(agentId: string, limit: number, maxChars: number): PrimeAgentMessage[] {
    if (!Number.isInteger(limit)) throw new Error("agent_observe limit must be an integer");
    if (limit < 1 || limit > OBSERVE_MAX_LIMIT) {
      throw new Error(`agent_observe limit must be between 1 and ${OBSERVE_MAX_LIMIT}`);
    }
    if (!Number.isInteger(maxChars)) throw new Error("agent_observe max_chars must be an integer");
    if (maxChars < OBSERVE_MIN_MAX_CHARS || maxChars > OBSERVE_MAX_MAX_CHARS) {
      throw new Error(`agent_observe max_chars must be between ${OBSERVE_MIN_MAX_CHARS} and ${OBSERVE_MAX_MAX_CHARS}`);
    }
    if (agentId !== this.owner.id && agentId !== this.owner.name) {
      this.resolveReachableTarget(this.owner, agentId);
    }
    const node = this.nodes.get(agentId) ?? this.nodeByName(agentId);
    if (!node?.recorder) {
      throw new Error(`Agent "${agentId}" has no message recorder available`);
    }
    // The backing store is bounded by contract; clip anyway because a future
    // journal-backed recorder must not be able to break the bound.
    return node.recorder.recentMessages(limit, maxChars).map((message) =>
      message.content.length <= maxChars ? message : { ...message, content: message.content.slice(0, maxChars) },
    );
  }

  private recordReply(fromId: string, message: PrimeAgentMessage): void {
    const entry = this.children.get(fromId);
    if (!entry) return;
    entry.replied = true;
    entry.replyPreview = boundedPreview(message.content);
    this.emit({ type: "subagent-reply", handle: this.handleSnapshot(entry.id), message });
    void this.appendLedger({
      kind: "reply",
      agentIds: [entry.id, this.owner.id],
      detail: { messageId: message.id },
      at: this.now(),
    });
  }

  // ============================ internal: helpers ==========================

  private emit(event: PrimeRuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener bugs must not corrupt orchestration; the event stream is
        // a side channel and a throwing observer may still be detached later.
      }
    }
  }

  private materializeNode(node: PrimeAgentNodeAttachment, status: ChildStatus): CatalogNode {
    return {
      id: node.id,
      name: node.name,
      role: node.role,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      depth: node.depth,
      model: node.model,
      sessionPath: node.sessionPath,
      ...(node.sink !== undefined ? { sink: node.sink } : {}),
      ...(node.recorder !== undefined ? { recorder: node.recorder } : {}),
      status,
    };
  }

  private childByRef(idOrName: string): ChildEntry | undefined {
    return this.children.get(idOrName) ?? [...this.children.values()].find((entry) => entry.name === idOrName);
  }

  private nodeByName(name: string): CatalogNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.name === name) return node;
    }
    return undefined;
  }

  /**
   * Nuclear-family resolution: a named ref is addressable only if it is the
   * parent, a sibling, or a direct child. The error names BOTH the requested
   * target and the sender beside the reach rule, mirroring prime-agent's
   * one-descriptive-sentence tone.
   */
  private resolveReachableTarget(from: CatalogNode, ref: string): CatalogNode {
    const reachable = new Set<string>();
    if (from.parentId !== undefined) reachable.add(from.parentId);
    for (const node of this.nodes.values()) {
      if (node.id !== from.id && node.parentId === from.parentId) reachable.add(node.id);
      if (node.parentId === from.id) reachable.add(node.id);
    }
    const candidate = this.nodes.get(ref) ?? this.nodeByName(ref);
    if (candidate && reachable.has(candidate.id)) return candidate;
    throw new Error(
      `Agent "${ref}" is unreachable from "${from.id}": ${AGENT_FAMILY_REACH_ERROR} (nuclear family: parent, siblings, direct children)`,
    );
  }

  /**
   * Names are unique among siblings GLOBALLY (the freeze's consolidation of
   * the prime-agent upstream rule): across every node this registry knows,
   * regardless of parent edge, plus pending admissions (checked separately
   * at the spawn call site so a spawn never fails on its own reservation).
   */
  private assertNameAvailable(name: string, depth: number): void {
    if (this.nodeByName(name)) {
      throw new Error(
        `Agent name "${name}" is unavailable: an agent of that name already exists at depth ${depth} under this parent`,
      );
    }
  }

  private async resolveSpawnModel(requested: string | undefined): Promise<ChildEntry["model"]> {
    if (this.modelResolver) {
      return this.modelResolver(requested, this.owner.model);
    }
    if (requested !== undefined) {
      // Fail closed: only the parent session can authenticate a catalog, so
      // an unresolvable selector is an error, never a silent inherit.
      throw new Error(`rlm.run model "${requested}" cannot be resolved: no model catalog resolver is wired`);
    }
    return this.owner.model;
  }

  private async resolveMaxDepth(): Promise<PrimeMaxDepthStatus> {
    const persisted = this.chatMaxDepth ?? (await this.readHarnessMaxDepth());
    if (persisted !== undefined) {
      return { maxDepth: persisted, source: "chat" };
    }
    if (this.globalMaxDepth !== undefined) {
      return { maxDepth: this.globalMaxDepth, source: "global" };
    }
    const env = this.env?.RLM_MAX_DEPTH;
    if (env !== undefined && env !== "") {
      return { maxDepth: parseEnvDepth(env, "RLM_MAX_DEPTH"), source: "env" };
    }
    return { maxDepth: DEFAULT_RLM_MAX_DEPTH, source: "default" };
  }

  private async readHarnessMaxDepth(): Promise<number | undefined> {
    if (!this.harnessStore) return undefined;
    const entry = await this.harnessStore.get(SUBAGENT_MAX_DEPTH_SCOPE, "subagent", SUBAGENT_MAX_DEPTH_ENTRY_ID);
    if (!entry || entry.kind !== "subagent") return undefined;
    const fromMetadata = (entry.metadata as { maxDepth?: unknown } | undefined)?.maxDepth;
    if (isNonNegativeInteger(fromMetadata)) return fromMetadata;
    if (/^\d+$/.test(entry.content)) {
      const parsed = Number(entry.content);
      if (isNonNegativeInteger(parsed)) return parsed;
    }
    return undefined;
  }

  private captureUsage(entry: ChildEntry): Usage | undefined {
    if (!entry.bundle) return undefined;
    try {
      return entry.bundle.runtime.usage();
    } catch {
      return undefined;
    }
  }

  private async appendLedger(entry: PrimeAgentLedgerEntry): Promise<void> {
    if (!this.ledger) return;
    await this.ledger.append(entry);
  }

  private handleSnapshot(childId: string): PrimeSubagentHandle {
    const entry = this.children.get(childId);
    if (!entry) throw new Error(`No subagent registered under id "${childId}"`);
    return Object.freeze({
      id: entry.id,
      name: entry.name,
      role: "subagent" as const,
      parentId: entry.parentId,
      depth: entry.depth,
      model: entry.model,
      sessionPath: entry.sessionPath,
      status: entry.status,
    });
  }

  private nodeSnapshot(node: CatalogNode): PrimeSubagentHandle {
    return Object.freeze({
      id: node.id,
      name: node.name,
      role: node.role,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      depth: node.depth,
      model: node.model,
      sessionPath: node.sessionPath,
      status: node.status,
    });
  }

  private randomHex(length: number): string {
    const hex = this.randomId().replace(/[^a-fA-F0-9]/g, "").toLowerCase();
    return (hex + "00000000").slice(0, length);
  }
}

/**
 * Default in-memory ledger for hosts that have not wired the journal yet.
 * Entries are retrievable in append order; evidence ordering is the whole
 * point, so `entries()` never sorts.
 */
export class InMemoryPrimeAgentLedger implements PrimeAgentLedger {
  private readonly recorded: PrimeAgentLedgerEntry[] = [];

  append(entry: PrimeAgentLedgerEntry): void {
    this.recorded.push(entry);
  }

  entries(): readonly PrimeAgentLedgerEntry[] {
    return this.recorded;
  }
}

export function createInMemoryPrimeAgentLedger(): InMemoryPrimeAgentLedger {
  return new InMemoryPrimeAgentLedger();
}
