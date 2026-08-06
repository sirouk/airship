/**
 * The prime RLM tool surface: rlm_spawn, subagent, agent_message,
 * agent_observe, rlm_heartbeat, and prime_harness.
 *
 * Why these are thin tools over ports instead of being the runtime:
 * subagent orchestration (admission, family routing, terminal notices),
 * the message sink queues, and session persistence are the session
 * authority's job (src/prime/subagents/registry.ts implements it; the
 * parent session wires it). The tools here do exactly four things and
 * never more:
 *   1. translate model arguments into the frozen contract calls
 *      (invariant 25's `spawn` is admission-shaped: it returns the
 *      handle, never the answer, and says so in the result text);
 *   2. pre-check what the model can fix (names, roles, depth budget)
 *      so the refusal arrives as data-shaped `isError` content instead
 *      of an orchestration throw — unreachable targets, duplicate names,
 *      and exhausted depth are model-correctable facts;
 *   3. surface every bound as data: rate limits, pending caps, depth
 *      source, and the delivered|queued distinction from invariant 26;
 *   4. stay honest about absence: anything the ports cannot answer is
 *      a named refusal, never a fabricated roster or a silent drop.
 *
 * The family model is the nuclear family (parent, siblings, direct
 * children; deeper reach relays through the intermediate child), and the
 * one sentence every reach refusal shares is the registry's
 * AGENT_FAMILY_REACH_ERROR.
 */

import type { JsonValue, Tool, ToolExecutionResult } from "../../core/contracts";
import { objectArguments, requiredString } from "../../tools/schema";
import type { PrimeAgentMessage, PrimeAgentMessageReceipt, PrimeSubagentHandle } from "../runtime/types-prime";
import {
  canonicalPrimeAgentName,
  MAX_AGENT_MESSAGE_CHARS,
  MAX_PENDING_AGENT_MESSAGES,
  MAX_SPAWN_PROMPT_CHARS,
  PRIME_MESSAGE_BURST_CAPACITY,
  PRIME_MESSAGE_REFILL_MS,
} from "../runtime/types-prime";
import type { PrimeAgentRegistry } from "../subagents/registry";
import { OBSERVE_MAX_LIMIT, OBSERVE_MAX_MAX_CHARS, OBSERVE_MIN_MAX_CHARS } from "../subagents/registry";
import type { HarnessStore } from "../harness/store";
import type { HarnessEntry, HarnessEntryKind, HarnessScope } from "../harness/types";

/** The tools depend on the owning agent's identity as registered; the session authority knows it. */
/**
 * The owning agent's identity as the session authority registered it.
 * `parentId` is what makes parent/sibling disambiguation exact: two
 * attached depth-mates are siblings, the node whose id this agent points
 * to is its parent, and guessing by depth arithmetic is what mislabels a
 * depth-mate as the parent when both exist in the roster.
 */
export type PrimeRlmSelfIdentity = Readonly<{ id: string; name: string; depth: number; parentId?: string }>;

export type PrimeRlmAgentDeps = Readonly<{
  self: PrimeRlmSelfIdentity;
  registry: PrimeAgentRegistry;
}>;

/** Observe defaults, mirroring prime-agent's normalizeObserveLimit/normalizeObserveMaxChars defaults (the registry exports only the clamps). */
const OBSERVE_DEFAULT_LIMIT = 8;
const OBSERVE_DEFAULT_MAX_CHARS = 800;

/** Structured reach refusal metadata, shared by agent_message and agent_observe. */
type ReachRefusal = Readonly<{ isError: true; content: string; metadata: JsonValue }>;

/**
 * Locate a family member by role/name/id *within the roster the router
 * itself declared reachable*. The reach rule is checked twice on purpose:
 * here so the refusal is data-shaped for the model, and inside the router
 * so no call path can bypass it (defense in depth on invariant 26).
 */
function resolveFamilyTarget(
  deps: PrimeRlmAgentDeps,
  address: Readonly<{ role: "parent" | "sibling" | "child"; id?: string; name?: string }>,
): Readonly<{ target: PrimeSubagentHandle } | { refusal: ReachRefusal }> {
  let roster: readonly PrimeSubagentHandle[];
  try {
    roster = deps.registry.route.reachableAgents(deps.self.id);
  } catch (error) {
    return { refusal: refuse("The agent family roster is unavailable", error) };
  }
  const roleOf = (handle: PrimeSubagentHandle): "parent" | "sibling" | "child" =>
    deps.self.parentId !== undefined && handle.id === deps.self.parentId
      ? "parent"
      : handle.parentId === deps.self.id ? "child" : "sibling";
  const candidates = roster.filter((handle) => roleOf(handle) === address.role);
  /* The parent is unambiguous: exactly one roster row is the parent, so no id/name narrows it. */
  const target = address.role === "parent"
    ? candidates[0]
    : candidates.find((handle) =>
      address.id !== undefined ? handle.id === address.id
        : address.name !== undefined ? handle.name === address.name
        : false,
    );
  if (!target) {
    const reachable = candidates.map((handle) => `${handle.name} (${handle.id})`);
    const selfHasNone = address.role === "parent"
      ? `${deps.self.name} (a root) has no parent in this family; roots are siblings of one another.`
      : `${deps.self.name} has no reachable ${address.role}${address.id ?? address.name ? ` named ${address.id ?? address.name}` : ""}.`;
    return {
      refusal: {
        isError: true,
        content:
          `${selfHasNone} Agent reach is limited to parent, siblings, and children. ` +
          `Reachable ${address.role}${candidates.length === 1 ? "" : "s"}: ${reachable.length > 0 ? reachable.join(", ") : "none"}.`,
        metadata: {
          refused: "family-reach",
          requestedRole: address.role,
          requested: address.id ?? address.name ?? null,
          reachableCount: candidates.length,
        } satisfies JsonValue,
      },
    };
  }
  return { target };
}

