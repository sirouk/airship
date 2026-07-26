import { describe, expect, it } from "vitest";
import { extensionBridgeObservation } from "../../capabilities/extension-bridge";
import { CONNECT_LANE_IDS, describeConnectLanes, type ConnectLaneId, type ConnectLaneInput } from "./connect-lanes";
import { observeHostExtensionSupport } from "./extension-bridge-presence";

const DESKTOP = observeHostExtensionSupport(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
);
const CHROME_ANDROID = observeHostExtensionSupport(
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
);
// Built by the bridge package's own reader, so a lane can never be asserted
// against a record shape that nothing in production produces.
const BRIDGE_SILENT = extensionBridgeObservation({ kind: "silent", deadlineMs: 1_500 });
const INSTALL_URL = "https://example.invalid/airship-extension";

function input(overrides: Partial<ConnectLaneInput> = {}): ConnectLaneInput {
  return Object.freeze({
    online: true,
    chutes: { connected: false, signInAvailable: true },
    codex: { connected: false, available: true },
    claude: { connected: false, signInAvailable: true },
    grok: { connected: false, signInAvailable: true },
    bridge: BRIDGE_SILENT,
    host: DESKTOP,
    local: { connected: [] },
    ...overrides,
  });
}

function lane(lanes: readonly { id: ConnectLaneId }[], id: ConnectLaneId) {
  const found = lanes.find((entry) => entry.id === id);
  if (!found) throw new Error(`lane ${id} was not rendered`);
  return found as ReturnType<typeof describeConnectLanes>[number];
}

