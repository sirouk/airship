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

/*
 * `provider-model-control.tsx` used to be read here too.
 *
 * It was a fourth session-model control with a fourth capability vocabulary,
 * imported by no production module — this test file was its only importer, so
 * every assertion about its copy, its `aria-label` and its popover width was a
 * test proving a test. Deleting it removes the vocabulary rather than
 * documenting it. The one control Chat renders is `ModelControl`, and the
 * shared model vocabulary is asserted where it is actually used.
 */
const [panelSource, styles] = await Promise.all([
  readFile(new URL("./provider-fabric-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("./provider-fabric-panel.css", import.meta.url), "utf8"),
]);

describe("provider fabric presentation contract", () => {
  it("keeps same-provider authorities distinct", () => {
    const snapshot = availability([
      connection("openai-work", "openai", "OpenAI", "Work", "gpt-5", ["tool-calling"]),
      connection("openai-lab", "openai", "OpenAI", "Lab", "gpt-5", ["reasoning"]),
      connection("ollama-local", "ollama", "Ollama", "Laptop", "qwen", ["image-input"]),
    ]);

    expect(providerConnectionCount(snapshot, "openai")).toBe(2);
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
  });

  /*
   * The fourth session-model control is gone, not merely unimported.
   *
   * `ProviderModelControl` shipped a parallel `Session model` menu with its own
   * route vocabulary and its own posture strings, reachable from nowhere. A
   * dead control is not neutral: the next reader wiring a model picker finds
   * two candidates and no statement of which one is the product's, which is how
   * this surface came to have three live vocabularies in the first place.
   */
  it("leaves no second session-model control behind", async () => {
    await expect(readFile(new URL("./provider-model-control.tsx", import.meta.url), "utf8"))
      .rejects.toThrow();
    expect(styles).not.toContain(".provider-model-control");
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
    expect(panelSource).not.toMatch(
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
  });

  it("uses the accessible menu contract and collapses cleanly on small screens", () => {
    expect(panelSource).not.toMatch(/<select(?:\\s|>)/u);
    expect(panelSource).toContain("<MenuSelect");
    expect(styles).toContain("@media (max-width: 820px)");
    expect(styles).toContain("@media (max-width: 520px)");
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
