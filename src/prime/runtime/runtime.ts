/**
 * The prime runtime facade: the embedder-facing registry of session
 * authorities. Owns create/attach/list/prompt/abort/dispose over one page
 * runtime; sessions are keyed by sessionId; manifests come from airship's
 * own `createSessionManifest` so a prime session is digest-identical to an
 * airship session built from the same facts. Disposal is serialized so one
 * session's slow abort cannot reorder another's teardown.
 */

import type { ApprovalPolicy, CanonicalImageInput, JsonValue, SecurityPosture, SessionContextPolicy, SessionManifest, ToolDefinition } from "../../core/contracts";
import type { RunTurnOptions, TurnResult } from "../../core/agent";
import { createSessionManifest } from "../../core/session-manifest";
import type { EventJournal, SessionRecord } from "../../core/journal";
import type { ToolRegistry } from "../../tools/registry";
import type { Api, Model } from "../ai/types";
import type { KernelBudgets } from "../kernel/kernel-contract";
import type { StreamFn } from "../agent";
import type { InferenceTransport } from "../../core/contracts";
import type { AgentSignal } from "../../core/agent";
import { randomUuid } from "../../core/id";
import { sha256, stableStringify } from "../../core/hash";
import { withInferenceRetry } from "../../core/inference-retry";
import { sessionRuntimeKind } from "../../load-agent-runtime";
import {
  PRIME_DEFAULT_SESSION_TITLE,
  primeConversationNamingDrafts,
  primeConversationTitleFromModel,
  primeConversationTitleFromPrompt,
} from "./naming";
import { PrimeAgentSession } from "./session";
import { attachPrimeAgentRegistry, attachPrimeKernelTool, createPrimeToolSurface } from "./tool-surface";
import { primeHarnessStore } from "./harness-store";
import { buildPrimeSystemPrompt, primeToolInventoryFrom } from "../system-prompt";
import { primeHeartbeatStore } from "./heartbeat-store";
import { createPrimeSubagentRegistry } from "./subagent-registry";
import type { PrimeSessionOptions, PrimeTurnResult } from "./session";
import type { ConversationReceipt } from "../../receipts/types";

export type PrimeRuntimeOptions = Readonly<{
  journal: EventJournal;
  registry: ToolRegistry;
  approvalPolicy: ApprovalPolicy;
  /** Test/embedding seam: observe or replace session construction. */
  factory?: (sessionOptions: PrimeSessionOptions) => PrimeAgentSession;
}>;

/** Manifest facts the host pins at session creation; tools default to the live registry surface. */
export type PrimeManifestRequest = Readonly<{
  systemPrompt: string;
  providerId: string;
  model: string;
  workspaceId: string;
  tools?: readonly ToolDefinition[];
  capabilityTier?: SessionManifest["capabilityTier"];
  securityPosture?: SecurityPosture;
  contextPolicy?: SessionContextPolicy;
  turnContext?: "required" | "disabled";
  now?: string;
}>;

export type PrimeSessionWiring = Readonly<{
  model: Model<Api>;
  streamFn?: StreamFn;
  transport?: InferenceTransport;
  onReceipt?: (receipt: ConversationReceipt) => void;
  onSignal?: (signal: AgentSignal) => void;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  getSystemPrompt?: () => string | Promise<string>;
  maxSteps?: number;
  kernelBudgets?: Partial<KernelBudgets>;
  kernelWorkerFactory?: () => Worker;
  signal?: AbortSignal;
}>;

export type PrimeCreateSessionOptions = PrimeSessionWiring & Readonly<{
  title?: string;
  manifest: PrimeManifestRequest;
}>;

export type PrimeAttachSessionOptions = PrimeSessionWiring & Readonly<{
  sessionId: string;
  /** Supplying a manifest skips the journal read; omit to attach from the durable record. */
  manifest?: SessionManifest;
}>;

// App-minted default: a record still wearing this exact string has never
// seen its first prompt, which is what makes the title on the journal record
// itself the naming gate (mirrors app.tsx isAppMintedConversationTitle's role
// for airship's minted titles).
const DEFAULT_SESSION_TITLE = PRIME_DEFAULT_SESSION_TITLE;

export class PrimeRuntime {
  private readonly options: PrimeRuntimeOptions;
  private readonly sessions = new Map<string, PrimeAgentSession>();
  private disposed = false;

  constructor(options: PrimeRuntimeOptions) {
    this.options = options;
  }

