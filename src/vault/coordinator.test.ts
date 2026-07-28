import { describe, expect, it, vi } from "vitest";
import { ownedArrayBuffer } from "../core/bytes";
import { CognitoIdentityError } from "../storage/cognito-identity-credentials";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store";
import type { ObjectReclamationReceipt, ReclaimableObjectStore } from "../storage/object-store";
import type { S3TemporaryCredentials } from "../storage/s3-object-store";
import { VaultCoordinator, type ResettableVaultCredentialProvider } from "./coordinator";
import { createBuiltInProfileCatalog } from "../profiles/catalog";
import type { VaultS3ConfigurationInput } from "./config";

const startedAt = Date.parse("2026-07-18T12:00:00.000Z");
const temporaryCredentials: S3TemporaryCredentials = {
  accessKeyId: "temporary-access",
  secretAccessKey: "temporary-secret",
  sessionToken: "temporary-session",
  expiration: "2026-07-18T13:00:00.000Z",
};

describe("VaultCoordinator", () => {
  it("separates validated configuration from readiness and never exposes credential material", async () => {
    const coordinator = new VaultCoordinator();
    const provider = memoryOnlyProvider();
    const snapshot = coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: provider,
      now: () => new Date(startedAt),
    });

    expect(snapshot).toMatchObject({ phase: "configured", workspaceKey: "missing" });
    if (snapshot.phase === "disconnected") throw new Error("expected configured snapshot");
    expect(snapshot.requirements.credentialContract).toMatchObject({
      persistence: "memory-only",
      productionRequiresExpiration: true,
      productionRequiresSessionToken: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("temporary-secret");
    expect(() => coordinator.readyRuntime()).toThrow("unavailable");

    const degraded = await coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "missingkey001",
    });
    expect(degraded).toMatchObject({
      phase: "degraded",
      diagnostic: { code: "workspace-key-missing", operation: "encryption" },
    });
    expect(provider.getCredentials).not.toHaveBeenCalled();
  });

  it("reaches ready only after live S3 and encrypted journal/workspace checks", async () => {
    const emulator = new S3Emulator();
    const { key } = await WorkspaceRootKey.generate();
    const coordinator = new VaultCoordinator();
    const phases: string[] = [];
    coordinator.subscribe((snapshot) => phases.push(snapshot.phase));
    coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: memoryOnlyProvider(),
      workspaceKey: key,
      fetchImplementation: emulator.fetch,
      now: () => new Date(startedAt),
    });

    const snapshot = await coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "verifiedrun001",
    });

    expect(snapshot.phase).toBe("ready");
    if (snapshot.phase !== "ready") throw new Error("expected ready snapshot");
    expect(snapshot.evidence.readiness).toEqual({
      conditionalCreate: "verified",
      compareAndSwap: "verified",
      exactRange: "verified",
      prefixList: "verified",
      readAfterWrite: "verified",
      encryptedJournal: "verified",
      encryptedWorkspace: "verified",
      dataSynchronization: "not-evaluated",
    });
    expect(snapshot.message).toContain("synchronization has not been evaluated");
    expect(snapshot.evidence.createdKeys.length).toBeGreaterThan(8);
    expect(snapshot.evidence.cleanup).toMatchObject({
      deletionAvailableInRuntime: false,
      policy: "provider-lifecycle-or-out-of-band",
    });
    expect(snapshot.evidence.checks.map((check) => check.name)).toContain("encrypted workspace write/read/list/remove");
    expect(phases).toEqual(["disconnected", "configured", "probing", "ready"]);

    const runtime = coordinator.readyRuntime();
    expect(runtime.acceleration).toMatchObject({
      active: true,
      backend: "memory",
      persistenceBoundary: "ciphertext-only",
      authority: "vault-provider-remains-authoritative",
    });
    const file = await runtime.workspace.write("real.txt", "actual private state", { expectedRevision: null });
    expect(await runtime.workspace.read("real.txt")).toEqual(file);
    const profiles = await runtime.profiles.initialize(await createBuiltInProfileCatalog());
    expect(profiles).toMatchObject({ disposition: "created", checkpoint: { generation: 1 } });
    expect(emulator.serializedBytes()).not.toContain("actual private state");
    expect(emulator.serializedBytes()).not.toContain("Evidence first");
  }, 15_000);

  it("adopts a Google Drive ObjectStore only after the same strict encrypted composition probe", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const reset = vi.fn();
    const reauthorize = vi.fn(async () => undefined);
    const coordinator = new VaultCoordinator();
    const snapshot = coordinator.configureGoogleDrive({
      workspace: {
        workspaceFolderId: "drive_workspace_123",
        workspaceName: "Airship Workspace",
        rootFolderId: "drive_root_123",
        segmentsFolderId: "drive_segments_123",
        namespaceId: "opaque-drive-namespace",
        webViewLink: "https://drive.google.com/drive/folders/drive_workspace_123",
      },
      store: new MemoryObjectStore(),
      workspaceKey: key,
      accountLabel: "operator@example.test",
      reauthorize,
      reset,
      now: () => new Date(startedAt),
    });
    expect(snapshot).toMatchObject({
      phase: "configured",
      config: { provider: "google-drive", workspaceName: "Airship Workspace" },
      requirements: { credentialContract: { productionRequiresSessionToken: false, persistence: "memory-only" } },
    });
    // The store handed in here cannot reclaim, so the declaration must not
    // promise a runtime sweep just because the provider is Drive.
    expect(snapshot).toMatchObject({
      requirements: {
        probeLifecycle: {
          deletionAvailableInRuntime: false,
          cleanup: "provider-lifecycle-or-out-of-band",
        },
      },
    });

    const ready = await coordinator.probe({ acknowledgeImmutableProbeObjects: true, nonce: "driveprobe001" });
    expect(ready).toMatchObject({ phase: "ready", config: { provider: "google-drive" } });
    const adoptedRuntime = coordinator.readyRuntime();
    const written = await adoptedRuntime.workspace.write("drive.txt", "encrypted composition", { expectedRevision: null });
    expect((await adoptedRuntime.workspace.read("drive.txt"))?.revision).toBe(written.revision);
    await coordinator.reauthorizeGoogleDrive();
    expect(reauthorize).toHaveBeenCalledOnce();
    const reprobe = coordinator.probe({ acknowledgeImmutableProbeObjects: true, nonce: "driveprobe002" });
    expect(coordinator.snapshot.phase).toBe("probing");
    expect(() => coordinator.readyRuntime()).toThrow("unavailable");
    expect((await adoptedRuntime.workspace.read("drive.txt"))?.content).toBe("encrypted composition");
    await expect(reprobe).resolves.toMatchObject({ phase: "ready", evidence: { runId: "driveprobe002" } });
    expect(coordinator.readyRuntime()).toBe(adoptedRuntime);
    const afterReprobe = await adoptedRuntime.workspace.write("after-reprobe.txt", "still operable", { expectedRevision: null });
    expect((await adoptedRuntime.workspace.read("after-reprobe.txt"))?.revision).toBe(afterReprobe.revision);
    coordinator.disconnect();
    expect(reset).toHaveBeenCalledOnce();
    await expect(coordinator.reauthorizeGoogleDrive()).rejects.toThrow("not the configured");
  });

  it("reclaims probe litter when the provider can, and never claims an unconfirmed removal", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new ReclaimingMemoryObjectStore();
    const coordinator = new VaultCoordinator();
    const configured = coordinator.configureGoogleDrive({
      workspace: {
        workspaceFolderId: "drive_workspace_reclaim",
        workspaceName: "Airship Reclaim",
        rootFolderId: "drive_root_reclaim",
        segmentsFolderId: "drive_segments_reclaim",
        namespaceId: "opaque-drive-reclaim",
      },
      store,
      workspaceKey: key,
      accountLabel: "operator@example.test",
      now: () => new Date(startedAt),
    });
    // This store does reclaim, so the static declaration says so before any
    // probe runs — and still keeps the out-of-band path for keys a sweep
    // cannot confirm, which the second probe below actually produces.
    expect(configured).toMatchObject({
      requirements: {
        probeLifecycle: {
          deletionAvailableInRuntime: true,
          cleanup: "runtime-reclaimed-then-out-of-band",
        },
      },
    });

    const snapshot = await coordinator.probe({ acknowledgeImmutableProbeObjects: true, nonce: "drivesweep001" });
    if (snapshot.phase !== "ready") throw new Error("expected ready snapshot");
    expect(snapshot.evidence.cleanup).toMatchObject({
      deletionAvailableInRuntime: true,
      policy: "runtime-reclaimed",
    });
    expect(snapshot.evidence.cleanup.retainedKeys).toEqual([]);
    expect(snapshot.evidence.cleanup.reclaimedKeys).toEqual([...snapshot.evidence.createdKeys].sort());
    for (const probeKey of snapshot.evidence.createdKeys) expect(await store.get(probeKey)).toBeUndefined();
    // A verified probe must stay verified even after the sweep runs.
    expect(snapshot.evidence.readiness.compareAndSwap).toBe("verified");

    // A provider that refuses one key must keep the original warning verbatim.
    store.refuseKeysContaining = "-adjacent/";
    const second = await coordinator.probe({ acknowledgeImmutableProbeObjects: true, nonce: "drivesweep002" });
    if (second.phase !== "ready") throw new Error("expected ready snapshot");
    expect(second.evidence.cleanup.policy).toBe("provider-lifecycle-or-out-of-band");
    expect(second.evidence.cleanup.retainedKeys?.length).toBeGreaterThan(0);
    expect(second.evidence.cleanup.warning).toContain("remove the listed keys out-of-band");
  });

  it("fails a same-authority re-probe closed without invalidating the adopted runtime", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const coordinator = new VaultCoordinator();
    coordinator.configureGoogleDrive({
      workspace: {
        workspaceFolderId: "drive_workspace_fail_closed",
        workspaceName: "Airship Fail Closed",
        rootFolderId: "drive_root_fail_closed",
        segmentsFolderId: "drive_segments_fail_closed",
        namespaceId: "opaque-drive-fail-closed",
      },
      store,
      workspaceKey: key,
      accountLabel: "operator@example.test",
      now: () => new Date(startedAt),
    });
    await expect(coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "drivegood001",
    })).resolves.toMatchObject({ phase: "ready" });
    const adoptedRuntime = coordinator.readyRuntime();
    await adoptedRuntime.workspace.write("survives.txt", "retained ciphertext path", { expectedRevision: null });

    const authoritativePut = store.putIfAbsent.bind(store);
    vi.spyOn(store, "putIfAbsent").mockImplementation((objectKey, bytes) => {
      if (objectKey.startsWith(".airship-probes/v1/drivefailed001/")) {
        throw new TypeError("simulated provider outage");
      }
      return authoritativePut(objectKey, bytes);
    });
    const degraded = await coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "drivefailed001",
    });

    expect(degraded).toMatchObject({
      phase: "degraded",
      diagnostic: { code: "conformance-failed" },
      previousEvidence: { runId: "drivegood001" },
    });
    expect(() => coordinator.readyRuntime()).toThrow("unavailable");
    expect((await adoptedRuntime.workspace.read("survives.txt"))?.content).toBe("retained ciphertext path");
    expect(coordinator.disconnect()).toMatchObject({ phase: "disconnected" });
  });

  it("validates a replacement Google Drive authority before releasing the ready runtime", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const reset = vi.fn();
    const coordinator = new VaultCoordinator();
    coordinator.configureGoogleDrive({
      workspace: {
        workspaceFolderId: "drive_workspace_atomic",
        workspaceName: "Mounted workspace",
        rootFolderId: "drive_root_atomic",
        segmentsFolderId: "drive_segments_atomic",
        namespaceId: "opaque-drive-atomic-authority",
      },
      store: new MemoryObjectStore(),
      workspaceKey: key,
      accountLabel: "operator@example.test",
      reset,
      now: () => new Date(startedAt),
    });
    await expect(coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "driveatomic001",
    })).resolves.toMatchObject({ phase: "ready" });
    const runtime = coordinator.readyRuntime();
    const before = coordinator.snapshot;

    expect(() => coordinator.configureGoogleDrive({
      workspace: {
        workspaceFolderId: "drive_workspace_replacement",
        workspaceName: "Invalid replacement",
        // Reusing one ID for two folder roles must fail before any authority
        // cleanup or readiness transition occurs.
        rootFolderId: "drive_same_folder",
        segmentsFolderId: "drive_same_folder",
        namespaceId: "opaque-drive-replacement",
      },
      store: new MemoryObjectStore(),
      workspaceKey: key,
      accountLabel: "replacement@example.test",
    })).toThrow("distinct folders");

    expect(coordinator.snapshot).toBe(before);
    expect(coordinator.readyRuntime()).toBe(runtime);
    expect(reset).not.toHaveBeenCalled();
    const written = await runtime.workspace.write("still-mounted.txt", "authority survived", { expectedRevision: null });
    expect((await runtime.workspace.read("still-mounted.txt"))?.revision).toBe(written.revision);
  });

  it("returns a typed redacted degraded state when the credential authority denies access", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const provider: ResettableVaultCredentialProvider = {
      async getCredentials() {
        throw new CognitoIdentityError(
          "raw provider secret csc_should-never-escape",
          "NotAuthorizedException",
          false,
          "safe-request-123",
        );
      },
    };
    const coordinator = new VaultCoordinator();
    coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: provider,
      workspaceKey: key,
      fetchImplementation: new S3Emulator().fetch,
      now: () => new Date(startedAt),
    });

    const snapshot = await coordinator.probe({ acknowledgeImmutableProbeObjects: true, nonce: "deniedrun001" });

    expect(snapshot).toMatchObject({
      phase: "degraded",
      diagnostic: {
        code: "credential-denied",
        operation: "credentials",
        retryable: false,
        requestId: "safe-request-123",
      },
      probeResidue: {
        logicalPrefix: ".airship-probes/v1/deniedrun001",
        inventory: "unknown-after-failed-probe",
        deletionAvailableInRuntime: false,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("csc_should-never-escape");
    expect(() => coordinator.readyRuntime()).toThrow("unavailable");
  });

  it("cancels and supersedes an in-flight probe without allowing stale state to win", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const reset = vi.fn();
    const blockedProvider: ResettableVaultCredentialProvider = {
      reset,
      async getCredentials(signal) {
        return new Promise<S3TemporaryCredentials>((_resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    };
    const coordinator = new VaultCoordinator();
    coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: blockedProvider,
      workspaceKey: key,
      fetchImplementation: new S3Emulator().fetch,
      now: () => new Date(startedAt),
    });
    const stale = coordinator.probe({ acknowledgeImmutableProbeObjects: true, nonce: "superseded001" });
    expect(coordinator.snapshot.phase).toBe("probing");

    coordinator.configure({
      configuration: { ...productionConfig(), namespace: "airship/v1/subject:new" },
      credentialProvider: memoryOnlyProvider(),
      workspaceKey: key,
      fetchImplementation: new S3Emulator().fetch,
      now: () => new Date(startedAt),
    });

    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.snapshot).toMatchObject({
      phase: "configured",
      config: { namespace: "airship/v1/subject:new" },
    });
    expect(reset).toHaveBeenCalledOnce();
  });

  it("drops credential/key/runtime references and calls provider reset on disconnect", async () => {
    const emulator = new S3Emulator();
    const { key } = await WorkspaceRootKey.generate();
    const provider = memoryOnlyProvider();
    const coordinator = new VaultCoordinator();
    coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: provider,
      workspaceKey: key,
      fetchImplementation: emulator.fetch,
      now: () => new Date(startedAt),
    });
    await coordinator.probe({ acknowledgeImmutableProbeObjects: true, nonce: "resetprobe001" });

    expect(coordinator.disconnect()).toMatchObject({ phase: "disconnected" });
    expect(provider.reset).toHaveBeenCalledOnce();
    expect(() => coordinator.readyRuntime()).toThrow("unavailable");
  });

  it("requires explicit immutable-probe acknowledgement before making any provider request", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const provider = memoryOnlyProvider();
    const coordinator = new VaultCoordinator();
    coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: provider,
      workspaceKey: key,
      now: () => new Date(startedAt),
    });

    await expect(coordinator.probe({ acknowledgeImmutableProbeObjects: false } as never)).rejects.toThrow("acknowledgement");
    expect(provider.getCredentials).not.toHaveBeenCalled();
    expect(coordinator.snapshot.phase).toBe("configured");
  });

  it("runs against an explicitly loopback S3-compatible lab with development credentials", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const coordinator = new VaultCoordinator();
    coordinator.configure({
      configuration: {
        mode: "local-development",
        endpoint: "http://127.0.0.1:9000",
        region: "auto",
        bucket: "airship-dev",
        namespace: "users/local",
        credentialSource: {
          kind: "local-development",
          displayName: "Local S3 lab",
          authorityOrigins: [],
        },
      },
      credentialProvider: {
        async getCredentials() {
          return { accessKeyId: "development-access", secretAccessKey: "development-secret" };
        },
      },
      workspaceKey: key,
      fetchImplementation: new S3Emulator().fetch,
      now: () => new Date(startedAt),
    });

    await expect(coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "localprobe001",
    })).resolves.toMatchObject({ phase: "ready", config: { mode: "local-development" } });
  });

  it("refuses a permanent credential shape at a production vault before network dispatch", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const emulator = new S3Emulator();
    const coordinator = new VaultCoordinator();
    coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: {
        async getCredentials() {
          return { accessKeyId: "permanent-access", secretAccessKey: "permanent-secret" };
        },
      },
      workspaceKey: key,
      fetchImplementation: emulator.fetch,
      now: () => new Date(startedAt),
    });

    await expect(coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "permanent001",
    })).resolves.toMatchObject({
      phase: "degraded",
      diagnostic: { code: "credential-denied", operation: "credentials" },
    });
    expect(emulator.fetch).not.toHaveBeenCalled();
  });

  it("preserves ambiguous write outcome in a redacted degraded diagnostic", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const coordinator = new VaultCoordinator();
    coordinator.configure({
      configuration: productionConfig(),
      credentialProvider: memoryOnlyProvider(),
      workspaceKey: key,
      fetchImplementation: async () => {
        throw new TypeError("network failed with private-provider-detail");
      },
      now: () => new Date(startedAt),
    });

    const snapshot = await coordinator.probe({
      acknowledgeImmutableProbeObjects: true,
      nonce: "ambiguous001",
    });
    expect(snapshot).toMatchObject({
      phase: "degraded",
      diagnostic: {
        code: "storage-unreachable",
        operation: "storage",
        retryable: true,
        commitState: "unknown",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-provider-detail");
  });
});

