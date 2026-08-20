import { describe, expect, it, vi } from "vitest";
import type { InferenceRequest } from "../../core/contracts";
import {
  ExtensionBridgeClient,
  type BridgeMessageChannel,
  type BridgeMessageEventLike,
} from "../bridge/client";
import type { BridgeRequestMessage } from "../bridge/protocol";
import {
  AnthropicBrowserTransport,
  OpenAiBrowserTransport,
  ProviderTransportError,
  XaiBrowserTransport,
  type ProviderFetch,
} from "./browser-cloud";
import { InferenceConnectionRegistry } from "./connection-registry";
import type { InferenceProviderDescriptor } from "./contracts";
import { InferenceProviderCatalog } from "./provider-catalog";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const ORIGIN = "https://airship.test";
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type ScriptedReply = Readonly<{
  status?: number;
  contentType: string;
  body: string;
}>;

/**
 * A scripted extension behind the real protocol client: these tests drive the
 * transport through the same envelope, ordering, and validation the shipped
 * bridge uses, not through a stub of it.
 */
function scriptedBridge(
  reply: ScriptedReply | undefined,
  providers: readonly string[] = ["anthropic", "xai"],
) {
  const listeners = new Set<(event: BridgeMessageEventLike) => void>();
  const posted: BridgeRequestMessage[] = [];
  const pageWindow = { name: "page-window" };
  const send = (data: unknown): void => {
    for (const listener of [...listeners]) listener({ data, origin: ORIGIN, source: pageWindow });
  };
  const channel: BridgeMessageChannel = Object.freeze({
    postMessage: (message: BridgeRequestMessage) => {
      posted.push(message);
      queueMicrotask(() => {
        if (message.kind === "hello") {
          send({
            airshipBridge: 1,
            from: "extension",
            id: message.id,
            kind: "hello",
            version: "0.4.1",
            providers,
          });
          return;
        }
        if (message.kind !== "fetch" || !reply) return;
        send({
          airshipBridge: 1,
          from: "extension",
          id: message.id,
          kind: "head",
          status: reply.status ?? 200,
          headers: { "content-type": reply.contentType },
        });
        send({
          airshipBridge: 1,
          from: "extension",
          id: message.id,
          kind: "chunk",
          seq: 1,
          data: btoa(reply.body),
        });
        send({ airshipBridge: 1, from: "extension", id: message.id, kind: "end", seq: 1 });
      });
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
  return {
    posted,
    client: new ExtensionBridgeClient(channel, { limits: { helloTimeoutMs: 20 } }),
    fetchMessages: (): BridgeRequestMessage[] => posted.filter((m) => m.kind === "fetch"),
  };
}

function oauthDescriptor(id: "anthropic" | "xai" | "openai"): InferenceProviderDescriptor {
  return {
    version: 1,
    id,
    label: id,
    protocol: id === "anthropic" ? "anthropic-messages" : "openai-responses",
    transportBoundary: "provider-tls",
    baseUrl: `https://api.${id === "anthropic" ? "anthropic.com" : id === "xai" ? "x.ai" : "openai.com"}/v1/`,
    oauth: {
      state: "configured-public-pkce",
      authMethodId: `${id}-oauth`,
      detail: "Fixture registration for the bridged OAuth route.",
    },
    authMethods: [{
      id: `${id}-oauth`,
      kind: "oauth-public-pkce",
      label: `${id} account`,
      authorizationEndpoint: `https://auth.${id}.test/authorize`,
      tokenEndpoint: `https://auth.${id}.test/token`,
      clientId: "fixture-client",
      redirectUris: ["https://airship.test/callback"],
      scopes: ["user:inference"],
      tokenEndpointAuthMethod: "none",
      codeChallengeMethod: "S256",
      browserUse: "reviewed-direct",
      review: {
        id: "fixture-review",
        reviewedAt: "2026-07-25T00:00:00.000Z",
        sourceUrl: "https://airship.test/review",
      },
    }, {
      id: `${id}-api-key`,
      kind: "api-key",
      label: `${id} API key`,
      header: { name: id === "anthropic" ? "x-api-key" : "Authorization", scheme: id === "anthropic" ? "raw" : "bearer" },
      browserUse: "dangerous-user-opt-in",
      warning: "Fixture warning for a page-memory key.",
    }],
    capabilities: ["invoke", "models:list"],
    documentationUrl: `https://docs.${id}.test/`,
  };
}

function connections(
  id: "anthropic" | "xai" | "openai",
  kind: "oauth" | "api-key",
): InferenceConnectionRegistry {
  const registry = new InferenceConnectionRegistry(
    new InferenceProviderCatalog([oauthDescriptor(id)]),
    () => NOW,
  );
  if (kind === "oauth") {
    registry.connectOAuth({
      id: `${id}-connection`,
      providerId: id,
      authMethodId: `${id}-oauth`,
      label: `${id} account`,
      accessToken: "oauth-access-token",
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      scopes: ["user:inference"],
      connectedAt: new Date(NOW).toISOString(),
    });
  } else {
    registry.connectApiKey({
      id: `${id}-connection`,
      providerId: id,
      authMethodId: `${id}-api-key`,
      label: `${id} key`,
      apiKey: "sk-page-memory",
      connectedAt: new Date(NOW).toISOString(),
    });
  }
  return registry;
}

const ANTHROPIC_CATALOG = JSON.stringify({
  data: [{ id: "claude-fixture", display_name: "Claude Fixture" }],
  has_more: false,
});

const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function inferenceRequest(): InferenceRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    turnId: "turn-1",
    idempotencyKey: "idempotency-1",
    model: "claude-fixture",
    systemPrompt: "You are a fixture.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };
}

describe("browser cloud transports and the extension bridge", () => {
  it("keeps the Anthropic API-key path on the direct browser fetch", async () => {
    const bridge = scriptedBridge({ contentType: "application/json", body: ANTHROPIC_CATALOG });
    const fetch = vi.fn<ProviderFetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-page-memory");
      expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("user-agent")).toBeNull();
      return new Response(ANTHROPIC_CATALOG, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const transport = new AnthropicBrowserTransport({
      connectionId: "anthropic-connection",
      connectionGeneration: 1,
      connections: connections("anthropic", "api-key"),
      bridge: bridge.client,
      fetch,
      now: () => NOW,
    });

    const models = await transport.listModels();
    expect(models).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    // The bridge is available and still untouched: an API key never leaves the page.
    expect(bridge.posted).toHaveLength(0);
  });

  it("reports Anthropic OAuth as typed unavailable without retaining relay prose", async () => {
    const fetch = vi.fn<ProviderFetch>(async () => new Response("{}", { status: 200 }));
    const transport = new AnthropicBrowserTransport({
      connectionId: "anthropic-connection",
      connectionGeneration: 1,
      connections: connections("anthropic", "oauth"),
      bridge: null,
      fetch,
      now: () => NOW,
    });

    const failure = await transport.listModels().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTransportError);
    expect(failure).toMatchObject({ code: "bridge-unavailable" });
    expect((failure as Error).message).toBe("Inference provider relay is unavailable.");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    // Fail closed: no silent fallback to a direct request that would be refused.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not disguise an absent extension as a network or CORS failure", async () => {
    // A bridge client exists, but nothing answers its handshake.
    const silent = scriptedBridge(undefined, []);
    const silentClient = new ExtensionBridgeClient(
      Object.freeze({
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        expectedOrigin: ORIGIN,
        expectedSource: {},
      }),
      { limits: { helloTimeoutMs: 5 } },
    );
    const transport = new XaiBrowserTransport({
      connectionId: "xai-connection",
      connectionGeneration: 1,
      connections: connections("xai", "oauth"),
      bridge: silentClient,
      fetch: async () => new Response("{}", { status: 200 }),
      now: () => NOW,
    });

    const failure = await transport.listModels().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "bridge-unavailable" });
    expect((failure as ProviderTransportError).code).not.toBe("network-or-cors");
    expect((failure as Error).message).toBe("Inference provider relay is unavailable.");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(silent.posted).toHaveLength(0);
  });

  it("sends Anthropic OAuth inference through the bridge with the Claude Code fingerprint", async () => {
    const bridge = scriptedBridge({ contentType: "text/event-stream", body: ANTHROPIC_STREAM });
    const fetch = vi.fn<ProviderFetch>(async () => {
      throw new Error("the OAuth route must never touch the direct fetch");
    });
    const transport = new AnthropicBrowserTransport({
      connectionId: "anthropic-connection",
      connectionGeneration: 1,
      connections: connections("anthropic", "oauth"),
      bridge: bridge.client,
      fetch,
      now: () => NOW,
    });

    const events = [];
    for await (const event of transport.stream(inferenceRequest(), new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toContainEqual({ type: "text-delta", text: "hi" });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(fetch).not.toHaveBeenCalled();

    const sent = bridge.fetchMessages()[0]!;
    expect(sent).toMatchObject({
      provider: "anthropic",
      path: "https://api.anthropic.com/v1/messages",
      method: "POST",
      stream: true,
    });
    expect(sent.headers).toMatchObject({
      authorization: "Bearer oauth-access-token",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
    });
    expect(sent.headers?.["user-agent"]).toMatch(/^claude-code\//u);
    // The direct-browser acknowledgement belongs to the API-key path only, and
    // an OAuth token must never be sent as an API key.
    expect(sent.headers?.["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(sent.headers?.["x-api-key"]).toBeUndefined();
  });

  it("routes xAI OAuth through the bridge and keeps xAI API keys direct", async () => {
    const catalog = JSON.stringify({ models: [{ id: "grok-fixture" }] });
    const bridged = scriptedBridge({ contentType: "application/json", body: catalog });
    const bridgedTransport = new XaiBrowserTransport({
      connectionId: "xai-connection",
      connectionGeneration: 1,
      connections: connections("xai", "oauth"),
      bridge: bridged.client,
      fetch: async () => {
        throw new Error("the OAuth route must never touch the direct fetch");
      },
      now: () => NOW,
    });
    await expect(bridgedTransport.listModels()).resolves.toHaveLength(1);
    expect(bridged.fetchMessages()[0]).toMatchObject({
      provider: "xai",
      path: "https://api.x.ai/v1/language-models",
      method: "GET",
      stream: false,
    });
    expect(bridged.fetchMessages()[0]!.headers).toMatchObject({
      authorization: "Bearer oauth-access-token",
    });

    const direct = scriptedBridge({ contentType: "application/json", body: catalog });
    const directFetch = vi.fn<ProviderFetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-page-memory");
      return new Response(catalog, { status: 200, headers: { "content-type": "application/json" } });
    });
    const directTransport = new XaiBrowserTransport({
      connectionId: "xai-connection",
      connectionGeneration: 1,
      connections: connections("xai", "api-key"),
      bridge: direct.client,
      fetch: directFetch,
      now: () => NOW,
    });
    await expect(directTransport.listModels()).resolves.toHaveLength(1);
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(direct.posted).toHaveLength(0);
  });

  it("leaves the OpenAI OAuth route in the page, where it was measured to work", async () => {
    const bridge = scriptedBridge({ contentType: "application/json", body: "{}" });
    const fetch = vi.fn<ProviderFetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-access-token");
      return new Response(JSON.stringify({ data: [{ id: "gpt-fixture" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const transport = new OpenAiBrowserTransport({
      connectionId: "openai-connection",
      connectionGeneration: 1,
      connections: connections("openai", "oauth"),
      bridge: bridge.client,
      fetch,
      now: () => NOW,
    });

    await expect(transport.listModels()).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bridge.posted).toHaveLength(0);
  });

  it("surfaces an HTTP refusal that arrived through the bridge as an HTTP refusal", async () => {
    const bridge = scriptedBridge({
      status: 401,
      contentType: "application/json",
      body: '{"error":{"type":"authentication_error"}}',
    });
    const transport = new AnthropicBrowserTransport({
      connectionId: "anthropic-connection",
      connectionGeneration: 1,
      connections: connections("anthropic", "oauth"),
      bridge: bridge.client,
      fetch: async () => {
        throw new Error("unreachable");
      },
      now: () => NOW,
    });

    const failure = await transport.listModels().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "http", status: 401 });
  });

  it("propagates cancellation through the bridge to the extension", async () => {
    const bridge = scriptedBridge(undefined);
    const controller = new AbortController();
    const transport = new XaiBrowserTransport({
      connectionId: "xai-connection",
      connectionGeneration: 1,
      connections: connections("xai", "oauth"),
      bridge: bridge.client,
      fetch: async () => {
        throw new Error("unreachable");
      },
      now: () => NOW,
    });

    const pending = transport.listModels(controller.signal);
    await tick();
    await tick();
    controller.abort(new Error("operator stopped"));
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(bridge.posted.some((message) => message.kind === "cancel")).toBe(true);
  });
});
