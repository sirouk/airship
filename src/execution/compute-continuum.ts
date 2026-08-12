import { deepFreeze } from "../core/freeze";
import type { JsonValue } from "../core/contracts";
import { fromBase64Url, sha256, stableStringify, toBase64Url } from "../core/hash";
import type { ExecutionRuntimeId } from "./runtime-registry";

export type ContinuumRuntimeId = ExecutionRuntimeId | "linux-process";

export type ContinuumPlacementMode =
  | "browser-only"
  | "prefer-browser"
  | "remote-confidential";

/**
 * These states are observations, not executable capabilities. In particular,
 * an evidence result is not enough: a private broker must also bind a channel,
 * pass a live protocol probe, prepare the exact effect, and obtain approval.
 */
export type RemoteExecutorInspection = Readonly<
  | { state: "unavailable"; detail: string }
  | { state: "provider-asserted"; detail: string }
  | { state: "evidence-verified"; detail: string; evidenceId: string }
  | { state: "channel-bound"; detail: string; evidenceId: string; channelBindingDigest: string }
>;

export type ContinuumPlacementRequest = Readonly<{
  operationId: string;
  runtime: ContinuumRuntimeId;
  mode: ContinuumPlacementMode;
  local: Readonly<{
    state: "ready" | "unavailable";
    detail: string;
  }>;
  requirements: Readonly<{
    nativeLinux: boolean;
    inputBytes: number;
    outputBytes: number;
    runtimeMs: number;
    workspaceReadBytes: number;
    workspaceWriteBytes: number;
  }>;
  remote?: Readonly<{ inspection: RemoteExecutorInspection }>;
}>;

export type ContinuumPlacementDecision = Readonly<
  | { placement: "browser"; reason: string }
  | {
      placement: "unavailable";
      code:
        | "local-unavailable"
        | "remote-unavailable"
        | "remote-unverified"
        | "remote-not-ready";
      reason: string;
    }
>;

/**
 * Selects from caller-observed local readiness. The selected browser adapter
 * must still prove readiness when invoked. The current release deliberately
 * cannot emit remote-confidential until a real, private attestation/channel/
 * prepared-approval broker is installed.
 */
export function planContinuumPlacement(request: ContinuumPlacementRequest): ContinuumPlacementDecision {
  assertPlacementRequest(request);
  const snapshot = structuredClone(request);
  assertPlacementRequest(snapshot);
  const localCompatible = snapshot.local.state === "ready"
    && !snapshot.requirements.nativeLinux
    && snapshot.runtime !== "linux-process";

  if (snapshot.mode !== "remote-confidential" && localCompatible) {
    return {
      placement: "browser",
      reason: snapshot.mode === "browser-only"
        ? "The operation is pinned to the ready browser runtime."
        : "The ready browser runtime is preferred and no remote disclosure is needed.",
    };
  }

  if (snapshot.mode === "browser-only") {
    return unavailable("local-unavailable", snapshot.local.detail || "The requested browser runtime is unavailable.");
  }

  const inspection = snapshot.remote?.inspection;
  if (!inspection || inspection.state === "unavailable") {
    return unavailable("remote-unavailable", inspection?.detail ?? "No paired remote executor is configured.");
  }
  if (inspection.state === "provider-asserted") {
    return unavailable("remote-unverified", "Provider metadata is not independently verified executor evidence.");
  }
  if (inspection.state === "evidence-verified") {
    return unavailable(
      "remote-not-ready",
      "Executor evidence is verified, but no attestation-bound channel and live protocol probe are installed.",
    );
  }
  return unavailable(
    "remote-not-ready",
    "The channel observation is not an executable grant. The private prepared-effect approval broker is not installed.",
  );
}