/** Models a provider (like Drive) that exposes the optional reclamation capability. */
class ReclaimingMemoryObjectStore extends MemoryObjectStore implements ReclaimableObjectStore {
  private readonly trashed = new Set<string>();
  refuseKeysContaining?: string;

  override async get(key: string) {
    return this.trashed.has(key) ? undefined : super.get(key);
  }

  override async list(prefix: string) {
    return (await super.list(prefix)).filter((entry) => !this.trashed.has(entry.key));
  }

  async trash(keys: readonly string[]): Promise<ObjectReclamationReceipt> {
    const outcomes = keys.map((key) => {
      if (this.refuseKeysContaining && key.includes(this.refuseKeysContaining)) {
        return Object.freeze({ key, reclaimed: false as const, reason: "refused" as const });
      }
      this.trashed.add(key);
      return Object.freeze({ key, reclaimed: true as const });
    });
    return Object.freeze({
      requested: keys.length,
      reclaimed: Object.freeze(outcomes.filter((outcome) => outcome.reclaimed).map((outcome) => outcome.key)),
      retained: Object.freeze(outcomes.filter((outcome) => !outcome.reclaimed).map((outcome) => outcome.key)),
      outcomes: Object.freeze(outcomes),
    });
  }
}

function productionConfig(): VaultS3ConfigurationInput {
  return {
    mode: "strict-production",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "airship-private",
    namespace: "airship/v1/subject:abc",
    forcePathStyle: false,
    credentialSource: {
      kind: "cognito-identity",
      displayName: "Cognito Identity",
      authorityOrigins: ["https://cognito-identity.us-east-1.amazonaws.com"],
    },
  };
}

