import { describe, expect, it } from "vitest";
import { probeBrowserRuntimeCapabilities } from "../capabilities/browser-runtime";
import { ToolRegistry } from "./registry";
import { registerBrowserCapabilityTool } from "./browser-capabilities";

describe("inspect_browser_capabilities tool", () => {
  it("returns the exact observed report without promoting unavailable accelerators", async () => {
    const report = await probeBrowserRuntimeCapabilities({
      navigator: {},
      isSecureContext: true,
      crossOriginIsolated: false,
      hasWebAssembly: true,
      hasSharedArrayBuffer: false,
      hasCacheStorage: false,
      exposedInterfaces: new Set(),
      validateWasm: () => false,
      canTransferSharedArrayBuffer: () => false,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      timeoutMs: 50,
    });
    const registry = new ToolRegistry();
    registerBrowserCapabilityTool(registry, async () => report);
    const tool = registry.get("inspect_browser_capabilities");
    const controller = new AbortController();
    const result = await tool!.execute({}, {
      sessionId: "session",
      turnId: "turn",
      operationId: "operation",
      signal: controller.signal,
    });

    expect(tool?.definition.effect).toBe("read");
    expect(JSON.parse(result.content)).toMatchObject({
      webgpu: { state: "unavailable" },
      webnn: { state: "unavailable" },
      wasm: { state: "available" },
      signals: { thermal: { state: "unavailable" } },
    });
    expect(result.metadata).toEqual({
      observedAt: report.observedAt,
      schedulingClass: report.scheduling.class,
      preferredSemanticBackend: report.scheduling.preferredSemanticBackend,
    });
  });
});
