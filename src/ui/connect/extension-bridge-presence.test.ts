import { describe, expect, it } from "vitest";
import { extensionBridgeObservation } from "../../capabilities/extension-bridge";
import type { BridgeHandshakeResult } from "../../inference/bridge/protocol";
import {
  bridgeCarriesProvider,
  bridgeRefusalReason,
  bridgeSummary,
  observeHostExtensionSupport,
} from "./extension-bridge-presence";

const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/*
 * Every observation below is built by the bridge package's own reader from a
 * real `BridgeHandshakeResult` shape. Restating the record here is what let the
 * surface read a shape nothing ever produced, so these readers are exercised
 * against the authority instead of a local literal.
 */
function observe(result: BridgeHandshakeResult) {
  return extensionBridgeObservation(result);
}

describe("host extension support", () => {
  it("names Chrome for Android as unable to host an extension at all", () => {
    const support = observeHostExtensionSupport(CHROME_ANDROID);
    expect(support.kind).toBe("cannot-host");
    expect(support.kind === "cannot-host" && support.reason).toContain("Firefox for Android");
    expect(support.evidence).toBe("browser-self-report");
  });

  it("keeps Firefox for Android installable — it is the one mobile browser that works", () => {
    expect(observeHostExtensionSupport(FIREFOX_ANDROID).kind).toBe("installable");
  });

  it("separates iOS, where an extension could exist but Airship publishes none", () => {
    const support = observeHostExtensionSupport(IPHONE_SAFARI);
    expect(support.kind).toBe("not-published");
    expect(support.kind === "not-published" && support.reason).toContain("App Store");
  });

  it("treats every unrecognised browser as installable rather than guessing a refusal", () => {
    expect(observeHostExtensionSupport(DESKTOP_CHROME).kind).toBe("installable");
    expect(observeHostExtensionSupport("").kind).toBe("installable");
  });
});

describe("reading the bridge package's observation", () => {
  it("never reports a provider the extension did not say it carries", () => {
    const answered = observe({
      kind: "answered",
      version: "1.2.0",
      providers: ["anthropic"],
      unavailable: [{ provider: "xai", reason: "no header-rewrite mechanism in this browser" }],
      elapsedMs: 12,
    });
    expect(bridgeCarriesProvider(answered, "anthropic")).toBe(true);
    expect(bridgeCarriesProvider(answered, "xai")).toBe(false);
  });

  it("treats an unsettled observation as carrying nothing rather than as an absence", () => {
    expect(bridgeCarriesProvider(undefined, "anthropic")).toBe(false);
    expect(bridgeCarriesProvider(observe({ kind: "silent", deadlineMs: 400 }), "anthropic")).toBe(false);
  });

  it("passes the extension's own refusal cause through instead of inventing one", () => {
    const answered = observe({
      kind: "answered",
      version: "1.2.0",
      providers: ["anthropic"],
      unavailable: [{ provider: "xai", reason: "not been granted access to the provider hosts" }],
      elapsedMs: 12,
    });
    expect(bridgeRefusalReason(answered, "xai")).toBe("not been granted access to the provider hosts");
    expect(bridgeRefusalReason(answered, "anthropic")).toBeUndefined();
    expect(bridgeRefusalReason(undefined, "xai")).toBeUndefined();
  });

  it("prints the version the extension actually returned", () => {
    const summary = bridgeSummary(observe({
      kind: "answered",
      version: "0.4.1",
      providers: ["xai", "anthropic"],
      unavailable: [],
      elapsedMs: 8,
    }));
    expect(summary).toContain("0.4.1");
    expect(summary).toContain("xai, anthropic");
  });

  it("passes an absence through with its named deadline instead of a generic line", () => {
    expect(bridgeSummary(observe({ kind: "silent", deadlineMs: 400 }))).toContain("400 ms");
  });

  it("keeps 'could not ask' separate from 'asked and heard nothing'", () => {
    const summary = bridgeSummary(observe({ kind: "unsupported", detail: "no page window to relay through" }));
    expect(summary).toContain("no page window to relay through");
    expect(summary).not.toContain("within");
  });

  it("fails a malformed reply closed rather than counting it as a working extension", () => {
    const malformed = observe({ kind: "malformed", detail: "unknown protocol version" });
    expect(bridgeCarriesProvider(malformed, "anthropic")).toBe(false);
    expect(bridgeSummary(malformed)).toContain("rejected");
  });

  it("says it is still checking while an observation is in flight", () => {
    expect(bridgeSummary(undefined)).toContain("Checking");
  });
});