  /**
   * New manifest + new journal session + new authority. Digest semantics are
   * exactly `src/core/session-manifest.ts` (protocol v2, sorted tools,
   * toolManifestDigest, systemPromptDigest): a runtime-created session is
   * indistinguishable from one the airship side created.
   */
  async createSession(options: PrimeCreateSessionOptions): Promise<PrimeAgentSession> {
    this.assertLive();
    const tools = [...(options.manifest.tools ?? this.options.registry.definitions())];
    const manifest = await createSessionManifest({
      systemPrompt: options.manifest.systemPrompt,
      providerId: options.manifest.providerId,
      model: options.manifest.model,
      tools,
      workspaceId: options.manifest.workspaceId,
      ...(options.manifest.capabilityTier !== undefined ? { capabilityTier: options.manifest.capabilityTier } : {}),
      ...(options.manifest.securityPosture !== undefined ? { securityPosture: options.manifest.securityPosture } : {}),
      ...(options.manifest.contextPolicy !== undefined ? { contextPolicy: options.manifest.contextPolicy } : {}),
      ...(options.manifest.turnContext !== undefined ? { turnContext: options.manifest.turnContext } : {}),
      ...(options.manifest.now !== undefined ? { now: options.manifest.now } : {}),
    });
    const record = await this.options.journal.createSession(
      options.title ?? DEFAULT_SESSION_TITLE,
      manifest,
    );
    const session = this.buildSession({
      ...options,
      sessionId: record.id,
      manifest,
    });
    this.sessions.set(record.id, session);
    return session;
  }

  /**
   * Rebind a session authority to an existing journal session. The manifest
   * is the durable record's (the journal is the authority), unless the host
   * re-pins it explicitly.
   */
  async attachSession(options: PrimeAttachSessionOptions): Promise<PrimeAgentSession> {
    this.assertLive();
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Session ${options.sessionId} is already attached to this runtime.`);
    }
    let manifest = options.manifest;
    if (!manifest) {
      const record = await this.options.journal.getSession(options.sessionId);
      if (!record) throw new Error(`Unknown session: ${options.sessionId}`);
      manifest = record.manifest;
    }
    const session = this.buildSession({ ...options, manifest });
    this.sessions.set(options.sessionId, session);
    return session;
  }

  /** The journal is the session library; the runtime only lists what is durable. */
  listSessions(): Promise<SessionRecord[]> {
    return this.options.journal.listSessions();
  }

  /** The currently attached session authority, when one is bound. */
  getSession(sessionId: string): PrimeAgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  async prompt(sessionId: string, content: string, images?: readonly CanonicalImageInput[]): Promise<PrimeTurnResult> {
    const session = this.requireSession(sessionId);
    const naming = await this.prepareConversationNaming(sessionId, content);
    const result = await session.prompt(content, images);
    /*
     * The model-naming request runs strictly off the turn's critical path:
     * it fires after the turn completed and its promise is never awaited,
     * matching app.tsx verbatim. A failed or unusable answer changes
     * nothing about the result — the request that was made is journaled
     * either way, because it was requested and billed.
     */
    if (naming && result.outcome === "completed") {
      void this.applyConversationNaming(sessionId, content, naming.transport, naming.model);
    }
    return result;
  }

  /**
   * Naming gate, mirroring app.tsx exactly: heuristic title first so the
   * thread is never nameless; the flag is the journal-record title itself
   * (a default-title record has never met a prompt). Best-effort by
   * construction — titling is presentational and must never fail a turn.
   *
   * The once-only latch is the `namingWiring.delete` below and nothing else:
   * dropping the wiring before the request is issued makes "at most one paid
   * naming request per attached session" a synchronous fact. Nothing tracks
   * or cancels the request after that, by design — a presentational request
   * must not hold up `waitForIdle` or teardown.
   */
  private async prepareConversationNaming(
    sessionId: string,
    content: string,
  ): Promise<{ transport: InferenceTransport; model: string } | undefined> {
    const wiring = this.namingWiring.get(sessionId);
    if (!wiring) return undefined;
    let record;
    try {
      record = await this.options.journal.getSession(sessionId);
    } catch {
      return undefined;
    }
    if (!record || record.title !== DEFAULT_SESSION_TITLE) return undefined;
    this.namingWiring.delete(sessionId);
    try {
      await this.options.journal.renameSession(sessionId, primeConversationTitleFromPrompt(content));
    } catch {
      // A storage race on a presentation detail must not prevent the turn.
    }
    return wiring;
  }

  /** The paid model-naming request and its journaling; never throws outward. */
  private async applyConversationNaming(
    sessionId: string,
    content: string,
    transport: InferenceTransport,
    model: string,
  ): Promise<void> {
    try {
      const identity = {
        sessionId,
        turnId: `naming-${randomUuid()}`,
        operationId: `naming-request-${randomUuid()}`,
      };
      const named = await primeConversationTitleFromModel({ transport, model, content, identity });
      if (!named) return;
      await this.options.journal.append(
        sessionId,
        primeConversationNamingDrafts(named, {
          model,
          turnId: identity.turnId,
          operationId: identity.operationId,
        }),
      );
      if (named.title) {
        await this.options.journal.renameSession(sessionId, named.title);
      }
    } catch (error) {
      // The conversation is already titled heuristically; a naming failure is a no-op.
    }
  }

  async abortTurn(sessionId: string, reason?: string): Promise<void> {
    return this.requireSession(sessionId).abortTurn(reason);
  }

  /** Serialized so teardown order is observable, never racing: one authority at a time. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await session.dispose("The prime runtime was disposed.");
    }
  }

  private requireSession(sessionId: string): PrimeAgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown prime session: ${sessionId}. Attach it before prompting.`);
    }
    return session;
  }

  /** Transport pinned for the side-channel naming request, keyed by session. */
  private readonly namingWiring = new Map<string, { transport: InferenceTransport; model: string }>();

  private buildSession(
    options: PrimeSessionWiring & Readonly<{ sessionId: string; manifest: SessionManifest }>,
  ): PrimeAgentSession {
    const { title: _title, manifest: _manifest, sessionId, ...wiring } = options as PrimeCreateSessionOptions & { sessionId: string };
    void _title;
    void _manifest;
    const sessionOptions: PrimeSessionOptions = {
      sessionId,
      manifest: options.manifest,
      journal: this.options.journal,
      registry: this.options.registry,
      approvalPolicy: this.options.approvalPolicy,
      ...wiring,
    };
    if (options.transport) {
      this.namingWiring.set(options.sessionId, { transport: options.transport, model: options.manifest.model });
    } else {
      this.namingWiring.delete(options.sessionId);
    }
    return this.options.factory?.(sessionOptions) ?? new PrimeAgentSession(sessionOptions);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("The prime runtime is disposed.");
  }
}



