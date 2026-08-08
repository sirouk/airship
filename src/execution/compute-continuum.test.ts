import { describe, expect, it } from "vitest";
import { sha256 } from "../core/hash";
import {
  RemoteProcessTranscriptValidator,
  createRemoteProcessFrame,
  encodeRemoteOutput,
  planContinuumPlacement,
  remoteProcessResultDigest,
  type ContinuumPlacementRequest,
  type RemoteProcessFrame,
  type RemoteProcessPayload,
  type RemoteProcessResultCommitment,
  type RemoteProcessTranscriptPolicy,
} from "./compute-continuum";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

function placementRequest(): ContinuumPlacementRequest {
  return {
    operationId: "operation-1",
    runtime: "python-pyodide",
    mode: "prefer-browser",
    local: { state: "ready", detail: "Python is ready in a browser Worker." },
    requirements: {
      nativeLinux: false,
      inputBytes: 100,
      outputBytes: 1_000,
      runtimeMs: 10_000,
      workspaceReadBytes: 2_000,
      workspaceWriteBytes: 1_000,
    },
  };
}

describe("compute continuum placement", () => {
  it("prefers a compatible browser runtime without disclosing work remotely", () => {
    expect(planContinuumPlacement(placementRequest())).toMatchObject({ placement: "browser" });
  });

  it("does not promote provider assertions to remote execution", () => {
    const request = placementRequest();
    expect(planContinuumPlacement({
      ...request,
      local: { state: "unavailable", detail: "No local runtime." },
      remote: { inspection: { state: "provider-asserted", detail: "Provider metadata only." } },
    })).toMatchObject({ placement: "unavailable", code: "remote-unverified" });
  });

  it("keeps evidence-only and channel-only observations non-executable", async () => {
    const request = placementRequest();
    const digest = await sha256("channel");
    expect(planContinuumPlacement({
      ...request,
      mode: "remote-confidential",
      remote: { inspection: { state: "evidence-verified", detail: "Quote passed.", evidenceId: "evidence-1" } },
    })).toMatchObject({ placement: "unavailable", code: "remote-not-ready" });
    expect(planContinuumPlacement({
      ...request,
      mode: "remote-confidential",
      remote: { inspection: { state: "channel-bound", detail: "Channel observed.", evidenceId: "evidence-1", channelBindingDigest: digest } },
    })).toMatchObject({ placement: "unavailable", code: "remote-not-ready" });
  });

  /*
   * `airship-sh` is a `ContinuumRuntimeId`, so the type system promises this
   * call is legal. The validator's own list omitted it, which made the one tier
   * that is ready in every browser the one tier placement refused to plan.
   */
  it("plans the browser-native shell the runtime union admits", () => {
    expect(planContinuumPlacement({
      ...placementRequest(),
      runtime: "airship-sh",
      mode: "browser-only",
      local: { state: "ready", detail: "airship-sh needs no pack." },
    })).toMatchObject({ placement: "browser" });
  });

  it("never falls back from remote-confidential to a ready local runtime", () => {
    expect(planContinuumPlacement({
      ...placementRequest(),
      mode: "remote-confidential",
    })).toMatchObject({ placement: "unavailable", code: "remote-unavailable" });
  });

  it("rejects contradictory native-Linux requirements", () => {
    expect(() => planContinuumPlacement({
      ...placementRequest(),
      requirements: { ...placementRequest().requirements, nativeLinux: true },
    })).toThrow(/linux-process/u);
  });

  it("rejects non-record and coercible placement fields", () => {
    expect(() => planContinuumPlacement({
      ...placementRequest(),
      operationId: 123,
    } as unknown as ContinuumPlacementRequest)).toThrow(/Operation ID/u);
    expect(() => planContinuumPlacement({
      ...placementRequest(),
      unexpected: true,
    } as unknown as ContinuumPlacementRequest)).toThrow(/unknown field/u);
  });

  it("rejects accessor-backed placement records before they can downgrade", () => {
    const request = { ...placementRequest() } as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(request, "mode", {
      enumerable: true,
      get: () => reads++ === 0 ? "remote-confidential" : "prefer-browser",
    });
    expect(() => planContinuumPlacement(request as unknown as ContinuumPlacementRequest))
      .toThrow(/accessors/u);
  });
});

