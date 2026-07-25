/**
 * Browser capability probes are observations, never grants.  A successful
 * probe can select a preferred implementation, but the consuming adapter must
 * still report its own active backend.  This keeps, for example, an available
 * WebGPU adapter from becoming a false claim that semantic inference is using
 * WebGPU.
 *
 * The WebAssembly byte fixtures are minimal feature probes derived from the
 * Apache-2.0 GoogleChromeLabs/wasm-feature-detect 1.8.0 detectors.  Keeping the
 * fixtures here avoids loading a feature-detection package on the startup path.
 */

export type BrowserProbeState = "available" | "unavailable" | "failed";
export type BrowserProbeEvidence = "probe-passed" | "api-exposed" | "not-observed" | "probe-failed";
export type WasmFeatureId = "simd" | "threads" | "memory64" | "multi-memory" | "relaxed-simd" | "tail-call";

export type BrowserCapabilityObservation = Readonly<{
  state: BrowserProbeState;
  evidence: BrowserProbeEvidence;
  detail: string;
}>;

export type WebGpuObservation = BrowserCapabilityObservation & Readonly<{
  powerPreference: "high-performance" | "low-power" | "default";
  features: readonly string[];
  limits: Readonly<Record<string, number>>;
  adapterInfo: Readonly<Record<string, string>>;
  fallbackAdapter?: boolean;
}>;

export type WebAssemblyObservation = BrowserCapabilityObservation & Readonly<{
  features: Readonly<Record<WasmFeatureId, boolean>>;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
}>;

export type OpfsObservation = BrowserCapabilityObservation & Readonly<{
  syncAccessHandle: "api-exposed" | "not-observed";
}>;

export type BrowserSignalReport = Readonly<{
  logicalProcessors?: number;
  deviceMemoryGiB?: number;
  online?: boolean;
  battery: Readonly<{
    state: BrowserProbeState;
    charging?: boolean;
    level?: number;
    detail: string;
  }>;
  connection: Readonly<{
    state: BrowserProbeState;
    effectiveType?: string;
    saveData?: boolean;
    downlinkMbps?: number;
    rttMs?: number;
    detail: string;
  }>;
  thermal: Readonly<{
    state: "unavailable";
    detail: string;
  }>;
}>;

export type AdaptiveSchedulingPolicy = Readonly<{
  class: "constrained" | "balanced" | "performance";
  maxWorkerConcurrency: number;
  maxIndexingConcurrency: number;
  embeddingBatchSize: number;
  yieldEveryMs: number;
  heavyPackLoading: "manual" | "lazy-on-demand";
  preferredSemanticBackend: "webgpu" | "wasm";
  preferredWasmTier: "simd-threads" | "threads" | "simd" | "baseline";
  preferredWorkspaceStorage: "opfs" | "indexeddb-fallback";
  powerPreference: "high-performance" | "low-power" | "default";
  reasons: readonly string[];
}>;

export type BrowserRuntimeCapabilityReport = Readonly<{
  version: 1;
  observedAt: string;
  secureContext: boolean;
  crossOriginIsolated: boolean;
  webgpu: WebGpuObservation;
  webnn: BrowserCapabilityObservation;
  wasm: WebAssemblyObservation;
  opfs: OpfsObservation;
  serviceWorker: BrowserCapabilityObservation;
  cacheStorage: BrowserCapabilityObservation;
  webCodecs: BrowserCapabilityObservation & Readonly<{ interfaces: readonly string[] }>;
  webTransport: BrowserCapabilityObservation;
  signals: BrowserSignalReport;
  scheduling: AdaptiveSchedulingPolicy;
}>;

type GpuAdapterLike = Readonly<{
  features?: Iterable<unknown>;
  limits?: unknown;
  info?: unknown;
  isFallbackAdapter?: boolean;
}>;

type BrowserNavigatorLike = Readonly<{
  hardwareConcurrency?: number;
  deviceMemory?: number;
  onLine?: boolean;
  gpu?: Readonly<{
    requestAdapter(options?: Readonly<{ powerPreference?: string }>): Promise<GpuAdapterLike | null>;
  }>;
  ml?: Readonly<{
    createContext(options?: Readonly<{ powerPreference?: string; accelerated?: boolean }>): Promise<unknown> | unknown;
  }>;
  storage?: Readonly<{
    getDirectory(): Promise<unknown>;
  }>;
  serviceWorker?: unknown;
  getBattery?: () => Promise<unknown>;
  connection?: unknown;
}>;