// ---------------------------------------------------------------------------
// The runtime gate (docs/PRIME-RUNTIME-GATE.md): explicit, fail-closed
// selection between airship-core and prime engines, enforced by journal
// evidence instead of flags so the pin is itself durable evidence.
// ---------------------------------------------------------------------------

export type PrimeRuntimeKind = "airship-core" | "prime";

/*
 * The evidence rule is the gate's, re-exported rather than restated. The local
 * two-valued copy that used to live here called an empty journal
 * "airship-core", which docs/PRIME-RUNTIME-GATE.md says is "unpinned" — and
 * that one word decided everything below: a fresh session's `selection` came
 * out "airship-core", so the seal the Proof view reads was never written for
 * any session the gate actually routes here. Importing the eager gate module
 * from this lazy chunk is acyclic (`load-agent-runtime.ts` only `import
 * type`s from here and reaches the engines through `import()`), which is the
 * same move `agent-runtimes.ts` already makes for the read side.
 */
export { sessionRuntimeKind };

const apiFromTransportId = new Map<string, string>([
  ["openai-responses-v1", "openai-responses"],
  ["xai-responses-v1", "openai-responses"],
  ["anthropic-messages-v1", "anthropic-messages"],
  ["chutes-e2ee-v1", "openai-completions"],
  ["ollama-openai-local-v1", "openai-completions"],
  ["lm-studio-openai-local-v1", "openai-completions"],
  ["local-demo", "openai-completions"],
]);

export function primeModelFromManifest(manifest: SessionManifest): Model<Api> {
  const providerId = manifest.providerId;
  const api = apiFromTransportId.get(providerId) ?? "openai-completions";
  return {
    id: manifest.model,
    name: manifest.model,
    api,
    provider: providerId,
    baseUrl: `https://gateway/${encodeURIComponent(providerId)}`,
    reasoning: false,
    thinkingLevelMap: undefined,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: manifest.contextPolicy ? manifest.contextPolicy.contextWindowTokens : 0,
    maxTokens: 0,
  };
}

