import { describe, expect, it, vi } from "vitest";
import {
  pollDeviceAccessToken,
  requestDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceCodePollProgress,
} from "./device-code";
import { XAI_OAUTH } from "./registrations";
import {
  createDirectFetchTransport,
  ProviderOAuthError,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
  type ProviderOAuthTransport,
} from "./transport";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

/** A stand-in for the extension bridge: it carries xAI and records every request. */
function bridge(
  replies: readonly Readonly<{ status: number; payload: unknown }>[],
): Readonly<{ transport: ProviderOAuthTransport; sent: OAuthHttpRequest[] }> {
  const sent: OAuthHttpRequest[] = [];
  let index = 0;
  const transport: ProviderOAuthTransport = Object.freeze({
    id: "extension-bridge" as const,
    carries: ["xai" as const],
    request: async (request: OAuthHttpRequest): Promise<OAuthHttpResponse> => {
      sent.push(request);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (!reply) throw new Error("the test supplied no reply");
      return Object.freeze({
        status: reply.status,
        contentType: "application/json",
        body: JSON.stringify(reply.payload),
      });
    },
  });
  return { transport, sent };
}

const DEVICE_PAYLOAD = Object.freeze({
  device_code: "device-code-value",
  user_code: "ABCD-EFGH",
  verification_uri: "https://x.ai/device",
  verification_uri_complete: "https://x.ai/device?code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
});

describe("xAI device authorization", () => {
  it("requires the bridge before touching the network", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const failure = await requestDeviceAuthorization({
      registration: XAI_OAUTH,
      transport: createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch }),
      now: NOW,
    }).catch((error: unknown) => error);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((failure as ProviderOAuthError).code).toBe("transport-unavailable");
    expect((failure as ProviderOAuthError).message).toContain("extension");
  });

  it("requests a device code with the registered client and scopes", async () => {
    const { transport, sent } = bridge([{ status: 200, payload: DEVICE_PAYLOAD }]);
    const authorization = await requestDeviceAuthorization({
      registration: XAI_OAUTH,
      transport,
      now: NOW,
    });

    expect(sent[0]?.url).toBe("https://auth.x.ai/oauth2/device/code");
    expect(Object.fromEntries(new URLSearchParams(sent[0]?.body ?? ""))).toEqual({
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      scope: "openid profile email offline_access grok-cli:access api:access",
    });
    expect(authorization).toEqual({
      provider: "xai",
      deviceCode: "device-code-value",
      userCode: "ABCD-EFGH",
      verificationUri: "https://x.ai/device",
      verificationUriComplete: "https://x.ai/device?code=ABCD-EFGH",
      intervalMs: 5_000,
      expiresAt: NOW + 600_000,
    });
  });

  it("refuses a verification URL outside the issuer's own domain", async () => {
    const { transport } = bridge([{
      status: 200,
      payload: { ...DEVICE_PAYLOAD, verification_uri: "https://grok-device-login.example/approve" },
    }]);
    await expect(requestDeviceAuthorization({ registration: XAI_OAUTH, transport, now: NOW }))
      .rejects.toThrow("invalid device verification URL");
  });

  it("bounds the poll interval and the code lifetime the provider declares", async () => {
    const { transport } = bridge([{
      status: 200,
      payload: { ...DEVICE_PAYLOAD, interval: 3_600 },
    }]);
    const authorization = await requestDeviceAuthorization({
      registration: XAI_OAUTH,
      transport,
      now: NOW,
    });
    expect(authorization.intervalMs).toBe(60_000);

    const { transport: tooLong } = bridge([{
      status: 200,
      payload: { ...DEVICE_PAYLOAD, expires_in: 90_000 },
    }]);
    await expect(requestDeviceAuthorization({ registration: XAI_OAUTH, transport: tooLong, now: NOW }))
      .rejects.toThrow("invalid device expiry");
  });
});