/** Target wire record. Possession of this plain record never authorizes spawn. */
export type RemoteProcessStartRecord = Readonly<{
  schema: "airship.remote-process-start.v1";
  jobId: string;
  operationId: string;
  executorId: string;
  runtime: ContinuumRuntimeId;
  artifactDigest: string;
  planDigest: string;
  approvalDigest: string;
  channelBindingDigest: string;
  argv: readonly string[];
  cwd: string;
  ioMode: "pipes" | "pty";
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  workspaceSnapshotDigest?: string;
  mountPolicyDigest: string;
  egressPolicyDigest: string;
  secretSetDigest: string;
}>;

export type RemoteProcessPayload = Readonly<
  | {
      type: "accepted";
      executorId: string;
      runtime: ContinuumRuntimeId;
      artifactDigest: string;
      ioMode: "pipes" | "pty";
      planDigest: string;
      approvalDigest: string;
      channelBindingDigest: string;
      workspaceSnapshotDigest?: string;
    }
  | { type: "stdout"; encoding: "base64url"; data: string }
  | { type: "stderr"; encoding: "base64url"; data: string }
  | {
      type: "workspace-delta";
      baseManifestDigest: string;
      deltaManifestDigest: string;
      changedPathsDigest: string;
      encryptedBytes: number;
    }
  | {
      type: "exited";
      exitCode: number;
      stdoutDigest: string;
      stderrDigest: string;
      resultDigest: string;
    }
  | {
      type: "failed";
      code: string;
      message: string;
      stdoutDigest: string;
      stderrDigest: string;
      resultDigest: string;
    }
>;

export type RemoteProcessFrame = Readonly<{
  schema: "airship.remote-process-frame.v1";
  jobId: string;
  sequence: number;
  recordedAt: string;
  previousDigest: string | null;
  payload: RemoteProcessPayload;
  digest: string;
}>;

export type RemoteProcessTranscript = Readonly<{
  jobId: string;
  terminal: "exited" | "failed";
  exitCode?: number;
  frameCount: number;
  outputBytes: number;
  stdoutDigest: string;
  stderrDigest: string;
  resultDigest: string;
  workspaceDeltaManifestDigest?: string;
  workspaceDeltaCommitmentDigest?: string;
  /** Structural chain commitment; authorship requires channel/receipt proof. */
  structuralDigest: string;
}>;

export type RemoteProcessTranscriptPolicy = Readonly<{
  jobId: string;
  executorId: string;
  runtime: ContinuumRuntimeId;
  artifactDigest: string;
  ioMode: "pipes" | "pty";
  planDigest: string;
  approvalDigest: string;
  channelBindingDigest: string;
  maxOutputBytes: number;
  maxFrames?: number;
  workspace:
    | Readonly<{ mode: "none" }>
    | Readonly<{
        mode: "encrypted-delta";
        snapshotDigest: string;
        baseManifestDigest: string;
        maxEncryptedBytes: number;
      }>;
}>;

export type RemoteProcessResultCommitment = Readonly<{
  schema: "airship.remote-process-result.v1";
  jobId: string;
  planDigest: string;
  disposition: "exited" | "failed";
  exitCode: number | null;
  failureCode: string | null;
  stdoutDigest: string;
  stderrDigest: string;
  workspaceDeltaCommitmentDigest: string | null;
}>;

const MAX_FRAME_OUTPUT_BYTES = 256 * 1024;
const MAX_FRAME_OUTPUT_ENCODED_CHARS = Math.ceil(MAX_FRAME_OUTPUT_BYTES * 4 / 3);
const MAX_TRANSCRIPT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_FRAMES = 10_000;
const MAX_WORKSPACE_DELTA_BYTES = 64 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_FAILURE_MESSAGE = /^[^\u0000-\u001f\u007f]{1,512}$/u;