export type BrowserCapabilityProbeHost = Readonly<{
  navigator?: BrowserNavigatorLike;
  isSecureContext: boolean;
  crossOriginIsolated: boolean;
  hasWebAssembly: boolean;
  hasSharedArrayBuffer: boolean;
  hasCacheStorage: boolean;
  exposedInterfaces: ReadonlySet<string>;
  validateWasm(feature: WasmFeatureId, bytes: Uint8Array): boolean;
  canTransferSharedArrayBuffer(): boolean;
  now(): Date;
  timeoutMs: number;
}>;

export type BrowserCapabilityPromptEntry = Readonly<{
  id: string;
  evidence: "probe-passed" | "api-exposed";
  detail: string;
}>;

const WASM_FEATURE_FIXTURES: Readonly<Record<WasmFeatureId, Uint8Array>> = Object.freeze({
  simd: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
  threads: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11]),
  memory64: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]),
  "multi-memory": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 2, 0, 0, 0, 0]),
  "relaxed-simd": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]),
  "tail-call": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 18, 0, 11]),
});

const GPU_LIMIT_NAMES = Object.freeze([
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxBufferSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupStorageSize",
  "maxComputeWorkgroupsPerDimension",
  "maxStorageBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
] as const);

const GPU_INFO_NAMES = Object.freeze(["vendor", "architecture", "device", "description"] as const);

export async function probeBrowserRuntimeCapabilities(
  overrides: Partial<BrowserCapabilityProbeHost> = {},
): Promise<BrowserRuntimeCapabilityReport> {
  const host = createProbeHost(overrides);
  const signals = await probeSignals(host);
  const powerPreference = schedulingPowerPreference(signals);
  const [webgpu, webnn, opfs] = await Promise.all([
    probeWebGpu(host, powerPreference),
    probeWebNn(host, powerPreference),
    probeOpfs(host),
  ]);
  const wasm = probeWebAssembly(host);
  const serviceWorker = apiObservation(
    host.navigator?.serviceWorker !== undefined,
    "Service Worker API is exposed in this browser.",
    "Service Worker API was not observed.",
  );
  const cacheStorage = apiObservation(
    host.hasCacheStorage,
    "Cache Storage API is exposed; cache contents and service-worker control remain separate observations.",
    "Cache Storage API was not observed.",
  );
  const codecInterfaces = ["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder", "ImageDecoder"]
    .filter((name) => host.exposedInterfaces.has(name));
  const webCodecs = Object.freeze({
    ...apiObservation(
      codecInterfaces.length > 0,
      `${String(codecInterfaces.length)} WebCodecs interface${codecInterfaces.length === 1 ? "" : "s"} observed; codec support remains format-specific.`,
      "No WebCodecs encoder or decoder interface was observed.",
    ),
    interfaces: Object.freeze(codecInterfaces),
  });
  const webTransport = apiObservation(
    host.exposedInterfaces.has("WebTransport"),
    "WebTransport constructor is exposed; no remote session or endpoint capability was established.",
    "WebTransport constructor was not observed.",
  );
  const scheduling = deriveAdaptiveSchedulingPolicy({ webgpu, webnn, wasm, opfs, signals });

  return deepFreeze({
    version: 1,
    observedAt: host.now().toISOString(),
    secureContext: host.isSecureContext,
    crossOriginIsolated: host.crossOriginIsolated,
    webgpu,
    webnn,
    wasm,
    opfs,
    serviceWorker,
    cacheStorage,
    webCodecs,
    webTransport,
    signals,
    scheduling,
  }) as BrowserRuntimeCapabilityReport;
}

