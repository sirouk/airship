import { describe, expect, it } from "vitest";
import {
  LIVE_LOCAL_S3_ENVIRONMENT,
  LiveLocalVaultHarnessError,
  publicCleanupArtifacts,
  readLiveLocalS3Environment,
  runLiveLocalS3Probe,
  type LiveLocalS3Environment,
} from "./local-lab-live";

describe("live local S3 harness boundaries", () => {
  it("is disabled by default and reports only missing environment variable names", () => {
    expect(() => readLiveLocalS3Environment({})).toThrow("disabled");
    const environment = {
      [LIVE_LOCAL_S3_ENVIRONMENT.enabled]: "1",
      [LIVE_LOCAL_S3_ENVIRONMENT.accessKeyId]: "access-secret-canary",
    };
    const error = capture(() => readLiveLocalS3Environment(environment));
    expect(error).toBeInstanceOf(LiveLocalVaultHarnessError);
    expect(error.message).toContain("AIRSHIP_LOCAL_S3_ENDPOINT");
    expect(error.message).not.toContain("access-secret-canary");
  });

  it("reads every live target field from the provided environment without defaults", () => {
    expect(readLiveLocalS3Environment(completeEnvironment())).toEqual({
      endpoint: "http://127.0.0.1:9900",
      region: "auto",
      bucket: "secret-bucket-canary",
      namespace: "secret/namespace-canary",
      accessKeyId: "secret-access-canary",
      secretAccessKey: "secret-key-canary",
    });
  });

  it("emits a single redacted evidence envelope on provider failure", async () => {
    const lines: string[] = [];
    await expect(runLiveLocalS3Probe({
      environment: completeEnvironment(),
      writeEvidence: (line) => lines.push(line),
      now: () => new Date("2026-07-18T12:00:00.000Z"),
      fetchImplementation: async () => {
        throw new TypeError("transport secret-provider-canary");
      },
    })).rejects.toBeInstanceOf(LiveLocalVaultHarnessError);

    expect(lines).toHaveLength(1);
    const serialized = lines[0]!;
    const evidence = JSON.parse(serialized) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      version: 1,
      kind: "airship-local-s3-live-conformance",
      result: "degraded",
      target: { transport: "loopback-http" },
      execution: { client: "node-vitest", browserCors: "not-evaluated" },
      diagnostic: { code: "storage-unreachable", commitState: "unknown" },
    });
    for (const secret of [
      "127.0.0.1:9900",
      "secret-bucket-canary",
      "secret/namespace-canary",
      "secret-access-canary",
      "secret-key-canary",
      "secret-provider-canary",
    ]) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("createdKeys");
    expect(serialized).not.toContain("publicMessage");
  }, 15_000);

  it("reports the sweep the coordinator observed instead of a fixed no-deletion claim", () => {
    // A non-reclaiming provider (no `trash`, as with S3ObjectStore).
    expect(publicCleanupArtifacts(Object.freeze({
      deletionAvailableInRuntime: false,
      policy: "provider-lifecycle-or-out-of-band",
      warning: "Probe objects are immutable.",
    }))).toEqual({
      deletionAvailableInRuntime: false,
      cleanup: "provider-lifecycle-or-out-of-band",
    });

    // The same harness against a provider that did reclaim must not emit the
    // literal "no runtime deletion" claim the previous envelope hardcoded.
    expect(publicCleanupArtifacts(Object.freeze({
      deletionAvailableInRuntime: true,
      policy: "runtime-reclaimed",
      warning: "Probe objects were moved to the provider's trash.",
      reclaimedKeys: Object.freeze(["secret/namespace-canary/a", "secret/namespace-canary/b"]),
      retainedKeys: Object.freeze([]),
    }))).toEqual({
      deletionAvailableInRuntime: true,
      cleanup: "runtime-reclaimed",
      reclaimedObjectCount: 2,
      retainedObjectCount: 0,
    });
  });

  it("rejects non-loopback targets before credential or storage use", async () => {
    const environment = { ...completeEnvironment(), [LIVE_LOCAL_S3_ENVIRONMENT.endpoint]: "https://s3.example" };
    let writes = 0;
    await expect(runLiveLocalS3Probe({
      environment,
      writeEvidence: () => { writes += 1; },
    })).rejects.toThrow("loopback endpoint");
    expect(writes).toBe(0);
  });
});

const liveEnvironment = processEnvironment();
const liveEnabled = liveEnvironment[LIVE_LOCAL_S3_ENVIRONMENT.enabled] === "1";

describe.skipIf(!liveEnabled)("opt-in loopback S3 conformance", () => {
  it("verifies the configured disposable provider and emits only public evidence", async () => {
    const secretValues = [
      liveEnvironment[LIVE_LOCAL_S3_ENVIRONMENT.accessKeyId],
      liveEnvironment[LIVE_LOCAL_S3_ENVIRONMENT.secretAccessKey],
    ].filter((value): value is string => Boolean(value));
    let emitted = "";
    const evidence = await runLiveLocalS3Probe({
      environment: liveEnvironment,
      writeEvidence: (line) => {
        emitted = line;
        console.info(`[airship-live-vault] ${line}`);
      },
    });

    expect(evidence.result).toBe("verified");
    expect(evidence.readiness?.dataSynchronization).toBe("not-evaluated");
    // Derived from the coordinator's observed sweep rather than asserted by the
    // harness: an S3 store exposes no reclamation capability, so probe objects
    // stay resident and this run is what proves it.
    expect(evidence.artifacts.deletionAvailableInRuntime).toBe(false);
    expect(evidence.artifacts.cleanup).toBe("provider-lifecycle-or-out-of-band");
    for (const secret of secretValues) expect(emitted).not.toContain(secret);
  }, 120_000);
});

function completeEnvironment(): LiveLocalS3Environment {
  return {
    [LIVE_LOCAL_S3_ENVIRONMENT.enabled]: "1",
    [LIVE_LOCAL_S3_ENVIRONMENT.endpoint]: "http://127.0.0.1:9900",
    [LIVE_LOCAL_S3_ENVIRONMENT.region]: "auto",
    [LIVE_LOCAL_S3_ENVIRONMENT.bucket]: "secret-bucket-canary",
    [LIVE_LOCAL_S3_ENVIRONMENT.namespace]: "secret/namespace-canary",
    [LIVE_LOCAL_S3_ENVIRONMENT.accessKeyId]: "secret-access-canary",
    [LIVE_LOCAL_S3_ENVIRONMENT.secretAccessKey]: "secret-key-canary",
  };
}

function processEnvironment(): LiveLocalS3Environment {
  return (globalThis as typeof globalThis & {
    process?: { env?: LiveLocalS3Environment };
  }).process?.env ?? {};
}

function capture(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected operation to throw.");
}
