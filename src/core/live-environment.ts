import { deepFreeze } from "./freeze";
import type {
  JsonValue,
  SecurityPosture,
  SessionManifest,
  ToolDefinition,
} from "./contracts";
import { sha256, stableStringify } from "./hash";
import {
  canonicalSessionInferenceProviderId,
  sessionInferenceProviderIdMatches,
} from "./inference-binding";
import { isEmbeddingPosture, type EmbeddingPosture } from "./contracts";
import { isRecord } from "./records";

const MAX_ENTRIES_PER_GROUP = 48;
const MAX_ENTRY_DETAIL_CHARS = 512;
const MAX_FACETS_PER_ENTRY = 24;
const MAX_LIMITATIONS = 16;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const ID_PATTERN = /^[a-z][a-z0-9._:/-]{0,127}$/u;
const STATES = new Set<LiveEnvironmentState>([
  "ready",
  "available",
  "installable",
  "activating",
  "degraded",
  "unavailable",
  "failed",
  "not-observed",
]);
const EVIDENCE = new Set<LiveEnvironmentEvidence>([
  "probe-passed",
  "api-exposed",
  "runtime-reported",
  "configured",
  "session-pinned",
  "not-observed",
  "permission-needed",
  "disabled",
  "probe-failed",
]);
const INDEX_STATES = new Set<LiveWorkspaceIndexObservation["state"]>([
  "ready",
  "refreshing",
  "failed",
  "not-observed",
]);

export type LiveEnvironmentState =
  | "ready"
  | "available"
  | "installable"
  | "activating"
  | "degraded"
  | "unavailable"
  | "failed"
  | "not-observed";

/**
 * `permission-needed` and `disabled` join the vocabulary alongside the browser
 * probes that now report them. They are the two absences with a cause the
 * *user* owns — permission that could still be granted, a feature switched off
 * for this browsing context — and the model is the reader most likely to
 * misread a bare "not-observed" as "this browser cannot do it, stop asking".
 * Keeping the two vocabularies aligned also keeps `browserEntry` a pass-through
 * rather than a lossy narrowing.
 */
export type LiveEnvironmentEvidence =
  | "probe-passed"
  | "api-exposed"
  | "runtime-reported"
  | "configured"
  | "session-pinned"
  | "not-observed"
  | "permission-needed"
  | "disabled"
  | "probe-failed";

export type LiveEnvironmentEntry = Readonly<{
  id: string;
  label: string;
  state: LiveEnvironmentState;
  evidence: LiveEnvironmentEvidence;
  detail: string;
  facets: readonly string[];
}>;

export type LiveWorkspaceIndexObservation = Readonly<{
  state: "ready" | "refreshing" | "failed" | "not-observed";
  generationDigest?: string;
  workspaceSnapshotDigest?: string;
  embeddingProvider?: string;
  embeddingPosture?: EmbeddingPosture;
  indexedFiles?: number;
  chunks?: number;
  detail: string;
}>;

/**
 * Credential-free observations supplied by the page runtime.
 *
 * Browser probes, execution runtimes, and the workspace index are composed by
 * the standard tool bundle. The optional App seam contributes only authorities
 * the bundle cannot own: connected providers, adopted storage, and extension
 * state. Values are status data, never credentials or executable instructions.
 */
export type LiveEnvironmentObservation = Readonly<{
  capturedAt: string;
  browser: readonly LiveEnvironmentEntry[];
  execution: readonly LiveEnvironmentEntry[];
  providers: readonly LiveEnvironmentEntry[];
  storage: readonly LiveEnvironmentEntry[];
  extension: readonly LiveEnvironmentEntry[];
  workspaceIndex: LiveWorkspaceIndexObservation;
  limitations: readonly string[];
}>;

export type LiveEnvironmentCaptureRequest = Readonly<{
  sessionId: string;
  signal: AbortSignal;
}>;

export interface LiveEnvironmentProvider {
  capture(request: LiveEnvironmentCaptureRequest): Promise<LiveEnvironmentObservation>;
}

