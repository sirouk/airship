import { deepFreeze } from "../core/freeze";
import type { JsonValue, SessionManifest, SessionProfileBinding } from "../core/contracts";
import { enforcedMemoryScope } from "../profiles/domain";
import type { DurableEvent, EventJournal, SessionRecord } from "../core/journal";

export const PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE = "profile.active-conversation.selected";

export type ProfileActiveConversationPointer = Readonly<{
  version: 1;
  profileId: string;
  sessionId: string;
  generation: number;
  previousEventId?: string;
  eventId: string;
  recordedAt: string;
  hostSessionId: string;
}>;

export type ProfileActiveConversationResolution = Readonly<{
  profileId: string;
  pointer?: ProfileActiveConversationPointer;
  session?: SessionRecord;
  state: "selected" | "missing-target" | "no-selection";
}>;

export type SelectProfileActiveConversationResult = Readonly<{
  pointer: ProfileActiveConversationPointer;
  session: SessionRecord;
  changed: boolean;
}>;

/** The ordinary Chat/session command boundary is the active Profile. */
export function profileOwnsSession(session: SessionRecord, profileId: string): boolean {
  assertProfileId(profileId);
  return session.manifest.profile?.profileId === profileId;
}

export function profileOwnedSessions(
  sessions: readonly SessionRecord[],
  profileId: string,
): readonly SessionRecord[] {
  assertProfileId(profileId);
  return Object.freeze(sessions.filter((session) => profileOwnsSession(session, profileId)));
}

export function requireProfileOwnedSession(
  session: SessionRecord,
  profileId: string,
  operation: "open" | "fork",
): SessionRecord {
  if (!profileOwnsSession(session, profileId)) {
    throw new Error(
      `The requested conversation belongs to another Profile. Switch Profiles before trying to ${operation} it.`,
    );
  }
  return session;
}

export class ProfileActiveConversationConflictError extends Error {
  constructor(message = "A newer active-conversation selection won before this profile switch committed.") {
    super(message);
    this.name = "ProfileActiveConversationConflictError";
  }
}

/**
 * Resolve the one durable active-conversation pointer owned by `profileId`.
 *
 * Pointer generations are Lamport-style counters. The highest generation
 * wins. Concurrent writers that observed the same generation converge by the
 * persisted event timestamp, then event ID and host session ID. A pointer can
 * never cross a profile boundary: both its host and target must belong to the
 * named profile. A missing/deleted target is reported rather than silently
 * manufacturing a replacement session.
 */
export async function resolveProfileActiveConversation(
  journal: EventJournal,
  profileId: string,
  signal?: AbortSignal,
): Promise<ProfileActiveConversationResolution> {
  assertProfileId(profileId);
  signal?.throwIfAborted();
  const sessions = await journal.listSessions();
  signal?.throwIfAborted();
  const profileSessions = sessions.filter((session) => session.manifest.profile?.profileId === profileId);
  const pointers = (await Promise.all(profileSessions.map(async (session) => {
    const events = await journal.readEvents(session.id, 0, signal);
    signal?.throwIfAborted();
    return events.flatMap((event) => {
      if (event.type !== PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE) return [];
      const pointer = profileActiveConversationPointer(event);
      return pointer?.profileId === profileId && pointer.hostSessionId === session.id ? [pointer] : [];
    });
  }))).flat().sort(comparePointersNewestFirst);
  const pointer = pointers[0];
  if (!pointer) return Object.freeze({ profileId, state: "no-selection" });
  const target = profileSessions.find((session) => session.id === pointer.sessionId);
  if (!target) return Object.freeze({ profileId, pointer, state: "missing-target" });
  return deepFreeze({ profileId, pointer, session: structuredClone(target), state: "selected" });
}

/**
 * Append a profile-local active-conversation choice to the selected session.
 * Page-memory journals keep this page-scoped; adopted encrypted journals make
 * the exact same event durable with their authority. The caller may fence the
 * target head after an audit so a concurrent turn cannot be presented from a
 * stale snapshot.
 */