export async function createRemoteProcessFrame(args: Omit<RemoteProcessFrame, "schema" | "digest">): Promise<RemoteProcessFrame> {
  const snapshot = structuredClone(args);
  const input = deepFreeze({
    schema: "airship.remote-process-frame.v1" as const,
    jobId: snapshot.jobId,
    sequence: snapshot.sequence,
    recordedAt: snapshot.recordedAt,
    previousDigest: snapshot.previousDigest,
    payload: snapshot.payload,
  });
  assertFrameShape({ ...input, digest: await sha256("pending") });
  return deepFreeze({
    ...input,
    digest: await sha256(stableStringify(input as unknown as JsonValue)),
  });
}

export function encodeRemoteOutput(bytes: Uint8Array): Readonly<{
  encoding: "base64url";
  data: string;
}> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_OUTPUT_BYTES) {
    throw new Error("Remote process output frame is empty or exceeds the per-frame limit.");
  }
  return Object.freeze({ encoding: "base64url", data: toBase64Url(bytes) });
}

export async function remoteProcessResultDigest(
  commitment: RemoteProcessResultCommitment,
): Promise<string> {
  assertResultCommitment(commitment);
  const snapshot = structuredClone(commitment);
  assertResultCommitment(snapshot);
  return sha256(stableStringify(snapshot as unknown as JsonValue));
}

/**
 * Validates structural consistency of a remote frame transcript. This does not
 * establish authorship, attestation, or channel E2EE; those must be verified by
 * the future private broker before frames reach this validator.
 */
export class RemoteProcessTranscriptValidator {
  private readonly policy: RemoteProcessTranscriptPolicy;
  private nextSequence = 0;
  private previousDigest: string | null = null;
  private accepted = false;
  private terminal?: "exited" | "failed";
  private exitCode?: number;
  private resultDigest?: string;
  private outputBytes = 0;
  private readonly stdout: Uint8Array[] = [];
  private readonly stderr: Uint8Array[] = [];
  private stdoutDigest?: string;
  private stderrDigest?: string;
  private workspaceDeltaManifestDigest?: string;
  private workspaceDeltaCommitmentDigest?: string;
  private lastRecordedAt?: number;
  private failed = false;

  constructor(policy: RemoteProcessTranscriptPolicy) {
    assertTranscriptPolicy(policy);
    const copy = structuredClone(policy);
    assertTranscriptPolicy(copy);
    this.policy = deepFreeze(copy);
  }

  async accept(frameInput: RemoteProcessFrame): Promise<void> {
    if (this.failed) throw new Error("Remote process transcript validator is failed closed.");
    try {
      // Reject malformed or oversized caller objects before cloning them into
      // the validator's immutable trust boundary.
      assertFrameShape(frameInput);
      const frame = deepFreeze(structuredClone(frameInput));
      await this.acceptFrame(frame);
    } catch (error) {
      this.failed = true;
      this.stdout.length = 0;
      this.stderr.length = 0;
      throw error;
    }
  }

  async finish(): Promise<RemoteProcessTranscript> {
    if (this.failed) throw new Error("Remote process transcript validator is failed closed.");
    if (!this.terminal || !this.previousDigest || !this.resultDigest) {
      this.failed = true;
      this.stdout.length = 0;
      this.stderr.length = 0;
      throw new Error("Remote process stream ended without a verified structural terminal event.");
    }
    if (!this.stdoutDigest || !this.stderrDigest) {
      this.failed = true;
      throw new Error("Remote process terminal digests are unavailable.");
    }
    return deepFreeze({
      jobId: this.policy.jobId,
      terminal: this.terminal,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      frameCount: this.nextSequence,
      outputBytes: this.outputBytes,
      stdoutDigest: this.stdoutDigest,
      stderrDigest: this.stderrDigest,
      resultDigest: this.resultDigest,
      ...(this.workspaceDeltaManifestDigest
        ? { workspaceDeltaManifestDigest: this.workspaceDeltaManifestDigest }
        : {}),
      ...(this.workspaceDeltaCommitmentDigest
        ? { workspaceDeltaCommitmentDigest: this.workspaceDeltaCommitmentDigest }
        : {}),
      structuralDigest: this.previousDigest,
    });
  }