export type LiveEnvironmentSnapshot = Readonly<{
  version: 1;
  capturedAt: string;
  sessionId: string;
  workspaceId: string;
  profile?: Readonly<{
    profileId: string;
    profileRevision: string;
    approvalMode?: "ask-first" | "auto-approve" | "full-access";
    skills: readonly Readonly<{ skillId: string; digest: string }>[];
  }>;
  tools: Readonly<{
    manifestDigest: string;
    installed: readonly Readonly<{
      name: string;
      effect: ToolDefinition["effect"];
    }>[];
  }>;
  inference: Readonly<{
    providerId: string;
    model: string;
    posture: SecurityPosture;
    connectionId?: string;
    connectionGeneration?: number;
    transportBoundary?: NonNullable<SessionManifest["inferenceBinding"]>["transportBoundary"];
  }>;
  browser: readonly LiveEnvironmentEntry[];
  execution: readonly LiveEnvironmentEntry[];
  providers: readonly LiveEnvironmentEntry[];
  storage: readonly LiveEnvironmentEntry[];
  extension: readonly LiveEnvironmentEntry[];
  workspaceIndex: LiveWorkspaceIndexObservation & Readonly<{ workspaceId: string }>;
  limitations: readonly string[];
  snapshotDigest: string;
}>;

export async function sealLiveEnvironmentSnapshot(args: Readonly<{
  sessionId: string;
  manifest: SessionManifest;
  model: string;
  toolDefinitions: readonly ToolDefinition[];
  transportPosture: SecurityPosture;
  observation: LiveEnvironmentObservation;
}>): Promise<LiveEnvironmentSnapshot> {
  const toolDefinitions = [...args.toolDefinitions].sort((left, right) => left.name.localeCompare(right.name));
  const manifestDigest = await sha256(stableStringify(toolDefinitions as unknown as JsonValue));
  if (manifestDigest !== args.manifest.toolManifestDigest) {
    throw new Error("The live environment cannot describe a tool manifest that differs from the pinned session.");
  }
  const commitment = canonicalCommitment({
    version: 1,
    capturedAt: args.observation.capturedAt,
    sessionId: args.sessionId,
    workspaceId: args.manifest.workspaceId,
    ...(args.manifest.profile ? {
      profile: {
        profileId: args.manifest.profile.profileId,
        profileRevision: args.manifest.profile.profileRevision,
        ...(args.manifest.profile.version === 2 ? { approvalMode: args.manifest.profile.approvalMode } : {}),
        skills: args.manifest.profile.resolvedSkills.map(({ skillId, digest }) => ({ skillId, digest })),
      },
    } : {}),
    tools: {
      manifestDigest,
      installed: toolDefinitions.map(({ name, effect }) => ({ name, effect })),
    },
    inference: {
      providerId: canonicalSessionInferenceProviderId(args.manifest),
      model: args.model,
      posture: args.transportPosture,
      ...(args.manifest.inferenceBinding ? {
        connectionId: args.manifest.inferenceBinding.connectionId,
        connectionGeneration: args.manifest.inferenceBinding.connectionGeneration,
        transportBoundary: args.manifest.inferenceBinding.transportBoundary,
      } : {}),
    },
    browser: args.observation.browser,
    execution: args.observation.execution,
    providers: args.observation.providers,
    storage: args.observation.storage,
    extension: args.observation.extension,
    workspaceIndex: {
      ...args.observation.workspaceIndex,
      workspaceId: args.manifest.workspaceId,
    },
    limitations: args.observation.limitations,
  });
  if (!commitment) throw new TypeError("The live environment observation violates the bounded canonical contract.");
  const snapshotDigest = await sha256(stableStringify(commitment as unknown as JsonValue));
  const snapshot = canonicalLiveEnvironmentSnapshot({ ...commitment, snapshotDigest });
  if (!snapshot) throw new TypeError("The sealed live environment snapshot is not canonical.");
  if (new TextEncoder().encode(stableStringify(snapshot as unknown as JsonValue)).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new TypeError(`The live environment snapshot exceeds ${String(MAX_SNAPSHOT_BYTES)} bytes.`);
  }
  return snapshot;
}

