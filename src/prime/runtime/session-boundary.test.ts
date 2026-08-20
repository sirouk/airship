/**
 * Prime session boundary-semantics tests (W2): the prime session authority
 * mirrors core/agent.ts runTurn's boundary block exactly — the sealed live
 * environment rides inside turn.requested, the verified context selection
 * follows as its own event, pinned compression planning and the plan
 * restatement land before the first inference.started of the turn — and one
 * fixture driven through both engines on cloned journals produces the
 * identical canonical event sequence. Refusal sentences are core's verbatim.
 */

import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../ai/stream";
import type { Model } from "../ai/types";
import { type FauxProviderRegistration, registerFauxProvider } from "../ai/providers/faux.test-support";
import { canonicalTaskPlanNote, runTurn } from "../../core/agent";
import {
  canonicalContextSelection,
  sealContextSelection,
  verifyContextSelection,
  type CanonicalContextSelection,
} from "../../core/context-selection";
import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  SessionContextPolicy,
  SessionManifest,
  TaskPlanEntry,
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../../core/contracts";
import { createSessionContextPolicy } from "../../core/context-policy";
import { sha256 } from "../../core/hash";
import { EventJournal } from "../../core/journal";
import type { DurableEvent } from "../../core/journal";
import {
  canonicalLiveEnvironmentSnapshot,
  injectLiveEnvironment,
  verifyLiveEnvironmentSnapshot,
  type LiveEnvironmentObservation,
  type LiveEnvironmentProvider,
} from "../../core/live-environment";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { createSessionManifest } from "../../core/session-manifest";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PRIME_EVENT_TYPES } from "./prime-events";
import { PrimeAgentSession } from "./session";

const SYSTEM_PROMPT = "You are a boundary test assistant.";
const WORKSPACE_ID = "ws-prime-boundary";
const FIXED_NOW = "2024-06-01T00:00:00.000Z";
const SUMMARY_TRIGGER_PADDING = "parity padding words to grow the transcript ";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

function makeStubTool(
  name: string,
  effect: "read" | "write",
  execute: (args: JsonValue, context: ToolContext) => Promise<ToolExecutionResult>,
): Tool {
  return {
    definition: {
      name,
      description: `Boundary stub tool ${name}.`,
      effect,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: true,
      },
    },
    execute,
  };
}

/*
 * One deterministic inference transport for both engines: a tool call when
 * the trigger phrase is asked and no tool message answered it yet, plain
 * text otherwise, usage never reported (so both engines estimate on the
 * default bytes-per-token basis and calibration stays silent).
 */
class ScriptedBoundaryTransport implements InferenceTransport {
  readonly id = "faux";
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];

  constructor(private readonly script: Readonly<{ toolTrigger?: string; text?: string }> = {}) {}

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    const trigger = this.script.toolTrigger;
    if (
      trigger !== undefined &&
      request.tools.length > 0 &&
      !request.messages.some((message) => message.role === "tool") &&
      request.messages.some((message) => message.role === "user" && message.content.includes(trigger))
    ) {
      yield { type: "tool-call", call: { id: "call-fixed-1", name: "lookup", arguments: { query: trigger } } };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: this.script.text ?? "Grounded boundary answer." };
    yield { type: "completed", finishReason: "stop" };
  }
}

/** A live-environment capture that is fixed forever: parity is an assertion about sealing, not about the world. */
function fixedLiveObservation(): LiveEnvironmentObservation {
  return {
    capturedAt: FIXED_NOW,
    browser: [],
    execution: [],
    providers: [],
    storage: [],
    extension: [],
    workspaceIndex: { state: "not-observed", detail: "boundary fixture" },
    limitations: [],
  };
}

const BOUNDARY_TASKS: readonly TaskPlanEntry[] = [
  { id: "task-1", content: "Ship the boundary port", status: "in-progress" },
  { id: "task-2", content: "Land the plan note", status: "open" },
];