export function deriveAdaptiveSchedulingPolicy(input: Readonly<{
  webgpu: BrowserCapabilityObservation;
  webnn: BrowserCapabilityObservation;
  wasm: WebAssemblyObservation;
  opfs: BrowserCapabilityObservation;
  signals: BrowserSignalReport;
}>): AdaptiveSchedulingPolicy {
  const processors = boundedInteger(input.signals.logicalProcessors, 1, 256) ?? 2;
  const memory = boundedNumber(input.signals.deviceMemoryGiB, 0.25, 1024);
  const batteryConstrained = input.signals.battery.state === "available"
    && input.signals.battery.charging === false
    && (input.signals.battery.level ?? 1) <= 0.2;
  const networkConstrained = input.signals.connection.saveData === true
    || ["slow-2g", "2g"].includes(input.signals.connection.effectiveType ?? "");
  const constrained = processors <= 2 || (memory !== undefined && memory <= 2) || batteryConstrained || networkConstrained;
  const performance = !constrained
    && processors >= 8
    && (memory === undefined || memory >= 8)
    && input.signals.online !== false;
  const policyClass = constrained ? "constrained" : performance ? "performance" : "balanced";
  const workerCeiling = policyClass === "performance" ? 8 : policyClass === "balanced" ? 4 : 2;
  const maxWorkerConcurrency = Math.max(1, Math.min(workerCeiling, processors - 1));
  const reasons: string[] = [];
  if (processors <= 2) reasons.push("limited logical processors");
  if (memory !== undefined && memory <= 2) reasons.push("limited reported device memory");
  if (batteryConstrained) reasons.push("low battery while unplugged");
  if (networkConstrained) reasons.push("data-saving or constrained network");
  if (performance) reasons.push("high parallelism and memory headroom");
  if (!reasons.length) reasons.push("balanced browser resource signals");

  const wasmFeatures = input.wasm.features;
  const preferredWasmTier = wasmFeatures.threads && wasmFeatures.simd
    ? "simd-threads"
    : wasmFeatures.threads
      ? "threads"
      : wasmFeatures.simd
        ? "simd"
        : "baseline";
  // The shipped semantic pack has real WebGPU and WASM backends. WebNN is
  // reported independently but cannot be selected until a WebNN embedding
  // adapter passes the same activation contract.
  const preferredSemanticBackend = input.webgpu.state === "available" && policyClass !== "constrained"
    ? "webgpu"
    : "wasm";

  return deepFreeze({
    class: policyClass,
    maxWorkerConcurrency,
    maxIndexingConcurrency: Math.max(1, Math.min(maxWorkerConcurrency, policyClass === "performance" ? 4 : 2)),
    embeddingBatchSize: policyClass === "performance" ? 32 : policyClass === "balanced" ? 12 : 4,
    yieldEveryMs: policyClass === "performance" ? 16 : policyClass === "balanced" ? 12 : 8,
    heavyPackLoading: input.signals.online === false || networkConstrained ? "manual" : "lazy-on-demand",
    preferredSemanticBackend,
    preferredWasmTier,
    preferredWorkspaceStorage: input.opfs.state === "available" ? "opfs" : "indexeddb-fallback",
    powerPreference: schedulingPowerPreference(input.signals),
    reasons: Object.freeze(reasons),
  }) as AdaptiveSchedulingPolicy;
}

/** Stable, non-volatile session prompt entries. Unavailable probes are omitted. */
export function browserCapabilityPromptEntries(
  report: BrowserRuntimeCapabilityReport,
): readonly BrowserCapabilityPromptEntry[] {
  const entries: BrowserCapabilityPromptEntry[] = [];
  if (report.webgpu.state === "available") {
    entries.push({
      id: "webgpu-adapter",
      evidence: "probe-passed",
      detail: `A usable adapter was acquired with ${report.webgpu.powerPreference} preference; a consuming pack must still report WebGPU as its active backend.`,
    });
  }
  if (report.webnn.state === "available") {
    entries.push({ id: "webnn-context", evidence: "probe-passed", detail: "A WebNN context was created and released; no model is implicitly loaded." });
  }
  if (report.opfs.state === "available") {
    entries.push({ id: "opfs-root", evidence: "probe-passed", detail: "The origin-private filesystem root was acquired; the active workspace adapter remains authoritative." });
  }
  if (report.wasm.state === "available") {
    entries.push({ id: "wasm-baseline", evidence: "probe-passed", detail: "WebAssembly validation is live in this page." });
    for (const [feature, supported] of Object.entries(report.wasm.features) as [WasmFeatureId, boolean][]) {
      if (supported) entries.push({ id: `wasm-${feature}`, evidence: "probe-passed", detail: `${feature} passed its minimal WebAssembly module validation probe.` });
    }
  }
  if (report.crossOriginIsolated) {
    entries.push({ id: "cross-origin-isolation", evidence: "api-exposed", detail: "This page is cross-origin isolated; individual threaded runtimes still require their own readiness probe." });
  }
  for (const [id, observation] of [
    ["service-worker", report.serviceWorker],
    ["cache-storage", report.cacheStorage],
    ["webcodecs", report.webCodecs],
    ["webtransport", report.webTransport],
  ] as const) {
    if (observation.state === "available") entries.push({ id, evidence: "api-exposed", detail: observation.detail });
  }
  return Object.freeze(entries.sort((left, right) => left.id.localeCompare(right.id)).map((entry) => Object.freeze(entry)));
}

