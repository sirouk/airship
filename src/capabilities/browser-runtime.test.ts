import { describe, expect, it, vi } from "vitest";
import {
  BrowserCapabilityRegistry,
  browserCapabilityPromptEntries,
  deriveAdaptiveSchedulingPolicy,
  probeBrowserRuntimeCapabilities,
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
      exposedInterfaces: new Set(["VideoEncoder", "VideoDecoder", "WebTransport", "FileSystemSyncAccessHandle"]),
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
    expect(report.opfs).toMatchObject({ state: "failed", evidence: "probe-failed" });
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

async function minimalReport(observedAt: string): Promise<BrowserRuntimeCapabilityReport> {
  return probeBrowserRuntimeCapabilities({
    navigator: {} as BrowserCapabilityProbeHost["navigator"],
    isSecureContext: true,
    crossOriginIsolated: false,
    hasWebAssembly: true,
    hasSharedArrayBuffer: false,
    hasCacheStorage: false,
    exposedInterfaces: new Set(),
    validateWasm: () => false,
    canTransferSharedArrayBuffer: () => false,
    now: () => new Date(observedAt),
    timeoutMs: 50,
  });
}
