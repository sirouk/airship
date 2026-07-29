import { describe, expect, it, vi } from "vitest";
import {
  BrowserCapabilityRegistry,
  browserCapabilityPromptEntries,
  deriveAdaptiveSchedulingPolicy,
  probeBrowserRuntimeCapabilities,
  semanticWasmThreadCount,
  type BrowserCapabilityObservation,
  type BrowserCapabilityProbeHost,
  type BrowserRuntimeCapabilityReport,
  type BrowserSignalReport,
  type OpfsObservation,
  type WebAssemblyObservation,
} from "./browser-runtime";

describe("browser runtime capability probes", () => {
  it("promotes only probes that actually pass and derives a performance policy", async () => {
    const destroy = vi.fn();
    const report = await probeBrowserRuntimeCapabilities({
      navigator: {
        hardwareConcurrency: 12,
        deviceMemory: 16,
        onLine: true,
        gpu: {
          async requestAdapter() {
            return {
              features: new Set(["shader-f16", "subgroups"]),
              limits: { maxBufferSize: 268_435_456, maxComputeInvocationsPerWorkgroup: 256 },
              info: { vendor: "Test GPU", architecture: "test-arch" },
              isFallbackAdapter: false,
            };
          },
        },
        ml: { async createContext() { return { destroy }; } },
        storage: { async getDirectory() { return { kind: "directory" }; } },
        serviceWorker: {},
        async getBattery() { return { charging: true, level: 0.84 }; },
        connection: { effectiveType: "4g", saveData: false, downlink: 80, rtt: 20 },
      } as BrowserCapabilityProbeHost["navigator"],
      isSecureContext: true,
      crossOriginIsolated: true,
      hasWebAssembly: true,
      hasSharedArrayBuffer: true,
      hasCacheStorage: true,
      exposedInterfaces: new Set(["VideoEncoder", "VideoDecoder", "WebTransport"]),
      hasSyncAccessHandleInterface: true,
      validateWasm: () => true,
      canTransferSharedArrayBuffer: () => true,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      timeoutMs: 50,
    });

    expect(report.webgpu).toMatchObject({
      state: "available",
      evidence: "probe-passed",
      powerPreference: "high-performance",
      features: ["shader-f16", "subgroups"],
      limits: { maxBufferSize: 268_435_456, maxComputeInvocationsPerWorkgroup: 256 },
      adapterInfo: { vendor: "Test GPU", architecture: "test-arch" },
      fallbackAdapter: false,
    });
    expect(report.webnn.state).toBe("available");
    expect(destroy).toHaveBeenCalledOnce();
    expect(report.opfs).toMatchObject({ state: "available", syncAccessHandle: "api-exposed" });
    expect(report.wasm.features).toEqual({
      simd: true,
      threads: true,
      memory64: true,
      "multi-memory": true,
      "relaxed-simd": true,
      "tail-call": true,
    });
    expect(report.scheduling).toMatchObject({
      class: "performance",
      maxWorkerConcurrency: 8,
      preferredSemanticBackend: "webgpu",
      preferredWasmTier: "simd-threads",
      preferredWorkspaceStorage: "opfs",
    });
    expect(browserCapabilityPromptEntries(report)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "webgpu-adapter", evidence: "probe-passed" }),
      expect.objectContaining({ id: "webnn-context", evidence: "probe-passed" }),
      expect.objectContaining({ id: "wasm-threads", evidence: "probe-passed" }),
      expect.objectContaining({ id: "webtransport", evidence: "api-exposed" }),
    ]));
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.scheduling.reasons)).toBe(true);
  });

  it("fails closed when exposed APIs reject and never leaks provider error text into the prompt", async () => {
    const report = await probeBrowserRuntimeCapabilities({
      navigator: {
        hardwareConcurrency: 4,
        gpu: { async requestAdapter() { throw new Error("secret adapter diagnostic"); } },
        ml: { async createContext() { throw new DOMException("driver details", "NotSupportedError"); } },
        storage: { async getDirectory() { throw new DOMException("quota details", "SecurityError"); } },
      } as BrowserCapabilityProbeHost["navigator"],
      isSecureContext: true,
      crossOriginIsolated: false,
      hasWebAssembly: true,
      hasSharedArrayBuffer: true,
      hasCacheStorage: false,
      exposedInterfaces: new Set(),
      validateWasm: () => false,
      canTransferSharedArrayBuffer: () => true,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      timeoutMs: 50,
    });

    expect(report.webgpu).toMatchObject({ state: "failed", evidence: "probe-failed" });
    expect(report.webgpu.detail).toContain("Error");
    expect(report.webgpu.detail).not.toContain("secret adapter diagnostic");
    expect(report.webnn).toMatchObject({ state: "failed", evidence: "probe-failed" });
    // The OPFS rejection here is a SecurityError, which is how engines report
    // storage switched off for a private window rather than a probe that broke.
    // Failing closed is unchanged; only the stated cause is now specific.
    expect(report.opfs).toMatchObject({ state: "failed", evidence: "disabled" });
    expect(report.opfs.detail).not.toContain("quota details");
    const promptIds = browserCapabilityPromptEntries(report).map(({ id }) => id);
    expect(promptIds).not.toContain("webgpu-adapter");
    expect(promptIds).not.toContain("webnn-context");
    expect(promptIds).not.toContain("opfs-root");
    expect(promptIds).toContain("wasm-baseline");
  });

  it("requires isolation and transferable SharedArrayBuffer in addition to a valid threads module", async () => {
    const report = await probeBrowserRuntimeCapabilities({
      navigator: {} as BrowserCapabilityProbeHost["navigator"],
      isSecureContext: true,
      crossOriginIsolated: false,
      hasWebAssembly: true,
      hasSharedArrayBuffer: true,
      hasCacheStorage: false,
      exposedInterfaces: new Set(),
      validateWasm: () => true,
      canTransferSharedArrayBuffer: () => true,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      timeoutMs: 50,
    });

    expect(report.wasm.features.simd).toBe(true);
    expect(report.wasm.features.threads).toBe(false);
    expect(browserCapabilityPromptEntries(report).map(({ id }) => id)).not.toContain("wasm-threads");
  });
});