  private async acceptFrame(frame: RemoteProcessFrame): Promise<void> {
    if (this.terminal) throw new Error("Remote process emitted a frame after its terminal event.");
    if (this.nextSequence >= (this.policy.maxFrames ?? MAX_FRAMES)) throw new Error("Remote process frame limit exceeded.");
    assertFrameShape(frame);
    if (frame.jobId !== this.policy.jobId) throw new Error("Remote process frame job identity does not match.");
    if (frame.sequence !== this.nextSequence) throw new Error("Remote process frame sequence is not contiguous.");
    if (frame.previousDigest !== this.previousDigest) throw new Error("Remote process frame structural chain is discontinuous.");
    const recordedAt = Date.parse(frame.recordedAt);
    if (!Number.isFinite(recordedAt) || (this.lastRecordedAt !== undefined && recordedAt < this.lastRecordedAt)) {
      throw new Error("Remote process frame timestamp is invalid or regressed.");
    }
    const canonical = {
      schema: frame.schema,
      jobId: frame.jobId,
      sequence: frame.sequence,
      recordedAt: frame.recordedAt,
      previousDigest: frame.previousDigest,
      payload: frame.payload,
    };
    if (await sha256(stableStringify(canonical as unknown as JsonValue)) !== frame.digest) {
      throw new Error("Remote process frame structural digest verification failed.");
    }

    await this.acceptPayload(frame.payload);
    this.previousDigest = frame.digest;
    this.lastRecordedAt = recordedAt;
    this.nextSequence += 1;
  }

  private async acceptPayload(payload: RemoteProcessPayload): Promise<void> {
    if (!this.accepted) {
      if (payload.type !== "accepted") throw new Error("Remote process stream must begin with an accepted event.");
      const expectedSnapshot = this.policy.workspace.mode === "encrypted-delta"
        ? this.policy.workspace.snapshotDigest
        : undefined;
      if (
        payload.executorId !== this.policy.executorId
        || payload.runtime !== this.policy.runtime
        || payload.artifactDigest !== this.policy.artifactDigest
        || payload.ioMode !== this.policy.ioMode
        || payload.planDigest !== this.policy.planDigest
        || payload.approvalDigest !== this.policy.approvalDigest
        || payload.channelBindingDigest !== this.policy.channelBindingDigest
        || payload.workspaceSnapshotDigest !== expectedSnapshot
      ) {
        throw new Error("Remote process acceptance does not match the prepared executor, plan, channel, or snapshot.");
      }
      this.accepted = true;
      return;
    }
    if (payload.type === "accepted") throw new Error("Remote process emitted more than one accepted event.");
    if (payload.type === "stdout" || payload.type === "stderr") {
      if (this.workspaceDeltaManifestDigest) throw new Error("Remote process emitted output after its workspace delta.");
      if (payload.type === "stderr" && this.policy.ioMode === "pty") {
        throw new Error("A PTY remote process cannot emit a separate stderr stream.");
      }
      const bytes = decodeRemoteOutput(payload);
      this.outputBytes += bytes.byteLength;
      if (!Number.isSafeInteger(this.outputBytes) || this.outputBytes > this.policy.maxOutputBytes) {
        throw new Error("Remote process output exceeds its approved limit.");
      }
      (payload.type === "stdout" ? this.stdout : this.stderr).push(bytes);
      return;
    }
    if (payload.type === "workspace-delta") {
      if (this.policy.workspace.mode !== "encrypted-delta") {
        throw new Error("Remote process emitted a workspace delta without writeback authority.");
      }
      if (this.workspaceDeltaManifestDigest) throw new Error("Remote process emitted more than one workspace delta manifest.");
      if (
        payload.baseManifestDigest !== this.policy.workspace.baseManifestDigest
        || payload.encryptedBytes > this.policy.workspace.maxEncryptedBytes
      ) {
        throw new Error("Remote workspace delta does not match its approved base or byte limit.");
      }
      this.workspaceDeltaManifestDigest = payload.deltaManifestDigest;
      this.workspaceDeltaCommitmentDigest = await sha256(stableStringify({
        schema: "airship.remote-workspace-delta-commitment.v1",
        jobId: this.policy.jobId,
        planDigest: this.policy.planDigest,
        snapshotDigest: this.policy.workspace.snapshotDigest,
        baseManifestDigest: payload.baseManifestDigest,
        deltaManifestDigest: payload.deltaManifestDigest,
        changedPathsDigest: payload.changedPathsDigest,
        encryptedBytes: payload.encryptedBytes,
      }));
      return;
    }

    const stdoutDigest = await sha256(concatBytes(this.stdout));
    const stderrDigest = await sha256(concatBytes(this.stderr));
    if (payload.stdoutDigest !== stdoutDigest || payload.stderrDigest !== stderrDigest) {
      throw new Error("Remote process terminal stream digests do not match accepted output.");
    }
    const commitment: RemoteProcessResultCommitment = {
      schema: "airship.remote-process-result.v1",
      jobId: this.policy.jobId,
      planDigest: this.policy.planDigest,
      disposition: payload.type,
      exitCode: payload.type === "exited" ? payload.exitCode : null,
      failureCode: payload.type === "failed" ? payload.code : null,
      stdoutDigest,
      stderrDigest,
      workspaceDeltaCommitmentDigest: this.workspaceDeltaCommitmentDigest ?? null,
    };
    if (payload.resultDigest !== await remoteProcessResultDigest(commitment)) {
      throw new Error("Remote process result commitment does not match its transcript.");
    }
    if (payload.type === "exited") {
      this.exitCode = payload.exitCode;
      this.terminal = "exited";
    } else {
      this.terminal = "failed";
    }
    this.stdoutDigest = stdoutDigest;
    this.stderrDigest = stderrDigest;
    this.stdout.length = 0;
    this.stderr.length = 0;
    this.resultDigest = payload.resultDigest;
  }
}