function memoryOnlyProvider(): ResettableVaultCredentialProvider & {
  getCredentials: ReturnType<typeof vi.fn<() => Promise<S3TemporaryCredentials>>>;
  reset: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    getCredentials: vi.fn(async () => ({ ...temporaryCredentials })),
    reset: vi.fn(),
  };
}

class S3Emulator {
  private readonly objects = new Map<string, { bytes: Uint8Array; etag: string; updatedAt: string }>();
  private etag = 0;

  readonly fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `<Contents><Key>${xml(key)}</Key><LastModified>${value.updatedAt}</LastModified><ETag>&quot;${value.etag}&quot;</ETag><Size>${value.bytes.byteLength}</Size></Contents>`)
        .join("");
      return new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }

    const rawKey = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const key = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
      ? rawKey.split("/").slice(1).join("/")
      : rawKey;
    if (method === "PUT") {
      const current = this.objects.get(key);
      if (headers.get("if-none-match") === "*" && current) return new Response(null, { status: 412 });
      const expected = headers.get("if-match")?.replace(/^"|"$/gu, "");
      if (expected && !current) return new Response(null, { status: 404 });
      if (expected && current?.etag !== expected) return new Response(null, { status: 412 });
      const bytes = new Uint8Array(init?.body as ArrayBuffer);
      const etag = `etag-${++this.etag}`;
      this.objects.set(key, { bytes: bytes.slice(), etag, updatedAt: "2026-07-18T12:00:00.000Z" });
      return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
    }
    if (method !== "GET") return new Response(null, { status: 405 });
    const current = this.objects.get(key);
    if (!current) return new Response(null, { status: 404 });
    const range = headers.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1]);
      const end = Number(match[2]);
      const bytes = current.bytes.slice(start, end + 1);
      return new Response(ownedArrayBuffer(bytes), {
        status: 206,
        headers: {
          ETag: `"${current.etag}"`,
          "Content-Length": String(bytes.byteLength),
          "Content-Range": `bytes ${start}-${end}/${current.bytes.byteLength}`,
          "Last-Modified": current.updatedAt,
        },
      });
    }
    return new Response(ownedArrayBuffer(current.bytes), {
      status: 200,
      headers: {
        ETag: `"${current.etag}"`,
        "Content-Length": String(current.bytes.byteLength),
        "Last-Modified": current.updatedAt,
      },
    });
  });

  serializedBytes(): string {
    return [...this.objects.values()].map((value) => new TextDecoder().decode(value.bytes)).join("\n");
  }
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