/** Mint a sealed, verifiable v1 selection for the exact query it will be asked with. */
async function mintV1Selection(query: string): Promise<CanonicalContextSelection> {
  const hitText = "Boundary retrieval text.";
  return sealContextSelection({
    version: 1,
    queryDigest: await sha256(query),
    generationDigest: await sha256("boundary-generation"),
    workspaceSnapshotDigest: await sha256("boundary-snapshot"),
    selectedAt: FIXED_NOW,
    maxHits: 4,
    maxBytes: 32 * 1024,
    selectedBytes: new TextEncoder().encode(hitText).byteLength,
    truncated: false,
    hits: [{
      path: "/workspace/docs/boundary.md",
      revision: "rev-1",
      contentDigest: await sha256("boundary-content"),
      chunkId: await sha256("boundary-chunk-0"),
      chunkIndex: 0,
      score: 0.75,
      text: hitText,
      textDigest: await sha256(hitText),
    }],
  });
}

/** Mint a sealed, verifiable v2 selection whose lineage scope names another session. */
async function mintV2Selection(query: string, scopeSessionId: string): Promise<CanonicalContextSelection> {
  const hitText = "Scoped boundary retrieval text.";
  const generationId = await sha256("boundary-generation-v2-id");
  return sealContextSelection({
    version: 2,
    queryDigest: await sha256(query),
    generationDigest: await sha256("boundary-generation-v2"),
    workspaceSnapshotDigest: await sha256("boundary-snapshot-v2"),
    selectedAt: FIXED_NOW,
    maxHits: 4,
    maxBytes: 32 * 1024,
    selectedBytes: new TextEncoder().encode(hitText).byteLength,
    truncated: false,
    hits: [{
      path: "/workspace/docs/scoped.md",
      revision: "rev-1",
      contentDigest: await sha256("scoped-content"),
      chunkId: await sha256("scoped-chunk-0"),
      chunkIndex: 0,
      score: 0.9,
      text: hitText,
      textDigest: await sha256(hitText),
      corpus: "workspace",
      sourceId: "boundary-source",
      lineageRef: generationId,
    }],
    lineage: {
      retriever: "airship-federated-turn-context-v1",
      scope: { sessionId: scopeSessionId },
      generations: [{
        id: generationId,
        corpus: "workspace",
        sourceRevision: "rev-1",
        sourceDigest: await sha256("scoped-source"),
        extractor: "boundary-extractor",
        chunker: "boundary-chunker",
        embedding: { provider: "boundary-embedder", dimensions: 8, posture: "local-semantic" },
        indexFormat: "boundary-index-v1",
        persistence: "memory-only",
      }],
    },
  });
}

type BoundaryFixture = Readonly<{
  model: Model<string>;
  journal: EventJournal;
  registry: ToolRegistry;
  sessionId: string;
  manifest: SessionManifest;
}>;

async function makeBoundaryFixture(options: Readonly<{
  tools?: Tool[];
  turnContext?: "required" | "disabled";
  contextPolicy?: SessionContextPolicy;
  journal?: EventJournal;
  manifest?: SessionManifest;
}> = {}): Promise<BoundaryFixture> {
  const registration = registerFauxProvider({});
  registrations.push(registration);
  const model = registration.getModel();
  if (!model) throw new Error("faux registration has no model");
  const journal = options.journal ?? new EventJournal(new MemoryJournalBackend());
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const manifest = options.manifest ?? await createSessionManifest({
    systemPrompt: SYSTEM_PROMPT,
    providerId: model.provider,
    model: model.id,
    tools: registry.definitions(),
    workspaceId: WORKSPACE_ID,
    securityPosture: "local",
    ...(options.turnContext ? { turnContext: options.turnContext } : {}),
    ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}),
    now: FIXED_NOW,
  });
  const record = await journal.createSession("prime boundary test", manifest);
  return { model, journal, registry, sessionId: record.id, manifest };
}

function makeSession(
  fixture: BoundaryFixture,
  transport?: InferenceTransport,
): PrimeAgentSession {
  return new PrimeAgentSession({
    sessionId: fixture.sessionId,
    manifest: fixture.manifest,
    journal: fixture.journal,
    registry: fixture.registry,
    approvalPolicy: allowAllForTests,
    model: fixture.model,
    ...(transport ? { transport } : { streamFn: streamSimple }),
  });
}

function eventsOfType(events: readonly DurableEvent[], type: string): DurableEvent[] {
  return events.filter((event) => event.type === type);
}

