/**
 * Prime runtime contracts: the seam between the prime tool surface
 * (src/prime/tools/*) and the session orchestration authority.
 *
 * Why this module is types-only: the RLM tools (spawn, message, observe,
 * subagent management) must not *be* the runtime. Spawning a child session,
 * routing a message across sessions, and reaping completed children are
 * session-orchestration concerns owned by the prime session authority;
 * the tools only admit, address, and observe through these ports. Keeping
 * every contract here — and only here — means the tool surface and the
 * orchestrator agree on one spelling of admission, reach, and receipt
 * without importing each other's modules.
 *
 * The invariants this vocabulary carries (port manifest §3.5, invariants
 * 25 and 26):
 *   - admission semantics: spawn returns a handle immediately and never
 *     the child's answer; the answer, when one is owed, arrives as an
 *     agent message;
 *   - the nuclear family: an agent may message or observe only its
 *     parent, its siblings, and its direct children; deeper reach is a
 *     relay through the intermediate child, not a wider address space;
 *   - depth is a hard gate: depth >= maxDepth refuses spawn, with the
 *     refusal naming the bound;
 *   - admission returns a handle immediately and never the answer.
 */

export const PRIME_AGENT_NAME_MAX_CHARS = 64;
/** Upstream message budget (manifest invariant 26): 16,384 chars per agent message. */
export const PRIME_AGENT_MESSAGE_MAX_CHARS = 16_384;
/** Pending messages per session before send is rejected as data, from prime-agent invariant 26. */
export const PRIME_AGENT_MESSAGE_PENDING_CAP = 20;
/** Token-bucket capacity for one sender: 3 messages per burst, one token refilled per second. */
export const PRIME_MESSAGE_BURST_CAPACITY = 3;
export const PRIME_MESSAGE_REFILL_MS = 1_000;
/** Hard ceiling on one message, carried verbatim from the upstream family-routing invariant. */
export const MAX_AGENT_MESSAGE_CHARS = 16_384;
/** Pending per session beyond which a send is refused rather than silently delayed. */
export const MAX_PENDING_AGENT_MESSAGES = 20;
/** Root sessions are depth 0; the default depth gate refuses spawn at depth >= 1. */
export const DEFAULT_RLM_MAX_DEPTH = 1;
/** Agent names share the skill-name discipline: readable, stable, URL-and-log safe. */
export const MAX_AGENT_NAME_CHARS = 64;
/** Spawn prompt bound: a task prompt is a brief, not a transcript. */
export const MAX_SPAWN_PROMPT_CHARS = 16 * 1_024;

export type PrimeAgentId = string;

/**
 * The reach vocabulary, scoped to the nuclear family: parent, siblings,
 * and direct children. Roots are siblings of one another, and anything
 * deeper relays through the intermediate child — the tools enforce the
 * same rule upstream asserts with `assertAgentFamilyReach`.
 */
export const PRIME_AGENT_FAMILY_ROLES = Object.freeze(["parent", "sibling", "child"] as const);
export type PrimeAgentFamilyRole = (typeof PRIME_AGENT_FAMILY_ROLES)[number];

