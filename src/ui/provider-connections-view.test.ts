import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { InferenceModelDescriptor } from "../inference/providers";
import {
  modelOptionDescription,
  providerBoundaryLabel,
  providerConnectionCountLabel,
  safeProviderErrorMessage,
  supportedModelCapabilityLabels,
} from "./provider-connections-view";

const source = await readFile(new URL("./provider-connections-view.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./provider-connections-view.css", import.meta.url), "utf8");

describe("provider connection presentation", () => {
  it("pluralizes the connected count without ambiguous shorthand", () => {
    expect(providerConnectionCountLabel(0)).toBe("0 connections");
    expect(providerConnectionCountLabel(1)).toBe("1 connection");
    expect(providerConnectionCountLabel(3)).toBe("3 connections");
  });

  it("shows only capabilities carrying supported source evidence", () => {
    const model = fixtureModel({
      "image-input": { state: "supported", source: "provider-directory" },
      reasoning: { state: "unknown", source: "provider-directory" },
      embeddings: { state: "unsupported", source: "provider-directory" },
      "tool-calling": { state: "supported", source: "live-probe" },
    });
    expect(supportedModelCapabilityLabels(model)).toEqual(["Vision", "Tools"]);
    expect(modelOptionDescription(model)).toBe(
      "Provider directory · available · Vision · Tools",
    );
  });

  it("does not infer capabilities from a model name", () => {
    const model = fixtureModel({}, "definitely-vision-reasoning-model");
    expect(supportedModelCapabilityLabels(model)).toEqual([]);
    expect(modelOptionDescription(model)).toContain("no capabilities confirmed by source evidence");
  });

  it("names transport boundaries without promoting them to proof", () => {
    expect(providerBoundaryLabel("e2ee-attestable")).toContain("evidence evaluated separately");
    expect(providerBoundaryLabel("provider-tls")).toBe("Provider TLS · browser direct");
    expect(providerBoundaryLabel("loopback-local")).toBe("This machine · loopback");
    expect(providerBoundaryLabel("e2ee-attestable")).not.toMatch(/\bverified\b/iu);
  });

  it("redacts credential-shaped material and bounds raw provider failures", () => {
    const secret = "cpk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example";
    const message = safeProviderErrorMessage(
      new Error(`Bearer abcdefgh rejected ${secret} ${"x".repeat(500)}`),
      true,
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("abcdefgh");
    expect(message).toContain("[credential]");
    expect(message.length).toBeLessThanOrEqual(320);
    expect(safeProviderErrorMessage(new Error("network"), false)).toContain("Offline");
  });
});

describe("provider connection component contract", () => {
  it("keeps API keys out of component state and clears the DOM field before connecting", () => {
    expect(source).toContain("keyInput.current?.value");
    expect(source).toContain('keyInput.current.value = ""');
    expect(source).not.toContain("setApiKey");
    expect(source).not.toContain("value={apiKey}");
  });

  it("derives OAuth and API-key warnings from the provider registry", () => {
    expect(source).toContain("provider.oauth.detail");
    expect(source).toContain("apiKeyMethod.warning");
    expect(source).not.toContain("const CLOUD =");
  });

  it("requires confirmation before disconnecting the active route", () => {
    expect(source).toContain("Confirm disconnect");
    expect(source).toContain("if (activeModel && !disconnectArmed)");
    expect(source).toContain("This conversation remains readable");
    expect(source).toContain("focusNoticeAfterRemoval.current = true");
    expect(source).toContain("tabIndex={-1}");
  });

  it("delegates disconnect to the app-level route authority", () => {
    expect(source).toContain("await onDisconnect(entry.connection.id)");
    expect(source).not.toContain("browserInferenceFabric.disconnect(");
  });

  it("admits only one provider/session transaction at a time", () => {
    expect(source).toContain("if (abort.current) return");
    expect(source).toContain("disabled={Boolean(busyConnection)}");
    expect(source).not.toContain("A newer connection operation started.");
  });

  it("exposes accessible live state and compact mobile layout", () => {
    expect(source).toContain('aria-busy={Boolean(busyConnection)}');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('class="provider-fabric__cloud-disclosure"');
    expect(source).toContain('placement="down"');
    expect(source).toContain("cardId={`provider-setup-${provider.id}`}");
    expect(source).toContain("tabIndex={-1}");
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain(":focus-visible");
  });

  it("uses the live theme token vocabulary", () => {
    expect(styles).toContain("var(--ink-muted)");
    expect(styles).toContain("var(--surface-soft)");
    expect(styles).toContain("var(--v-verified)");
    expect(styles).not.toContain("var(--muted)");
    expect(styles).not.toContain("var(--surface-2)");
    expect(styles).not.toContain("var(--surface-3)");
    expect(styles).not.toContain("var(--verified)");
    expect(styles).not.toContain("var(--failed)");
    expect(styles).not.toContain("var(--radius-pill)");
  });
});

function fixtureModel(
  capabilities: InferenceModelDescriptor["capabilities"],
  id = "model-1",
): InferenceModelDescriptor {
  return {
    version: 1,
    connectionId: "connection-1",
    connectionGeneration: 1,
    providerId: "provider-1",
    id,
    label: id,
    capabilities,
    availability: {
      state: "available",
      source: "provider-directory",
      observedAt: "2026-07-24T00:00:00.000Z",
    },
    source: {
      kind: "provider-directory",
      observedAt: "2026-07-24T00:00:00.000Z",
    },
  };
}
