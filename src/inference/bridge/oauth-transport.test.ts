import { describe, expect, it } from "vitest";
import { XAI_OAUTH } from "../../auth/provider-oauth/registrations";
import {
  MAX_OAUTH_RESPONSE_BYTES,
  OAUTH_REQUEST_TIMEOUT_MS,
  ProviderOAuthError,
  requireTransportFor,
} from "../../auth/provider-oauth/transport";
import { ExtensionBridgeClient, type BridgeMessageChannel, type BridgeMessageEventLike } from "./client";
import { createExtensionBridgeOAuthTransport } from "./oauth-transport";
import type { BridgeRequestMessage } from "./protocol";

const ORIGIN = "https://airship.test";
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const listeners = new Set<(event: BridgeMessageEventLike) => void>();
  const posted: BridgeRequestMessage[] = [];
  const pageWindow = { name: "page-window" };
  const channel: BridgeMessageChannel = Object.freeze({
    postMessage: (message: BridgeRequestMessage) => {
      posted.push(message);
    },
    addEventListener: (listener: (event: BridgeMessageEventLike) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (listener: (event: BridgeMessageEventLike) => void) => {
      listeners.delete(listener);
    },
    expectedOrigin: ORIGIN,
    expectedSource: pageWindow,
  });
  const deliver = (data: unknown): void => {
    for (const listener of [...listeners]) listener({ data, origin: ORIGIN, source: pageWindow });
  };
  return { channel, posted, deliver };
}

function client(bridge: ReturnType<typeof harness>): ExtensionBridgeClient {
  return new ExtensionBridgeClient(bridge.channel, { limits: { helloTimeoutMs: 20 } });
}

function oauthRequest(overrides: Record<string, unknown> = {}) {
  return {
    provider: "xai" as const,
    url: "https://auth.x.ai/oauth2/device/code",
    method: "POST" as const,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "client_id=b1a00492",
    maxResponseBytes: MAX_OAUTH_RESPONSE_BYTES,
    timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
    ...overrides,
  };
}

/** Build a transport whose `carries` came from a real hello exchange. */
async function connectedTransport(bridge: ReturnType<typeof harness>, providers = ["anthropic", "xai"]) {
  const active = client(bridge);
  const pending = createExtensionBridgeOAuthTransport({ client: active });
  await tick();
  bridge.deliver({
    airshipBridge: 1,
    from: "extension",
    id: bridge.posted[0]!.id,
    kind: "hello",
    version: "0.4.1",
    providers,
  });
  return await pending;
}

describe("extension bridge OAuth transport", () => {
  it("carries nothing when no extension answered, and names the cause", async () => {
    const bridge = harness();
    const transport = await createExtensionBridgeOAuthTransport({ client: client(bridge) });
    expect(transport.id).toBe("extension-bridge");
    expect(transport.carries).toEqual([]);
    expect(() => requireTransportFor(transport, XAI_OAUTH)).toThrow(/browser extension/u);
    await expect(transport.request(oauthRequest())).rejects.toMatchObject({
      code: "transport-unavailable",
    });
  });

  it("carries exactly the providers the live hello reply declared", async () => {
    const bridge = harness();
    const transport = await connectedTransport(bridge, ["xai"]);
    expect(transport.carries).toEqual(["xai"]);
    expect(() => requireTransportFor(transport, XAI_OAUTH)).not.toThrow();
    await expect(transport.request(oauthRequest({
      url: "https://api.anthropic.com/v1/messages",
    }))).rejects.toMatchObject({ code: "transport-unavailable" });
  });

  it("relays a request and returns the decoded bounded body", async () => {
    const bridge = harness();
    const transport = await connectedTransport(bridge);
    const pending = transport.request(oauthRequest());
    await tick();
    const sent = bridge.posted[1]!;
    expect(sent).toMatchObject({
      kind: "fetch",
      provider: "xai",
      path: "https://auth.x.ai/oauth2/device/code",
      method: "POST",
      stream: false,
    });
    bridge.deliver({
      airshipBridge: 1,
      from: "extension",
      id: sent.id,
      kind: "head",
      status: 200,
      headers: { "content-type": "application/json" },
    });
    bridge.deliver({
      airshipBridge: 1,
      from: "extension",
      id: sent.id,
      kind: "chunk",
      seq: 1,
      data: btoa('{"device_code":"d"}'),
    });
    bridge.deliver({ airshipBridge: 1, from: "extension", id: sent.id, kind: "end", seq: 1 });
    await expect(pending).resolves.toEqual({
      status: 200,
      contentType: "application/json",
      body: '{"device_code":"d"}',
    });
  });

  it("reports an extension-side failure as a network cause, not as an absent transport", async () => {
    const bridge = harness();
    const transport = await connectedTransport(bridge);
    const pending = transport.request(oauthRequest());
    await tick();
    bridge.deliver({
      airshipBridge: 1,
      from: "extension",
      id: bridge.posted[1]!.id,
      kind: "error",
      reason: "fetch failed",
    });
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderOAuthError);
    expect(failure).toMatchObject({ code: "network", provider: "xai" });
  });

  it("enforces the caller's response ceiling", async () => {
    const bridge = harness();
    const transport = await connectedTransport(bridge);
    const pending = transport.request(oauthRequest({ maxResponseBytes: 4 }));
    await tick();
    const sent = bridge.posted[1]!;
    bridge.deliver({
      airshipBridge: 1,
      from: "extension",
      id: sent.id,
      kind: "head",
      status: 200,
      headers: {},
    });
    bridge.deliver({
      airshipBridge: 1,
      from: "extension",
      id: sent.id,
      kind: "chunk",
      seq: 1,
      data: btoa("0123456789"),
    });
    await expect(pending).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("refuses an endpoint outside the compiled destination allowlist", async () => {
    const bridge = harness();
    const transport = await connectedTransport(bridge);
    await expect(transport.request(oauthRequest({
      provider: "anthropic" as const,
      url: "https://console.anthropic.com/v1/oauth/token",
    }))).rejects.toMatchObject({ code: "transport-unavailable" });
    // Textually inside an allowlisted prefix, resolves outside it.
    await expect(transport.request(oauthRequest({
      url: "https://auth.x.ai/oauth2/../../evil",
    }))).rejects.toMatchObject({ code: "transport-unavailable" });
    expect(bridge.posted).toHaveLength(1);
  });

  it("refuses a request whose declared provider does not own the URL", async () => {
    /*
     * The URL is not the authority on whose exchange this is. A request that
     * claims one provider and names another's endpoint is a mismatch, and it is
     * reported against the provider the caller declared rather than against
     * whichever one the URL happened to suggest.
     */
    const bridge = harness();
    const transport = await connectedTransport(bridge);
    const failure = await transport.request(oauthRequest({
      provider: "xai" as const,
      url: "https://platform.claude.com/v1/oauth/token",
    })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "transport-unavailable", provider: "xai" });
    expect(bridge.posted).toHaveLength(1);
  });
});