function assertPlacementRequest(request: ContinuumPlacementRequest): void {
  assertExactKeys(
    request,
    ["operationId", "runtime", "mode", "local", "requirements", "remote"],
    "Continuum placement request",
    ["remote"],
  );
  assertSafeId(request.operationId, "Operation ID");
  assertRuntime(request.runtime);
  if (!(["browser-only", "prefer-browser", "remote-confidential"] as const).includes(request.mode)) {
    throw new Error("Continuum placement mode is invalid.");
  }
  assertExactKeys(request.local, ["state", "detail"], "Continuum local inspection");
  if (request.local.state !== "ready" && request.local.state !== "unavailable") {
    throw new Error("Continuum local state is invalid.");
  }
  assertBoundedText(request.local.detail, "Continuum local detail");
  assertExactKeys(request.requirements, [
    "nativeLinux", "inputBytes", "outputBytes", "runtimeMs", "workspaceReadBytes", "workspaceWriteBytes",
  ], "Continuum requirements");
  if (typeof request.requirements.nativeLinux !== "boolean") {
    throw new Error("Native-Linux requirement is invalid.");
  }
  if (request.requirements.nativeLinux !== (request.runtime === "linux-process")) {
    throw new Error("Native-Linux requirements must use the linux-process runtime and vice versa.");
  }
  const requirements = request.requirements;
  assertLimit(requirements.inputBytes, "Input size", 0, MAX_TRANSCRIPT_OUTPUT_BYTES);
  assertLimit(requirements.outputBytes, "Output size", 0, MAX_TRANSCRIPT_OUTPUT_BYTES);
  assertLimit(requirements.runtimeMs, "Runtime limit", 1, 24 * 60 * 60 * 1_000);
  assertLimit(requirements.workspaceReadBytes, "Workspace read size", 0, MAX_WORKSPACE_DELTA_BYTES);
  assertLimit(requirements.workspaceWriteBytes, "Workspace write size", 0, MAX_WORKSPACE_DELTA_BYTES);
  if (request.remote) {
    assertExactKeys(request.remote, ["inspection"], "Continuum remote inspection wrapper");
    assertRemoteInspection(request.remote.inspection);
  }
}