function refuse(prefix: string, error: unknown): ReachRefusal {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: `${prefix}: ${message}`, metadata: { refused: true } };
}

function handleView(handle: PrimeSubagentHandle): JsonValue {
  return Object.freeze({
    id: handle.id,
    name: handle.name,
    role: handle.role,
    depth: handle.depth,
    model: handle.model.id,
    sessionPath: handle.sessionPath,
    status: handle.status,
    ...(handle.parentId !== undefined ? { parentId: handle.parentId } : {}),
  }) as JsonValue;
}

function requireAction(args: Record<string, JsonValue>, actions: readonly string[]): string {
  const action = requiredString(args.action, "action");
  if (!actions.includes(action)) {
    throw new Error(`action must be one of ${actions.map((name) => JSON.stringify(name)).join(", ")}.`);
  }
  return action;
}

function optionalString(args: Record<string, JsonValue>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalInteger(args: Record<string, JsonValue>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value as number;
}

function optionalBoolean(args: Record<string, JsonValue>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalRecord(args: Record<string, JsonValue>, name: string): Readonly<Record<string, unknown>> | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

export function createPrimeRlmSpawnTool(deps: PrimeRlmAgentDeps): Tool {
  return {
    definition: {
      name: "rlm_spawn",
      description:
        "Spawn a child agent with a task prompt. Admission returns immediately with the child handle — " +
        "rlm_child_id, name, session_dir, model — and NEVER the child's answer; replies arrive later as " +
        "agent_message results or terminal notices. Names must be unique among siblings, and the depth " +
        "budget (RLM_MAX_DEPTH, persisted per chat) refuses spawns at the ceiling.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: MAX_SPAWN_PROMPT_CHARS },
          name: { type: "string", description: `Stable child name (<=64 chars, letters/digits/._-); default is subagent-<slug>-<8hex>.` },
          model: { type: "string", description: "Explicit model selector; omit to inherit this agent's model." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const prompt = requiredString(args.prompt, "prompt");
      const name = optionalString(args, "name");
      const model = optionalString(args, "model");

      /*
       * The depth gate pre-check mirrors the registry's own gate so the
       * refusal is data-shaped before spawn is attempted; the registry
       * still enforces it authoritatively (a stale roster cannot weaken
       * the rule), and its throw maps to isError below.
       */
      const depthStatus = await deps.registry.getMaxDepthStatus();
      if (deps.self.depth >= depthStatus.maxDepth) {
        return {
          content:
            `RLM recursion depth limit reached (depth=${String(deps.self.depth)}, max=${String(depthStatus.maxDepth)}, source=${depthStatus.source}): ` +
            "child sessions at the ceiling cannot spawn further agents.",
          isError: true,
          metadata: { depth: deps.self.depth, maxDepth: depthStatus.maxDepth, maxDepthSource: depthStatus.source } satisfies JsonValue,
        };
      }
      if (name !== undefined) {
        if (canonicalPrimeAgentName(name) === undefined) {
          return {
            content: `Invalid child name ${JSON.stringify(name)}: 1\u201364 chars of letters, digits, ".", "_", or "-", starting with a letter or digit.`,
            isError: true,
            metadata: { refused: "invalid-name", name },
          };
        }
        const duplicate = deps.registry.list().find((child) => child.name === name);
        if (duplicate) {
          return {
            content: `Child name ${JSON.stringify(name)} is already taken by sibling ${duplicate.id} (${duplicate.status}); choose a unique name.`,
            isError: true,
            metadata: { refused: "duplicate-name", name, existing: { id: duplicate.id, status: duplicate.status } } satisfies JsonValue,
          };
        }
      }

      try {
        const handle = await deps.registry.spawn(prompt, { ...(name !== undefined ? { name } : {}), ...(model !== undefined ? { model } : {}) });
        /*
         * Upstream's admission dict keys are kept verbatim
         * ({rlm_child_id, name, session_dir, model}) because ported
         * prompts and skills destructure exactly those keys.
         */
        const admission = {
          rlm_child_id: handle.id,
          name: handle.name,
          session_dir: handle.sessionPath,
          model: handle.model.id,
        };
        return {
          content:
            `Spawned child agent "${handle.name}" (admitted at depth ${String(handle.depth)}; the answer is never returned here — ` +
            `it arrives as an agent_message reply or a terminal notice).\n\n${JSON.stringify(admission, null, 2)}`,
          metadata: {
            ...admission,
            depth: handle.depth,
            maxDepth: depthStatus.maxDepth,
            maxDepthSource: depthStatus.source,
          } satisfies JsonValue,
        };
      } catch (error) {
        return refuse("Spawn was refused", error);
      }
    },
  };
}

export function createPrimeSubagentTool(deps: PrimeRlmAgentDeps): Tool {
  return {
    definition: {
      name: "subagent",
      description:
        "Manage direct child agents: list their handles (never their answers) or stop one by id or name. " +
        "A stopped child settles with a terminal notice; completed children stay listed until the session reaps them.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "stop"] },
          child: { type: "string", description: "Child id or name; required by stop. Recent handles come from rlm_spawn results or the list action." },
          reason: { type: "string", description: "Recorded stop reason for the journal and the child's terminal notice." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const action = requireAction(args, ["list", "stop"]);
      if (action === "list") {
        const children = deps.registry.list().map(handleView);
        return {
          content: JSON.stringify({ children, count: children.length }, null, 2),
          metadata: { count: children.length, children },
        };
      }
      const childRef = optionalString(args, "child");
      if (!childRef) throw new Error("subagent stop requires the child (id or name).");
      const reason = optionalString(args, "reason") ?? "stopped by parent via the subagent tool";
      const stopped = await deps.registry.stop(childRef, reason);
      if (!stopped) {
        return {
          content: `No running direct child named ${JSON.stringify(childRef)}; only direct children this agent spawned can be stopped.`,
          isError: true,
          metadata: { child: childRef, stopped: false },
        };
      }
      const handle = deps.registry.list().find((child) => child.id === childRef || child.name === childRef);
      return {
        content: `Stopped child ${JSON.stringify(childRef)} (${reason}); its terminal notice will arrive as an agent_message result.`,
        metadata: { child: childRef, stopped: true, reason, ...(handle ? { handle: handleView(handle) } : {}) } satisfies JsonValue,
      };
    },
  };
}

/** The rate-limit facts every send result carries as data, combined from the frozen vocabulary. */
function rateLimitData(): JsonValue {
  return {
    burstCapacity: PRIME_MESSAGE_BURST_CAPACITY,
    refillPerSecond: 1_000 / PRIME_MESSAGE_REFILL_MS,
    pendingCap: MAX_PENDING_AGENT_MESSAGES,
  };
}

function receiptData(receipt: PrimeAgentMessageReceipt): JsonValue {
  return {
    messageId: receipt.messageId,
    delivered: receipt.delivered,
    queued: receipt.queued,
    ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
  };
}

export function createPrimeAgentMessageTool(deps: PrimeRlmAgentDeps): Tool {
  return {
    definition: {
      name: "agent_message",
      description:
        `Send a message to a family agent (parent, sibling, or direct child; deeper reach relays through a child) or list the family roster. ` +
        `Messages are capped at ${String(MAX_AGENT_MESSAGE_CHARS)} chars; receipts always name delivered|queued and the rate-limit posture as data.`,
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["send", "list_agents"] },
          message: { type: "string", minLength: 1, maxLength: MAX_AGENT_MESSAGE_CHARS },
          receiver_role: { type: "string", enum: ["parent", "sibling", "child"] },
          receiver_id: { type: "string", description: "Id of the sibling or child; omit for parent." },
          receiver_name: { type: "string", description: "Name of the sibling or child; omit for parent." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const action = requireAction(args, ["send", "list_agents"]);

      if (action === "list_agents") {
        let roster: readonly PrimeSubagentHandle[];
        try {
          roster = deps.registry.route.reachableAgents(deps.self.id);
        } catch (error) {
          return refuse("The agent family roster is unavailable", error);
        }
        const roleOf = (handle: PrimeSubagentHandle): string =>
          deps.self.parentId !== undefined && handle.id === deps.self.parentId
            ? "parent"
            : handle.parentId === deps.self.id ? "child" : "sibling";
        const agents = roster.map((handle) => ({ ...((handleView(handle)) as Record<string, JsonValue>), familyRole: roleOf(handle) }));
        return {
          content: JSON.stringify({ self: { id: deps.self.id, name: deps.self.name, depth: deps.self.depth }, agents, count: agents.length }, null, 2),
          metadata: { count: agents.length },
        };
      }

      const message = requiredString(args.message, "message");
      const receiverRole = requiredString(args.receiver_role, "receiver_role");
      if (receiverRole !== "parent" && receiverRole !== "sibling" && receiverRole !== "child") {
        throw new Error("receiver_role must be one of \"parent\", \"sibling\", \"child\".");
      }
      const receiverId = optionalString(args, "receiver_id");
      const receiverName = optionalString(args, "receiver_name");
      if (receiverRole === "parent" && (receiverId !== undefined || receiverName !== undefined)) {
        throw new Error("receiver_role \"parent\" takes no receiver_id or receiver_name; the parent is unambiguous.");
      }
      if (receiverRole !== "parent" && receiverId === undefined && receiverName === undefined) {
        throw new Error(`receiver_role \"${receiverRole}\" requires receiver_id or receiver_name.`);
      }

      const resolved = resolveFamilyTarget(deps, { role: receiverRole, ...(receiverId !== undefined ? { id: receiverId } : {}), ...(receiverName !== undefined ? { name: receiverName } : {}) });
      if ("refusal" in resolved) return resolved.refusal;

      try {
        const receipt = await deps.registry.route.send({ fromId: deps.self.id, toId: resolved.target.id, content: message });
        if (receipt.reason !== undefined && !receipt.delivered && !receipt.queued) {
          // Rate-limit refusal is data, never a drop: the receipt names it and the retry posture ships alongside.
          const retry = /retry after (\d+)ms/u.exec(receipt.reason);
          return {
            content: `Message to ${resolved.target.name} was refused: ${receipt.reason}`,
            isError: true,
            metadata: {
              ...((receiptData(receipt)) as Record<string, JsonValue>),
              rateLimited: true,
              ...(retry ? { retryAfterMs: Number(retry[1]) } : {}),
              rateLimit: rateLimitData(),
              target: { id: resolved.target.id, name: resolved.target.name },
            } satisfies JsonValue,
          };
        }
        return {
          content:
            `Message to ${resolved.target.name} ${receipt.delivered ? "delivered" : "queued"} (${receipt.messageId}). ` +
            "Do not block waiting for a reply; replies arrive as later agent_message results.",
          metadata: {
            ...((receiptData(receipt)) as Record<string, JsonValue>),
            rateLimit: rateLimitData(),
            target: { id: resolved.target.id, name: resolved.target.name },
          } satisfies JsonValue,
        };
      } catch (error) {
        return refuse(`Message to ${resolved.target.name} was refused`, error);
      }
    },
  };
}

export function createPrimeAgentObserveTool(deps: PrimeRlmAgentDeps): Tool {
  return {
    definition: {
      name: "agent_observe",
      description:
        "Read-only, bounded family observation: list reachable agents, get one handle, or read a bounded " +
        `slice (<=${String(OBSERVE_MAX_LIMIT)} messages, <=${String(OBSERVE_MAX_MAX_CHARS)} chars each) of an agent's recent message traffic. ` +
        "Never mutates the observed agent; reach is the same nuclear family as agent_message.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "recent_messages"] },
          agent: { type: "string", description: "Id or name of a reachable agent (defaults to self for recent_messages)." },
          limit: { type: "integer", minimum: 1, maximum: OBSERVE_MAX_LIMIT, default: OBSERVE_DEFAULT_LIMIT },
          max_chars: { type: "integer", minimum: OBSERVE_MIN_MAX_CHARS, maximum: OBSERVE_MAX_MAX_CHARS, default: OBSERVE_DEFAULT_MAX_CHARS },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const action = requireAction(args, ["list", "get", "recent_messages"]);
      const agentRef = optionalString(args, "agent");
      const limit = optionalInteger(args, "limit") ?? OBSERVE_DEFAULT_LIMIT;
      const maxChars = optionalInteger(args, "max_chars") ?? OBSERVE_DEFAULT_MAX_CHARS;
      if (limit < 1 || limit > OBSERVE_MAX_LIMIT) throw new Error(`limit must be between 1 and ${String(OBSERVE_MAX_LIMIT)}.`);
      if (maxChars < OBSERVE_MIN_MAX_CHARS || maxChars > OBSERVE_MAX_MAX_CHARS) {
        throw new Error(`max_chars must be between ${String(OBSERVE_MIN_MAX_CHARS)} and ${String(OBSERVE_MAX_MAX_CHARS)}.`);
      }

      if (action === "list") {
        let roster: readonly PrimeSubagentHandle[];
        try {
          roster = deps.registry.route.reachableAgents(deps.self.id);
        } catch (error) {
          return refuse("The agent family roster is unavailable", error);
        }
        const agents = roster.map(handleView);
        return {
          content: JSON.stringify({ self: { id: deps.self.id, name: deps.self.name, depth: deps.self.depth }, agents, count: agents.length }, null, 2),
          metadata: { count: agents.length },
        };
      }

      if (action === "get") {
        if (!agentRef) throw new Error("agent_observe get requires the agent (id or name).");
        let roster: readonly PrimeSubagentHandle[];
        try {
          roster = deps.registry.route.reachableAgents(deps.self.id);
        } catch (error) {
          return refuse("The agent family roster is unavailable", error);
        }
        const target = roster.find((handle) => handle.id === agentRef || handle.name === agentRef);
        if (!target) {
          return {
            content: `Agent ${JSON.stringify(agentRef)} is not observable from ${deps.self.name}: agent reach is limited to parent, siblings, and children.`,
            isError: true,
            metadata: { refused: "family-reach", agent: agentRef, observableCount: roster.length },
          };
        }
        return { content: JSON.stringify(handleView(target), null, 2), metadata: { handle: handleView(target) } };
      }

      const ref = agentRef ?? deps.self.id;
      try {
        const messages: readonly PrimeAgentMessage[] = deps.registry.route.recentMessages(ref, limit, maxChars);
        const views = messages.map((message) => ({
          id: message.id,
          from: { id: message.fromId, name: message.fromName },
          to: { id: message.toId, name: message.toName },
          content: message.content,
          timestamp: message.timestamp,
          /*
           * Honesty at the clip bound: the router clips each message to
           * max_chars before it returns, and content that reaches the
           * bound exactly is indistinguishable from content it clipped —
           * so the flag names the bound, never a fabricated boolean.
           */
          reachedClipBound: message.content.length >= maxChars,
        }));
        return {
          content: JSON.stringify({ agent: ref, count: views.length, limit, maxChars, messages: views }, null, 2),
          metadata: { agent: ref, count: views.length, limit, maxChars },
        };
      } catch (error) {
        return refuse(`agent_observe recent_messages for ${JSON.stringify(ref)} was refused`, error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// rlm_heartbeat: agent-owned heartbeat CRUD over the chat-scoped state store.
// ---------------------------------------------------------------------------

/**
 * Chat-scoped keyed persistence, the same slot shape the subagent
 * orchestrator uses for its persisted max-depth override
 * (src/prime/subagents/types.ts PrimeSubagentHarnessStore). Heartbeats
 * persist as ONE aggregate document (kind "heartbeat", id
 * "prime-heartbeat-registry") because the slot is read/write by key and a
 * heartbeat roster is small (<=32): a document keeps the listing cheap
 * and the write atomic per call within one session.
 */
export interface PrimeHeartbeatStateStore {
  read(kind: string, id: string): unknown;
  write(kind: string, id: string, value: unknown): void | Promise<void>;
}

export const HEARTBEAT_REGISTRY_KIND = "heartbeat";
export const HEARTBEAT_REGISTRY_ID = "prime-heartbeat-registry";

/** Heartbeat roster ceiling; a wake schedule is not a task queue. */
const MAX_HEARTBEATS = 32;
const MAX_HEARTBEAT_NAME_CHARS = 64;
const MAX_HEARTBEAT_PROMPT_CHARS = 4_096;
/** Wake intervals tighter than a minute are a spin loop with extra steps; looser than a day belongs in a calendar. */
const MIN_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_HEARTBEAT_INTERVAL_MS = 86_400_000;

export type PrimeHeartbeatSchedule = Readonly<
  | { kind: "interval"; everyMs: number }
  | { kind: "at"; at: string }
>;

export type PrimeHeartbeatRecord = Readonly<{
  id: string;
  name: string;
  prompt: string;
  schedule: PrimeHeartbeatSchedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
  nextRunAt?: string;
}>;

type HeartbeatRegistryState = Readonly<{ schema: 1; records: Readonly<Record<string, PrimeHeartbeatRecord>> }>;

/** Corrupt persisted state is treated as absent, mirroring the subagent store's rule so a bad record cannot brick every wake. */
function canonicalHeartbeatRegistryState(value: unknown): HeartbeatRegistryState {
  if (typeof value !== "object" || value === null) return Object.freeze({ schema: 1, records: {} });
  const raw = (value as { records?: unknown }).records;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return Object.freeze({ schema: 1, records: {} });
  const records: Record<string, PrimeHeartbeatRecord> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry.id === "string" &&
      typeof entry.name === "string" &&
      typeof entry.prompt === "string" &&
      typeof entry.enabled === "boolean" &&
      typeof entry.createdAt === "string" &&
      typeof entry.updatedAt === "string" &&
      typeof entry.runCount === "number" &&
      isRecord(entry.schedule) &&
      ((entry.schedule.kind === "interval" && typeof (entry.schedule as { everyMs?: unknown }).everyMs === "number") ||
        (entry.schedule.kind === "at" && typeof (entry.schedule as { at?: unknown }).at === "string"))
    ) {
      records[key] = entry as unknown as PrimeHeartbeatRecord;
    }
  }
  return Object.freeze({ schema: 1, records });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type PrimeHeartbeatDeps = Readonly<{
  store: PrimeHeartbeatStateStore;
  now?: () => Date;
  randomHex8?: () => string;
}>;

function parseSchedule(value: unknown): PrimeHeartbeatSchedule | Readonly<{ error: string }> {
  if (!isRecord(value)) return { error: "schedule must be an object with kind \"interval\" or \"at\"." };
  if (value.kind === "interval") {
    const everyMs = value.everyMs;
    if (!Number.isInteger(everyMs)) return { error: "schedule.everyMs must be an integer number of milliseconds." };
    const interval = everyMs as number;
    if (interval < MIN_HEARTBEAT_INTERVAL_MS || interval > MAX_HEARTBEAT_INTERVAL_MS) {
      return { error: `schedule.everyMs must be between ${String(MIN_HEARTBEAT_INTERVAL_MS)} and ${String(MAX_HEARTBEAT_INTERVAL_MS)} ms.` };
    }
    return { kind: "interval", everyMs: interval };
  }
  if (value.kind === "at") {
    const at = value.at;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return { error: "schedule.at must be an ISO-8601 timestamp." };
    return { kind: "at", at };
  }
  return { error: "schedule.kind must be \"interval\" or \"at\." };
}

function defaultRandomHex8(): string {
  return globalThis.crypto.randomUUID().replace(/-/gu, "").slice(0, 8);
}

export function createPrimeRlmHeartbeatTool(deps: PrimeHeartbeatDeps): Tool {
  const now = deps.now ?? (() => new Date());
  const randomHex8 = deps.randomHex8 ?? defaultRandomHex8;
  const load = (): HeartbeatRegistryState => canonicalHeartbeatRegistryState(deps.store.read(HEARTBEAT_REGISTRY_KIND, HEARTBEAT_REGISTRY_ID));
  const save = (state: HeartbeatRegistryState): void | Promise<void> => deps.store.write(HEARTBEAT_REGISTRY_KIND, HEARTBEAT_REGISTRY_ID, state);

  return {
    definition: {
      name: "rlm_heartbeat",
      description:
        `CRUD for this agent's own heartbeats (<=${String(MAX_HEARTBEATS)} wake records, persisted chat-scoped). ` +
        "Records are data-plane only: the session authority owns the clock, the wake, and the journal trail; " +
        "this tool declares and edits the intent, never fires it.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
          id: { type: "string" },
          name: { type: "string", maxLength: MAX_HEARTBEAT_NAME_CHARS },
          prompt: { type: "string", maxLength: MAX_HEARTBEAT_PROMPT_CHARS },
          schedule: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["interval", "at"] },
              everyMs: { type: "integer", minimum: MIN_HEARTBEAT_INTERVAL_MS, maximum: MAX_HEARTBEAT_INTERVAL_MS },
              at: { type: "string" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          enabled: { type: "boolean" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const action = requireAction(args, ["list", "get", "create", "update", "delete"]);
      const state = load();
      const records = Object.values(state.records).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

      if (action === "list") {
        return {
          content: JSON.stringify({ heartbeats: records, count: records.length, cap: MAX_HEARTBEATS }, null, 2),
          metadata: { count: records.length, cap: MAX_HEARTBEATS },
        };
      }
      if (action === "get" || action === "delete" || action === "update") {
        const id = requiredString(args.id, "id");
        const existing = state.records[id];
        if (!existing) return { content: `No heartbeat named id ${JSON.stringify(id)}.`, isError: true, metadata: { id, found: false } };
        if (action === "get") return { content: JSON.stringify(existing, null, 2), metadata: { heartbeat: existing as unknown as JsonValue } };
        if (action === "delete") {
          const next = { ...state.records };
          delete next[id];
          await save(Object.freeze({ schema: 1, records: next }));
          return { content: `Deleted heartbeat ${existing.name} (${id}).`, metadata: { id, deleted: true } };
        }
        const name = optionalString(args, "name") ?? existing.name;
        const prompt = optionalString(args, "prompt") ?? existing.prompt;
        const scheduleValue = args.schedule !== undefined ? parseSchedule(args.schedule) : existing.schedule;
        if ("error" in scheduleValue) return { content: scheduleValue.error, isError: true, metadata: { refused: "invalid-schedule" } };
        const enabled = optionalBoolean(args, "enabled") ?? existing.enabled;
        const validated = validateHeartbeatFields(name, prompt);
        if (validated !== undefined) return validated;
        const updated = Object.freeze({ ...existing, name, prompt, schedule: scheduleValue, enabled, updatedAt: now().toISOString() });
        await save(Object.freeze({ schema: 1, records: { ...state.records, [id]: updated } }));
        return { content: `Updated heartbeat ${name} (${id}).`, metadata: { heartbeat: updated as unknown as JsonValue } };
      }

      // create
      if (records.length >= MAX_HEARTBEATS) {
        return {
          content: `Heartbeat roster is full (${String(MAX_HEARTBEATS)} records); delete one before creating another.`,
          isError: true,
          metadata: { refused: "capacity", cap: MAX_HEARTBEATS },
        };
      }
      const name = requiredString(args.name, "name");
      const prompt = requiredString(args.prompt, "prompt");
      const scheduleValue = parseSchedule(args.schedule);
      if ("error" in scheduleValue) return { content: scheduleValue.error, isError: true, metadata: { refused: "invalid-schedule" } };
      const validated = validateHeartbeatFields(name, prompt);
      if (validated !== undefined) return validated;
      const timestamp = now().toISOString();
      const record = Object.freeze({
        id: `hb-${randomHex8()}`,
        name,
        prompt,
        schedule: scheduleValue,
        enabled: optionalBoolean(args, "enabled") ?? true,
        createdAt: timestamp,
        updatedAt: timestamp,
        runCount: 0,
      });
      await save(Object.freeze({ schema: 1, records: { ...state.records, [record.id]: record } }));
      return {
        content: `Created heartbeat ${name} (${record.id}); the session authority owns the wake itself.`,
        metadata: { heartbeat: record as unknown as JsonValue },
      };
    },
  };
}

function validateHeartbeatFields(name: string, prompt: string): ToolExecutionResult | undefined {
  if (name.trim().length === 0 || name.length > MAX_HEARTBEAT_NAME_CHARS) {
    return { content: `Heartbeat name must be 1\u2013${String(MAX_HEARTBEAT_NAME_CHARS)} characters.`, isError: true };
  }
  if (prompt.trim().length === 0 || prompt.length > MAX_HEARTBEAT_PROMPT_CHARS) {
    return { content: `Heartbeat prompt must be 1\u2013${String(MAX_HEARTBEAT_PROMPT_CHARS)} characters.`, isError: true };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// prime_harness: continual-harness CRUD over the HarnessStore.
// ---------------------------------------------------------------------------

/** Guard bounds; the harness is prompt context, not a document store. */
const MAX_HARNESS_TITLE_CHARS = 200;
const MAX_HARNESS_CONTENT_CHARS = 16 * 1_024;
const MAX_HARNESS_RECORD_CHARS = 8 * 1_024;
/** Overview caps, mirroring upstream formatHarnessStateForPrompt (6 entries per kind, 5 refinement events). */
const HARNESS_OVERVIEW_ENTRIES_PER_KIND = 6;
const HARNESS_OVERVIEW_REFINEMENTS = 5;

const HARNESS_KINDS: readonly HarnessEntryKind[] = Object.freeze(["prompt", "memory", "skill", "subagent"] as const);
const HARNESS_SCOPES: readonly HarnessScope[] = Object.freeze(["local", "global"] as const);

function parseKind(value: string): HarnessEntryKind {
  if (!(HARNESS_KINDS as readonly string[]).includes(value)) {
    throw new Error(`kind must be one of ${HARNESS_KINDS.map((kind) => JSON.stringify(kind)).join(", ")}.`);
  }
  return value as HarnessEntryKind;
}

function parseScope(value: string | undefined): HarnessScope {
  if (value === undefined) return "local";
  if (!(HARNESS_SCOPES as readonly string[]).includes(value)) {
    throw new Error(`scope must be one of ${HARNESS_SCOPES.map((scope) => JSON.stringify(scope)).join(", ")}.`);
  }
  return value as HarnessScope;
}

function entryView(entry: HarnessEntry): JsonValue {
  return {
    id: entry.id,
    kind: entry.kind,
    scope: entry.scope,
    title: entry.title,
    path: entry.path ?? "general",
    version: entry.version,
    source: entry.source,
    updatedAt: entry.updatedAt,
  };
}

function recordBound(name: string, value: Readonly<Record<string, unknown>>): string | undefined {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_HARNESS_RECORD_CHARS) {
    return `${name} serializes to ${String(serialized.length)} chars, over the ${String(MAX_HARNESS_RECORD_CHARS)}-char bound.`;
  }
  return undefined;
}

export function createPrimeHarnessTool(store: HarnessStore): Tool {
  return {
    definition: {
      name: "prime_harness",
      description:
        "CRUD for continual-harness entries (prompt notes, memories, skills, subagent specs) in local or global scope. " +
        "Local shadows global at prompt time; update/delete honor expected_version optimistic concurrency, and skill " +
        "entries must carry a python reference plus an arguments contract.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["overview", "list", "get", "create", "update", "delete"] },
          scope: { type: "string", enum: ["local", "global"], default: "local" },
          kind: { type: "string", enum: ["prompt", "memory", "skill", "subagent"] },
          id: { type: "string", description: "Entry id; `local:`/`global:` prefixes override scope (upstream convention)." },
          title: { type: "string", maxLength: MAX_HARNESS_TITLE_CHARS },
          content: { type: "string", maxLength: MAX_HARNESS_CONTENT_CHARS },
          path: { type: "string" },
          reference: { type: "object", additionalProperties: true },
          arguments: { type: "object", additionalProperties: true },
          metadata: { type: "object", additionalProperties: true },
          expected_version: { type: "integer", minimum: 1 },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const action = requireAction(args, ["overview", "list", "get", "create", "update", "delete"]);
      const scope = parseScope(optionalString(args, "scope"));
      const kindValue = optionalString(args, "kind");

      if (action === "overview") {
        const entries = await store.list();
        const refinements = await store.refinements();
        const perScope = Object.fromEntries(HARNESS_SCOPES.map((scopeName) => {
          const scoped = entries.filter((entry) => entry.scope === scopeName);
          const perKind = Object.fromEntries(HARNESS_KINDS.map((kind) => {
            const ofKind = scoped.filter((entry) => entry.kind === kind);
            return [kind, {
              count: ofKind.length,
              entries: ofKind.slice(0, HARNESS_OVERVIEW_ENTRIES_PER_KIND).map((entry) => ({ id: entry.id, title: entry.title, path: entry.path ?? "general" })),
              ...(ofKind.length > HARNESS_OVERVIEW_ENTRIES_PER_KIND ? { more: ofKind.length - HARNESS_OVERVIEW_ENTRIES_PER_KIND } : {}),
            }];
          }));
          return [scopeName, { count: scoped.length, kinds: perKind }];
        }));
        const recent = refinements.slice(-HARNESS_OVERVIEW_REFINEMENTS).map((event) => ({ id: event.id, summary: event.summary, scope: event.scope }));
        const snapshotId = await store.snapshotId();
        return {
          content: JSON.stringify({ snapshotId, scopes: perScope, refinements: { count: refinements.length, recent } }, null, 2),
          metadata: { snapshotId, entries: entries.length, refinements: refinements.length },
        };
      }

      if (kindValue === undefined) throw new Error(`prime_harness ${action} requires kind.`);
      const kind = parseKind(kindValue);

      if (action === "list") {
        const entries = (await store.list(scope, kind)).map(entryView);
        return { content: JSON.stringify({ scope, kind, entries, count: entries.length }, null, 2), metadata: { scope, kind, count: entries.length } };
      }

      const idValue = optionalString(args, "id");
      if (action === "get" || action === "delete" || action === "update") {
        if (!idValue) throw new Error(`prime_harness ${action} requires id.`);
      }
      const id = idValue ?? "";

      if (action === "get") {
        const entry = await store.get(scope, kind, id);
        if (!entry) return { content: `No ${kind} entry ${JSON.stringify(id)} in ${scope} scope.`, isError: true, metadata: { scope, kind, id, found: false } };
        return { content: JSON.stringify(entry, null, 2), metadata: { entry: entry as unknown as JsonValue } };
      }

      if (action === "delete") {
        const expectedVersion = optionalInteger(args, "expected_version");
        const removed = await store.delete(scope, kind, id, expectedVersion !== undefined ? { expectedVersion } : {});
        if (!removed) return { content: `No ${kind} entry ${JSON.stringify(id)} in ${scope} scope to delete.`, isError: true, metadata: { scope, kind, id, deleted: false } };
        return { content: `Deleted ${kind} entry ${JSON.stringify(id)} from ${scope} scope.`, metadata: { scope, kind, id, deleted: true } };
      }

      if (action === "create") {
        const title = requiredString(args.title, "title");
        const content = requiredString(args.content, "content");
        if (title.length > MAX_HARNESS_TITLE_CHARS) throw new Error(`title must be at most ${String(MAX_HARNESS_TITLE_CHARS)} characters.`);
        if (content.length > MAX_HARNESS_CONTENT_CHARS) throw new Error(`content must be at most ${String(MAX_HARNESS_CONTENT_CHARS)} characters.`);
        const reference = optionalRecord(args, "reference");
        const argsRecord = optionalRecord(args, "arguments");
        const metadata = optionalRecord(args, "metadata");
        for (const [recordName, record] of [["reference", reference], ["arguments", argsRecord], ["metadata", metadata]] as const) {
          if (record === undefined) continue;
          const violation = recordBound(recordName, record);
          if (violation) return { content: violation, isError: true, metadata: { refused: "record-bound", record: recordName } };
        }
        try {
          const entry = await store.create(scope, {
            ...(idValue !== undefined ? { id: idValue } : {}),
            kind,
            title,
            content,
            ...(optionalString(args, "path") !== undefined ? { path: optionalString(args, "path") } : {}),
            ...(reference !== undefined ? { reference } : {}),
            ...(argsRecord !== undefined ? { arguments: argsRecord } : {}),
            ...(metadata !== undefined ? { metadata } : {}),
          });
          return { content: `Created ${kind} entry ${JSON.stringify(entry.id)} in ${entry.scope} scope (version ${String(entry.version)}).`, metadata: { entry: entryView(entry) } };
        } catch (error) {
          return refuse(`Create of ${kind} entry was refused`, error);
        }
      }

      // update
      const patch: Record<string, unknown> = {};
      const title = optionalString(args, "title");
      if (title !== undefined) {
        if (title.length > MAX_HARNESS_TITLE_CHARS) throw new Error(`title must be at most ${String(MAX_HARNESS_TITLE_CHARS)} characters.`);
        patch.title = title;
      }
      const content = optionalString(args, "content");
      if (content !== undefined) {
        if (content.length > MAX_HARNESS_CONTENT_CHARS) throw new Error(`content must be at most ${String(MAX_HARNESS_CONTENT_CHARS)} characters.`);
        patch.content = content;
      }
      const pathValue = optionalString(args, "path");
      if (pathValue !== undefined) patch.path = pathValue;
      const reference = optionalRecord(args, "reference");
      if (reference !== undefined) patch.reference = reference;
      const argsRecord = optionalRecord(args, "arguments");
      if (argsRecord !== undefined) patch.arguments = argsRecord;
      const metadata = optionalRecord(args, "metadata");
      if (metadata !== undefined) patch.metadata = metadata;
      if (Object.keys(patch).length === 0) {
        return { content: "prime_harness update received no fields to change; the entry would be version-bumped for nothing.", isError: true, metadata: { refused: "empty-patch" } };
      }
      for (const [recordName, record] of [["reference", reference], ["arguments", argsRecord], ["metadata", metadata]] as const) {
        if (record === undefined) continue;
        const violation = recordBound(recordName, record);
        if (violation) return { content: violation, isError: true, metadata: { refused: "record-bound", record: recordName } };
      }
      const expectedVersion = optionalInteger(args, "expected_version");
      try {
        const entry = await store.update(scope, kind, id, patch, expectedVersion !== undefined ? { expectedVersion } : {});
        return {
          content: `Updated ${kind} entry ${JSON.stringify(entry.id)} in ${entry.scope} scope (version ${String(entry.version)}).`,
          metadata: { entry: entryView(entry), previousVersion: expectedVersion ?? null } satisfies JsonValue,
        };
      } catch (error) {
        return refuse(`Update of ${kind} entry ${JSON.stringify(id)} was refused`, error);
      }
    },
  };
}