export async function selectProfileActiveConversation(
  journal: EventJournal,
  profileId: string,
  sessionId: string,
  options: Readonly<{
    expectedTargetHead?: Readonly<{ sequence: number; digest: string }>;
    signal?: AbortSignal;
  }> = {},
): Promise<SelectProfileActiveConversationResult> {
  assertProfileId(profileId);
  assertSessionId(sessionId);
  options.signal?.throwIfAborted();
  const target = await journal.getSession(sessionId, options.signal);
  if (!target) throw new Error(`Unknown session: ${sessionId}`);
  if (target.manifest.profile?.profileId !== profileId) {
    throw new Error("An active conversation can only be selected inside its owning profile.");
  }
  if (
    options.expectedTargetHead
    && (target.headSequence !== options.expectedTargetHead.sequence || target.headDigest !== options.expectedTargetHead.digest)
  ) {
    throw new ProfileActiveConversationConflictError("The selected conversation changed after it was inspected.");
  }

  const before = await resolveProfileActiveConversation(journal, profileId, options.signal);
  if (before.state === "selected" && before.session?.id === sessionId) {
    return deepFreeze({ pointer: before.pointer!, session: structuredClone(target), changed: false });
  }
  const generation = (before.pointer?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ProfileActiveConversationConflictError("The active-conversation generation is exhausted.");
  }
  const appended = await journal.append(sessionId, [{
    type: PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE,
    payload: {
      version: 1,
      profileId,
      sessionId,
      generation,
      ...(before.pointer ? { previousEventId: before.pointer.eventId } : {}),
    } as JsonValue,
  }], options.signal);
  const event = appended[0];
  const selected = event ? profileActiveConversationPointer(event) : undefined;
  if (!selected) throw new Error("The journal did not return the committed active-conversation event.");

  const after = await resolveProfileActiveConversation(journal, profileId, options.signal);
  if (after.pointer?.eventId !== selected.eventId || after.session?.id !== sessionId) {
    throw new ProfileActiveConversationConflictError();
  }
  const committed = await journal.getSession(sessionId, options.signal);
  if (!committed) throw new Error(`Selected session disappeared: ${sessionId}`);
  return deepFreeze({ pointer: selected, session: structuredClone(committed), changed: true });
}

/**
 * Choose the exact durable pointer when it is resumable. Legacy authorities
 * without a pointer may use their page-local hint; a missing, deleted, or
 * incompatible pointer falls back to the newest compatible existing record.
 * This function is read-only and never manufactures a session.
 */
export async function resolveResumableProfileConversation(
  journal: EventJournal,
  profileId: string,
  expectedManifest: SessionManifest,
  preferredSessionId?: string,
  signal?: AbortSignal,
): Promise<SessionRecord | undefined> {
  const pointer = await resolveProfileActiveConversation(journal, profileId, signal);
  if (
    pointer.state === "selected"
    && pointer.session
    && resumableProfileManifestMatches(pointer.session.manifest, expectedManifest)
  ) return pointer.session;

  const sessions = (await journal.listSessions()).filter((session) =>
    session.manifest.profile?.profileId === profileId
    && resumableProfileManifestMatches(session.manifest, expectedManifest)
  );
  signal?.throwIfAborted();
  if (pointer.state === "no-selection" && preferredSessionId) {
    const preferred = sessions.find((session) => session.id === preferredSessionId);
    if (preferred) return preferred;
  }
  return sessions.sort((left, right) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id)
  )[0];
}

/** Strict parser shared by pointer projection and focused protocol tests. */
export function profileActiveConversationPointer(
  event: DurableEvent,
): ProfileActiveConversationPointer | undefined {
  if (event.type !== PROFILE_ACTIVE_CONVERSATION_EVENT_TYPE || event.turnId || event.operationId) return undefined;
  const payload = plainRecord(event.payload);
  if (
    !payload
    || payload.version !== 1
    || !boundedIdentifier(payload.profileId)
    || !boundedIdentifier(payload.sessionId)
    || !Number.isSafeInteger(payload.generation)
    || (payload.generation as number) < 1
    || (payload.previousEventId !== undefined && !boundedIdentifier(payload.previousEventId))
  ) return undefined;
  return Object.freeze({
    version: 1,
    profileId: payload.profileId as string,
    sessionId: payload.sessionId as string,
    generation: payload.generation as number,
    ...(typeof payload.previousEventId === "string" ? { previousEventId: payload.previousEventId } : {}),
    eventId: event.eventId,
    recordedAt: event.recordedAt,
    hostSessionId: event.sessionId,
  });
}

/**
 * Whether a profile conversation can keep using its immutable session pins in
 * the current runtime.
 *
 * Browser probes and provider-directory observations are live turn context.
 * They may change the composed prompt used for a *new* session without making
 * an existing conversation incompatible: an existing conversation continues
 * with its own immutable `systemPrompt`. Stable profile, tool, inference,
 * workspace, posture, and context-policy pins must still match exactly.
 */
export function resumableProfileManifestMatches(
  actual: SessionManifest,
  expected: SessionManifest,
): boolean {
  return profileManifestResumeMismatches(actual, expected).length === 0;
}

