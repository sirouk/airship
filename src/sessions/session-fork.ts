import { deepFreeze } from "../core/freeze";
import type { JsonValue, SessionForkContextSeed, SessionManifest } from "../core/contracts";
import {
  FORK_CONTEXT_EVENT_TYPE,
  canonicalForkContextSeed,
  prepareForkContext,
  sealForkContextSeed,
} from "../core/fork-context";
import {
  projectedSessionApprovalMode,
  projectedSessionContextPolicy,
  projectedSessionModel,
  type DurableEvent,
  type EventJournal,
  type SessionRecord,
} from "../core/journal";
import { assertValidSessionInferenceBinding } from "../core/inference-binding";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import { DEFAULT_SESSION_INSPECTION_LIMITS, type SessionInspectionLimits } from "./domain";
import {
  SessionForkConflictError,
  type ForkSessionRequest,
  type SessionForkResult,
} from "./library";

/**
 * What a branch of an imported conversation is told, when nobody named the
 * manifest it should be pinned to.
 */
export const IMPORTED_CONVERSATION_FORK_REFUSAL =
  "This conversation arrived in a bundle file. A branch of it has to be pinned to this device's own profile,"
  + " not to the instructions that came with it; use “Fork to continue”.";

/** Lazy implementation: a user who never forks a conversation never fetches it. */
export async function forkSession(
  journal: EventJournal,
  limits: Partial<SessionInspectionLimits>,
  now: () => string,
  sourceSessionId: string,
  request: ForkSessionRequest = {},
): Promise<SessionForkResult> {
  assertSessionId(sourceSessionId);
  throwIfAborted(request.signal);
  const source = await journal.getSession(sourceSessionId);
  throwIfAborted(request.signal);
  if (!source) throw new Error(`Unknown session: ${sourceSessionId}`);
  /*
   * A branch of a conversation that arrived in a file is pinned by this device
   * or not made at all.
   *
   * Without `request.manifest` a fork inherits `manifestAtBoundary(source)` —
   * the source's whole manifest, including the `systemPrompt` sent to the
   * provider on every turn the branch ever takes. For a conversation this
   * browser composed that is exactly right. For one that arrived in a bundle it
   * is the refusal in `IMPORTED_CONVERSATION_REFUSAL` undone by another door:
   * the import is held because its instructions were written somewhere else,
   * and the branch would carry those instructions into a conversation that is
   * *not* held and can take turns. `forkHeldConversation`, the Sessions view
   * and the `sessions.fork` command all pass this device's own manifest and are
   * unaffected; the transcript's Fork/Edit/Retry did not, which is the one call
   * site this closes. Checked here rather than at that call site so a later
   * caller cannot reopen it by forgetting.
   */
  if (source.importedAt !== undefined && !request.manifest) {
    throw new SessionForkConflictError(IMPORTED_CONVERSATION_FORK_REFUSAL);
  }
  if (
    request.expectedSourceHead &&
    (
      request.expectedSourceHead.sequence !== source.headSequence ||
      request.expectedSourceHead.digest !== source.headDigest ||
      (request.expectedSourceHead.incarnation !== undefined && request.expectedSourceHead.incarnation !== source.headIncarnation)
    )
  ) {
    throw new SessionForkConflictError();
  }
  const sourceEvents = await journal.readEvents(source.id);
  throwIfAborted(request.signal);
  const maximumAuditedEvents = limits.maxEvents ?? DEFAULT_SESSION_INSPECTION_LIMITS.maxEvents;
  if (sourceEvents.length > maximumAuditedEvents) {
    throw new SessionForkConflictError(
      `The source contains ${sourceEvents.length} events; the bounded fork audit limit is ${maximumAuditedEvents}.`,
    );
  }
  const stableSource = await journal.getSession(source.id);
  throwIfAborted(request.signal);
  if (!stableSource || !sameHead(source, stableSource)) throw new SessionForkConflictError();

  const boundary = resolveForkBoundary(sourceEvents, request.sourcePoint);
  const boundaryIndex = sourceEvents.findIndex((event) => event.sequence === boundary.sequence);
  const sourcePrefix = sourceEvents.slice(0, boundaryIndex + 1);
  const prefixSession = sessionAtBoundary(source, sourcePrefix);
  const { auditSessionHistory } = await loadDeferredCapabilities();
  const sourceHeadAudit = await auditSessionHistory(
    { session: source, events: sourceEvents },
    { limits: { maxEvents: maximumAuditedEvents } },
  );
  throwIfAborted(request.signal);
  if (sourceHeadAudit.status === "invalid") {
    const codes = sourceHeadAudit.findings.filter((finding) => finding.severity === "error")
      .slice(0, 3).map((finding) => finding.code).join(", ");
    throw new SessionForkConflictError(
      `The observed source head did not pass the local journal audit${codes ? ` (${codes})` : ""}.`,
    );
  }
  const sourceAudit = await auditSessionHistory(
    { session: prefixSession, events: sourcePrefix },
    { limits: { maxEvents: maximumAuditedEvents } },
  );
  throwIfAborted(request.signal);
  if (sourceAudit.status !== "verified") {
    const codes = sourceAudit.findings.slice(0, 3).map((finding) => finding.code).join(", ");
    throw new SessionForkConflictError(
      `The selected source boundary did not pass the local journal audit${codes ? ` (${codes})` : ""}.`,
    );
  }
  const { materializeMessages } = await import("../core/agent");
  const verifiedSourceForkContextDigest = source.manifest.lineage
    ? canonicalForkContextSeed(sourcePrefix.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE)?.payload)?.contextDigest
    : undefined;
  const sourceMessages = materializeMessages(sourcePrefix, {
    injectLatestContext: false,
    allowEmbeddedContext: source.manifest.turnContext === undefined,
    allowSelectedContext: source.manifest.turnContext !== "disabled",
    forkContextScope: { sessionId: source.id, lineage: source.manifest.lineage },
    verifiedForkContextDigest: verifiedSourceForkContextDigest,
  });
  const preparedContext = prepareForkContext(sourceMessages);
  throwIfAborted(request.signal);

  const forkedAt = now();
  if (!Number.isFinite(Date.parse(forkedAt))) throw new Error("The session library clock returned an invalid timestamp.");
  const title = forkTitle(request.title, source.title);
  const manifest = structuredClone(request.manifest ?? manifestAtBoundary(source.manifest, sourcePrefix));
  manifest.createdAt = forkedAt;
  manifest.lineage = {
    version: 1,
    kind: "fork",
    sourceSessionId: source.id,
    sourceHeadSequence: boundary.sequence,
    sourceHeadDigest: boundary.digest,
    forkedAt,
  };
  validateForkManifest(manifest);

  // Fork lineage is a commitment to a specific source head. Recheck as late
  // as possible before the cross-session mutation so an append racing the
  // manifest preparation cannot silently produce stale ancestry.
  const fresh = await journal.getSession(source.id);
  throwIfAborted(request.signal);
  if (!fresh || !sameHead(source, fresh)) throw new SessionForkConflictError();

  // No abort check after this mutation boundary: if the journal commits while
  // cancellation races, returning the committed identity avoids an ambiguous retry.
  let seed: SessionForkContextSeed | undefined;
  const created = await journal.createSession(title, manifest, async (destination) => {
    seed = await sealForkContextSeed({
      forkSessionId: destination.id,
      sourceSessionId: source.id,
      sourceHeadSequence: source.headSequence,
      sourceHeadDigest: source.headDigest,
      sourceBoundarySequence: boundary.sequence,
      sourceBoundaryDigest: boundary.digest,
    }, preparedContext);
    return [{ type: FORK_CONTEXT_EVENT_TYPE, payload: seed as unknown as JsonValue }];
  });
  if (created.id === source.id) throw new Error("The journal reused the source session identity for a fork.");
  if (!seed) throw new Error("The journal created a fork without resolving its context seed.");
  return deepFreeze({
    sourceSessionId: source.id,
    sourceHeadSequence: source.headSequence,
    sourceHeadDigest: source.headDigest,
    sourceBoundarySequence: boundary.sequence,
    sourceBoundaryDigest: boundary.digest,
    session: structuredClone(created),
    historyCopied: false,
    contextSeeded: true,
    contextMessageCount: seed.messages.length,
    omittedContextMessages: seed.omittedMessages,
    omittedContextImages: seed.omittedImages,
    abortRequestedAfterCommit: request.signal?.aborted ?? false,
  });
}