export const PRIME_AGENT_STATES = Object.freeze([
  "running",
  "idle",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const);
export type PrimeAgentState = (typeof PRIME_AGENT_STATES)[number];

/**
 * A family-roster row, already bounded to what the observer is allowed to
 * know. `role` is relative to the observer, so two agents never agree on
 * a shared mislabeled snapshot: a sibling of the parent is invisible, not
 * mislabeled "uncle".
 */
export type PrimeAgentSummary = Readonly<{
  id: string;
  name: string;
  role: PrimeAgentFamilyRole | "self";
  state: PrimeAgentState;
  model: string;
  parentId?: string;
  createdAt: string;
  /** Presentation-level activity hints; never authority over the transcript. */
  activity?: Readonly<{
    phase?: string;
    toolUseCount?: number;
    answerPreview?: string;
  }>;
}>;

/**
 * The admission record for a spawned child. Invariant 25: spawn returns
 * this handle at admission and *never* the child's answer; the answer
 * arrives later as an ordinary agent message or a terminal notice.
 *
 * `sessionDir` is an opaque host artifact location (session journal and
 * scratch space), mirroring the upstream `session_dir` admission field —
 * the host decides where child artifacts live and the parent agent only
 * receives a name for the place.
 */
export type PrimeSubagentHandle = Readonly<{
  childId: string;
  name: string;
  model: string;
  sessionDir: string;
  admittedAt: string;
  state: "admitted" | "running" | "completed" | "failed" | "cancelled";
}>;

export type PrimeSpawnRequest = Readonly<{
  prompt: string;
  name?: string;
  model?: string;
  /** Optional human label for journals and docks ("research", "review"). */
  label?: string;
}>;

/** Where a message is aimed. Reach is validated against the family roster before any send. */
export type PrimeAgentAddress = Readonly<
  | { role: "parent" }
  | { role: "sibling" | "child"; name?: string; id?: string }
>;

/** Rate-limit posture carried as data on every receipt and refusal. */
export type PrimeAgentMessageRateLimit = Readonly<{
  /** Token-bucket ceiling; upstream allows a 3-message burst. */
  burstCapacity: number;
  refillPerSecond: number;
  tokensRemaining: number;
  retryAfterMs: number;
  /** Messages accepted but not yet injected into the receiver's turn. */
  pending: number;
  pendingCap: number;
}>;

/** The durable record of one send attempt. `queued` is a first-class outcome, never disguised as delivered. */
export type PrimeAgentMessageReceipt = Readonly<{
  messageId: string;
  targetId: string;
  targetName: string;
  status: "delivered" | "queued";
  queuedPosition?: number;
  rateLimit: PrimeAgentMessageRateLimit;
  acceptedAt: string;
}>;

/** A bounded transcript excerpt for observation. Excerpts are never editable from the observer side. */
export type PrimeTranscriptPreview = Readonly<{
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  at?: string;
  truncated: boolean;
}>;

/**
 * The runtime seam the RLM tools depend on. The session authority
 * implements it; the tools never orchestrate.
 *
 * Contract honesty rules the implementer must keep:
 *   - `spawn` resolves at admission with the handle and never waits for
 *     the child's answer (invariant 25);
 *   - `sendMessage` refuses targets outside the family roster by
 *     throwing; the tools pre-check reach so refusals arrive as data;
 *   - `listReachable` is the *complete* family roster (self, parent,
 *     siblings, direct children) — the tools enforce reach against it,
 *     so it must not omit and must not widen;
 *   - depth gating uses `depth`/`maxDepth` exactly as upstream gates
 *     `RLM_DEPTH >= RLM_MAX_DEPTH` (roots are depth 0, default max 1).
 */
export interface PrimeAgentRuntime {
  readonly selfId: string;
  readonly selfName: string;
  readonly depth: number;
  readonly maxDepth: number;
  spawn(request: PrimeSpawnRequest): Promise<PrimeSubagentHandle>;
  stopChild(childId: string, reason?: string): Promise<boolean>;
  listChildren(): Promise<readonly PrimeSubagentHandle[]>;
  listReachable(): Promise<readonly PrimeAgentSummary[]>;
  sendMessage(target: PrimeAgentAddress, message: string): Promise<PrimeAgentMessageReceipt>;
}

/**
 * Read-only observation port for `agent_observe`. The registry's answer
 * is already family-bounded for the observing agent: the tools must not
 * widen it by joining the registry against anything else. Observation
 * never mutates the observed session.
 */
export interface PrimeAgentRegistry {
  listAgents(): Promise<readonly PrimeAgentSummary[]>;
  getAgent(idOrName: string): Promise<PrimeAgentSummary | undefined>;
  recentMessages(
    idOrName: string,
    bounds: Readonly<{ limit: number; maxChars: number }>,
  ): Promise<readonly PrimeTranscriptPreview[]>;
}

/** Harness entry kinds, mirroring upstream `RefinementKind` exactly. */
export const PRIME_HARNESS_KINDS = Object.freeze(["prompt", "memory", "skill", "subagent"] as const);
export type PrimeHarnessKind = (typeof PRIME_HARNESS_KINDS)[number];

export const PRIME_HARNESS_SCOPES = Object.freeze(["local", "global"] as const);
export type PrimeHarnessScope = (typeof PRIME_HARNESS_SCOPES)[number];

/**
 * One continual-harness entry. Field names mirror the upstream
 * harness.py/harness_state.json record verbatim (snake_case,
 * `created_at`/`updated_at`, `version`) because kernel-side code and
 * serialized state files read the same shape — narrowing or renaming
 * here would fork the one record both sides agree on.
 */
export type PrimeHarnessEntry = Readonly<{
  id: string;
  kind: PrimeHarnessKind;
  title: string;
  content: string;
  path: string;
  scope: PrimeHarnessScope;
  reference: Readonly<Record<string, unknown>>;
  arguments: Readonly<Record<string, unknown>>;
  metadata: Readonly<Record<string, unknown>>;
  source: string;
  created_at: string;
  updated_at: string;
  version: number;
}>;

export type PrimeHarnessRefinement = Readonly<{
  id: string;
  trigger: string;
  changes: readonly string[];
  outcome: string;
  created_at: string;
}>;

/**
 * The merged, prompt-ready harness view. Merging is the store's job
 * (local entries shadow global entries of the same id; each entry keeps
 * its own scope label) because only the store sees both scopes.
 */
export type PrimeHarnessOverview = Readonly<{
  entries: Readonly<Record<PrimeHarnessKind, readonly PrimeHarnessEntry[]>>;
  refinements: readonly PrimeHarnessRefinement[];
}>;

/**
 * Persistence seam for the continual harness and agent-owned heartbeats.
 * Local scope is bound to the owning session by the implementing authority;
 * the tools pass scope through and never resolve storage locations.
 *
 * All mutations are version-CAS: `putEntry` with `expectedVersion` must
 * refuse a stale write, and `removeEntry` honors `expectedVersion`, so two
 * agents refining concurrently produce a named conflict rather than a
 * silent last-writer win.
 */
export interface PrimeHarnessStore {
  listEntries(filter?: Readonly<{ scope?: PrimeHarnessScope; kind?: PrimeHarnessKind }>): Promise<readonly PrimeHarnessEntry[]>;
  getEntry(scope: PrimeHarnessScope, kind: PrimeHarnessKind, id: string): Promise<PrimeHarnessEntry | undefined>;
  putEntry(entry: PrimeHarnessEntry, expectedVersion?: number): Promise<PrimeHarnessEntry>;
  removeEntry(scope: PrimeHarnessScope, kind: PrimeHarnessKind, id: string, expectedVersion?: number): Promise<boolean>;
  /** Merged local-shadows-global overview for prompt injection and the CRUD tool's `overview` action. */
  overview(): Promise<PrimeHarnessOverview>;

  listHeartbeats(): Promise<readonly PrimeHeartbeatRecord[]>;
  getHeartbeat(id: string): Promise<PrimeHeartbeatRecord | undefined>;
  putHeartbeat(record: PrimeHeartbeatRecord): Promise<PrimeHeartbeatRecord>;
  removeHeartbeat(id: string): Promise<boolean>;
}

/**
 * An agent-owned heartbeat record: a standing instruction for the session
 * authority to wake this agent on a schedule. The tools only CRUD the
 * record; the session authority owns the clock, the wake, and the journal
 * trail. Data-plane / control-plane separation is deliberate — a tool
 * that could both declare and fire a wake could forge the receipt.
 */
export type PrimeHeartbeatRecord = Readonly<{
  id: string;
  name: string;
  prompt: string;
  schedule: Readonly<
    | { kind: "interval"; every_ms: number }
    | { kind: "at"; at: string }
  >;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  next_run_at?: string;
  last_run_at?: string;
  run_count: number;
  /** Present only when the store scopes heartbeats per session. */
  sessionId?: string;
}>;

/*
 * Naming and address policies, kept as pure functions so the tool surface
 * and the session authority cannot drift on what a valid child name is.
 * Mirrors upstream: name <= 64 chars; uniqueness is enforced by callers
 * against the live sibling roster because only the runtime knows it.
 */

const AGENT_NAME_MAX_CHARS = 64;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export function canonicalPrimeAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > AGENT_NAME_MAX_CHARS) return undefined;
  return AGENT_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

const SPAWN_NAME_SLUG_MAX_CHARS = 24;

/**
 * The upstream default-name recipe: `subagent-<promptslug>-<8hex>`. The
 * suffix keeps default names unique without a roster lookup; explicit
 * names are the ones that must be unique among siblings.
 */
export function deriveDefaultSubagentName(prompt: string, randomHex8: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SPAWN_NAME_SLUG_MAX_CHARS)
    .replace(/-+$/u, "");
  return `subagent-${slug.length > 0 ? slug : "child"}-${randomHex8}`;
}

/** Message size ceiling from invariant 26 (16,384 chars per agent message). */
export const PRIME_AGENT_MESSAGE_MAX_CHARS = 16_384;

/** Pending-message ceiling per receiving session, from invariant 26. */
export const PRIME_AGENT_PENDING_CAP = 20;

/** Token-bucket shape from invariant 26: a 3-message burst with a 1-token-per-second refill. */
export const PRIME_AGENT_RATE_LIMIT = Object.freeze({
  burstCapacity: 3,
  refillPerSecond: 1,
} as const);
