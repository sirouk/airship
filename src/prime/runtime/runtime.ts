/**
 * The prime runtime facade: the embedder-facing registry of session
 * authorities. Owns create/attach/list/prompt/abort/dispose over one page
 * runtime; sessions are keyed by sessionId; manifests come from airship's
 * own `createSessionManifest` so a prime session is digest-identical to an
 * airship session built from the same facts. Disposal is serialized so one
 * session's slow abort cannot reorder another's teardown.
 */

import type { ApprovalPolicy, CanonicalImageInput, SecurityPosture, SessionContextPolicy, SessionManifest, ToolDefinition } from "../../core/contracts";
import { createSessionManifest } from "../../core/session-manifest";
import type { EventJournal, SessionRecord } from "../../core/journal";
import type { ToolRegistry } from "../../tools/registry";
import type { Api, Model } from "../ai/types";
import type { KernelBudgets } from "../kernel/kernel-contract";
import type { StreamFn } from "../agent";
import type { InferenceTransport } from "../../core/contracts";
import type { AgentSignal } from "../../core/agent";
import { PrimeAgentSession } from "./session";
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

const DEFAULT_SESSION_TITLE = "Prime conversation";

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
    return this.requireSession(sessionId).prompt(content, images);
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
    return this.options.factory?.(sessionOptions) ?? new PrimeAgentSession(sessionOptions);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("The prime runtime is disposed.");
  }
}