describe("WebGPU adapter request options", () => {
  it("omits powerPreference entirely when the policy expresses none, because the WebIDL enum has no \"default\"", async () => {
    const requested: unknown[] = [];
    const report = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {
        // A mid-tier device: not constrained, not performance, so the policy's
        // powerPreference is "default".
        hardwareConcurrency: 4,
        deviceMemory: 4,
        onLine: true,
        gpu: {
          async requestAdapter(options?: Readonly<{ powerPreference?: string }>) {
            requested.push(options);
            // Exactly what Chromium does: GPUPowerPreference accepts only
            // "low-power" and "high-performance".
            if (options && "powerPreference" in options && options.powerPreference !== "low-power" && options.powerPreference !== "high-performance") {
              throw new TypeError("The provided value 'default' is not a valid enum value of type GPUPowerPreference.");
            }
            return { features: new Set<string>(), limits: {}, info: {} };
          },
        },
      } as BrowserCapabilityProbeHost["navigator"],
    });

    expect(report.scheduling.powerPreference).toBe("default");
    expect(requested).toEqual([{}]);
    expect(report.webgpu).toMatchObject({ state: "available", evidence: "probe-passed", powerPreference: "default" });
    expect(browserCapabilityPromptEntries(report).map(({ id }) => id)).toContain("webgpu-adapter");
    expect(report.scheduling.preferredSemanticBackend).toBe("webgpu");
  });
});