export async function runPrimeTurn(options: RunTurnOptions & { runtime?: PrimeRuntimeKind }): Promise<TurnResult> {
  const events = await options.journal.readEvents(options.sessionId);
  const history = sessionRuntimeKind(events);
  // Unpinned journals admit prime (PRIME-RUNTIME-GATE.md item 2); only durable
  // airship turn history refuses it. The old `events.length > 0` proxy for
  // "has history" counted the session.created record every real journal
  // carries, so an explicit `runtime: "prime"` on a fresh session was refused
  // as if it were airship-pinned.
  const selection = options.runtime ?? (history === "airship-core" ? "airship-core" : "prime");

  if (selection === "prime" && history === "airship-core") {
    throw new Error(`runtime selection mismatch: this session runs airship-core; fork the session to use the PRIME runtime.`);
  }
  if (selection === "airship-core" && history === "prime") {
    throw new Error(`runtime selection mismatch: this session is prime-pinned; fork the session to use the airship-core runtime.`);
  }

  // Seal-on-first-prime-run evidence pin: a session whose journal's first
  // prime turn lands the seal first, so every later engine decision
  // about this session reads the same durable evidence the Proof view reads.
  if (selection === "prime" && !events.some(
    (event) => event.type.startsWith("prime."),
  )) {
    await options.journal.append(options.sessionId, [
      {
        type: "prime.session.runtime.seal",
        payload: { runtime: "prime", pinnedBy: "prime", at: new Date().toISOString() },
      },
    ]);
  }

  const manifest = (await options.journal.getSession(options.sessionId))?.manifest;
  if (!manifest) throw new Error(`session ${options.sessionId} does not exist in this journal`);
  if (manifest.providerId && options.transport?.id && manifest.providerId !== options.transport.id) {
    throw new Error(`provider pin mismatch: manifest providerId ${manifest.providerId} !== transport.id ${options.transport.id}; fork the session.`);
  }

  const model = primeModelFromManifest(manifest);
  /*
   * The surface this turn runs on.
   *
   * With a workspace port in hand the prime lane composes its own vocabulary
   * over Airship's — prime's file and search tools winning the six names both
   * engines claim, everything Airship has that prime-agent does not carried
   * across untouched. Without one it runs on the registry it was handed, which
   * is the engine-only shape the port shipped in first and is still the shape
   * every direct caller and test gets.
   *
   * `execute_code` is attached after the session exists, not here: the kernel
   * host is session-scoped, and a tool bound to any other host would journal
   * its bridge calls under an operation identity no approval matches.
   */
  /*
   * The subagent family, and the reason it can exist now.
   *
   * `PrimeAgentRegistry` needs a factory that builds a real child runtime, and
   * the only implementation was a test double — so `rlm_spawn`, `subagent`,
   * `agent_message` and `agent_observe` were omitted from every session with a
   * named reason. `createPrimeAgentRuntimeFactory` is that implementation: each
   * child is its own journaled conversation, with its own manifest digested
   * from this same surface, its own kernel and its own approval path.
   *
   * The owner node is this turn's session. Its `sink` is required by the
   * registry constructor — host-synthesized terminal notices are delivered
   * there, so a registry without one could admit a child and have nowhere to
   * report that it died. The parent's sink resolves against the session the
   * turn is about to attach, which is why it is a late-bound closure rather
   * than a value: the registry has to exist before the session that owns it.
   */
  const agentRegistry = options.workspace && options.transport
    ? createPrimeSubagentRegistry({
        journal: options.journal,
        approvalPolicy: options.approvalPolicy,
        workspace: options.workspace,
        airshipTools: options.tools,
        transport: options.transport,
        providerId: manifest.providerId,
        workspaceId: manifest.workspaceId,
        sessionId: options.sessionId,
        model,
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        signal: options.signal,
      })
    : undefined;

  /*
   * One surface, no hedge.
   *
   * Every port is deferred rather than optional, so this composition is
   * deterministic: the same workspace and the same Airship registry always
   * produce the same tool names, which is what `toolManifestDigest` binds. A
   * session created on this build pins exactly what every later turn composes.
   *
   * There is deliberately no fallback to the incoming registry when a manifest
   * disagrees. A conversation pinned to a different tool set is a conversation
   * that was a different agent, and the session already answers that with
   * "fork the session before using a different tool set" — the product's
   * existing contract for exactly this. Quietly running such a turn on a
   * narrower surface would mean two conversations claiming the same engine
   * while reaching different tools, which is worse than a refusal that names
   * the remedy.
   */
  const surface = options.workspace
    ? createPrimeToolSurface({
        workspace: options.workspace,
        airship: options.tools,
        ...(primeHarnessStore() ? { harness: primeHarnessStore()! } : {}),
        heartbeats: primeHeartbeatStore(),
      })
    : undefined;
  // Bound after composition, so the tool names — and therefore the digest —
  // never depend on which ports happened to be constructible this turn.
  if (surface && agentRegistry) attachPrimeAgentRegistry(surface, agentRegistry.registry, agentRegistry.deps.self);

  const runtime = new PrimeRuntime({
    journal: options.journal,
    registry: surface?.registry ?? options.tools,
    approvalPolicy: options.approvalPolicy,
  });
  /*
   * This runtime and its session live exactly one turn, so the turn owns
   * their teardown: without it every turn left its PrimeKernelHost — and any
   * worker it booted — running past the turn that created it, one live worker
   * per turn for the life of the tab. `appendSideband` no-ops once disposed,
   * so the fire-and-forget prime.* writes cannot throw across the teardown.
   */
  try {
    /*
     * The briefing, which the root conversation did not have.
     *
     * `composePrimeSystemPrompt` was wired only into the child factory, so a
     * subagent spawned by `rlm()` knew its working directory, the date, its
     * security posture, its real tool inventory, the harness notes and the
     * live environment — and the conversation that spawned it knew none of
     * that. It got the Agent Profile prompt alone and re-derived its own
     * situation from scratch every turn, which reads exactly like an agent
     * that is unsure what it can do.
     *
     * The Profile's prompt is not replaced; it becomes the identity at the
     * head of the base layer, and prime's layers brief around it. It is
     * delivered through `getSystemPrompt` rather than by rewriting the
     * manifest, because `systemPromptDigest` pins what the person authored
     * and runtime facts are not something a conversation can pin — the date
     * changes, the environment changes, the harness grows. Same reason
     * airship-core injects its live environment per turn instead of into the
     * manifest.
     */
    const briefing = await buildPrimeSystemPrompt({
      sessionId: options.sessionId,
      operatorPrompt: manifest.systemPrompt,
      workingDirectory: "/workspace",
      conversationLogPath: `journal:${options.sessionId}`,
      currentDate: new Date().toISOString().slice(0, 10),
      toolInventory: primeToolInventoryFrom(
        (surface?.registry ?? options.tools).definitions(),
      ),
      ...(manifest.securityPosture !== undefined ? { securityPosture: manifest.securityPosture } : {}),
      ...(primeHarnessStore() ? { harnessStore: primeHarnessStore()! } : {}),
      signal: options.signal,
    });

    const session = await runtime.attachSession({
      sessionId: options.sessionId,
      manifest,
      getSystemPrompt: () => briefing.prompt,
      model,
      /*
       * The credential bridge (W1), and the reason no `getApiKey` accompanies
       * it.
       *
       * Every vendor transport this product carries — Chutes E2EE, anthropic,
       * openai, ollama, lm-studio — arrives at this gate with its credential
       * plumbing already bound to it: a vault-backed key, a connection-pinned
       * generation, an extension OAuth bridge. Forwarding the transport means
       * the prime lane's provider calls go back out over the caller's own
       * wire, through `createTransportForPrimeModel`, so the ported provider
       * registry is never asked to resolve a key it was never told about —
       * which is exactly the "No API key for provider: <id>" this slot was
       * left empty to avoid. `getApiKey` belongs to the other lane, the one a
       * session with no transport takes, and `RunTurnOptions.transport` is
       * required, so that lane is unreachable from the app.
       *
       * Retry parity with core: `core/agent.ts` wraps the caller's transport
       * in `withInferenceRetry` before its loop ever sees it, and the bridge
       * in `transport-adapter.ts` folds prime's structural stream failures
       * back into the shape that wrapper reads. So the wrap belongs here —
       * outside the adapter, around the airship wire — and a prime turn
       * redelivers a transient provider refusal exactly as an airship-core
       * turn does. `options.retry` is honoured for the same reason it is
       * there: a caller passing `maxAttempts: 1` opts both engines out alike.
       */
      transport: withInferenceRetry(options.transport, options.retry),
      onSignal: options.onSignal,
      maxSteps: options.maxSteps,
      signal: options.signal,

    });

    if (surface) attachPrimeKernelTool(surface, session.kernelHost);
    // The owner's sink is only answerable once the session exists; the
    // registry was built before it because the tool surface needed it first.
    agentRegistry?.bindOwnerSession(session);

    const result = await session.prompt(options.content, options.images);
    if (result.outcome !== "completed") {
      throw new Error(
        result.outcome === "cancelled" ? `prime turn cancelled: ${result.reason}` : `prime turn failed: ${result.error}`,
      );
    }
    if (result.text === undefined || result.receipt === undefined) {
      throw new Error("prime turn result was malformed: completed without text or receipt.");
    }
    return {
      turnId: result.turnId,
      content: result.text,
      receipt: result.receipt,
      events: result.events,
    };
  } finally {
    await runtime.dispose();
  }
}