function assertTranscriptPolicy(policy: RemoteProcessTranscriptPolicy): void {
  assertExactKeys(policy, [
    "jobId", "executorId", "runtime", "artifactDigest", "ioMode", "planDigest", "approvalDigest",
    "channelBindingDigest", "maxOutputBytes", "maxFrames", "workspace",
  ], "Remote transcript policy", ["maxFrames"]);
  assertSafeId(policy.jobId, "Remote job ID");
  assertSafeId(policy.executorId, "Remote executor ID");
  assertRuntime(policy.runtime);
  assertDigest(policy.artifactDigest, "Remote artifact digest");
  if (policy.ioMode !== "pipes" && policy.ioMode !== "pty") throw new Error("Remote I/O mode is invalid.");
  assertDigest(policy.planDigest, "Remote plan digest");
  assertDigest(policy.approvalDigest, "Remote approval digest");
  assertDigest(policy.channelBindingDigest, "Remote channel-binding digest");
  assertLimit(policy.maxOutputBytes, "Remote output limit", 0, MAX_TRANSCRIPT_OUTPUT_BYTES);
  assertLimit(policy.maxFrames ?? MAX_FRAMES, "Remote frame limit", 1, MAX_FRAMES);
  if (policy.workspace.mode === "none") {
    assertExactKeys(policy.workspace, ["mode"], "Remote no-workspace policy");
  } else if (policy.workspace.mode === "encrypted-delta") {
    assertExactKeys(policy.workspace, [
      "mode", "snapshotDigest", "baseManifestDigest", "maxEncryptedBytes",
    ], "Remote workspace policy");
    assertDigest(policy.workspace.snapshotDigest, "Remote workspace snapshot digest");
    assertDigest(policy.workspace.baseManifestDigest, "Remote workspace base digest");
    assertLimit(policy.workspace.maxEncryptedBytes, "Remote workspace delta limit", 0, MAX_WORKSPACE_DELTA_BYTES);
  } else {
    throw new Error("Remote workspace policy mode is invalid.");
  }
}

function assertFrameShape(frame: RemoteProcessFrame): void {
  assertExactKeys(frame, [
    "schema", "jobId", "sequence", "recordedAt", "previousDigest", "payload", "digest",
  ], "Remote process frame");
  if (frame.schema !== "airship.remote-process-frame.v1") throw new Error("Unsupported remote process frame schema.");
  assertSafeId(frame.jobId, "Remote frame job ID");
  assertLimit(frame.sequence, "Remote frame sequence", 0, MAX_FRAMES - 1);
  if (frame.previousDigest !== null) assertDigest(frame.previousDigest, "Remote previous-frame digest");
  if (
    typeof frame.recordedAt !== "string"
    || frame.recordedAt.length !== 24
    || !Number.isFinite(Date.parse(frame.recordedAt))
    || new Date(Date.parse(frame.recordedAt)).toISOString() !== frame.recordedAt
  ) {
    throw new Error("Remote frame timestamp is invalid.");
  }
  assertDigest(frame.digest, "Remote frame digest");
  assertPayloadShape(frame.payload);
}

