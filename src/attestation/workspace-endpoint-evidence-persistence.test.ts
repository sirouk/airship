import { describe, expect, it } from "vitest";
import { sha256, stableStringify } from "../core/hash";
import { MemoryWorkspace } from "../workspace/memory";
import { isWorkspaceControlPlanePath } from "../workspace/contracts";
import { bytesToBase64, hexToBytes, sha256Hex } from "./encoding";
import type { AttestationClaimKey, ChutesEndpointEvidenceRecord } from "./provider-types";
import type { JsonObject } from "./types";
import {
  MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS,
  WorkspaceEndpointEvidenceAuthority,
  WorkspaceEndpointEvidencePersistence,
  endpointEvidenceCheckpointPath,
  endpointEvidenceEntriesForSession,
  type EndpointEvidenceRecordIdentity,
} from "./workspace-endpoint-evidence-persistence";

const PROFILE_ID = "general";
const SESSION_ID = "session-general";
const INSTANCE_ID = "instance-1";
const FETCHED_AT = "2026-07-28T12:00:00.000Z";
const NOW = Date.parse(FETCHED_AT) + 1_000;

describe("workspace endpoint-evidence persistence", () => {
  it("reloads complete raw verification material through the active WorkspacePort", async () => {
    const workspace = new MemoryWorkspace();
    const store = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const record = await evidenceRecord();
    const identity = evidenceIdentity("receipt-1", record);
    const committed = await store.commit({ identity, record }, NOW);

    expect(committed.disposition).toBe("persisted");
    const file = await workspace.read(endpointEvidenceCheckpointPath(PROFILE_ID));
    expect(file).toBeDefined();
    expect(isWorkspaceControlPlanePath(file!.path)).toBe(true);
    expect(file!.content).toContain(record.evidence.quote.base64);
    expect(file!.content).toContain(record.evidence.certificate.base64);
    expect(file!.content).toContain(record.acquisition.requestNonce);
    expect(file!.content).toContain(record.subject.e2ePublicKey);
    expect(file!.content).not.toContain("access_token");

    const reloaded = await new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID).load(NOW);
    expect(reloaded.snapshot.entries).toHaveLength(1);
    expect(reloaded.snapshot.entries[0]?.record).toEqual(record);
    expect(endpointEvidenceEntriesForSession(reloaded.snapshot, SESSION_ID)[0]?.identity.receiptId)
      .toBe("receipt-1");

    // A different page-memory authority does not inherit another page's state.
    expect((await new WorkspaceEndpointEvidencePersistence(new MemoryWorkspace(), PROFILE_ID).load(NOW)).snapshot.entries)
      .toEqual([]);
  });

  it("merges concurrent CAS writers without losing different receipt identities", async () => {
    const workspace = new MemoryWorkspace();
    const left = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const right = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const first = await evidenceRecord({ nonce: "nonce-left", fetchedAt: "2026-07-28T12:00:01.000Z" });
    const second = await evidenceRecord({ nonce: "nonce-right", fetchedAt: "2026-07-28T12:00:02.000Z" });

    await Promise.all([
      left.commit({ identity: evidenceIdentity("receipt-left", first), record: first }, NOW + 2_000),
      right.commit({ identity: evidenceIdentity("receipt-right", second), record: second }, NOW + 2_000),
    ]);

    const loaded = await left.load(NOW + 2_000);
    expect(loaded.snapshot.entries.map((entry) => entry.identity.receiptId).sort())
      .toEqual(["receipt-left", "receipt-right"]);
  });

  it("uses acquisition time then record ID as the deterministic idempotent receipt winner", async () => {
    const workspace = new MemoryWorkspace();
    const left = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const right = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const older = await evidenceRecord({ nonce: "nonce-older", fetchedAt: "2026-07-28T11:59:00.000Z" });
    const newer = await evidenceRecord({ nonce: "nonce-newer", fetchedAt: "2026-07-28T12:00:03.000Z" });
    const identity = evidenceIdentity("receipt-same", newer);

    await Promise.all([
      left.commit({ identity, record: newer }, NOW + 3_000),
      right.commit({ identity, record: older }, NOW + 3_000),
    ]);
    await left.commit({ identity, record: older }, NOW + 4_000);

    const loaded = await left.load(NOW + 4_000);
    expect(loaded.snapshot.entries).toHaveLength(1);
    expect(loaded.snapshot.entries[0]?.record.recordId).toBe(newer.recordId);
  });

  it("removes only one conversation's evidence when proof cleanup is explicitly requested", async () => {
    const workspace = new MemoryWorkspace();
    const store = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const kept = await evidenceRecord({ nonce: "nonce-kept", fetchedAt: "2026-07-28T12:00:04.000Z" });
    const removed = await evidenceRecord({ nonce: "nonce-removed", fetchedAt: "2026-07-28T12:00:05.000Z" });
    await store.commit({ identity: evidenceIdentity("receipt-kept", kept), record: kept }, NOW);
    await store.commit({
      identity: { ...evidenceIdentity("receipt-removed", removed), sessionId: "session-removed" },
      record: removed,
    }, NOW);

    const result = await store.removeSession("session-removed", NOW + 1);

    expect(result.removed).toBe(1);
    expect(result.snapshot.entries.map((entry) => entry.identity.receiptId)).toEqual(["receipt-kept"]);
    expect((await store.load(NOW + 1)).snapshot.entries.map((entry) => entry.identity.receiptId)).toEqual(["receipt-kept"]);
  });

  it("does not silently age-prune durable evidence", async () => {
    const workspace = new MemoryWorkspace();
    const store = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const old = await evidenceRecord({ fetchedAt: "2020-01-01T00:00:00.000Z" });
    await store.commit({ identity: evidenceIdentity("receipt-old", old), record: old }, NOW);

    const farFuture = Date.parse("2050-01-01T00:00:00.000Z");
    const loaded = await new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID).load(farFuture);
    expect(loaded.snapshot.entries).toHaveLength(1);
    expect(loaded.snapshot.entries[0]?.identity.receiptId).toBe("receipt-old");
  });

  it("isolates Profile and WorkspacePort authority and rejects an obsolete binding", async () => {
    const firstWorkspace = new MemoryWorkspace();
    const secondWorkspace = new MemoryWorkspace();
    const authority = new WorkspaceEndpointEvidenceAuthority();
    const record = await evidenceRecord();
    const general = await authority.activate(scope(firstWorkspace, "memory://first", "general"));
    await authority.commit(general, { identity: evidenceIdentity("receipt-general", record), record });

    const research = await authority.activate(scope(firstWorkspace, "memory://first", "research"));
    expect(research.snapshot.entries).toEqual([]);
    await expect(authority.commit(general, {
      identity: evidenceIdentity("receipt-obsolete", record),
      record,
    })).rejects.toMatchObject({ name: "AbortError" });

    const separate = await authority.activate(scope(secondWorkspace, "memory://second", "general"));
    expect(separate.snapshot.entries).toEqual([]);
    const restored = await authority.activate(scope(firstWorkspace, "memory://first", "general"));
    expect(restored.snapshot.entries[0]?.identity.receiptId).toBe("receipt-general");
    await authority.release();
  });

  it("rejects malformed, cross-profile, credential-shaped, and digest-corrupted checkpoints", async () => {
    const workspace = new MemoryWorkspace();
    const path = endpointEvidenceCheckpointPath(PROFILE_ID);
    await workspace.write(path, "{not-json", { expectedRevision: null });
    await expect(new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID).load(NOW))
      .rejects.toThrow("not valid JSON");

    const clean = new MemoryWorkspace();
    const store = new WorkspaceEndpointEvidencePersistence(clean, PROFILE_ID);
    const record = await evidenceRecord();
    await expect(store.commit({
      identity: { ...evidenceIdentity("receipt-cross", record), profileId: "research" },
      record,
    }, NOW)).rejects.toThrow("crosses its active Profile scope");

    const credentialPayload = await evidenceRecord({
      gpuPayloads: [{ access_token: "cak_super_secret_value" }],
    });
    await expect(store.commit({
      identity: evidenceIdentity("receipt-secret", credentialPayload),
      record: credentialPayload,
    }, NOW)).rejects.toThrow("credential-shaped field");

    const corrupted = structuredClone(record) as MutableRecord;
    corrupted.evidence.payloadDigest = `sha256:${"A".repeat(43)}`;
    await expect(store.commit({
      identity: evidenceIdentity("receipt-corrupt", corrupted),
      record: corrupted,
    }, NOW)).rejects.toThrow("payload digest does not commit");
  });

  it("keeps oversize and capacity-exceeding records page-only without truncating or evicting durable proof", async () => {
    const workspace = new MemoryWorkspace();
    const store = new WorkspaceEndpointEvidencePersistence(workspace, PROFILE_ID);
    const oversize = await evidenceRecord({ gpuPayloads: [{ evidence: "x".repeat(3 * 1_024 * 1_024) }] });
    const oversizeResult = await store.commit({
      identity: evidenceIdentity("receipt-oversize", oversize),
      record: oversize,
    }, NOW);
    expect(oversizeResult).toMatchObject({ disposition: "page-only", reason: expect.stringContaining("none was truncated") });
    expect((await store.load(NOW)).snapshot.entries).toEqual([]);

    const record = await evidenceRecord();
    for (let index = 0; index < MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS; index += 1) {
      const result = await store.commit({
        identity: evidenceIdentity(`receipt-${index}`, record),
        record,
      }, NOW + index);
      expect(result.disposition).toBe("persisted");
    }
    const atCapacity = await store.commit({
      identity: evidenceIdentity("receipt-capacity", record),
      record,
    }, NOW + MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS);
    expect(atCapacity).toMatchObject({
      disposition: "page-only",
      reason: expect.stringContaining("Existing proof was not evicted"),
    });
    const loaded = await store.load(NOW + MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS);
    expect(loaded.snapshot.entries).toHaveLength(MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS);
    expect(loaded.snapshot.entries.some((entry) => entry.identity.receiptId === "receipt-0")).toBe(true);
  });
});

