import {
  getBrowserCapabilityRegistry,
  type BrowserCapabilityObservation,
  type BrowserRuntimeCapabilityReport,
} from "../capabilities/browser-runtime";
import type {
  LiveEnvironmentCaptureRequest,
  LiveEnvironmentEntry,
  LiveEnvironmentObservation,
  LiveEnvironmentProvider,
  LiveWorkspaceIndexObservation,
} from "../core/live-environment";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import { getClientExecutionRuntime } from "./execution-tools";
import type { ExecutionCapability } from "../execution/runtime-registry";

export type LiveEnvironmentSupplement = Readonly<{
  providers?: readonly LiveEnvironmentEntry[];
  storage?: readonly LiveEnvironmentEntry[];
  extension?: readonly LiveEnvironmentEntry[];
  limitations?: readonly string[];
}>;

/** Credential-free App seam for authorities the standard tool bundle does not own. */
export type LiveEnvironmentSupplementSource = (
  request: LiveEnvironmentCaptureRequest,
) => LiveEnvironmentSupplement | Promise<LiveEnvironmentSupplement>;

type LiveEnvironmentContextRuntime = Pick<ClientContextRuntime, "refreshNow" | "getState">;

export function createToolLiveEnvironmentProvider(options: Readonly<{
  contextRuntime: LiveEnvironmentContextRuntime;
  supplement?: LiveEnvironmentSupplementSource;
  /** Hermetic test seam; production always uses the lifecycle-aware registry. */
  browser?: () => Promise<BrowserRuntimeCapabilityReport>;
  /** Hermetic test seam; production always reads the active execution runtime. */
  execution?: () => readonly ExecutionCapability[];
  now?: () => Date;
}>): LiveEnvironmentProvider {
  return Object.freeze({
    async capture(request: LiveEnvironmentCaptureRequest): Promise<LiveEnvironmentObservation> {
      request.signal.throwIfAborted();
      // A turn snapshot is an authority statement, not a UI optimization.
      // Force a new generation rather than restamping the registry's 30s UI
      // cache with this turn's `capturedAt`.
      const browserPromise = options.browser?.() ?? getBrowserCapabilityRegistry().refresh(true);
      const indexPromise = observeWorkspaceIndex(options.contextRuntime, request.signal);
      const supplementPromise = captureSupplement(options.supplement, request);
      const [browserResult, workspaceIndex, supplementResult] = await Promise.all([
        browserPromise.then(
          (report) => ({ report } as const),
          (error) => ({ error } as const),
        ),
        indexPromise,
        supplementPromise,
      ]);
      request.signal.throwIfAborted();

      const limitations = [...supplementResult.limitations];
      const browser = "report" in browserResult
        ? browserEntries(browserResult.report)
        : [failedEntry(
            "browser-probe",
            "Browser capability probe",
            `The live browser capability probe failed: ${errorMessage(browserResult.error)}`,
          )];
      if (!("report" in browserResult)) {
        limitations.push("Browser capability state could not be refreshed for this turn; no accelerator readiness should be inferred.");
      }
      if (workspaceIndex.state === "failed") {
        limitations.push("The workspace index could not be refreshed for this turn; selected context may fail separately.");
      }
      return Object.freeze({
        capturedAt: (options.now?.() ?? new Date()).toISOString(),
        browser: Object.freeze(browser),
        execution: executionEntries(options.execution?.()),
        providers: supplementResult.providers,
        storage: supplementResult.storage,
        extension: supplementResult.extension,
        workspaceIndex,
        limitations: Object.freeze([...new Set(limitations)]),
      });
    },
  });
}