function assertPayloadShape(payload: RemoteProcessPayload): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Remote process payload is invalid.");
  if (payload.type === "accepted") {
    assertExactKeys(payload, [
      "type", "executorId", "runtime", "artifactDigest", "ioMode", "planDigest", "approvalDigest",
      "channelBindingDigest", "workspaceSnapshotDigest",
    ], "Remote accepted payload", ["workspaceSnapshotDigest"]);
    assertSafeId(payload.executorId, "Remote accepted executor ID");
    assertRuntime(payload.runtime);
    assertDigest(payload.artifactDigest, "Remote accepted artifact digest");
    if (payload.ioMode !== "pipes" && payload.ioMode !== "pty") throw new Error("Remote accepted I/O mode is invalid.");
    assertDigest(payload.planDigest, "Remote accepted plan digest");
    assertDigest(payload.approvalDigest, "Remote accepted approval digest");
    assertDigest(payload.channelBindingDigest, "Remote accepted channel digest");
    if (payload.workspaceSnapshotDigest !== undefined) assertDigest(payload.workspaceSnapshotDigest, "Remote accepted snapshot digest");
    return;
  }
  if (payload.type === "stdout" || payload.type === "stderr") {
    assertExactKeys(payload, ["type", "encoding", "data"], "Remote output payload");
    decodeRemoteOutput(payload);
    return;
  }
  if (payload.type === "workspace-delta") {
    assertExactKeys(payload, [
      "type", "baseManifestDigest", "deltaManifestDigest", "changedPathsDigest", "encryptedBytes",
    ], "Remote workspace-delta payload");
    assertDigest(payload.baseManifestDigest, "Remote workspace base digest");
    assertDigest(payload.deltaManifestDigest, "Remote workspace delta digest");
    assertDigest(payload.changedPathsDigest, "Remote changed-path digest");
    assertLimit(payload.encryptedBytes, "Remote workspace delta bytes", 0, MAX_WORKSPACE_DELTA_BYTES);
    return;
  }
  if (payload.type === "exited") {
    assertExactKeys(payload, [
      "type", "exitCode", "stdoutDigest", "stderrDigest", "resultDigest",
    ], "Remote exited payload");
    assertLimit(payload.exitCode, "Remote exit status", 0, 255);
  } else if (payload.type === "failed") {
    assertExactKeys(payload, [
      "type", "code", "message", "stdoutDigest", "stderrDigest", "resultDigest",
    ], "Remote failed payload");
    assertSafeId(payload.code, "Remote failure code");
    if (typeof payload.message !== "string" || !SAFE_FAILURE_MESSAGE.test(payload.message)) {
      throw new Error("Remote failure message is invalid.");
    }
  } else {
    throw new Error("Unknown remote process payload type.");
  }
  assertDigest(payload.stdoutDigest, "Remote stdout digest");
  assertDigest(payload.stderrDigest, "Remote stderr digest");
  assertDigest(payload.resultDigest, "Remote result digest");
}