type MutableRecord = {
  -readonly [K in keyof ChutesEndpointEvidenceRecord]: K extends "evidence"
    ? { -readonly [P in keyof ChutesEndpointEvidenceRecord["evidence"]]: ChutesEndpointEvidenceRecord["evidence"][P] }
    : ChutesEndpointEvidenceRecord[K];
};

function scope(workspace: MemoryWorkspace, workspaceId: string, profileId: string) {
  return Object.freeze({ workspace, workspaceId, profileId });
}

function evidenceIdentity(receiptId: string, record: ChutesEndpointEvidenceRecord): EndpointEvidenceRecordIdentity {
  return Object.freeze({
    version: 1,
    profileId: PROFILE_ID,
    sessionId: SESSION_ID,
    receiptId,
    instanceId: record.subject.instanceId,
    endpointKeyDigest: record.subject.e2ePublicKeyDigest,
  });
}

async function evidenceRecord(options: Readonly<{
  nonce?: string;
  fetchedAt?: string;
  gpuPayloads?: readonly JsonObject[];
}> = {}): Promise<ChutesEndpointEvidenceRecord> {
  const nonce = options.nonce ?? "nonce-general";
  const fetchedAt = options.fetchedAt ?? FETCHED_AT;
  const e2ePublicKey = "test-e2e-public-key";
  const expectedDigestHex = await sha256Hex(`${nonce}${e2ePublicKey}`);
  const quoteBytes = new Uint8Array(48 + 584 + 4);
  const quoteView = new DataView(quoteBytes.buffer);
  quoteView.setUint16(0, 4, true);
  quoteView.setUint16(2, 2, true);
  quoteView.setUint32(4, 0x81, true);
  quoteView.setUint32(48 + 584, 0, true);
  quoteBytes.set(hexToBytes(expectedDigestHex), 48 + 520);
  const quoteBase64 = bytesToBase64(quoteBytes);
  const reportDataHex = `${expectedDigestHex}${"0".repeat(64)}`;
  const certificateBytes = new Uint8Array([0x30, 0x00]);
  const certificateBase64 = bytesToBase64(certificateBytes);
  const gpuPayloads = options.gpuPayloads ?? [];
  const payloadDigest = await sha256(stableStringify({
    quote: quoteBase64,
    gpu_evidence: [...gpuPayloads],
    instance_id: INSTANCE_ID,
    certificate: certificateBase64,
  }));
  const e2ePublicKeyDigest = await sha256(e2ePublicKey);
  const recordIdDigest = await sha256(stableStringify({
    version: 1,
    provider: "chutes",
    instanceId: INSTANCE_ID,
    chuteId: "chute-1",
    e2ePublicKeyDigest,
    nonce,
    payloadDigest,
  }));
  const checkedAt = fetchedAt;
  const claims = Object.fromEntries(([
    "evidenceStructure", "nonceFreshness", "endpointKey", "cpuTee", "gpuTee",
    "runtimePolicy", "modelArtifact", "conversation", "request", "response", "payment",
  ] as const satisfies readonly AttestationClaimKey[]).map((key) => [key, {
    state: key === "evidenceStructure" ? "present" : key === "nonceFreshness" || key === "endpointKey" ? "matched" : "unavailable",
    title: `Claim ${key}`,
    summary: `Bounded summary for ${key}.`,
    checkedAt,
  }])) as ChutesEndpointEvidenceRecord["claims"];
  return Object.freeze({
    version: 1,
    recordId: `urn:airship:attestation:${recordIdDigest.slice("sha256:".length)}`,
    provider: "chutes",
    kind: "endpoint-evidence",
    verdict: "evidence-only",
    subject: {
      scope: "endpoint",
      chuteId: "chute-1",
      instanceId: INSTANCE_ID,
      e2ePublicKey,
      e2ePublicKeyDigest,
    },
    acquisition: {
      endpoint: "instance-evidence",
      requestUrl: "https://api.example.test/instances/instance-1/evidence",
      requestNonce: nonce,
      fetchedAt,
      cacheFreshUntil: new Date(Date.parse(fetchedAt) + 90_000).toISOString(),
      freshUntil: new Date(Date.parse(fetchedAt) + 90_000).toISOString(),
      authorization: "bearer",
      auth: "bearer",
      cache: "network",
    },
    evidence: {
      format: "chutes-tee-instance-evidence/v1",
      payloadDigest,
      quoteBytes: quoteBytes.byteLength,
      certificateBytes: certificateBytes.byteLength,
      gpuDeviceCount: gpuPayloads.length,
      quote: {
        format: "intel-tdx-quote-v4",
        base64: quoteBase64,
        byteLength: quoteBytes.byteLength,
        version: 4,
        attestationKeyType: 2,
        teeType: "0x81",
        signatureDataLength: 0,
        reportDataHex,
      },
      gpu: { reportedEvidenceCount: gpuPayloads.length, payloads: gpuPayloads },
      certificate: {
        format: "der",
        base64: certificateBase64,
        byteLength: certificateBytes.byteLength,
        binding: "not-established",
      },
    },
    binding: {
      construction: "SHA-256(UTF8(nonce + e2e_pubkey))",
      state: "matched",
      expectedDigestHex,
      quotedDigestHex: expectedDigestHex,
      reportDataHex,
    },
    claims,
    warnings: ["Complete raw evidence retained for independent verification."],
  } satisfies ChutesEndpointEvidenceRecord);
}