describe("connect lanes", () => {
  it("renders every canonical lane exactly once", () => {
    const lanes = describeConnectLanes(input());
    expect(lanes.map((entry) => entry.id).sort()).toEqual([...CONNECT_LANE_IDS].sort());
  });

  it("keeps every provider actionable when its API-key route works", () => {
    const order = describeConnectLanes(input()).map((entry) => entry.id);
    expect(order.indexOf("chutes")).toBeLessThan(order.indexOf("claude"));
    expect(order.indexOf("codex")).toBeLessThan(order.indexOf("claude"));
    expect(lane(describeConnectLanes(input()), "claude").status.kind).toBe("ready");
    expect(lane(describeConnectLanes(input()), "grok").status.kind).toBe("ready");
  });

  it("puts a connected lane first without reshuffling the rest", () => {
    const order = describeConnectLanes(input({ grok: { connected: true } })).map((entry) => entry.id);
    expect(order[0]).toBe("grok");
    expect(order.slice(1)).toEqual(["chutes", "codex", "claude", "local"]);
  });

  it("keeps every other lane offerable once Chutes is connected", () => {
    const lanes = describeConnectLanes(input({ chutes: { connected: true, signInAvailable: false } }));
    expect(lanes[0]?.id).toBe("chutes");
    expect(lane(lanes, "chutes").status.kind).toBe("connected");
    expect(lane(lanes, "local").status.kind).toBe("ready");
    expect(lane(lanes, "codex").status.kind).toBe("ready");
  });

  it("keeps the Chutes lane usable when sign-in is unconfigured, and names the cause", () => {
    const chutes = lane(describeConnectLanes(input({
      chutes: {
        connected: false,
        signInAvailable: false,
        signInUnavailableReason: "The local Chutes bridge is not configured in this build.",
      },
    })), "chutes");
    expect(chutes.status.kind).toBe("ready");
    expect(chutes.status.label).toBe("Use an API key");
    expect(chutes.status.detail).toContain("not configured in this build");
    expect(chutes.status.detail).toContain("API key instead");
    expect(chutes.status.detail).toContain("cpk_");
    // The summary sits one line above the detail and is bound by the same rule.
    expect(chutes.summary).not.toMatch(/sign in/iu);
    expect(chutes.summary).toContain("API key");
  });

  it("offers sign-in in the Chutes summary only when the exchange exists", () => {
    expect(lane(describeConnectLanes(input()), "chutes").summary).toMatch(/sign in/iu);
  });

  it("never offers a ChatGPT sign-in the build cannot start", () => {
    const codex = lane(describeConnectLanes(input({ codex: { connected: false, available: false } })), "codex");
    expect(codex.status.kind).toBe("unavailable");
    expect(codex.summary).not.toMatch(/sign in with your chatgpt/iu);
  });

  it("warns about the error-looking page before the Codex tab is opened", () => {
    const status = lane(describeConnectLanes(input()), "codex").status;
    expect(status.kind).toBe("ready");
    expect(status.detail).toContain("look like an error");
    expect(status.detail).toContain("address bar");
  });

  it("never claims a provider the bridge did not say it carries", () => {
    const lanes = describeConnectLanes(input({
      bridge: extensionBridgeObservation({
        kind: "answered",
        version: "1.4.0",
        providers: ["anthropic"],
        unavailable: [{ provider: "xai", reason: "no header-rewrite mechanism in this browser" }],
        elapsedMs: 9,
      }),
    }));
    expect(lane(lanes, "claude").oauthStatus?.kind).toBe("ready");
    const grok = lane(lanes, "grok").oauthStatus;
    expect(grok).toBeDefined();
    if (!grok) throw new Error("missing Grok OAuth status");
    expect(grok.kind).toBe("needs-extension");
    expect(grok.detail).toContain("1.4.0");
    expect(grok.detail).toContain("does not carry Grok");
    expect(grok.detail).toContain("no header-rewrite mechanism");
  });

  it("does not confuse an answering extension with a wired OAuth controller", () => {
    const claude = lane(describeConnectLanes(input({
      claude: { connected: false, signInAvailable: false },
      bridge: extensionBridgeObservation({
        kind: "answered",
        version: "1.4.0",
        providers: ["anthropic"],
        unavailable: [],
        elapsedMs: 9,
      }),
    })), "claude");
    expect(claude.status.kind).toBe("ready");
    expect(claude.oauthStatus?.kind).toBe("unavailable");
    expect(claude.oauthStatus?.detail).toContain("cannot start and commit");
  });

  it("reports checking, never absent, while the observation is in flight", () => {
    const lanes = describeConnectLanes(input({ bridge: undefined }));
    expect(lane(lanes, "claude").oauthStatus?.kind).toBe("checking");
    expect(lane(lanes, "grok").oauthStatus?.kind).toBe("checking");
    expect(lane(lanes, "claude").status.kind).toBe("ready");
  });

  it("asks for an install only where there is an install page to reach", () => {
    const withPage = lane(describeConnectLanes(input({ extensionInstallUrl: INSTALL_URL })), "claude").oauthStatus;
    expect(withPage).toBeDefined();
    if (!withPage) throw new Error("missing Claude OAuth status");
    expect(withPage.kind).toBe("needs-extension");
    expect(withPage.label).toBe("Add the Airship extension");

    // No published page: the instruction cannot be followed, so it is not given.
    const withoutPage = lane(describeConnectLanes(input()), "claude").oauthStatus;
    expect(withoutPage).toBeDefined();
    if (!withoutPage) throw new Error("missing Claude OAuth status");
    expect(withoutPage.kind).toBe("extension-unavailable");
    expect(withoutPage.label).not.toMatch(/add the airship extension/iu);
    expect(withoutPage.detail).toContain("built from source");
  });

  it("explains why the extension exists and offers each vendor's key alternative", () => {
    const lanes = describeConnectLanes(input());
    const claude = lane(lanes, "claude").oauthStatus;
    expect(claude).toBeDefined();
    if (!claude) throw new Error("missing Claude OAuth status");
    expect(claude.detail).toContain("Anthropic does not let a browser page read its sign-in replies");
    expect(claude.kind === "extension-unavailable" && claude.alternative).toContain("Anthropic API key");
    // xAI's key adapter and `connect-src` entry both exist, so the lane owes a
    // person that route rather than under-claiming it away.
    const grok = lane(lanes, "grok").oauthStatus;
    expect(grok).toBeDefined();
    if (!grok) throw new Error("missing Grok OAuth status");
    expect(grok.kind === "extension-unavailable" && grok.alternative).toContain("xAI API key");
  });

  it("says the browser cannot host an extension without blaming the person", () => {
    const status = lane(describeConnectLanes(input({ host: CHROME_ANDROID })), "grok").oauthStatus;
    expect(status).toBeDefined();
    if (!status) throw new Error("missing Grok OAuth status");
    expect(status.kind).toBe("extension-unavailable");
    expect(status.label).toBe("Not possible in this browser");
    expect(status.detail).toContain("cannot install extensions");
    expect(status.detail).not.toMatch(/you (?:must|need to|should|failed)/iu);
  });

  it("never says a local server was detected before anything was checked", () => {
    const status = lane(describeConnectLanes(input()), "local").status;
    expect(status.kind).toBe("ready");
    expect(status.detail).toContain("has not looked yet");
    expect(status.detail).not.toMatch(/detected|found|running/iu);
  });

  it("names the local servers that actually answered once they have", () => {
    const status = lane(describeConnectLanes(input({ local: { connected: ["Ollama"] } })), "local").status;
    expect(status.kind).toBe("connected");
    expect(status.detail).toContain("Ollama answered");
  });

  it("degrades every network lane to offline and leaves the local lane alone", () => {
    const lanes = describeConnectLanes(input({ online: false }));
    for (const id of ["chutes", "codex"] as const) {
      expect(lane(lanes, id).status.kind, id).toBe("offline");
    }
    expect(lane(lanes, "local").status.kind).toBe("ready");
  });

  it("maps every lane state onto the app's one seal family", () => {
    const seals = describeConnectLanes(input()).map((entry) => entry.seal);
    expect(seals.every((seal) => ["none", "checking", "stale", "verified", "asserted", "attention", "failed"].includes(seal))).toBe(true);
  });
});