/** Credential-free mismatch codes suitable for diagnostics and tests. */
export function profileManifestResumeMismatches(
  actual: SessionManifest,
  expected: SessionManifest,
): readonly string[] {
  const mismatches: string[] = [];
  if (actual.providerId !== expected.providerId) mismatches.push("provider");
  if (actual.model !== expected.model) mismatches.push("model");
  if (actual.workspaceId !== expected.workspaceId) mismatches.push("workspace");
  if (!browserCapabilityTiersMatch(actual.capabilityTier, expected.capabilityTier)) mismatches.push("capability-tier");
  if (actual.securityPosture !== expected.securityPosture) mismatches.push("security-posture");
  if ((actual.turnContext ?? "disabled") !== (expected.turnContext ?? "disabled")) mismatches.push("turn-context");
  if (!contextPoliciesMatch(actual.contextPolicy, expected.contextPolicy)) mismatches.push("context-policy");
  if (actual.toolManifestDigest !== expected.toolManifestDigest) mismatches.push("tool-manifest");
  if (!inferenceBindingsMatch(actual.inferenceBinding, expected.inferenceBinding)) mismatches.push("inference-binding");
  if (!profileBindingsMatch(actual.profile, expected.profile)) mismatches.push("profile-binding");
  return Object.freeze(mismatches);
}

function profileBindingsMatch(
  actual: SessionProfileBinding | undefined,
  expected: SessionProfileBinding | undefined,
): boolean {
  if (!actual || !expected) return actual === expected;
  if (
    actual.version !== expected.version
    || actual.profileId !== expected.profileId
    || actual.profileRevision !== expected.profileRevision
    || actual.themeId !== expected.themeId
    || actual.themeDigest !== expected.themeDigest
    || actual.skillSetDigest !== expected.skillSetDigest
  ) return false;
  if (actual.version === 1 || expected.version === 1) return actual.version === expected.version;
  return JSON.stringify(actual.workspaceBinding) === JSON.stringify(expected.workspaceBinding)
    /*
     * The boundary each pin enforces, not the word it stored.
     *
     * `workspace` was withdrawn as a memory scope: every reader narrows on the
     * pinned profile ID, so it always behaved as `profile`, and new pins resolve
     * it to that. Comparing the raw field therefore rejected every conversation
     * pinned before the withdrawal — the shipped Research profile pinned
     * `workspace` — against an identical revision, so selecting that profile
     * found no resumable conversation and silently started an empty one. Two
     * pins that enforce the same boundary are the same boundary.
     */
    && enforcedMemoryScope(actual.memoryScope) === enforcedMemoryScope(expected.memoryScope)
    && actual.approvalMode === expected.approvalMode
    && actual.minimumPosture === expected.minimumPosture;
}

function browserCapabilityTiersMatch(
  actual: SessionManifest["capabilityTier"],
  expected: SessionManifest["capabilityTier"],
): boolean {
  if (actual === expected) return true;
  const actualIsBrowser = actual === "web-baseline" || actual === "web-enhanced";
  const expectedIsBrowser = expected === "web-baseline" || expected === "web-enhanced";
  return actualIsBrowser && expectedIsBrowser;
}

/**
 * Whether two manifests name the same inference authority, field by field.
 *
 * Exported because `app.tsx` had carried a verbatim nine-field copy of this to
 * gate its external-inference preflight. Nine fields compared in two places is
 * nine chances for the preflight to consider a binding "the same" that this
 * resume check considers different — the failure mode being a conversation the
 * cockpit refuses to resume and the composer happily sends on.
 */
export function inferenceBindingsMatch(
  actual: SessionManifest["inferenceBinding"],
  expected: SessionManifest["inferenceBinding"],
): boolean {
  if (!actual || !expected) return actual === expected;
  return actual.version === expected.version
    && actual.connectionId === expected.connectionId
    && actual.connectionGeneration === expected.connectionGeneration
    && actual.providerId === expected.providerId
    && actual.providerLabel === expected.providerLabel
    && actual.providerRevision === expected.providerRevision
    && actual.authMethod === expected.authMethod
    && actual.transportBoundary === expected.transportBoundary
    && actual.modelId === expected.modelId;
}

function contextPoliciesMatch(
  actual: SessionManifest["contextPolicy"],
  expected: SessionManifest["contextPolicy"],
): boolean {
  if (!actual || !expected) return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function comparePointersNewestFirst(
  left: ProfileActiveConversationPointer,
  right: ProfileActiveConversationPointer,
): number {
  return right.generation - left.generation
    || right.recordedAt.localeCompare(left.recordedAt)
    || right.eventId.localeCompare(left.eventId)
    || right.hostSessionId.localeCompare(left.hostSessionId);
}

function plainRecord(value: JsonValue): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function assertProfileId(value: string): void {
  if (!boundedIdentifier(value)) throw new TypeError("Profile ID is invalid.");
}

function assertSessionId(value: string): void {
  if (!boundedIdentifier(value)) throw new TypeError("Session ID is invalid.");
}