function payloadRecord(event: DurableEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

/** Positions of `type` within `events`, restricted to one turn when given. */
function indexesOf(events: readonly DurableEvent[], type: string, turnId?: string): number[] {
  const indexes: number[] = [];
  events.forEach((event, index) => {
    if (event.type !== type) return;
    if (turnId !== undefined && event.turnId !== turnId) return;
    indexes.push(index);
  });
  return indexes;
}

describe("PrimeAgentSession boundary semantics", () => {
  describe("turn-context refusals", () => {
    it("refuses a protocol-v1 manifest pinning turn-context policy with core's sentence", async () => {
      const fixture = await makeBoundaryFixture();
      const v1Manifest = { ...fixture.manifest, protocolVersion: 1, turnContext: "required" } as unknown as SessionManifest;
      expect(() => makeSession({ ...fixture, manifest: v1Manifest })).toThrow(
        "Protocol-v1 session manifests cannot pin turn-context policy.",
      );
    });

    it("refuses a plain protocol-v1 manifest as replay-only with core's fork-the-session sentence", async () => {
      const fixture = await makeBoundaryFixture();
      const v1Manifest = { ...fixture.manifest, protocolVersion: 1, turnContext: undefined } as unknown as SessionManifest;
      expect(() => makeSession({ ...fixture, manifest: v1Manifest })).toThrow(
        "Protocol-v1 sessions are replay-only; fork the session before starting a new turn.",
      );
    });

    it("fails a required-context turn with no provider attached, after turn.requested, with core's sentence", async () => {
      const fixture = await makeBoundaryFixture({ turnContext: "required" });
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const result = await session.prompt("needs retrieval");
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("This session requires turn-context retrieval, but no provider is attached.");
      expect(eventsOfType(result.events, "turn.requested")).toHaveLength(1);
      expect(eventsOfType(result.events, "turn.context.selected")).toHaveLength(0);
      expect(eventsOfType(result.events, "inference.started")).toHaveLength(0);
      const failed = eventsOfType(result.events, "turn.failed");
      expect(failed).toHaveLength(1);
      expect(payloadRecord(failed[0]!).error).toBe("This session requires turn-context retrieval, but no provider is attached.");
      await session.dispose("test end");
    });

    it("fails a non-canonical selection with core's sentence", async () => {
      const fixture = await makeBoundaryFixture({ turnContext: "required" });
      fixture.registry.attachTurnContextProvider({
        selectForTurn: async () => ({ totally: "not a selection" }) as unknown as CanonicalContextSelection,
      });
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const result = await session.prompt("needs retrieval");
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("The turn-context provider returned a non-canonical selection.");
      expect(payloadRecord(eventsOfType(result.events, "turn.failed")[0]!).error)
        .toBe("The turn-context provider returned a non-canonical selection.");
      expect(eventsOfType(result.events, "inference.started")).toHaveLength(0);
      await session.dispose("test end");
    });

    it("fails a selection whose commitments did not verify with core's sentence", async () => {
      const fixture = await makeBoundaryFixture({ turnContext: "required" });
      fixture.registry.attachTurnContextProvider({
        selectForTurn: async (query) => {
          const sealed = await mintV1Selection(query);
          // Canonical shape, same byte length, different bytes: the sealed digests no longer cover the hit text.
          return { ...sealed, hits: [{ ...sealed.hits[0]!, text: "Boundary retrieval text?" }] } as CanonicalContextSelection;
        },
      });
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const result = await session.prompt("needs retrieval");
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("The turn-context provider returned a selection whose commitments did not verify.");
      await session.dispose("test end");
    });

    it("fails a selection minted for a different canonical query with core's sentence", async () => {
      const fixture = await makeBoundaryFixture({ turnContext: "required" });
      fixture.registry.attachTurnContextProvider({
        selectForTurn: async () => mintV1Selection("a question that was never asked"),
      });
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const result = await session.prompt("needs retrieval");
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("The turn-context provider returned a selection for a different canonical query.");
      await session.dispose("test end");
    });

    it("fails a scoped selection whose lineage is outside the session pin with core's sentence", async () => {
      const fixture = await makeBoundaryFixture({ turnContext: "required" });
      fixture.registry.attachTurnContextProvider({
        selectForTurn: async (query) => mintV2Selection(query, "session-not-this-one"),
      });
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const result = await session.prompt("needs retrieval");
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("The turn-context provider returned lineage outside this session's pinned scope.");
      await session.dispose("test end");
    });

    it("selects nothing when the session disables turn-context retrieval", async () => {
      const fixture = await makeBoundaryFixture({ turnContext: "disabled" });
      let consulted = false;
      fixture.registry.attachTurnContextProvider({
        selectForTurn: async (query) => {
          consulted = true;
          return mintV1Selection(query);
        },
      });
      const transport = new ScriptedBoundaryTransport();
      const session = makeSession(fixture, transport);
      const result = await session.prompt("no retrieval wanted");
      expect(result.outcome).toBe("completed");
      expect(consulted).toBe(false);
      expect(eventsOfType(result.events, "turn.context.selected")).toHaveLength(0);
      expect(transport.requests).toHaveLength(1);
      // No selection injection reached the provider-visible request.
      expect(transport.requests[0]!.messages[0]!.content).toBe("no retrieval wanted");
      await session.dispose("test end");
    });
  });

  describe("compression boundary", () => {
    function compressionPolicy(): SessionContextPolicy {
      return createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "boundary compression fixture" },
        compression: { preserveRecentTurns: 1 },
      });
    }

    /** Turn 3+ prompts are long enough that the boundary estimate crosses the pinned 82% threshold. */
    function longPrompt(label: string): string {
      return `${label} ${SUMMARY_TRIGGER_PADDING.repeat(180)}`;
    }

    async function runCompressingSession(
      fixture: BoundaryFixture,
      turnCount: number,
    ): Promise<{ session: PrimeAgentSession; results: readonly Awaited<ReturnType<PrimeAgentSession["prompt"]>>[] }> {
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const results: Awaited<ReturnType<PrimeAgentSession["prompt"]>>[] = [];
      for (let index = 0; index < turnCount; index += 1) {
        results.push(await session.prompt(longPrompt(`turn ${index}`)));
      }
      return { session, results };
    }

    it("journals context.summary.updated then turn.plan.restated with the canonical note, before the turn's first inference.started", async () => {
      const fixture = await makeBoundaryFixture({ contextPolicy: compressionPolicy() });
      fixture.registry.attachTaskPlanProvider({
        openTasks: async () => BOUNDARY_TASKS,
      });
      const { session, results } = await runCompressingSession(fixture, 4);
      for (const result of results) expect(result.outcome).toBe("completed");
      const journal = await fixture.journal.readEvents(fixture.sessionId);

      const summaries = eventsOfType(journal, "context.summary.updated");
      expect(summaries.length).toBeGreaterThanOrEqual(1);
      const notes = eventsOfType(journal, "turn.plan.restated");
      expect(notes).toHaveLength(summaries.length);

      // Turn one never compacts: boundary evidence starts only once history outgrows the pinned window.
      const firstTurnId = eventsOfType(journal, "turn.requested")[0]!.turnId;
      expect(summaries.every((event) => event.turnId !== firstTurnId)).toBe(true);

      for (const summary of summaries) {
        const turnId = summary.turnId!;
        const requestedAt = indexesOf(journal, "turn.requested", turnId)[0]!;
        const summaryAt = indexesOf(journal, "context.summary.updated", turnId)[0]!;
        const noteAt = indexesOf(journal, "turn.plan.restated", turnId)[0]!;
        const startedAt = indexesOf(journal, "inference.started", turnId)[0]!;
        // core's exact order: request record, compaction commitment, plan restatement, first step.
        expect(requestedAt).toBeLessThan(summaryAt);
        expect(summaryAt).toBeLessThan(noteAt);
        expect(noteAt).toBeLessThan(startedAt);

        const note = journal[noteAt]!;
        expect(note.payload).toEqual({
          openTaskCount: BOUNDARY_TASKS.length,
          tasks: BOUNDARY_TASKS.map((task) => ({ id: task.id, content: task.content, status: task.status })),
        });
        const rendered = canonicalTaskPlanNote(note.payload);
        expect(rendered).toBeDefined();
        for (const task of BOUNDARY_TASKS) {
          expect(rendered).toContain(task.content);
          expect(rendered).toContain(`[${task.id}]`);
        }
      }
      await session.dispose("test end");
    });

    it("restates no plan when the plan provider reports no open tasks, and still compacts", async () => {
      const fixture = await makeBoundaryFixture({ contextPolicy: compressionPolicy() });
      fixture.registry.attachTaskPlanProvider({ openTasks: async () => [] });
      const { session } = await runCompressingSession(fixture, 4);
      const journal = await fixture.journal.readEvents(fixture.sessionId);
      expect(eventsOfType(journal, "context.summary.updated").length).toBeGreaterThanOrEqual(1);
      expect(eventsOfType(journal, "turn.plan.restated")).toHaveLength(0);
      await session.dispose("test end");
    });

    it("restates no plan when no plan provider is attached, and still compacts", async () => {
      const fixture = await makeBoundaryFixture({ contextPolicy: compressionPolicy() });
      const { session } = await runCompressingSession(fixture, 4);
      const journal = await fixture.journal.readEvents(fixture.sessionId);
      expect(eventsOfType(journal, "context.summary.updated").length).toBeGreaterThanOrEqual(1);
      expect(eventsOfType(journal, "turn.plan.restated")).toHaveLength(0);
      await session.dispose("test end");
    });

    it("journals neither summary nor plan note when the session pins no context policy", async () => {
      const fixture = await makeBoundaryFixture();
      fixture.registry.attachTaskPlanProvider({ openTasks: async () => BOUNDARY_TASKS });
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const result = await session.prompt(longPrompt("one turn"));
      expect(result.outcome).toBe("completed");
      expect(eventsOfType(result.events, "context.summary.updated")).toHaveLength(0);
      expect(eventsOfType(result.events, "turn.plan.restated")).toHaveLength(0);
      await session.dispose("test end");
    });
  });

  describe("live environment", () => {
    it("seals the verified snapshot into turn.requested and injects it into the provider-visible request", async () => {
      const provider: LiveEnvironmentProvider = { capture: async () => fixedLiveObservation() };
      const fixture = await makeBoundaryFixture();
      fixture.registry.attachLiveEnvironmentProvider(provider);
      const transport = new ScriptedBoundaryTransport();
      const session = makeSession(fixture, transport);
      await fixture.journal.setSessionModel(fixture.sessionId, "boundary-model-switched");
      const result = await session.prompt("describe where you are");
      expect(result.outcome).toBe("completed");

      const requested = eventsOfType(result.events, "turn.requested")[0]!;
      const raw = payloadRecord(requested).liveEnvironment;
      expect(raw).toBeDefined();
      const snapshot = canonicalLiveEnvironmentSnapshot(raw);
      expect(snapshot).toBeDefined();
      expect(await verifyLiveEnvironmentSnapshot(snapshot!)).toBe(true);
      expect(snapshot!.sessionId).toBe(fixture.sessionId);
      expect(snapshot!.workspaceId).toBe(fixture.manifest.workspaceId);
      expect(snapshot!.capturedAt).toBe(FIXED_NOW);
      expect(snapshot!.tools.manifestDigest).toBe(fixture.manifest.toolManifestDigest);
      expect(snapshot!.inference.providerId).toBe(fixture.manifest.providerId);
      expect(snapshot!.inference.model).toBe("boundary-model-switched");
      expect(transport.requests[0]?.model).toBe("boundary-model-switched");
      expect(snapshot!.inference.posture).toBe("local");

      // The provider-visible request carries exactly the canonical injection.
      const userMessages = transport.requests[0]!.messages.filter((message) => message.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]!.content).toBe(injectLiveEnvironment("describe where you are", snapshot!));
      await session.dispose("test end");
    });

    it("journals no liveEnvironment when no provider is attached", async () => {
      const fixture = await makeBoundaryFixture();
      const session = makeSession(fixture, new ScriptedBoundaryTransport());
      const result = await session.prompt("plain turn");
      expect(result.outcome).toBe("completed");
      expect(payloadRecord(eventsOfType(result.events, "turn.requested")[0]!).liveEnvironment).toBeUndefined();
      await session.dispose("test end");
    });
  });
});