function decodeRemoteOutput(payload: Readonly<{ encoding: "base64url"; data: string }>): Uint8Array {
  if (
    payload.encoding !== "base64url"
    || typeof payload.data !== "string"
    || payload.data.length > MAX_FRAME_OUTPUT_ENCODED_CHARS
    || !/^[A-Za-z0-9_-]*$/u.test(payload.data)
  ) {
    throw new Error("Remote process output encoding is invalid.");
  }
  const bytes = fromBase64Url(payload.data);
  if (toBase64Url(bytes) !== payload.data || bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_OUTPUT_BYTES) {
    throw new Error("Remote process output frame is non-canonical or oversized.");
  }
  return bytes;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain record.`);
  }
  const actual = Object.keys(value).sort();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (actual.some((key) => descriptors[key]?.get || descriptors[key]?.set)) {
    throw new Error(`${label} cannot contain accessors.`);
  }
  const allowedSet = new Set(allowed);
  if (actual.some((key) => !allowedSet.has(key))) throw new Error(`${label} contains an unknown field.`);
  const actualSet = new Set(actual);
  if (allowed.some((key) => !optional.includes(key) && !actualSet.has(key))) throw new Error(`${label} is missing a required field.`);
  if (actual.some((key) => (value as Record<string, unknown>)[key] === undefined)) {
    throw new Error(`${label} contains an explicit undefined value.`);
  }
}

function unavailable(code: Extract<ContinuumPlacementDecision, { placement: "unavailable" }>["code"], reason: string): ContinuumPlacementDecision {
  return Object.freeze({ placement: "unavailable", code, reason });
}

function assertSafeId(value: string, label: string): void {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
}

function assertDigest(value: string, label: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
}

function assertResultCommitment(commitment: RemoteProcessResultCommitment): void {
  assertExactKeys(commitment, [
    "schema", "jobId", "planDigest", "disposition", "exitCode", "failureCode",
    "stdoutDigest", "stderrDigest", "workspaceDeltaCommitmentDigest",
  ], "Remote process result commitment");
  if (commitment.schema !== "airship.remote-process-result.v1") throw new Error("Unsupported remote process result schema.");
  assertSafeId(commitment.jobId, "Remote result job ID");
  assertDigest(commitment.planDigest, "Remote result plan digest");
  assertDigest(commitment.stdoutDigest, "Remote result stdout digest");
  assertDigest(commitment.stderrDigest, "Remote result stderr digest");
  if (commitment.workspaceDeltaCommitmentDigest !== null) {
    assertDigest(commitment.workspaceDeltaCommitmentDigest, "Remote result workspace-delta commitment digest");
  }
  if (commitment.disposition === "exited") {
    assertLimit(commitment.exitCode as number, "Remote result exit status", 0, 255);
    if (commitment.failureCode !== null) throw new Error("Exited remote results cannot contain a failure code.");
    return;
  }
  if (commitment.disposition === "failed") {
    if (commitment.exitCode !== null) throw new Error("Failed remote results cannot contain an exit status.");
    assertSafeId(commitment.failureCode as string, "Remote result failure code");
    return;
  }
  throw new Error("Remote result disposition is invalid.");
}

function assertRemoteInspection(inspection: RemoteExecutorInspection): void {
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    throw new Error("Continuum remote inspection is invalid.");
  }
  if (inspection.state === "unavailable" || inspection.state === "provider-asserted") {
    assertExactKeys(inspection, ["state", "detail"], "Continuum remote inspection");
  } else if (inspection.state === "evidence-verified") {
    assertExactKeys(inspection, ["state", "detail", "evidenceId"], "Continuum remote inspection");
    assertSafeId(inspection.evidenceId, "Continuum evidence ID");
  } else if (inspection.state === "channel-bound") {
    assertExactKeys(
      inspection,
      ["state", "detail", "evidenceId", "channelBindingDigest"],
      "Continuum remote inspection",
    );
    assertSafeId(inspection.evidenceId, "Continuum evidence ID");
    assertDigest(inspection.channelBindingDigest, "Continuum channel-binding digest");
  } else {
    throw new Error("Continuum remote inspection state is invalid.");
  }
  assertBoundedText(inspection.detail, "Continuum remote inspection detail");
}

function assertBoundedText(value: string, label: string): void {
  if (
    typeof value !== "string"
    || value.length > 512
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

/**
 * Every id `ContinuumRuntimeId` admits, and no fewer: a name missing here makes
 * the type system promise a call this validator refuses at runtime, which is
 * how `airship-sh` — the one tier ready in every browser with no pack and no
 * cross-origin isolation — became the one tier placement could not plan.
 */
function assertRuntime(value: string): asserts value is ContinuumRuntimeId {
  const runtimes: readonly ContinuumRuntimeId[] = [
    "javascript-worker", "wasi-preview1", "python-pyodide", "wasix",
    "node-webcontainer", "airship-sh", "linux-process",
  ];
  if (!runtimes.includes(value as ContinuumRuntimeId)) throw new Error("Continuum runtime is invalid.");
}

function assertLimit(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid.`);
}