// A boundary is quiescent when nothing is in flight, not when the last thing
// went well. A cancelled turn, a failed turn and a denied local command leave
// the conversation exactly as idle as their successful counterparts, and
// materializeMessages already drops non-actionable turns from provider history,
// so the seed built from such a prefix carries no abandoned intent.
function isForkBoundary(type: string): boolean {
  return type === "session.created" ||
    type === "turn.completed" ||
    type === "turn.failed" ||
    type === "turn.cancelled" ||
    type === "local.command.completed" ||
    type === "local.command.failed" ||
    type === "local.command.denied";
}

function resolveForkBoundary(
  events: readonly DurableEvent[],
  requested: ForkSessionRequest["sourcePoint"],
): Readonly<{ sequence: number; digest: string }> {
  const pointIndex = requested
    ? events.findIndex((event) => event.sequence === requested.sequence)
    : -1;
  const point = requested
    ? events[pointIndex]
    : [...events].reverse().find((event) => isForkBoundary(event.type));
  if (
    !point ||
    !(
      isForkBoundary(point.type)
      || (requested && isSessionScopedBoundary(point))
      || (requested && isImmediatePreTurnBoundary(events, pointIndex, point))
    ) ||
    (requested && point.digest !== requested.digest)
  ) {
    throw new SessionForkConflictError("The requested historical fork point is not an audited quiescent conversation boundary.");
  }
  return Object.freeze({ sequence: point.sequence, digest: point.digest });
}

