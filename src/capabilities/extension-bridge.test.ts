import { describe, expect, it } from "vitest";
import {
  extensionBridgeObservation,
  extensionBridgePromptEntries,
  probeExtensionBridge,
} from "./extension-bridge";

describe("extension bridge capability observation", () => {
  it("names the version the handshake actually returned", () => {
    const observation = extensionBridgeObservation({
      kind: "answered",
      version: "0.4.1",
      providers: ["anthropic", "xai"],
      unavailable: [],
      elapsedMs: 12,
    });
    expect(observation).toMatchObject({
      state: "available",
      evidence: "probe-passed",
      extensionVersion: "0.4.1",
      providers: ["anthropic", "xai"],
      handshakeMs: 12,
    });
    expect(observation.detail).toContain("0.4.1");
    expect(observation.detail).toContain("anthropic, xai");
  });

  it("carries the extension's own reason for a provider it will not carry", () => {
    const observation = extensionBridgeObservation({
      kind: "answered",
      version: "0.4.1",
      providers: ["anthropic"],
      unavailable: [{ provider: "xai", reason: "host access for auth.x.ai was not granted" }],
      elapsedMs: 8,
    });
    expect(observation.unavailable).toEqual([
      { provider: "xai", reason: "host access for auth.x.ai was not granted" },
    ]);
    // The cause is the extension's, restated; this side invents none.
    expect(observation.detail).toContain("host access for auth.x.ai was not granted");
  });

  it("reports silence as unavailable with the deadline named", () => {
    const observation = extensionBridgeObservation({ kind: "silent", deadlineMs: 1_500 });
    expect(observation).toMatchObject({
      state: "unavailable",
      evidence: "not-observed",
      providers: [],
    });
    expect(observation.extensionVersion).toBeUndefined();
    expect(observation.detail).toContain("1500 ms");
  });

  it("separates a rejected reply from an absent extension", () => {
    expect(extensionBridgeObservation({ kind: "malformed", detail: "bad providers" }))
      .toMatchObject({ state: "failed", evidence: "probe-failed" });
    expect(extensionBridgeObservation({ kind: "unsupported", detail: "no page window" }))
      .toMatchObject({ state: "unavailable", evidence: "not-observed" });
  });

  it("never claims a capability the probe did not observe", async () => {
    const silent = await probeExtensionBridge(async () => ({ kind: "silent", deadlineMs: 1_500 }));
    expect(extensionBridgePromptEntries(silent)).toEqual([]);
    const present = await probeExtensionBridge(async () => ({
      kind: "answered",
      version: "0.4.1",
      providers: ["xai"],
      unavailable: [],
      elapsedMs: 3,
    }));
    const entries = extensionBridgePromptEntries(present);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "extension-bridge", evidence: "probe-passed" });
    expect(entries[0]!.detail).toContain("0.4.1");
  });

  it("reports a throwing probe as failed rather than assuming either answer", async () => {
    const observation = await probeExtensionBridge(async () => {
      throw new TypeError("relay exploded");
    });
    expect(observation).toMatchObject({ state: "failed", evidence: "probe-failed", providers: [] });
    expect(observation.detail).toContain("TypeError");
  });

  it("states that the bridge changes reachability only", () => {
    const observation = extensionBridgeObservation({
      kind: "answered",
      version: "0.4.1",
      providers: [],
      unavailable: [],
      elapsedMs: 1,
    });
    // docs/EXTENSION_BRIDGE.md: installing the extension creates no attestation
    // or trust claim, so the record a surface renders must say so.
    expect(observation.detail).toMatch(/no attestation|creates no attestation|Reachability only/u);
    expect(observation.detail).toContain("no providers");
  });
});