export function availableBrowserCapabilityCount(report: BrowserRuntimeCapabilityReport): number {
  return [report.webgpu, report.webnn, report.wasm, report.opfs, report.serviceWorker, report.cacheStorage, report.webCodecs, report.webTransport]
    .filter(({ state }) => state === "available").length;
}

type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type BrowserCapabilityLifecycle = Readonly<{
  windowTarget?: EventTargetLike;
  documentTarget?: EventTargetLike & Readonly<{ visibilityState?: string }>;
  connectionTarget?: EventTargetLike;
  getBatteryTarget?: () => Promise<EventTargetLike | undefined>;
}>;

/**
 * One page-memory monitor owns lifecycle re-probes. It deliberately stores no
 * hardware fingerprint, battery reading, or adapter information in local or
 * cloud storage.
 */
export class BrowserCapabilityRegistry {
  private report?: BrowserRuntimeCapabilityReport;
  private inFlight?: Promise<BrowserRuntimeCapabilityReport>;
  private readonly listeners = new Set<(report: BrowserRuntimeCapabilityReport) => void>();
  private readonly cleanups: Array<() => void> = [];
  private started = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly probe: () => Promise<BrowserRuntimeCapabilityReport> = () => probeBrowserRuntimeCapabilities(),
    private readonly lifecycle: BrowserCapabilityLifecycle = defaultLifecycle(),
    private readonly cacheMs = 30_000,
  ) {}

  snapshot(): BrowserRuntimeCapabilityReport | undefined { return this.report; }

  async refresh(force = false): Promise<BrowserRuntimeCapabilityReport> {
    if (!force && this.report && Date.now() - Date.parse(this.report.observedAt) < this.cacheMs) return this.report;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe().then((report) => {
      this.report = report;
      for (const listener of this.listeners) {
        try { listener(report); } catch { /* Presentation observers are non-authoritative. */ }
      }
      return report;
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  subscribe(listener: (report: BrowserRuntimeCapabilityReport) => void): () => void {
    this.listeners.add(listener);
    this.start();
    if (this.report) listener(this.report);
    else void this.refresh().catch(() => undefined);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const refreshWhenVisible = () => {
      if (this.lifecycle.documentTarget?.visibilityState === "hidden") return;
      this.scheduleRefresh();
    };
    this.bind(this.lifecycle.windowTarget, "pageshow", refreshWhenVisible);
    this.bind(this.lifecycle.windowTarget, "online", refreshWhenVisible);
    this.bind(this.lifecycle.windowTarget, "offline", refreshWhenVisible);
    this.bind(this.lifecycle.documentTarget, "visibilitychange", refreshWhenVisible);
    this.bind(this.lifecycle.connectionTarget, "change", refreshWhenVisible);
    void this.lifecycle.getBatteryTarget?.().then((target) => {
      if (!this.started || !target) return;
      this.bind(target, "chargingchange", refreshWhenVisible);
      this.bind(target, "levelchange", refreshWhenVisible);
    }).catch(() => undefined);
  }

  stop(): void {
    this.started = false;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private bind(target: EventTargetLike | undefined, event: string, listener: EventListener): void {
    if (!target) return;
    target.addEventListener(event, listener);
    this.cleanups.push(() => target.removeEventListener(event, listener));
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(true).catch(() => undefined);
    }, 150);
  }
}

let clientRegistry: BrowserCapabilityRegistry | undefined;

export function getBrowserCapabilityRegistry(): BrowserCapabilityRegistry {
  clientRegistry ??= new BrowserCapabilityRegistry();
  clientRegistry.start();
  return clientRegistry;
}

function createProbeHost(overrides: Partial<BrowserCapabilityProbeHost>): BrowserCapabilityProbeHost {
  const browserNavigator = typeof navigator === "undefined" ? undefined : navigator as unknown as BrowserNavigatorLike;
  const globalRecord = globalThis as typeof globalThis & Record<string, unknown>;
  return Object.freeze({
    navigator: browserNavigator,
    isSecureContext: globalThis.isSecureContext === true,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hasWebAssembly: typeof WebAssembly !== "undefined",
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    hasCacheStorage: "caches" in globalThis,
    exposedInterfaces: new Set(["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder", "ImageDecoder", "WebTransport"]
      .filter((name) => typeof globalRecord[name] === "function")),
    validateWasm: (_feature, bytes) => {
      try { return typeof WebAssembly !== "undefined" && WebAssembly.validate(bytes as unknown as BufferSource); } catch { return false; }
    },
    canTransferSharedArrayBuffer: () => {
      if (typeof MessageChannel === "undefined" || typeof SharedArrayBuffer === "undefined") return false;
      const channel = new MessageChannel();
      try {
        channel.port1.postMessage(new SharedArrayBuffer(1));
        return true;
      } catch {
        return false;
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    },
    now: () => new Date(),
    timeoutMs: 3_000,
    ...overrides,
  });
}

async function probeSignals(host: BrowserCapabilityProbeHost): Promise<BrowserSignalReport> {
  const nav = host.navigator;
  const logicalProcessors = boundedInteger(nav?.hardwareConcurrency, 1, 256);
  const deviceMemoryGiB = boundedNumber(nav?.deviceMemory, 0.25, 1024);
  const battery = await probeBattery(nav, host.timeoutMs);
  const connection = probeConnection(nav?.connection);
  return deepFreeze({
    ...(logicalProcessors !== undefined ? { logicalProcessors } : {}),
    ...(deviceMemoryGiB !== undefined ? { deviceMemoryGiB } : {}),
    ...(typeof nav?.onLine === "boolean" ? { online: nav.onLine } : {}),
    battery,
    connection,
    thermal: {
      state: "unavailable",
      detail: "No standardized browser thermal-state API was observed; Airship does not infer a temperature claim.",
    },
  }) as BrowserSignalReport;
}

async function probeBattery(nav: BrowserNavigatorLike | undefined, timeoutMs: number): Promise<BrowserSignalReport["battery"]> {
  if (typeof nav?.getBattery !== "function") {
    return Object.freeze({ state: "unavailable", detail: "Battery Status API was not observed." });
  }
  try {
    const value = await withDeadline(Promise.resolve(nav.getBattery()), timeoutMs, "Battery probe");
    const record = objectRecord(value);
    const level = boundedNumber(record?.level, 0, 1);
    const charging = typeof record?.charging === "boolean" ? record.charging : undefined;
    return Object.freeze({
      state: "available",
      ...(charging !== undefined ? { charging } : {}),
      ...(level !== undefined ? { level } : {}),
      detail: "Battery Status API returned a live page-memory observation.",
    });
  } catch (error) {
    return Object.freeze({ state: "failed", detail: boundedFailure("Battery probe failed", error) });
  }
}

function probeConnection(value: unknown): BrowserSignalReport["connection"] {
  const record = objectRecord(value);
  if (!record) return Object.freeze({ state: "unavailable", detail: "Network Information API was not observed." });
  const effectiveType = boundedToken(record.effectiveType, 24);
  const saveData = typeof record.saveData === "boolean" ? record.saveData : undefined;
  const downlinkMbps = boundedNumber(record.downlink, 0, 100_000);
  const rttMs = boundedNumber(record.rtt, 0, 3_600_000);
  return Object.freeze({
    state: "available",
    ...(effectiveType ? { effectiveType } : {}),
    ...(saveData !== undefined ? { saveData } : {}),
    ...(downlinkMbps !== undefined ? { downlinkMbps } : {}),
    ...(rttMs !== undefined ? { rttMs } : {}),
    detail: "Network Information API returned coarse scheduling signals; these are estimates, not throughput guarantees.",
  });
}

async function probeWebGpu(
  host: BrowserCapabilityProbeHost,
  powerPreference: AdaptiveSchedulingPolicy["powerPreference"],
): Promise<WebGpuObservation> {
  const gpu = host.navigator?.gpu;
  if (!gpu?.requestAdapter) return unavailableWebGpu(powerPreference, "WebGPU API was not observed.");
  if (!host.isSecureContext) return unavailableWebGpu(powerPreference, "WebGPU requires a secure browser context.");
  try {
    const adapter = await withDeadline(
      gpu.requestAdapter({ powerPreference }),
      host.timeoutMs,
      "WebGPU adapter probe",
    );
    if (!adapter) return unavailableWebGpu(powerPreference, "WebGPU returned no usable adapter for this page.");
    const features = [...(adapter.features ?? [])]
      .filter((value): value is string => typeof value === "string" && /^[a-z0-9-]{1,80}$/u.test(value))
      .slice(0, 128)
      .sort();
    const limits = numericProperties(adapter.limits, GPU_LIMIT_NAMES);
    const adapterInfo = stringProperties(adapter.info, GPU_INFO_NAMES);
    return deepFreeze({
      state: "available",
      evidence: "probe-passed",
      detail: "A WebGPU adapter was acquired. Features and limits are observed adapter capabilities; no model or workload is implied active.",
      powerPreference,
      features,
      limits,
      adapterInfo,
      ...(typeof adapter.isFallbackAdapter === "boolean" ? { fallbackAdapter: adapter.isFallbackAdapter } : {}),
    }) as WebGpuObservation;
  } catch (error) {
    return deepFreeze({
      ...unavailableWebGpu(powerPreference, boundedFailure("WebGPU adapter probe failed", error)),
      state: "failed",
      evidence: "probe-failed",
    }) as WebGpuObservation;
  }
}

async function probeWebNn(
  host: BrowserCapabilityProbeHost,
  powerPreference: AdaptiveSchedulingPolicy["powerPreference"],
): Promise<BrowserCapabilityObservation> {
  const ml = host.navigator?.ml;
  if (!ml?.createContext) return unavailable("WebNN navigator.ml API was not observed.");
  if (!host.isSecureContext) return unavailable("WebNN requires a secure browser context.");
  try {
    const context = await withDeadline(
      Promise.resolve(ml.createContext({ powerPreference, accelerated: true })),
      host.timeoutMs,
      "WebNN context probe",
    );
    const destroy = objectRecord(context)?.destroy;
    if (typeof destroy === "function") {
      try { destroy.call(context); } catch { /* Context creation is the readiness evidence. */ }
    }
    return Object.freeze({ state: "available", evidence: "probe-passed", detail: "A WebNN context was created and released; no graph or model is loaded." });
  } catch (error) {
    return Object.freeze({ state: "failed", evidence: "probe-failed", detail: boundedFailure("WebNN context probe failed", error) });
  }
}

function probeWebAssembly(host: BrowserCapabilityProbeHost): WebAssemblyObservation {
  if (!host.hasWebAssembly) {
    return deepFreeze({
      ...unavailable("WebAssembly API was not observed."),
      features: emptyWasmFeatures(),
      sharedArrayBuffer: false,
      crossOriginIsolated: host.crossOriginIsolated,
    }) as WebAssemblyObservation;
  }
  const features = Object.fromEntries((Object.keys(WASM_FEATURE_FIXTURES) as WasmFeatureId[]).map((feature) => {
    let supported = false;
    try { supported = host.validateWasm(feature, WASM_FEATURE_FIXTURES[feature]); } catch { supported = false; }
    if (feature === "threads") {
      supported = supported
        && host.crossOriginIsolated
        && host.hasSharedArrayBuffer
        && safeSharedArrayBufferTransfer(host);
    }
    return [feature, supported];
  })) as Record<WasmFeatureId, boolean>;
  return deepFreeze({
    state: "available",
    evidence: "probe-passed",
    detail: "WebAssembly is live; each advanced feature is reported only after its minimal module validates, and threads also require transferable SharedArrayBuffer isolation.",
    features,
    sharedArrayBuffer: host.hasSharedArrayBuffer,
    crossOriginIsolated: host.crossOriginIsolated,
  }) as WebAssemblyObservation;
}

async function probeOpfs(host: BrowserCapabilityProbeHost): Promise<OpfsObservation> {
  const storage = host.navigator?.storage;
  const syncAccessHandle = host.exposedInterfaces.has("FileSystemSyncAccessHandle")
    || host.exposedInterfaces.has("FileSystemFileHandle.createSyncAccessHandle")
    ? "api-exposed" as const
    : "not-observed" as const;
  if (!storage?.getDirectory) {
    return Object.freeze({ ...unavailable("Origin Private File System API was not observed."), syncAccessHandle });
  }
  if (!host.isSecureContext) {
    return Object.freeze({ ...unavailable("OPFS requires a secure browser context."), syncAccessHandle });
  }
  try {
    const root = await withDeadline(storage.getDirectory(), host.timeoutMs, "OPFS root probe");
    if (!root || typeof root !== "object") throw new TypeError("OPFS returned no directory handle.");
    return Object.freeze({
      state: "available",
      evidence: "probe-passed",
      detail: syncAccessHandle === "api-exposed"
        ? "The OPFS root was acquired and a synchronous-access interface was observed; no workspace migration or persistence claim is implied."
        : "The OPFS root was acquired. A synchronous Worker access handle was not independently observed in this realm.",
      syncAccessHandle,
    });
  } catch (error) {
    return Object.freeze({ state: "failed", evidence: "probe-failed", detail: boundedFailure("OPFS root probe failed", error), syncAccessHandle });
  }
}

function unavailableWebGpu(
  powerPreference: WebGpuObservation["powerPreference"],
  detail: string,
): WebGpuObservation {
  return Object.freeze({
    state: "unavailable",
    evidence: "not-observed",
    detail,
    powerPreference,
    features: Object.freeze([]),
    limits: Object.freeze({}),
    adapterInfo: Object.freeze({}),
  });
}

function apiObservation(available: boolean, readyDetail: string, unavailableDetail: string): BrowserCapabilityObservation {
  return available
    ? Object.freeze({ state: "available", evidence: "api-exposed", detail: readyDetail })
    : unavailable(unavailableDetail);
}

function unavailable(detail: string): BrowserCapabilityObservation {
  return Object.freeze({ state: "unavailable", evidence: "not-observed", detail });
}

function emptyWasmFeatures(): Readonly<Record<WasmFeatureId, boolean>> {
  return Object.freeze({ simd: false, threads: false, memory64: false, "multi-memory": false, "relaxed-simd": false, "tail-call": false });
}

function schedulingPowerPreference(signals: BrowserSignalReport): AdaptiveSchedulingPolicy["powerPreference"] {
  const lowBattery = signals.battery.state === "available"
    && signals.battery.charging === false
    && (signals.battery.level ?? 1) <= 0.25;
  if (lowBattery || signals.connection.saveData === true) return "low-power";
  if ((signals.logicalProcessors ?? 0) >= 8 && (signals.deviceMemoryGiB ?? 8) >= 8) return "high-performance";
  return "default";
}

function safeSharedArrayBufferTransfer(host: BrowserCapabilityProbeHost): boolean {
  try { return host.canTransferSharedArrayBuffer(); } catch { return false; }
}

function numericProperties(value: unknown, names: readonly string[]): Readonly<Record<string, number>> {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return Object.freeze({});
  const result: Record<string, number> = {};
  for (const name of names) {
    const candidate = (value as Record<string, unknown>)[name];
    const number = typeof candidate === "bigint" && candidate <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(candidate)
      : boundedNumber(candidate, 0, Number.MAX_SAFE_INTEGER);
    if (number !== undefined) result[name] = number;
  }
  return Object.freeze(result);
}

function stringProperties(value: unknown, names: readonly string[]): Readonly<Record<string, string>> {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return Object.freeze({});
  const result: Record<string, string> = {};
  for (const name of names) {
    const candidate = boundedText((value as Record<string, unknown>)[name], 160);
    if (candidate) result[name] = candidate;
  }
  return Object.freeze(result);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === "object" || typeof value === "function")
    ? value as Record<string, unknown>
    : undefined;
}

function boundedToken(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && /^[a-z0-9-]+$/iu.test(value) ? value.slice(0, maximum) : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return clean ? clean.slice(0, maximum) : undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function boundedFailure(prefix: string, error: unknown): string {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "Error";
  return `${prefix} (${boundedText(name, 48) ?? "Error"}).`;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DOMException(`${label} timed out.`, "TimeoutError")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function defaultLifecycle(): BrowserCapabilityLifecycle {
  const nav = typeof navigator === "undefined" ? undefined : navigator as unknown as BrowserNavigatorLike;
  const connection = nav?.connection;
  const connectionTarget = connection && typeof (connection as EventTargetLike).addEventListener === "function"
    ? connection as EventTargetLike
    : undefined;
  return Object.freeze({
    windowTarget: typeof window === "undefined" ? undefined : window,
    documentTarget: typeof document === "undefined" ? undefined : document,
    connectionTarget,
    getBatteryTarget: typeof nav?.getBattery === "function"
      ? async () => {
          try {
            const battery = await nav.getBattery!();
            return battery && typeof (battery as EventTargetLike).addEventListener === "function"
              ? battery as EventTargetLike
              : undefined;
          } catch {
            return undefined;
          }
        }
      : undefined,
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