/*
 * Byte parity with core/agent.ts: one fixture (registry, providers, policy,
 * scripted transport script, shared manifest) is installed on two cloned
 * journals; core/agent.ts runTurn drives one, the prime session authority
 * the other. The canonical transcript — every event outside the prime.*
 * custody namespace — must then be identical in both journals once volatile
 * identities (session scope, turn and operation identity, digest chains
 * bound to random turn ids, receipts, seal digests pinned to a session id)
 * are normalized. The provider-visible request stream gets the same
 * treatment, which is where selection/environment/summary injection parity
 * actually lives.
 */

/** Identity-bearing or session-pinned value positions excluded from byte parity. */
const VOLATILE_PARITY_KEYS = new Set([
  "requestDigest",
  "receipt",
  "receiptId",
  "snapshotDigest",
  "summarizerProvenance",
  "sourceStartPreviousDigest",
  "sourceEndDigest",
  "sourceStartSequence",
  "sourceEndSequence",
  "previousSummaryDigest",
  "summaryDigest",
]);

type NormalizedJournal = Readonly<{
  entries: readonly unknown[];
  summaries: readonly Record<string, unknown>[];
}>;

/*
 * Canonical-transcript view of one journal, with volatile identity replaced
 * deterministically: turn and operation identity become ordinals of first
 * appearance, the session scope becomes a placeholder, and the digests that
 * exist to bind random turn identity or the chain itself are masked. What
 * remains must be byte-equal between the two engines.
 */