async function captureSupplement(
  source: LiveEnvironmentSupplementSource | undefined,
  request: LiveEnvironmentCaptureRequest,
): Promise<Required<LiveEnvironmentSupplement>> {
  if (!source) {
    return Object.freeze({
      providers: Object.freeze([notObservedEntry(
        "provider-directory",
        "Inference provider directory",
        "No live provider-directory source is attached. The pinned provider and model remain authoritative for this session.",
      )]),
      storage: Object.freeze([notObservedEntry(
        "storage-authority",
        "Durability authority",
        "No live storage-authority source is attached. Do not infer page, Local Device, Drive, or S3 adoption from the session pin.",
      )]),
      extension: Object.freeze([notObservedEntry(
        "extension-bridge",
        "Browser extension",
        "No live extension source is attached. Extension relay, storage, and compute readiness were not observed for this turn.",
      )]),
      limitations: Object.freeze([
        "Provider, storage, and extension state are not yet wired into the live environment source.",
      ]),
    });
  }
  try {
    const supplement = await source(request);
    request.signal.throwIfAborted();
    const unobserved: string[] = [];
    if (supplement.providers === undefined) unobserved.push("provider directory");
    if (supplement.storage === undefined) unobserved.push("storage authority");
    if (supplement.extension === undefined) unobserved.push("extension bridge");
    return Object.freeze({
      providers: Object.freeze(supplement.providers === undefined
        ? [notObservedEntry("provider-directory", "Inference provider directory", "The App source did not observe provider-directory state for this turn.")]
        : [...supplement.providers]),
      storage: Object.freeze(supplement.storage === undefined
        ? [notObservedEntry("storage-authority", "Durability authority", "The App source did not observe storage-authority state for this turn.")]
        : [...supplement.storage]),
      extension: Object.freeze(supplement.extension === undefined
        ? [notObservedEntry("extension-bridge", "Browser extension", "The App source did not observe extension-bridge state for this turn.")]
        : [...supplement.extension]),
      limitations: Object.freeze([
        ...(supplement.limitations ?? []),
        ...(unobserved.length ? [`The App source did not observe ${unobserved.join(", ")} state for this turn.`] : []),
      ]),
    });
  } catch (error) {
    request.signal.throwIfAborted();
    const detail = `The application live-authority source failed: ${errorMessage(error)}`;
    return Object.freeze({
      providers: Object.freeze([failedEntry("provider-directory", "Inference provider directory", detail)]),
      storage: Object.freeze([failedEntry("storage-authority", "Durability authority", detail)]),
      extension: Object.freeze([failedEntry("extension-bridge", "Browser extension", detail)]),
      limitations: Object.freeze([
        "Provider, storage, and extension state could not be observed for this turn; only pinned inference identity and core browser/runtime observations are reliable.",
      ]),
    });
  }
}