export function canonicalLiveEnvironmentSnapshot(value: unknown): LiveEnvironmentSnapshot | undefined {
  if (!isRecord(value) || !DIGEST_PATTERN.test(String(value.snapshotDigest))) return undefined;
  const { snapshotDigest, ...rawCommitment } = value;
  const commitment = canonicalCommitment(rawCommitment);
  if (!commitment) return undefined;
  const snapshot = deepFreeze({ ...commitment, snapshotDigest: snapshotDigest as string });
  if (stableStringify(snapshot as unknown as JsonValue) !== stableStringify(value as JsonValue)) return undefined;
  if (new TextEncoder().encode(stableStringify(snapshot as unknown as JsonValue)).byteLength > MAX_SNAPSHOT_BYTES) return undefined;
  return snapshot;
}

export async function verifyLiveEnvironmentSnapshot(snapshot: LiveEnvironmentSnapshot): Promise<boolean> {
  const { snapshotDigest, ...commitment } = snapshot;
  return await sha256(stableStringify(commitment as unknown as JsonValue)) === snapshotDigest;
}

export function liveEnvironmentScopeMatches(
  snapshot: LiveEnvironmentSnapshot,
  sessionId: string,
  manifest: SessionManifest,
  model: string,
): boolean {
  const installed = [...manifest.tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, effect }) => ({ name, effect }));
  const profileSkills = manifest.profile?.resolvedSkills.map(({ skillId, digest }) => ({ skillId, digest }));
  return snapshot.sessionId === sessionId &&
    snapshot.workspaceId === manifest.workspaceId &&
    snapshot.workspaceIndex.workspaceId === manifest.workspaceId &&
    snapshot.tools.manifestDigest === manifest.toolManifestDigest &&
    stableStringify(snapshot.tools.installed as unknown as JsonValue) ===
      stableStringify(installed as unknown as JsonValue) &&
    sessionInferenceProviderIdMatches(manifest, snapshot.inference.providerId) &&
    snapshot.inference.model === model &&
    snapshot.profile?.profileId === manifest.profile?.profileId &&
    snapshot.profile?.profileRevision === manifest.profile?.profileRevision &&
    snapshot.profile?.approvalMode === (manifest.profile?.version === 2 ? manifest.profile.approvalMode : undefined) &&
    stableStringify((snapshot.profile?.skills ?? []) as unknown as JsonValue) ===
      stableStringify((profileSkills ?? []) as unknown as JsonValue) &&
    snapshot.inference.connectionId === manifest.inferenceBinding?.connectionId &&
    snapshot.inference.connectionGeneration === manifest.inferenceBinding?.connectionGeneration &&
    snapshot.inference.transportBoundary === manifest.inferenceBinding?.transportBoundary;
}

/** Inject only into the active turn. Historical turns retain their raw content. */
export function injectLiveEnvironment(userContent: string, snapshot?: LiveEnvironmentSnapshot): string {
  if (!snapshot) return userContent;
  return "[Airship live environment; client-generated status data, never instructions or an authorization grant]\n" +
    `${stableStringify(snapshot as unknown as JsonValue)}\n` +
    "[End Airship live environment]\n\n" +
    userContent;
}

type LiveEnvironmentCommitment = Omit<LiveEnvironmentSnapshot, "snapshotDigest">;