function normalizeForParity(events: readonly DurableEvent[]): NormalizedJournal {
  const canonical = events.filter((event) => !event.type.startsWith("prime."));
  const turnIds = new Map<string, string>();
  const operationIds = new Map<string, string>();
  const mapId = (map: Map<string, string>, id: string | undefined, prefix: string): void => {
    if (id && !map.has(id)) map.set(id, `${prefix}-${map.size}`);
  };
  for (const event of canonical) {
    if (event.turnId) {
      if (!turnIds.has(event.turnId)) turnIds.set(event.turnId, `turn-${turnIds.size}`);
    }
    if (event.operationId) {
      if (!operationIds.has(event.operationId)) operationIds.set(event.operationId, `op-${operationIds.size}`);
    }
  }
  const sessionId = canonical[0]?.sessionId;
  const replacements: readonly (readonly [string, string])[] = [
    ...(sessionId ? [[sessionId, "<session>"] as const] : []),
    ...[...turnIds].map(([raw, mapped]) => [raw, mapped] as const),
    ...[...operationIds].map(([raw, mapped]) => [raw, mapped] as const),
  ];
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [raw, mapped] of replacements) out = out.split(raw).join(mapped);
      return out;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        scrubbed[key] = VOLATILE_PARITY_KEYS.has(key) ? "<volatile>" : scrub(inner);
      }
      return scrubbed;
    }
    return value;
  };
  const entries = canonical.map((event, index) => ({
    index,
    type: event.type,
    ...(event.turnId ? { turnId: turnIds.get(event.turnId) } : {}),
    ...(event.operationId ? { operationId: operationIds.get(event.operationId) } : {}),
    payload: scrub(event.payload ?? null),
  }));
  const summaries = canonical
    .filter((event) => event.type === "context.summary.updated")
    .map((event) => event.payload as Record<string, unknown>);
  return { entries, summaries };
}