function browserEntries(report: BrowserRuntimeCapabilityReport): LiveEnvironmentEntry[] {
  const observedAt = `observed-at=${report.observedAt}`;
  const entries = [
    browserEntry("webgpu", "WebGPU", report.webgpu, [
      observedAt,
      `power=${report.webgpu.powerPreference}`,
      ...report.webgpu.features.slice(0, 12).map((feature) => `feature=${feature}`),
    ]),
    browserEntry("webnn", "WebNN", report.webnn, [observedAt]),
    browserEntry("wasm", "WebAssembly", report.wasm, [
      observedAt,
      ...Object.entries(report.wasm.features)
        .filter(([, available]) => available)
        .map(([feature]) => `feature=${feature}`),
      `shared-array-buffer=${String(report.wasm.sharedArrayBuffer)}`,
    ]),
    browserEntry("opfs", "Origin-private filesystem", report.opfs, [
      observedAt,
      `sync-access-handle=${report.opfs.syncAccessHandle}`,
    ]),
    browserEntry("service-worker", "Service Worker", report.serviceWorker, [observedAt]),
    browserEntry("cache-storage", "Cache Storage", report.cacheStorage, [observedAt]),
    browserEntry("webcodecs", "WebCodecs", report.webCodecs, [observedAt, ...report.webCodecs.interfaces.map((name) => `interface=${name}`)]),
    browserEntry("webtransport", "WebTransport", report.webTransport, [observedAt]),
    Object.freeze({
      id: "adaptive-scheduling",
      label: "Adaptive scheduling",
      state: "ready" as const,
      evidence: "runtime-reported" as const,
      detail: `The client derived a ${report.scheduling.class} scheduling posture from live coarse device signals; ceilings are policy inputs, not resource-use measurements.`,
      facets: Object.freeze([
        observedAt,
        `class=${report.scheduling.class}`,
        `heavy-pack-loading=${report.scheduling.heavyPackLoading}`,
        `indexing-concurrency=${String(report.scheduling.maxIndexingConcurrency)}`,
        `semantic-backend=${report.scheduling.preferredSemanticBackend}`,
        `workspace-storage=${report.scheduling.preferredWorkspaceStorage}`,
      ].sort()),
    }),
  ];
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function browserEntry(
  id: string,
  label: string,
  observation: BrowserCapabilityObservation,
  facets: readonly string[] = [],
): LiveEnvironmentEntry {
  return Object.freeze({
    id,
    label,
    state: observation.state === "available" ? "available" : observation.state,
    evidence: observation.evidence,
    detail: boundedDetail(observation.detail),
    facets: Object.freeze([...facets].sort()),
  });
}

function executionEntries(
  capabilities: readonly ExecutionCapability[] = getClientExecutionRuntime().capabilities(),
): readonly LiveEnvironmentEntry[] {
  return Object.freeze(capabilities.map((capability) => Object.freeze({
    id: capability.id,
    label: capability.label,
    state: capability.state,
    evidence: "runtime-reported" as const,
    detail: boundedDetail(capability.detail),
    facets: Object.freeze([
      `tier=${capability.tier}`,
      `shell=${capability.shell}`,
      `workspace=${capability.workspaceAccess}`,
      `persistence=${capability.persistence}`,
    ].sort()),
  })));
}

async function observeWorkspaceIndex(
  runtime: LiveEnvironmentContextRuntime,
  signal: AbortSignal,
): Promise<LiveWorkspaceIndexObservation> {
  try {
    signal.throwIfAborted();
    const generation = await runtime.refreshNow();
    signal.throwIfAborted();
    return Object.freeze({
      state: "ready",
      generationDigest: generation.lineage.generationDigest,
      workspaceSnapshotDigest: generation.workspaceSnapshotDigest,
      embeddingProvider: generation.lineage.embeddingProvider,
      embeddingPosture: generation.lineage.embeddingPosture,
      indexedFiles: generation.candidateStats.byStatus.indexed,
      chunks: generation.chunkStats.total,
      detail: `The client refreshed generation ${generation.lineage.generationDigest}; ${String(generation.candidateStats.byStatus.indexed)} files produced ${String(generation.chunkStats.total)} searchable chunks.`,
    });
  } catch (error) {
    signal.throwIfAborted();
    const state = runtime.getState();
    return Object.freeze({
      state: "failed",
      ...(state.generation ? {
        generationDigest: state.generation.lineage.generationDigest,
        workspaceSnapshotDigest: state.generation.workspaceSnapshotDigest,
        embeddingProvider: state.generation.lineage.embeddingProvider,
        embeddingPosture: state.generation.lineage.embeddingPosture,
        indexedFiles: state.generation.candidateStats.byStatus.indexed,
        chunks: state.generation.chunkStats.total,
      } : {}),
      detail: `The workspace index refresh failed: ${errorMessage(error)}`,
    });
  }
}

function failedEntry(id: string, label: string, detail: string): LiveEnvironmentEntry {
  return Object.freeze({
    id,
    label,
    state: "failed",
    evidence: "probe-failed",
    detail,
    facets: Object.freeze([]),
  });
}

function notObservedEntry(id: string, label: string, detail: string): LiveEnvironmentEntry {
  return Object.freeze({
    id,
    label,
    state: "not-observed",
    evidence: "not-observed",
    detail,
    facets: Object.freeze([]),
  });
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 320) || "unknown failure";
}

function boundedDetail(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length <= 512) return cleaned;
  return `${cleaned.slice(0, 509).trimEnd()}...`;
}