describe("xAI device polling", () => {
  const authorization: DeviceAuthorization = Object.freeze({
    provider: "xai",
    deviceCode: "device-code-value",
    userCode: "ABCD-EFGH",
    verificationUri: "https://x.ai/device",
    intervalMs: 5_000,
    expiresAt: NOW + 600_000,
  });

  function fakeClock(): Readonly<{ now: () => number; sleep: (ms: number) => Promise<void>; delays: number[] }> {
    let current = NOW;
    const delays: number[] = [];
    return {
      now: () => current,
      sleep: async (ms: number) => { delays.push(ms); current += ms; },
      delays,
    };
  }

  it("honours interval, slow_down, and authorization_pending before succeeding", async () => {
    const { transport, sent } = bridge([
      { status: 400, payload: { error: "authorization_pending" } },
      { status: 400, payload: { error: "slow_down" } },
      { status: 400, payload: { error: "authorization_pending" } },
      {
        status: 200,
        payload: {
          access_token: "xai-access-token",
          refresh_token: "xai-refresh-token",
          token_type: "bearer",
          expires_in: 3_600,
          scope: "api:access grok-cli:access",
        },
      },
    ]);
    const clock = fakeClock();
    const progress: DeviceCodePollProgress[] = [];

    const tokenSet = await pollDeviceAccessToken({
      registration: XAI_OAUTH,
      authorization,
      transport,
      now: clock.now,
      sleep: clock.sleep,
      onProgress: (event) => progress.push(event),
    });

    expect(clock.delays).toEqual([5_000, 5_000, 10_000, 10_000]);
    expect(progress.map((event) => event.state)).toEqual(["pending", "slow-down", "pending"]);
    expect(sent).toHaveLength(4);
    expect(Object.fromEntries(new URLSearchParams(sent[0]?.body ?? ""))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-code-value",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    expect(tokenSet).toMatchObject({
      provider: "xai",
      accessToken: "xai-access-token",
      refreshToken: "xai-refresh-token",
      tokenType: "Bearer",
      scopes: ["api:access", "grok-cli:access"],
    });
    expect(tokenSet.expiresAt).toBe(NOW + 30_000 + 3_600_000);
  });

  it("stops at the declared deadline instead of polling forever", async () => {
    const { transport, sent } = bridge([{ status: 400, payload: { error: "authorization_pending" } }]);
    const clock = fakeClock();
    const failure = await pollDeviceAccessToken({
      registration: XAI_OAUTH,
      authorization: Object.freeze({ ...authorization, expiresAt: NOW + 12_000 }),
      transport,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((error: unknown) => error);

    expect((failure as ProviderOAuthError).code).toBe("authorization-expired");
    expect(sent).toHaveLength(2);
  });

  it("treats refusal, expiry, and unknown errors as terminal", async () => {
    const clock = fakeClock();
    const denied = await pollDeviceAccessToken({
      registration: XAI_OAUTH,
      authorization,
      transport: bridge([{ status: 400, payload: { error: "access_denied" } }]).transport,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((error: unknown) => error);
    expect((denied as ProviderOAuthError).code).toBe("authorization-denied");

    const expired = await pollDeviceAccessToken({
      registration: XAI_OAUTH,
      authorization,
      transport: bridge([{ status: 400, payload: { error: "expired_token" } }]).transport,
      now: fakeClock().now,
      sleep: fakeClock().sleep,
    }).catch((error: unknown) => error);
    expect((expired as ProviderOAuthError).code).toBe("authorization-expired");

    const unknown = bridge([{ status: 400, payload: { error: "invalid_client" } }]);
    const failure = await pollDeviceAccessToken({
      registration: XAI_OAUTH,
      authorization,
      transport: unknown.transport,
      now: fakeClock().now,
      sleep: fakeClock().sleep,
    }).catch((error: unknown) => error);
    expect((failure as ProviderOAuthError).providerCode).toBe("invalid_client");
    expect(unknown.sent).toHaveLength(1);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, sent } = bridge([{ status: 200, payload: {} }]);
    const failure = await pollDeviceAccessToken({
      registration: XAI_OAUTH,
      authorization,
      transport,
      signal: controller.signal,
      now: () => NOW,
      sleep: async () => undefined,
    }).catch((error: unknown) => error);

    expect((failure as ProviderOAuthError).code).toBe("cancelled");
    expect(sent).toHaveLength(0);
  });
});
