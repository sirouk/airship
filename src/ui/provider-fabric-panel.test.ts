import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  InferenceAvailabilityConnection,
  InferenceAvailabilitySnapshot,
} from "../inference/providers";
import {
  capabilityLabel,
  modelDescription,
  providerConnectionCount,
} from "./provider-fabric-panel";
import {
  inferenceModelRoutes,
  inferenceRouteValue,
  providerRoutePosture,
} from "./provider-model-control";

const [panelSource, controlSource, styles] = await Promise.all([
  readFile(new URL("./provider-fabric-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("./provider-model-control.tsx", import.meta.url), "utf8"),
  readFile(new URL("./provider-fabric-panel.css", import.meta.url), "utf8"),
]);

describe("provider fabric presentation contract", () => {
  it("keeps same-provider authorities distinct and model routes connection-scoped", () => {
    const snapshot = availability([
      connection("openai-work", "openai", "OpenAI", "Work", "gpt-5", ["tool-calling"]),
      connection("openai-lab", "openai", "OpenAI", "Lab", "gpt-5", ["reasoning"]),
      connection("ollama-local", "ollama", "Ollama", "Laptop", "qwen", ["image-input"]),
    ]);

    expect(providerConnectionCount(snapshot, "openai")).toBe(2);
    expect(inferenceModelRoutes(snapshot).map((route) => [
      route.connectionId,
      route.modelId,
      route.supportedCapabilities,
    ])).toEqual([
      ["openai-work", "gpt-5", ["tool-calling"]],
      ["openai-lab", "gpt-5", ["reasoning"]],
      ["ollama-local", "qwen", ["image-input"]],
    ]);
    expect(inferenceRouteValue("openai-work", "gpt-5"))
      .not.toBe(inferenceRouteValue("openai-lab", "gpt-5"));
  });

  it("renders only discovered capabilities and honest route health", () => {
    const model = connection(
      "local",
      "ollama",
      "Ollama",
      "Laptop",
      "gemma",
      ["image-input", "tool-calling"],
    ).models[0]!;
    expect(modelDescription(model)).toBe("Available · Vision · Tools");
    expect(capabilityLabel("billing:read")).toBe("Billing");
    expect(capabilityLabel("unknown-capability")).toBe("unknown capability");

    const unchecked = {
      ...connection("c", "openai", "OpenAI", "Work", "gpt", []),
      health: "unchecked",
      canInvoke: false,
    } satisfies InferenceAvailabilityConnection;
    expect(providerRoutePosture(unchecked, undefined)).toBe("Invoke not proved");
    expect(providerRoutePosture({ ...unchecked, health: "ready", canInvoke: true }, "ready")).toBe("Ready");
    expect(providerRoutePosture({ ...unchecked, health: "degraded", canInvoke: true }, "ready")).toBe("Ready · degraded");
    expect(providerRoutePosture({ ...unchecked, health: "ready", canInvoke: true }, "connection-replaced"))
      .toBe("Route needs attention");
    expect(providerRoutePosture(undefined, undefined, true)).toBe("Opening pinned thread…");
  });

  it("offers real Chutes navigation without inventing OAuth for other providers", () => {
    expect(panelSource).toContain("configured-public-pkce");
    expect(panelSource).toContain("onOpen(): void");
    expect(panelSource).toContain("provider.descriptor.oauth.detail");
    expect(panelSource).toContain('kind: "cloud-api-key"');
    expect(panelSource).not.toContain('kind: "cloud-oauth"');
    expect(panelSource).not.toMatch(/Connect with (?:OpenAI|Anthropic|xAI)/u);
    expect(panelSource).toContain("not a provider-published third-party OAuth grant");
  });

  it("does not add a persistence path for provider credentials", () => {
    expect(`${panelSource}\n${controlSource}`).not.toMatch(
      /localStorage|sessionStorage|indexedDB|StorageManager|persistCredential/u,
    );
    expect(panelSource).toContain("const secrets = useRef");
    expect(panelSource).toContain("if (input) input.value = \"\"");
    expect(panelSource).toContain("errors are not copied into the DOM");
    expect(panelSource).not.toContain("caught.message");
  });

  it("makes route adoption explicit and preserves the existing pin on failure", () => {
    expect(panelSource).toContain("Use in new thread");
    expect(panelSource).toContain("Airship never retargets a");
    expect(controlSource).toContain("newly pinned conversation");
    expect(controlSource).toContain("existing conversation pin was preserved");
    expect(controlSource).toContain("inferenceRouteValue");
  });

  it("uses the accessible menu contract and collapses cleanly on small screens", () => {
    expect(`${panelSource}\n${controlSource}`).not.toMatch(/<select(?:\\s|>)/u);
    expect(panelSource).toContain("<MenuSelect");
    expect(controlSource).toContain('ariaLabel="Session inference provider and model"');
    expect(styles).toContain("@media (max-width: 820px)");
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain(".provider-model-control .menu-select-popover");
  });
});

function availability(
  connections: readonly InferenceAvailabilityConnection[],
): InferenceAvailabilitySnapshot {
  return {
    version: 1,
    capturedAt: "2026-07-24T12:00:00.000Z",
    connections,
    omittedConnections: 0,
  };
}

function connection(
  id: string,
  providerId: string,
  providerLabel: string,
  connectionLabel: string,
  modelId: string,
  supportedCapabilities: InferenceAvailabilityConnection["models"][number]["supportedCapabilities"],
): InferenceAvailabilityConnection {
  return {
    id,
    providerId,
    providerLabel,
    connectionLabel,
    authKind: providerId === "ollama" ? "local-none" : "api-key",
    health: "ready",
    canInvoke: true,
    availableCapabilities: ["invoke", "models:list"],
    models: [{
      id: modelId,
      label: modelId,
      availability: "available",
      supportedCapabilities,
    }],
    omittedModels: 0,
  };
}