/**
 * A turn's `previousDigest` is its exact pre-turn boundary even when the event
 * before it is an audited ancillary inference record carrying its own IDs.
 * Requiring that event itself to be session-scoped rejected Edit/Retry after a
 * completed conversation-naming call. The following request plus the prefix
 * audit below is the stronger record: this exact digest ended the quiescent
 * prefix from which the next turn began.
 */
function isImmediatePreTurnBoundary(
  events: readonly DurableEvent[],
  pointIndex: number,
  point: DurableEvent,
): boolean {
  const next = events[pointIndex + 1];
  return pointIndex >= 0
    && next?.type === "turn.requested"
    && next.sequence === point.sequence + 1
    && next.previousDigest === point.digest;
}

function isSessionScopedBoundary(event: DurableEvent): boolean {
  return event.turnId === undefined && event.operationId === undefined;
}

function manifestAtBoundary(
  source: SessionManifest,
  prefix: readonly DurableEvent[],
): SessionManifest {
  const model = projectedSessionModel(prefix, source.model) ?? source.model;
  const contextPolicy = projectedSessionContextPolicy(prefix, source.contextPolicy);
  const manifest = structuredClone(source);
  manifest.model = model;
  if (manifest.inferenceBinding) {
    manifest.inferenceBinding = { ...manifest.inferenceBinding, modelId: model };
  }
  if (contextPolicy === null || contextPolicy === undefined) delete manifest.contextPolicy;
  else manifest.contextPolicy = contextPolicy;
  return manifest;
}

function sessionAtBoundary(source: SessionRecord, prefix: readonly DurableEvent[]): SessionRecord {
  const boundary = prefix.at(-1);
  if (!boundary) throw new SessionForkConflictError("The source journal has no auditable creation boundary.");
  let title = source.title;
  for (const event of prefix) {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Readonly<Record<string, unknown>>
      : undefined;
    if ((event.type === "session.created" || event.type === "session.renamed") && typeof payload?.title === "string") {
      title = payload.title;
    }
  }
  const model = projectedSessionModel(prefix, source.manifest.model);
  const contextPolicy = projectedSessionContextPolicy(prefix, source.manifest.contextPolicy);
  const approvalMode = projectedSessionApprovalMode(prefix, undefined);
  return {
    ...structuredClone(source),
    title,
    ...(model && model !== source.manifest.model ? { modelOverride: model } : { modelOverride: undefined }),
    ...(contextPolicy !== source.manifest.contextPolicy
      ? { contextPolicyOverride: contextPolicy }
      : { contextPolicyOverride: undefined }),
    ...(approvalMode ? { approvalModeOverride: approvalMode } : { approvalModeOverride: undefined }),
    updatedAt: boundary.recordedAt,
    headSequence: boundary.sequence,
    headDigest: boundary.digest,
  };
}

function sameHead(left: SessionRecord, right: SessionRecord): boolean {
  return left.headSequence === right.headSequence
    && left.headDigest === right.headDigest
    && left.headIncarnation === right.headIncarnation;
}

function forkTitle(requested: string | undefined, sourceTitle: string): string {
  const title = (requested ?? `${sourceTitle} · fork`).trim();
  if (!title || title.length > 240 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(title)) {
    throw new TypeError("Fork title must be between 1 and 240 printable characters.");
  }
  return title;
}

function validateForkManifest(manifest: SessionManifest): void {
  if (
    (manifest.protocolVersion !== 1 && manifest.protocolVersion !== 2) ||
    (manifest.protocolVersion === 2 && manifest.turnContext !== "required" && manifest.turnContext !== "disabled") ||
    !manifest.providerId ||
    manifest.providerId.length > 256 ||
    !manifest.model ||
    manifest.model.length > 512 ||
    !manifest.workspaceId ||
    manifest.workspaceId.length > 2_048 ||
    !manifest.systemPromptDigest ||
    !manifest.toolManifestDigest ||
    !Array.isArray(manifest.tools)
  ) {
    throw new TypeError("Fork manifest does not satisfy a supported bounded session protocol shape.");
  }
  assertValidSessionInferenceBinding(manifest);
}

function assertSessionId(value: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001F\u007F]/u.test(value)) throw new TypeError("Session ID is invalid.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (typeof DOMException !== "undefined") throw new DOMException("The operation was cancelled.", "AbortError");
  const error = new Error("The operation was cancelled.");
  error.name = "AbortError";
  throw error;
}