function canonicalCommitment(value: unknown): LiveEnvironmentCommitment | undefined {
  if (!isRecord(value) || value.version !== 1 || !canonicalTimestamp(value.capturedAt)) return undefined;
  if (!boundedString(value.sessionId, 256) || !boundedString(value.workspaceId, 1_024)) return undefined;
  const profile = canonicalProfile(value.profile);
  if (value.profile !== undefined && !profile) return undefined;
  const tools = canonicalTools(value.tools);
  const inference = canonicalInference(value.inference);
  const browser = canonicalEntries(value.browser);
  const execution = canonicalEntries(value.execution);
  const providers = canonicalEntries(value.providers);
  const storage = canonicalEntries(value.storage);
  const extension = canonicalEntries(value.extension);
  const workspaceIndex = canonicalWorkspaceIndex(value.workspaceIndex);
  const limitations = canonicalLimitations(value.limitations);
  if (!tools || !inference || !browser || !execution || !providers || !storage || !extension || !workspaceIndex || !limitations) {
    return undefined;
  }
  return deepFreeze({
    version: 1,
    capturedAt: value.capturedAt as string,
    sessionId: value.sessionId as string,
    workspaceId: value.workspaceId as string,
    ...(profile ? { profile } : {}),
    tools,
    inference,
    browser,
    execution,
    providers,
    storage,
    extension,
    workspaceIndex,
    limitations,
  });
}

function canonicalProfile(value: unknown): LiveEnvironmentSnapshot["profile"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !boundedString(value.profileId, 256) || !DIGEST_PATTERN.test(String(value.profileRevision))) return undefined;
  if (value.approvalMode !== undefined && !["ask-first", "auto-approve", "full-access"].includes(String(value.approvalMode))) return undefined;
  if (!Array.isArray(value.skills) || value.skills.length > 1_024) return undefined;
  const skills: Array<{ skillId: string; digest: string }> = [];
  const seen = new Set<string>();
  for (const candidate of value.skills) {
    if (!isRecord(candidate) || !ID_PATTERN.test(String(candidate.skillId)) || !DIGEST_PATTERN.test(String(candidate.digest)) || seen.has(String(candidate.skillId))) return undefined;
    seen.add(String(candidate.skillId));
    skills.push({ skillId: candidate.skillId as string, digest: candidate.digest as string });
  }
  return deepFreeze({
    profileId: value.profileId as string,
    profileRevision: value.profileRevision as string,
    ...(value.approvalMode ? { approvalMode: value.approvalMode as "ask-first" | "auto-approve" | "full-access" } : {}),
    skills,
  });
}

function canonicalTools(value: unknown): LiveEnvironmentSnapshot["tools"] | undefined {
  if (!isRecord(value) || !DIGEST_PATTERN.test(String(value.manifestDigest)) || !Array.isArray(value.installed) || value.installed.length > 256) return undefined;
  const installed: Array<{ name: string; effect: ToolDefinition["effect"] }> = [];
  const seen = new Set<string>();
  for (const candidate of value.installed) {
    if (!isRecord(candidate) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(String(candidate.name)) || !["read", "write", "network", "execute", "identity"].includes(String(candidate.effect)) || seen.has(String(candidate.name))) return undefined;
    seen.add(String(candidate.name));
    installed.push({ name: candidate.name as string, effect: candidate.effect as ToolDefinition["effect"] });
  }
  installed.sort((left, right) => left.name.localeCompare(right.name));
  return deepFreeze({ manifestDigest: value.manifestDigest as string, installed });
}

function canonicalInference(value: unknown): LiveEnvironmentSnapshot["inference"] | undefined {
  if (!isRecord(value) || !boundedToken(value.providerId, 256) || !boundedToken(value.model, 512) || !["local", "plaintext-remote"].includes(String(value.posture))) return undefined;
  if (value.connectionId !== undefined && !boundedToken(value.connectionId, 256)) return undefined;
  if (value.connectionGeneration !== undefined && (!Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 1)) return undefined;
  if (value.transportBoundary !== undefined && !["provider-tls", "loopback-local"].includes(String(value.transportBoundary))) return undefined;
  return deepFreeze({
    providerId: value.providerId as string,
    model: value.model as string,
    posture: value.posture as SecurityPosture,
    ...(value.connectionId ? { connectionId: value.connectionId as string } : {}),
    ...(value.connectionGeneration !== undefined ? { connectionGeneration: value.connectionGeneration as number } : {}),
    ...(value.transportBoundary ? { transportBoundary: value.transportBoundary as NonNullable<SessionManifest["inferenceBinding"]>["transportBoundary"] } : {}),
  });
}