describe("OPFS synchronous access handle observation", () => {
  /**
   * The default host, not an injected name set: the previous check asked
   * `exposedInterfaces` for a constructor called
   * "FileSystemFileHandle.createSyncAccessHandle", a name no realm ever
   * exposes, so it passed its injected-name test and reported "not-observed" in
   * every shipping browser — contradicting the ciphertext cache, which runs the
   * real sync handle in a worker on the same Chromium.
   */
  function withRealmGlobals(values: Readonly<Record<string, unknown>>, run: () => Promise<void>): Promise<void> {
    const record = globalThis as unknown as Record<string, unknown>;
    const restore = Object.keys(values).map((name) => [name, name in record ? record[name] : undefined, name in record] as const);
    Object.assign(record, values);
    return run().finally(() => {
      for (const [name, previous, existed] of restore) {
        if (existed) record[name] = previous;
        else delete record[name];
      }
    });
  }

  it("observes the window-realm prototype method with no probe overrides at all", async () => {
    await withRealmGlobals({ FileSystemFileHandle: class { createSyncAccessHandle() { return Promise.resolve({}); } } }, async () => {
      const report = await probeBrowserRuntimeCapabilities();
      expect(report.opfs.syncAccessHandle).toBe("api-exposed");
    });
  });

  it("observes the worker-realm constructor with no probe overrides at all", async () => {
    await withRealmGlobals({ FileSystemSyncAccessHandle: class {} }, async () => {
      const report = await probeBrowserRuntimeCapabilities();
      expect(report.opfs.syncAccessHandle).toBe("api-exposed");
    });
  });

  it("reports not-observed when neither form of the interface exists", async () => {
    const report = await probeBrowserRuntimeCapabilities();
    expect(report.opfs.syncAccessHandle).toBe("not-observed");
  });

  it("keys off the observed interface rather than any constructor name", async () => {
    // Both spellings the old allowlist accepted, including the dotted
    // pseudo-name: neither may resurrect the capability on its own.
    const report = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      exposedInterfaces: new Set(["FileSystemSyncAccessHandle", "FileSystemFileHandle.createSyncAccessHandle"]),
      hasSyncAccessHandleInterface: false,
    });
    expect(report.opfs.syncAccessHandle).toBe("not-observed");
  });
});

describe("adaptive browser scheduling", () => {
  it("scales down on low battery and data-saving signals without inventing thermal state", () => {
    const signals: BrowserSignalReport = {
      logicalProcessors: 8,
      deviceMemoryGiB: 8,
      online: true,
      battery: { state: "available", charging: false, level: 0.1, detail: "live" },
      connection: { state: "available", effectiveType: "4g", saveData: true, detail: "coarse" },
      thermal: { state: "unavailable", detail: "No standardized API." },
    };
    const wasm: WebAssemblyObservation = {
      state: "available",
      evidence: "probe-passed",
      detail: "live",
      features: { simd: true, threads: true, memory64: false, "multi-memory": false, "relaxed-simd": false, "tail-call": false },
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
    };
    const available: BrowserCapabilityObservation = { state: "available", evidence: "probe-passed", detail: "live" };
    const opfs: OpfsObservation = { ...available, syncAccessHandle: "not-observed" };
    const policy = deriveAdaptiveSchedulingPolicy({ webgpu: available, webnn: available, wasm, opfs, signals });

    expect(policy).toMatchObject({
      class: "constrained",
      maxWorkerConcurrency: 2,
      embeddingBatchSize: 4,
      heavyPackLoading: "manual",
      powerPreference: "low-power",
      preferredSemanticBackend: "wasm",
    });
    expect(policy.reasons).toEqual(expect.arrayContaining(["low battery while unplugged", "data-saving or constrained network"]));
  });
});