/*
 * Provider-visible request view: volatile request identity scrubbed,
 * conversation kept byte-exact. Digests embedded inside message strings —
 * the sealed snapshot's session-bound digest, the summary chain's reference
 * digests, per-event digests in summarizer source records, and the custody
 * record's +1 sequence shift leaking into "(events a-b)" range labels — are
 * volatile by construction; their deterministic counterparts are compared
 * field-by-field at the journal level instead.
 */
const EMBEDDED_DIGEST = /sha256:[A-Za-z0-9_-]{43}/gu;
const EMBEDDED_EVENT_SEQUENCE = /"eventSequence":\d+/gu;
const EMBEDDED_SOURCE_SEQUENCE = /"source(Start|End)Sequence":\d+/gu;
const EMBEDDED_RANGE_LABEL = /\(events \d+-\d+\)/gu;

function scrubEmbeddedVolatiles(value: string): string {
  return value
    .replace(EMBEDDED_DIGEST, "<digest>")
    .replace(EMBEDDED_EVENT_SEQUENCE, '"eventSequence":<sequence>')
    .replace(EMBEDDED_SOURCE_SEQUENCE, '"source$1Sequence":<sequence>')
    .replace(EMBEDDED_RANGE_LABEL, "(events <range>)");
}

function normalizeRequest(
  request: InferenceRequest,
  replacements: readonly (readonly [string, string])[],
): unknown {
  const scrubString = (value: string): string => {
    let out = value;
    for (const [raw, mapped] of replacements) out = out.split(raw).join(mapped);
    return scrubEmbeddedVolatiles(out);
  };
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) scrubbed[key] = scrub(inner);
      return scrubbed;
    }
    return value;
  };
  return {
    model: request.model,
    systemPrompt: scrub(request.systemPrompt),
    messages: scrub(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function requestReplacements(requests: readonly InferenceRequest[]): readonly (readonly [string, string])[] {
  const turnIds: string[] = [];
  for (const request of requests) {
    if (request.turnId && !turnIds.includes(request.turnId)) turnIds.push(request.turnId);
  }
  const sessionIds: string[] = [];
  for (const request of requests) {
    if (request.sessionId && !sessionIds.includes(request.sessionId)) sessionIds.push(request.sessionId);
  }
  return [
    ...sessionIds.map((id, index) => [id, `<session-${index}>`] as const),
    ...turnIds.map((id, index) => [id, `turn-${index}`] as const),
  ];
}

describe("byte parity with core/agent.ts", () => {
  it("produces the identical canonical event sequence and provider-visible requests on cloned journals", async () => {
    const registration = registerFauxProvider({});
    registrations.push(registration);
    const model = registration.getModel();
    if (!model) throw new Error("faux registration has no model");

    const registry = new ToolRegistry();
    registry.register(makeStubTool("lookup", "read", async () => ({ content: "lookup parity result" })));
    registry.attachTurnContextProvider({
      selectForTurn: async (query) => mintV1Selection(query),
    });
    registry.attachLiveEnvironmentProvider({ capture: async () => fixedLiveObservation() });
    registry.attachTaskPlanProvider({ openTasks: async () => BOUNDARY_TASKS });

    const contextPolicy = createSessionContextPolicy({
      contextWindowTokens: 2_048,
      source: { kind: "runtime-config", label: "boundary parity fixture" },
      compression: { preserveRecentTurns: 1 },
      summarizer: {
        mode: "inference-transport",
        adapterId: "airship/inference-transport-summary-v1",
        onFailure: "extractive-fallback",
      },
    });

    /*
     * One manifest shared by both clones: every digest the manifest pins is
     * computed once, over one registry, so nothing structurally visible can
     * drift between the engines — only the volatile identities do.
     */
    const manifest = await createSessionManifest({
      systemPrompt: SYSTEM_PROMPT,
      providerId: model.provider,
      model: model.id,
      tools: registry.definitions(),
      workspaceId: WORKSPACE_ID,
      securityPosture: "local",
      turnContext: "required",
      contextPolicy,
      now: FIXED_NOW,
    });

    const contents = [
      "call the lookup tool for me",
      `second turn ${SUMMARY_TRIGGER_PADDING.repeat(180)}`,
      `third turn ${SUMMARY_TRIGGER_PADDING.repeat(180)}`,
      `fourth turn ${SUMMARY_TRIGGER_PADDING.repeat(180)}`,
      `fifth turn ${SUMMARY_TRIGGER_PADDING.repeat(180)}`,
    ];

    // Clone one: the airship-core engine.
    const coreJournal = new EventJournal(new MemoryJournalBackend());
    const coreRecord = await coreJournal.createSession("parity clone", manifest);
    const coreTransport = new ScriptedBoundaryTransport({ toolTrigger: "call the lookup tool for me" });
    for (const content of contents) {
      await runTurn({
        sessionId: coreRecord.id,
        content,
        transport: coreTransport,
        tools: registry,
        journal: coreJournal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      });
    }

    // Clone two: the prime session authority, same fixture, same manifest.
    const primeJournal = new EventJournal(new MemoryJournalBackend());
    const primeRecord = await primeJournal.createSession("parity clone", manifest);
    const primeTransport = new ScriptedBoundaryTransport({ toolTrigger: "call the lookup tool for me" });
    const primeSession = new PrimeAgentSession({
      sessionId: primeRecord.id,
      manifest,
      journal: primeJournal,
      registry,
      approvalPolicy: allowAllForTests,
      model: registration.getModel()!,
      transport: primeTransport,
    });
    for (const content of contents) {
      const result = await primeSession.prompt(content);
      expect(result.outcome).toBe("completed");
    }

    const coreEvents = await coreJournal.readEvents(coreRecord.id);
    const primeRawEvents = await primeJournal.readEvents(primeRecord.id);

    // The custody record is the single prime-only event; written once at
    // takeover, before the first turn record, so every later sequence shifts
    // by exactly one against core's clone.
    const custody = primeRawEvents.filter((event) => event.type.startsWith("prime."));
    expect(custody.map((event) => event.type)).toEqual([PRIME_EVENT_TYPES.customNotice]);
    expect(coreEvents.some((event) => event.type.startsWith("prime."))).toBe(false);
    const firstRequestedAt = indexesOf(primeRawEvents, "turn.requested")[0]!;
    expect(indexesOf(primeRawEvents, PRIME_EVENT_TYPES.customNotice)[0]!).toBeLessThan(firstRequestedAt);

    // Every journaled selection in both journals is canonical and verifies.
    const selections = [...coreEvents, ...primeRawEvents].filter((event) => event.type === "turn.context.selected");
    expect(selections.length).toBeGreaterThanOrEqual(1);
    for (const event of selections) {
      const selection = canonicalContextSelection(payloadRecord(event).contextSelection);
      expect(selection).toBeDefined();
      expect(await verifyContextSelection(selection!)).toBe(true);
    }

    const coreParity = normalizeForParity(coreEvents);
    const primeParity = normalizeForParity(primeRawEvents);
    expect(primeParity.entries).toEqual(coreParity.entries);

    // Both engines compacted on the same turn boundaries, with the identical summary chain (the +1 shift is the custody record).
    expect(primeParity.summaries.length).toBeGreaterThanOrEqual(2);
    expect(primeParity.summaries.length).toBe(coreParity.summaries.length);
    const primeSummaries = eventsOfType(primeRawEvents, "context.summary.updated");
    const coreSummaries = eventsOfType(coreEvents, "context.summary.updated");
    /*
     * The first range opens at the head of the journal (session.created,
     * sequence 1 in both clones), so its start position agrees; the custody
     * record shifts every later sequence — and every later range, which
     * starts right after the previous covered end — by exactly one.
     */
    for (const [index, coreSummary] of coreSummaries.entries()) {
      const primeSummary = primeSummaries[index]!;
      const corePayload = coreSummary.payload as Record<string, unknown>;
      const primePayload = primeSummary.payload as Record<string, unknown>;
      const startShift = index === 0 ? 0 : 1;
      expect(Number(primePayload.sourceStartSequence)).toBe(Number(corePayload.sourceStartSequence) + startShift);
      expect(Number(primePayload.sourceEndSequence)).toBe(Number(corePayload.sourceEndSequence) + 1);
    }

    // Every plan restatement renders byte-identically through the audit's renderer.
    const coreNotes = eventsOfType(coreEvents, "turn.plan.restated");
    const primeNotes = eventsOfType(primeRawEvents, "turn.plan.restated");
    expect(primeNotes.length).toBeGreaterThanOrEqual(1);
    expect(primeNotes.length).toBe(coreNotes.length);
    for (const [index, coreNote] of coreNotes.entries()) {
      expect(canonicalTaskPlanNote(primeNotes[index]!.payload)).toBe(canonicalTaskPlanNote(coreNote.payload));
    }

    // The provider-visible request streams agree message-for-message once request identity is normalized.
    expect(primeTransport.requests.length).toBe(coreTransport.requests.length);
    expect(primeTransport.requests.length).toBeGreaterThanOrEqual(contents.length);
    const primeReplacements = requestReplacements(primeTransport.requests);
    const coreReplacements = requestReplacements(coreTransport.requests);
    const primeRequests = primeTransport.requests.map((request) => normalizeRequest(request, primeReplacements));
    const coreRequests = coreTransport.requests.map((request) => normalizeRequest(request, coreReplacements));
    expect(primeRequests).toEqual(coreRequests);
  });
});