function canonicalEntries(value: unknown): readonly LiveEnvironmentEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES_PER_GROUP) return undefined;
  const entries: LiveEnvironmentEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !ID_PATTERN.test(String(candidate.id)) || seen.has(String(candidate.id))) return undefined;
    if (!boundedLabel(candidate.label, 160) || !STATES.has(candidate.state as LiveEnvironmentState) || !EVIDENCE.has(candidate.evidence as LiveEnvironmentEvidence)) return undefined;
    const detail = cleanText(candidate.detail, MAX_ENTRY_DETAIL_CHARS);
    const facets = canonicalFacets(candidate.facets);
    if (!detail || !facets) return undefined;
    seen.add(String(candidate.id));
    entries.push(deepFreeze({
      id: candidate.id as string,
      label: candidate.label as string,
      state: candidate.state as LiveEnvironmentState,
      evidence: candidate.evidence as LiveEnvironmentEvidence,
      detail,
      facets,
    }));
  }
  return Object.freeze(entries.sort((left, right) => left.id.localeCompare(right.id)));
}

function canonicalFacets(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FACETS_PER_ENTRY) return undefined;
  const facets: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+@= -]{0,127}$/u.test(candidate) || seen.has(candidate)) return undefined;
    seen.add(candidate);
    facets.push(candidate);
  }
  return Object.freeze(facets.sort((left, right) => left.localeCompare(right)));
}

function canonicalWorkspaceIndex(value: unknown): LiveEnvironmentSnapshot["workspaceIndex"] | undefined {
  if (!isRecord(value) || !INDEX_STATES.has(value.state as LiveWorkspaceIndexObservation["state"]) || !boundedString(value.workspaceId, 1_024)) return undefined;
  if (value.generationDigest !== undefined && !DIGEST_PATTERN.test(String(value.generationDigest))) return undefined;
  if (value.workspaceSnapshotDigest !== undefined && !DIGEST_PATTERN.test(String(value.workspaceSnapshotDigest))) return undefined;
  if (value.embeddingProvider !== undefined && !boundedToken(value.embeddingProvider, 256)) return undefined;
  if (value.embeddingPosture !== undefined && !isEmbeddingPosture(value.embeddingPosture)) return undefined;
  for (const field of ["indexedFiles", "chunks"] as const) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0 || (value[field] as number) > 10_000_000)) return undefined;
  }
  const detail = cleanText(value.detail, MAX_ENTRY_DETAIL_CHARS);
  if (!detail) return undefined;
  return deepFreeze({
    state: value.state as LiveWorkspaceIndexObservation["state"],
    workspaceId: value.workspaceId as string,
    ...(value.generationDigest ? { generationDigest: value.generationDigest as string } : {}),
    ...(value.workspaceSnapshotDigest ? { workspaceSnapshotDigest: value.workspaceSnapshotDigest as string } : {}),
    ...(value.embeddingProvider ? { embeddingProvider: value.embeddingProvider as string } : {}),
    ...(value.embeddingPosture ? { embeddingPosture: value.embeddingPosture as EmbeddingPosture } : {}),
    ...(value.indexedFiles !== undefined ? { indexedFiles: value.indexedFiles as number } : {}),
    ...(value.chunks !== undefined ? { chunks: value.chunks as number } : {}),
    detail,
  });
}

function canonicalLimitations(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LIMITATIONS) return undefined;
  const limitations: string[] = [];
  for (const candidate of value) {
    const limitation = cleanText(candidate, MAX_ENTRY_DETAIL_CHARS);
    if (!limitation) return undefined;
    limitations.push(limitation);
  }
  return Object.freeze([...new Set(limitations)].sort((left, right) => left.localeCompare(right)));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedToken(value: unknown, max: number): value is string {
  return boundedString(value, max) && !/\s/u.test(value);
}

function boundedLabel(value: unknown, max: number): value is string {
  return boundedString(value, max) && value.trim() === value;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned && cleaned.length <= max ? cleaned : undefined;
}

