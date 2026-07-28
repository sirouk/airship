import { sha256 } from "../core/hash";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import type { VaultProbeEvidence, VaultSnapshot } from "./coordinator";
import { VaultCoordinator } from "./coordinator";
import { MemoryOnlyLocalLabCredentialProvider } from "./local-lab";

export const LIVE_LOCAL_S3_ENVIRONMENT = Object.freeze({
  enabled: "AIRSHIP_LIVE_LOCAL_S3",
  endpoint: "AIRSHIP_LOCAL_S3_ENDPOINT",
  region: "AIRSHIP_LOCAL_S3_REGION",
  bucket: "AIRSHIP_LOCAL_S3_BUCKET",
  namespace: "AIRSHIP_LOCAL_S3_NAMESPACE",
  accessKeyId: "AIRSHIP_LOCAL_S3_ACCESS_KEY",
  secretAccessKey: "AIRSHIP_LOCAL_S3_SECRET_KEY",
} as const);

export type LiveLocalS3Environment = Record<string, string | undefined>;

export type LiveLocalS3Configuration = Readonly<{
  endpoint: string;
  region: string;
  bucket: string;
  namespace: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

export type PublicLiveVaultEvidence = Readonly<{
  version: 1;
  kind: "airship-local-s3-live-conformance";
  result: "verified" | "degraded" | "failed";
  target: Readonly<{
    transport: "loopback-http" | "loopback-https";
    bucketFingerprint: string;
    namespaceFingerprint: string;
  }>;
  execution: Readonly<{
    client: "node-vitest";
    browserCors: "not-evaluated";
  }>;
  startedAt: string;
  completedAt: string;
  checks: readonly Readonly<{ name: string; durationMs: number }>[];
  readiness?: Readonly<{
    conditionalCreate: "verified";
    compareAndSwap: "verified";
    exactRange: "verified";
    prefixList: "verified";
    readAfterWrite: "verified";
    encryptedJournal: "verified";
    encryptedWorkspace: "verified";
    dataSynchronization: "not-evaluated";
  }>;
  artifacts: Readonly<{
    createdObjectCount?: number;
    inventory: "complete-key-list-withheld" | "unknown-after-failed-probe" | "none-observed";
    /**
     * Reported from the coordinator's observed sweep, never asserted. A literal
     * `false` here would misreport a provider that can in fact reclaim.
     */
    deletionAvailableInRuntime: boolean;
    cleanup: "provider-lifecycle-or-out-of-band" | "runtime-reclaimed";
    /** Counts only; probe keys are never serialized into public evidence. */
    reclaimedObjectCount?: number;
    retainedObjectCount?: number;
  }>;
  diagnostic?: Readonly<{
    code: string;
    retryable: boolean;
    commitState: "not-applicable" | "not-committed" | "unknown";
  }>;
}>;

export class LiveLocalVaultHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveLocalVaultHarnessError";
  }
}

/** Reads every target and credential value from the caller's process memory. */
export function readLiveLocalS3Environment(environment: LiveLocalS3Environment): LiveLocalS3Configuration {
  if (environment[LIVE_LOCAL_S3_ENVIRONMENT.enabled] !== "1") {
    throw new LiveLocalVaultHarnessError("Live local S3 probe is disabled; set AIRSHIP_LIVE_LOCAL_S3=1 explicitly.");
  }
  const missing: string[] = [];
  const required = <T extends keyof typeof LIVE_LOCAL_S3_ENVIRONMENT>(name: T): string => {
    const environmentName = LIVE_LOCAL_S3_ENVIRONMENT[name];
    const value = environment[environmentName];
    if (!value) missing.push(environmentName);
    return value ?? "";
  };
  const configuration: LiveLocalS3Configuration = {
    endpoint: required("endpoint"),
    region: required("region"),
    bucket: required("bucket"),
    namespace: required("namespace"),
    accessKeyId: required("accessKeyId"),
    secretAccessKey: required("secretAccessKey"),
  };
  if (missing.length > 0) {
    throw new LiveLocalVaultHarnessError(`Live local S3 probe is missing environment variables: ${missing.sort().join(", ")}.`);
  }
  return Object.freeze(configuration);
}

/**
 * Runs the destructive-in-the-small probe and writes exactly one redacted JSON
 * evidence line. It never serializes configuration, keys, or created object IDs.
 */
export async function runLiveLocalS3Probe(args: {
  environment: LiveLocalS3Environment;
  writeEvidence(line: string): void;
  now?: () => Date;
  /** Deterministic test seam; the npm live harness always uses global fetch. */
  fetchImplementation?: typeof fetch;
}): Promise<PublicLiveVaultEvidence> {
  const configuration = readLiveLocalS3Environment(args.environment);
  const target = await publicTarget(configuration);
  const now = args.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const coordinator = new VaultCoordinator();
  const { key, recoveryBytes } = await WorkspaceRootKey.generate();
  let snapshot: VaultSnapshot | undefined;
  try {
    const credentialProvider = new MemoryOnlyLocalLabCredentialProvider(
      configuration.accessKeyId,
      configuration.secretAccessKey,
    );
    coordinator.configure({
      configuration: {
        mode: "local-development",
        endpoint: configuration.endpoint,
        region: configuration.region,
        bucket: configuration.bucket,
        namespace: configuration.namespace,
        forcePathStyle: true,
        credentialSource: {
          kind: "local-development",
          displayName: "Opt-in ephemeral live S3 harness",
          authorityOrigins: [],
        },
      },
      credentialProvider,
      workspaceKey: key,
      now,
      fetchImplementation: args.fetchImplementation,
    });
    snapshot = await coordinator.probe({ acknowledgeImmutableProbeObjects: true });
    const evidence = await publicEvidence({ snapshot, target, startedAt, completedAt: now().toISOString() });
    args.writeEvidence(JSON.stringify(evidence));
    if (evidence.result !== "verified") {
      throw new LiveLocalVaultHarnessError("Live local S3 provider did not establish the required vault contract; inspect redacted evidence.");
    }
    return evidence;
  } catch (error) {
    if (error instanceof LiveLocalVaultHarnessError) throw error;
    const evidence = await publicEvidence({ snapshot, target, startedAt, completedAt: now().toISOString() });
    args.writeEvidence(JSON.stringify(evidence));
    throw new LiveLocalVaultHarnessError("Live local S3 probe failed before verified readiness; only redacted evidence was emitted.");
  } finally {
    recoveryBytes.fill(0);
    coordinator.disconnect();
  }
}