describe("service worker and cache storage page reality", () => {
  it("promotes to probe-passed only when a worker controls this page and the shell cache exists", async () => {
    const report = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {
        serviceWorker: { controller: { scriptURL: "https://airship.test/sw.js" } },
      } as BrowserCapabilityProbeHost["navigator"],
      hasCacheStorage: true,
      cacheKeys: async () => ["airship-shell-v6", "unrelated"],
    });

    expect(report.serviceWorker).toMatchObject({ state: "available", evidence: "probe-passed" });
    expect(report.serviceWorker.detail).toContain("controlling this page");
    expect(report.cacheStorage).toMatchObject({ state: "available", evidence: "probe-passed" });
    expect(report.cacheStorage.detail).toContain("airship-shell-v6");
    expect(browserCapabilityPromptEntries(report)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "service-worker", evidence: "probe-passed" }),
      expect.objectContaining({ id: "cache-storage", evidence: "probe-passed" }),
    ]));
  });

  it("distinguishes a registered-but-not-controlling worker and an empty cache from a controlled page", async () => {
    const report = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {
        serviceWorker: { controller: null, getRegistration: async () => ({ scope: "/" }) },
      } as BrowserCapabilityProbeHost["navigator"],
      hasCacheStorage: true,
      cacheKeys: async () => ["some-other-cache"],
    });

    expect(report.serviceWorker).toMatchObject({ state: "available", evidence: "api-exposed" });
    expect(report.serviceWorker.detail).toContain("not yet controlling");
    expect(report.cacheStorage).toMatchObject({ state: "available", evidence: "api-exposed" });
    expect(browserCapabilityPromptEntries(report)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "service-worker", evidence: "api-exposed" }),
    ]));
  });

  it("reports an unregistered worker and fails closed when cache enumeration throws", async () => {
    const report = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {
        serviceWorker: { getRegistration: async () => undefined },
      } as BrowserCapabilityProbeHost["navigator"],
      hasCacheStorage: true,
      cacheKeys: async () => { throw new DOMException("private browsing", "SecurityError"); },
    });

    expect(report.serviceWorker.detail).toContain("no worker is registered");
    // Firefox private browsing raises SecurityError from caches.keys(), and
    // that is the browser reporting the feature switched off for this context —
    // not Airship breaking. The reader gets a cause they can act on; the
    // message itself is still bounded to the error name.
    expect(report.cacheStorage).toMatchObject({ state: "failed", evidence: "disabled" });
    expect(report.cacheStorage.detail).not.toContain("private browsing");
    const promptIds = browserCapabilityPromptEntries(report).map(({ id }) => id);
    expect(promptIds).not.toContain("cache-storage");
  });

  it("separates a probe that broke from a page that was refused permission", async () => {
    const refused = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {
        serviceWorker: { getRegistration: async () => { throw new DOMException("blocked", "NotAllowedError"); } },
      } as BrowserCapabilityProbeHost["navigator"],
      hasCacheStorage: true,
      cacheKeys: async () => { throw new DOMException("blocked", "NotAllowedError"); },
    });
    expect(refused.serviceWorker).toMatchObject({ evidence: "permission-needed" });
    expect(refused.cacheStorage).toMatchObject({ evidence: "permission-needed" });

    const broken = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {
        serviceWorker: { getRegistration: async () => { throw new TypeError("boom"); } },
      } as BrowserCapabilityProbeHost["navigator"],
      hasCacheStorage: true,
      cacheKeys: async () => { throw new TypeError("boom"); },
    });
    expect(broken.serviceWorker).toMatchObject({ evidence: "probe-failed" });
    expect(broken.cacheStorage).toMatchObject({ evidence: "probe-failed" });
  });

  it("reads an absent container in a secure context as switched off, and elsewhere as unobserved", async () => {
    // Every engine that can run this page ships service workers; withholding
    // the container from a secure context is how a private window or a disabled
    // preference reports itself, and that is a cause the reader can change.
    const secure = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {} as BrowserCapabilityProbeHost["navigator"],
      hasCacheStorage: false,
    });
    expect(secure.serviceWorker).toMatchObject({ state: "unavailable", evidence: "disabled" });
    expect(secure.serviceWorker.detail).toContain("switched off");
    expect(secure.cacheStorage).toMatchObject({ state: "unavailable", evidence: "not-observed" });

    // Outside a secure context the API is simply not exposed, and no browser
    // setting would change it, so the weaker word stays.
    const insecure = await probeBrowserRuntimeCapabilities({
      ...hermeticHost(),
      navigator: {} as BrowserCapabilityProbeHost["navigator"],
      isSecureContext: false,
      hasCacheStorage: false,
    });
    expect(insecure.serviceWorker).toMatchObject({ state: "unavailable", evidence: "not-observed" });
  });
});