describe("remote process structural transcript", () => {
  async function policy(workspace: RemoteProcessTranscriptPolicy["workspace"] = { mode: "none" }): Promise<RemoteProcessTranscriptPolicy> {
    return {
      jobId: "job-1",
      executorId: "executor-1",
      runtime: "linux-process",
      artifactDigest: await sha256("artifact"),
      ioMode: "pipes",
      planDigest: await sha256("plan"),
      approvalDigest: await sha256("approval"),
      channelBindingDigest: await sha256("channel"),
      maxOutputBytes: 1_024,
      workspace,
    };
  }

  async function terminalPayload(
    transcriptPolicy: RemoteProcessTranscriptPolicy,
    stdout: Uint8Array,
    stderr: Uint8Array,
    exitCode = 0,
    workspaceDeltaCommitmentDigest: string | null = null,
  ): Promise<Extract<RemoteProcessPayload, { type: "exited" }>> {
    const commitment: RemoteProcessResultCommitment = {
      schema: "airship.remote-process-result.v1",
      jobId: transcriptPolicy.jobId,
      planDigest: transcriptPolicy.planDigest,
      disposition: "exited",
      exitCode,
      failureCode: null,
      stdoutDigest: await sha256(stdout),
      stderrDigest: await sha256(stderr),
      workspaceDeltaCommitmentDigest,
    };
    return {
      type: "exited",
      exitCode,
      stdoutDigest: commitment.stdoutDigest,
      stderrDigest: commitment.stderrDigest,
      resultDigest: await remoteProcessResultDigest(commitment),
    };
  }

  async function frameChain(payloads: readonly RemoteProcessPayload[]): Promise<RemoteProcessFrame[]> {
    const frames: RemoteProcessFrame[] = [];
    let previousDigest: string | null = null;
    for (const [sequence, payload] of payloads.entries()) {
      const frame = await createRemoteProcessFrame({
        jobId: "job-1",
        sequence,
        recordedAt: new Date(NOW + sequence * 10).toISOString(),
        previousDigest,
        payload,
      });
      frames.push(frame);
      previousDigest = frame.digest;
    }
    return frames;
  }

  function accepted(transcriptPolicy: RemoteProcessTranscriptPolicy): Extract<RemoteProcessPayload, { type: "accepted" }> {
    return {
      type: "accepted",
      executorId: transcriptPolicy.executorId,
      runtime: transcriptPolicy.runtime,
      artifactDigest: transcriptPolicy.artifactDigest,
      ioMode: transcriptPolicy.ioMode,
      planDigest: transcriptPolicy.planDigest,
      approvalDigest: transcriptPolicy.approvalDigest,
      channelBindingDigest: transcriptPolicy.channelBindingDigest,
      ...(transcriptPolicy.workspace.mode === "encrypted-delta"
        ? { workspaceSnapshotDigest: transcriptPolicy.workspace.snapshotDigest }
        : {}),
    };
  }

  it("accepts binary-safe ordered output and verifies the result commitment", async () => {
    const transcriptPolicy = await policy();
    const stdout = new Uint8Array([0, 255, 128, 10]);
    const stderr = new Uint8Array([240, 40, 140, 40]);
    const frames = await frameChain([
      accepted(transcriptPolicy),
      { type: "stdout", ...encodeRemoteOutput(stdout) },
      { type: "stderr", ...encodeRemoteOutput(stderr) },
      await terminalPayload(transcriptPolicy, stdout, stderr),
    ]);
    const validator = new RemoteProcessTranscriptValidator(transcriptPolicy);
    for (const frame of frames) await validator.accept(frame);
    await expect(validator.finish()).resolves.toMatchObject({
      terminal: "exited",
      exitCode: 0,
      frameCount: 4,
      outputBytes: 8,
      stdoutDigest: await sha256(stdout),
      stderrDigest: await sha256(stderr),
      structuralDigest: frames.at(-1)!.digest,
    });
  });

  it("rejects missing acceptance, reordering, mutation, and post-terminal frames", async () => {
    const transcriptPolicy = await policy();
    const output = new TextEncoder().encode("hello");
    const frames = await frameChain([
      accepted(transcriptPolicy),
      { type: "stdout", ...encodeRemoteOutput(output) },
      await terminalPayload(transcriptPolicy, output, new Uint8Array()),
    ]);

    const missing = new RemoteProcessTranscriptValidator(transcriptPolicy);
    const badFirst = await frameChain([{ type: "stdout", ...encodeRemoteOutput(output) }]);
    await expect(missing.accept(badFirst[0]!)).rejects.toThrow(/begin with an accepted/u);

    const reordered = new RemoteProcessTranscriptValidator(transcriptPolicy);
    await expect(reordered.accept(frames[1]!)).rejects.toThrow(/sequence/u);

    const mutated = new RemoteProcessTranscriptValidator(transcriptPolicy);
    await mutated.accept(frames[0]!);
    await expect(mutated.accept({ ...frames[1]!, payload: { type: "stdout", ...encodeRemoteOutput(new TextEncoder().encode("changed")) } }))
      .rejects.toThrow(/structural digest/u);

    const terminal = new RemoteProcessTranscriptValidator(transcriptPolicy);
    for (const frame of frames) await terminal.accept(frame);
    await expect(terminal.accept(frames[2]!)).rejects.toThrow(/after its terminal/u);
  });

  it("fails permanently after one rejected frame", async () => {
    const transcriptPolicy = await policy();
    const validator = new RemoteProcessTranscriptValidator(transcriptPolicy);
    const bad = await frameChain([{ type: "stdout", ...encodeRemoteOutput(new Uint8Array([1])) }]);
    await expect(validator.accept(bad[0]!)).rejects.toThrow();
    const good = await frameChain([accepted(transcriptPolicy)]);
    await expect(validator.accept(good[0]!)).rejects.toThrow(/failed closed/u);
    await expect(validator.finish()).rejects.toThrow(/failed closed/u);
  });

  it("snapshots policy inputs before validation begins", async () => {
    const mutablePolicy = await policy() as RemoteProcessTranscriptPolicy & { planDigest: string };
    const acceptedPayload = accepted(mutablePolicy);
    const validator = new RemoteProcessTranscriptValidator(mutablePolicy);
    mutablePolicy.planDigest = await sha256("mutated-after-construction");
    const frames = await frameChain([acceptedPayload]);
    await expect(validator.accept(frames[0]!)).resolves.toBeUndefined();
  });

  it("rejects an accepted plan/channel/snapshot mismatch", async () => {
    const transcriptPolicy = await policy();
    const frames = await frameChain([{ ...accepted(transcriptPolicy), channelBindingDigest: await sha256("other") }]);
    await expect(new RemoteProcessTranscriptValidator(transcriptPolicy).accept(frames[0]!))
      .rejects.toThrow(/plan, channel, or snapshot/u);
  });

  it("rejects unauthorized or stale-base workspace deltas", async () => {
    const digest = await sha256("workspace");
    const noWorkspace = await policy();
    const unauthorized = await frameChain([
      accepted(noWorkspace),
      { type: "workspace-delta", baseManifestDigest: digest, deltaManifestDigest: digest, changedPathsDigest: digest, encryptedBytes: 10 },
    ]);
    const first = new RemoteProcessTranscriptValidator(noWorkspace);
    await first.accept(unauthorized[0]!);
    await expect(first.accept(unauthorized[1]!)).rejects.toThrow(/without writeback authority/u);

    const allowed = await policy({
      mode: "encrypted-delta",
      snapshotDigest: await sha256("snapshot"),
      baseManifestDigest: await sha256("expected-base"),
      maxEncryptedBytes: 10,
    });
    const stale = await frameChain([
      accepted(allowed),
      { type: "workspace-delta", baseManifestDigest: digest, deltaManifestDigest: digest, changedPathsDigest: digest, encryptedBytes: 10 },
    ]);
    const second = new RemoteProcessTranscriptValidator(allowed);
    await second.accept(stale[0]!);
    await expect(second.accept(stale[1]!)).rejects.toThrow(/approved base/u);
  });

  it("enforces delta ordering and PTY stream semantics", async () => {
    const digest = await sha256("workspace");
    const deltaPolicy = await policy({
      mode: "encrypted-delta",
      snapshotDigest: await sha256("snapshot"),
      baseManifestDigest: digest,
      maxEncryptedBytes: 10,
    });
    const deltaFrames = await frameChain([
      accepted(deltaPolicy),
      { type: "workspace-delta", baseManifestDigest: digest, deltaManifestDigest: digest, changedPathsDigest: digest, encryptedBytes: 10 },
      { type: "stdout", ...encodeRemoteOutput(new Uint8Array([1])) },
    ]);
    const deltaValidator = new RemoteProcessTranscriptValidator(deltaPolicy);
    await deltaValidator.accept(deltaFrames[0]!);
    await deltaValidator.accept(deltaFrames[1]!);
    await expect(deltaValidator.accept(deltaFrames[2]!)).rejects.toThrow(/output after/u);

    const ptyPolicy = { ...await policy(), ioMode: "pty" as const };
    const ptyFrames = await frameChain([
      accepted(ptyPolicy),
      { type: "stderr", ...encodeRemoteOutput(new Uint8Array([1])) },
    ]);
    const ptyValidator = new RemoteProcessTranscriptValidator(ptyPolicy);
    await ptyValidator.accept(ptyFrames[0]!);
    await expect(ptyValidator.accept(ptyFrames[1]!)).rejects.toThrow(/PTY/u);
  });

  it("rejects unknown fields and terminal output/result digest mismatches", async () => {
    const transcriptPolicy = await policy();
    const acceptedFrame = (await frameChain([accepted(transcriptPolicy)]))[0]!;
    const unknown = { ...acceptedFrame, unexpected: true } as unknown as RemoteProcessFrame;
    await expect(new RemoteProcessTranscriptValidator(transcriptPolicy).accept(unknown)).rejects.toThrow(/unknown field/u);

    const output = new TextEncoder().encode("hello");
    const frames = await frameChain([
      accepted(transcriptPolicy),
      { type: "stdout", ...encodeRemoteOutput(output) },
      await terminalPayload(transcriptPolicy, new TextEncoder().encode("different"), new Uint8Array()),
    ]);
    const validator = new RemoteProcessTranscriptValidator(transcriptPolicy);
    await validator.accept(frames[0]!);
    await validator.accept(frames[1]!);
    await expect(validator.accept(frames[2]!)).rejects.toThrow(/stream digests/u);
  });

  it("rejects output beyond policy and incomplete streams", async () => {
    const transcriptPolicy = { ...await policy(), maxOutputBytes: 1 };
    const frames = await frameChain([
      accepted(transcriptPolicy),
      { type: "stdout", ...encodeRemoteOutput(new Uint8Array([1, 2])) },
    ]);
    const validator = new RemoteProcessTranscriptValidator(transcriptPolicy);
    await validator.accept(frames[0]!);
    await expect(validator.accept(frames[1]!)).rejects.toThrow(/approved limit/u);
    await expect(validator.finish()).rejects.toThrow(/failed closed/u);

    const incomplete = new RemoteProcessTranscriptValidator(await policy());
    await expect(incomplete.finish()).rejects.toThrow(/without a verified structural terminal/u);
    const late = await frameChain([accepted(await policy())]);
    await expect(incomplete.accept(late[0]!)).rejects.toThrow(/failed closed/u);
  });

  it("rejects oversized encoded output before decoding or cloning it", async () => {
    const transcriptPolicy = await policy();
    const acceptedFrame = (await frameChain([accepted(transcriptPolicy)]))[0]!;
    const validator = new RemoteProcessTranscriptValidator(transcriptPolicy);
    await validator.accept(acceptedFrame);
    const oversized = {
      schema: "airship.remote-process-frame.v1",
      jobId: transcriptPolicy.jobId,
      sequence: 1,
      recordedAt: new Date(NOW + 10).toISOString(),
      previousDigest: acceptedFrame.digest,
      payload: { type: "stdout", encoding: "base64url", data: "A".repeat(350_000) },
      digest: await sha256("unused"),
    } as unknown as RemoteProcessFrame;
    await expect(validator.accept(oversized)).rejects.toThrow(/output encoding/u);
  });

  it("rejects contradictory result commitment records", async () => {
    const transcriptPolicy = await policy();
    const digest = await sha256(new Uint8Array());
    await expect(remoteProcessResultDigest({
      schema: "airship.remote-process-result.v1",
      jobId: transcriptPolicy.jobId,
      planDigest: transcriptPolicy.planDigest,
      disposition: "exited",
      exitCode: 0,
      failureCode: "should-not-exist",
      stdoutDigest: digest,
      stderrDigest: digest,
      workspaceDeltaCommitmentDigest: null,
    })).rejects.toThrow(/failure code/u);
  });

  it("rejects accessor-backed result commitments before hashing", async () => {
    const transcriptPolicy = await policy();
    const digest = await sha256(new Uint8Array());
    const commitment = {
      schema: "airship.remote-process-result.v1",
      jobId: transcriptPolicy.jobId,
      planDigest: transcriptPolicy.planDigest,
      disposition: "exited",
      exitCode: 0,
      failureCode: null,
      stdoutDigest: digest,
      stderrDigest: digest,
      workspaceDeltaCommitmentDigest: null,
    } as Record<string, unknown>;
    Object.defineProperty(commitment, "planDigest", {
      enumerable: true,
      get: () => transcriptPolicy.planDigest,
    });
    await expect(remoteProcessResultDigest(commitment as unknown as RemoteProcessResultCommitment))
      .rejects.toThrow(/accessors/u);
  });

  it("rejects unknown workspace modes and zero-progress output", async () => {
    const transcriptPolicy = await policy();
    expect(() => new RemoteProcessTranscriptValidator({
      ...transcriptPolicy,
      workspace: { mode: "mystery" },
    } as unknown as RemoteProcessTranscriptPolicy)).toThrow(/mode/u);
    expect(() => encodeRemoteOutput(new Uint8Array())).toThrow(/empty/u);
  });
});