async function publicTarget(configuration: LiveLocalS3Configuration): Promise<PublicLiveVaultEvidence["target"]> {
  let url: URL;
  try {
    url = new URL(configuration.endpoint);
  } catch {
    throw new LiveLocalVaultHarnessError("Live local S3 endpoint is not a valid URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new LiveLocalVaultHarnessError("Live local S3 harness accepts only an HTTP(S) loopback endpoint.");
  }
  return Object.freeze({
    transport: url.protocol === "https:" ? "loopback-https" : "loopback-http",
    bucketFingerprint: await sha256(`airship/live-s3-target/v1\0${configuration.bucket}`),
    namespaceFingerprint: await sha256(`airship/live-s3-namespace/v1\0${configuration.namespace}`),
  });
}

async function publicEvidence(args: {
  snapshot: VaultSnapshot | undefined;
  target: PublicLiveVaultEvidence["target"];
  startedAt: string;
  completedAt: string;
}): Promise<PublicLiveVaultEvidence> {
  const snapshot = args.snapshot;
  if (snapshot?.phase === "ready") {
    return Object.freeze({
      version: 1,
      kind: "airship-local-s3-live-conformance",
      result: "verified",
      target: args.target,
      execution: LIVE_EXECUTION_POSTURE,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      checks: Object.freeze(snapshot.evidence.checks.map((check) => Object.freeze({
        name: check.name,
        durationMs: roundedDuration(check.durationMs),
      }))),
      readiness: snapshot.evidence.readiness,
      artifacts: Object.freeze({
        createdObjectCount: snapshot.evidence.createdKeys.length,
        inventory: "complete-key-list-withheld",
        ...publicCleanupArtifacts(snapshot.evidence.cleanup),
      }),
    });
  }
  if (snapshot?.phase === "degraded") {
    return Object.freeze({
      version: 1,
      kind: "airship-local-s3-live-conformance",
      result: "degraded",
      target: args.target,
      execution: LIVE_EXECUTION_POSTURE,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      checks: Object.freeze([]),
      artifacts: Object.freeze({
        inventory: snapshot.probeResidue ? "unknown-after-failed-probe" : "none-observed",
        // No probe completed, so no sweep was observed: the conservative claim
        // is the only honest one here.
        ...NO_OBSERVED_RECLAMATION,
      }),
      diagnostic: Object.freeze({
        code: snapshot.diagnostic.code,
        retryable: snapshot.diagnostic.retryable,
        commitState: snapshot.diagnostic.commitState,
      }),
    });
  }
  return Object.freeze({
    version: 1,
    kind: "airship-local-s3-live-conformance",
    result: "failed",
    target: args.target,
    execution: LIVE_EXECUTION_POSTURE,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    checks: Object.freeze([]),
    artifacts: Object.freeze({
      inventory: "none-observed",
      ...NO_OBSERVED_RECLAMATION,
    }),
    diagnostic: Object.freeze({
      code: "harness-failed",
      retryable: false,
      commitState: "not-applicable",
    }),
  });
}

/** The only claim a run without a completed probe can make about reclamation. */
const NO_OBSERVED_RECLAMATION = Object.freeze({
  deletionAvailableInRuntime: false,
  cleanup: "provider-lifecycle-or-out-of-band",
} as const);

/**
 * Projects the coordinator's observed probe sweep onto the public envelope.
 *
 * This is a projection, not an assertion: whether the provider could delete at
 * runtime is whatever `VaultCoordinator` actually observed while reclaiming, so
 * a run against a reclaiming provider reports `runtime-reclaimed` instead of
 * silently emitting a stale "no runtime deletion" claim. Only counts cross the
 * boundary; probe keys never do.
 */
export function publicCleanupArtifacts(
  cleanup: VaultProbeEvidence["cleanup"],
): Readonly<{
  deletionAvailableInRuntime: boolean;
  cleanup: PublicLiveVaultEvidence["artifacts"]["cleanup"];
  reclaimedObjectCount?: number;
  retainedObjectCount?: number;
}> {
  return Object.freeze({
    deletionAvailableInRuntime: cleanup.deletionAvailableInRuntime,
    cleanup: cleanup.policy,
    ...(cleanup.reclaimedKeys ? { reclaimedObjectCount: cleanup.reclaimedKeys.length } : {}),
    ...(cleanup.retainedKeys ? { retainedObjectCount: cleanup.retainedKeys.length } : {}),
  });
}

function roundedDuration(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.max(0, value) * 1_000) / 1_000 : 0;
}

const LIVE_EXECUTION_POSTURE = Object.freeze({
  client: "node-vitest",
  browserCors: "not-evaluated",
} as const);