describe("semantic WASM thread count", () => {
  it("sizes the ONNX Runtime pool from the worker ceiling only on a threaded tier", () => {
    const base = deriveAdaptiveSchedulingPolicy({
      webgpu: { state: "unavailable", evidence: "not-observed", detail: "none" },
      webnn: { state: "unavailable", evidence: "not-observed", detail: "none" },
      wasm: {
        state: "available",
        evidence: "probe-passed",
        detail: "live",
        features: { simd: true, threads: true, memory64: false, "multi-memory": false, "relaxed-simd": false, "tail-call": false },
        sharedArrayBuffer: true,
        crossOriginIsolated: true,
      },
      opfs: { state: "available", evidence: "probe-passed", detail: "live" },
      signals: {
        logicalProcessors: 12,
        deviceMemoryGiB: 16,
        online: true,
        battery: { state: "unavailable", detail: "none" },
        connection: { state: "unavailable", detail: "none" },
        thermal: { state: "unavailable", detail: "none" },
      },
    });

    expect(base.preferredWasmTier).toBe("simd-threads");
    expect(semanticWasmThreadCount(base)).toBe(base.maxWorkerConcurrency);
    expect(semanticWasmThreadCount({ ...base, preferredWasmTier: "threads" })).toBe(base.maxWorkerConcurrency);
    // Without validated threads ORT would clamp the request itself; asking for
    // more would be a claim this page cannot keep.
    expect(semanticWasmThreadCount({ ...base, preferredWasmTier: "simd" })).toBe(1);
    expect(semanticWasmThreadCount({ ...base, preferredWasmTier: "baseline" })).toBe(1);
    expect(semanticWasmThreadCount({ ...base, maxWorkerConcurrency: 64 })).toBe(8);
  });
});

describe("browser capability lifecycle registry", () => {
  it("re-probes on meaningful lifecycle changes and stops cleanly", async () => {
    const target = new EventTarget();
    const first = await minimalReport("2026-07-22T12:00:00.000Z");
    const second = await minimalReport("2026-07-22T12:00:01.000Z");
    const probe = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const registry = new BrowserCapabilityRegistry(probe, {
      windowTarget: target,
      documentTarget: Object.assign(new EventTarget(), { visibilityState: "visible" }),
      connectionTarget: target,
    }, 60_000);
    const observed: BrowserRuntimeCapabilityReport[] = [];
    const unsubscribe = registry.subscribe((report) => observed.push(report));
    await registry.refresh();
    expect(probe).toHaveBeenCalledOnce();

    target.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)?.observedAt).toBe(second.observedAt);

    registry.stop();
    target.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(probe).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

function hermeticHost(): BrowserCapabilityProbeHost {
  return {
    navigator: {} as BrowserCapabilityProbeHost["navigator"],
    isSecureContext: true,
    crossOriginIsolated: false,
    hasWebAssembly: true,
    hasSharedArrayBuffer: false,
    hasCacheStorage: false,
    exposedInterfaces: new Set(),
    hasSyncAccessHandleInterface: false,
    validateWasm: () => false,
    canTransferSharedArrayBuffer: () => false,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    timeoutMs: 50,
  };
}

async function minimalReport(observedAt: string): Promise<BrowserRuntimeCapabilityReport> {
  return probeBrowserRuntimeCapabilities({
    navigator: {} as BrowserCapabilityProbeHost["navigator"],
    isSecureContext: true,
    crossOriginIsolated: false,
    hasWebAssembly: true,
    hasSharedArrayBuffer: false,
    hasCacheStorage: false,
    exposedInterfaces: new Set(),
    hasSyncAccessHandleInterface: false,
    validateWasm: () => false,
    canTransferSharedArrayBuffer: () => false,
    now: () => new Date(observedAt),
    timeoutMs: 50,
  });
}
