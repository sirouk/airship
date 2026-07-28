import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import {
  confidentialRevocationForm,
  confidentialTokenForm,
  localChutesOAuthBridge,
} from "./local-chutes-oauth-bridge";

describe("local confidential Chutes OAuth bridge", () => {
  it("reports readiness only when both process-held app credentials exist", async () => {
    const unreachable = () => {
      throw new Error("Readiness must not contact Chutes.");
    };
    await expect(driveBridge(
      "/__airship/chutes/oauth/token",
      "",
      unreachable,
      { method: "GET" },
    )).resolves.toEqual({ status: 204, body: "" });
    await expect(driveBridge(
      "/__airship/chutes/oauth/token",
      "",
      unreachable,
      { method: "GET", clientSecret: "" },
    )).resolves.toEqual({
      status: 503,
      body: JSON.stringify({ error: "local_bridge_unconfigured" }),
    });
  });

  it("adds the device-held secret to a PKCE exchange", () => {
    const form = confidentialTokenForm(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: "one-time-code",
        client_id: "cid_airship",
        redirect_uri: "http://localhost:4173/auth/chutes/callback",
        code_verifier: "v".repeat(43),
      }).toString(),
      "cid_airship",
      "device-secret",
    );
    expect(form.get("client_secret")).toBe("device-secret");
    expect(form.get("code_verifier")).toBe("v".repeat(43));
  });

  it("rejects browser-supplied secrets, foreign clients, and unsupported fields", () => {
    expect(() => confidentialTokenForm("grant_type=authorization_code&client_id=cid_airship&client_secret=leak", "cid_airship", "secret")).toThrow("must not submit");
    expect(() => confidentialTokenForm("grant_type=authorization_code&client_id=cid_other", "cid_airship", "secret")).toThrow("does not match");
    expect(() => confidentialTokenForm("grant_type=password&client_id=cid_airship&password=nope", "cid_airship", "secret")).toThrow("unsupported field");
    expect(() => confidentialTokenForm("grant_type=authorization_code&client_id=cid_airship&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback", "cid_airship", "secret")).toThrow("redirect does not match");
  });
});

describe("local confidential Chutes revocation bridge", () => {
  it("adds the device-held secret to a well-formed revocation", () => {
    const form = confidentialRevocationForm(
      new URLSearchParams({
        token: "crt_released.refresh",
        token_type_hint: "refresh_token",
        client_id: "cid_airship",
      }).toString(),
      "cid_airship",
      "device-secret",
    );
    expect(form.get("client_secret")).toBe("device-secret");
    expect(form.get("token")).toBe("crt_released.refresh");
  });

  it("refuses secrets, foreign clients, unsupported fields, and non-Chutes tokens", () => {
    expect(() => confidentialRevocationForm("token=crt_a.b&client_id=cid_airship&client_secret=leak", "cid_airship", "secret")).toThrow("must not submit");
    expect(() => confidentialRevocationForm("token=crt_a.b&client_id=cid_other", "cid_airship", "secret")).toThrow("does not match");
    expect(() => confidentialRevocationForm("token=crt_a.b&client_id=cid_airship&grant_type=refresh_token", "cid_airship", "secret")).toThrow("unsupported field");
    expect(() => confidentialRevocationForm("token=bearer-from-elsewhere&client_id=cid_airship", "cid_airship", "secret")).toThrow("token is invalid");
    expect(() => confidentialRevocationForm("token=crt_a.b&client_id=cid_airship&token_type_hint=id_token", "cid_airship", "secret")).toThrow("hint is unsupported");
  });
});

describe("local confidential Chutes bridge upstream body policy", () => {
  it("adds the secret only after the browser request crosses the localhost handler", async () => {
    let upstreamBody = "";
    const browserBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: "one-time-code",
      client_id: "cid_airship",
      redirect_uri: "http://localhost:4173/auth/chutes/callback",
      code_verifier: "v".repeat(43),
    }).toString();
    expect(new URLSearchParams(browserBody).has("client_secret")).toBe(false);

    await driveBridge(
      "/__airship/chutes/oauth/token",
      browserBody,
      (_url, init) => {
        upstreamBody = String(init?.body);
        return Response.json({ access_token: "cak_new" });
      },
    );

    expect(new URLSearchParams(upstreamBody).get("client_secret")).toBe("device-secret");
    expect(new URLSearchParams(upstreamBody).get("code_verifier")).toBe("v".repeat(43));
  });

  it("passes a bodyless revocation through, because RFC 7009 permits one", async () => {
    const result = await driveBridge(
      "/__airship/chutes/oauth/revoke",
      "token=crt_a.b&client_id=cid_airship",
      () => new Response(null, { status: 200 }),
    );
    expect(result).toEqual({ status: 200, body: "" });
  });

  it("fails a bodyless token exchange rather than forwarding an empty success", async () => {
    const result = await driveBridge(
      "/__airship/chutes/oauth/token",
      "grant_type=refresh_token&client_id=cid_airship&refresh_token=crt_a.b",
      () => new Response(null, { status: 200 }),
    );
    expect(result).toEqual({
      status: 502,
      body: JSON.stringify({ error: "local_bridge_exchange_failed" }),
    });
  });

  it("still forwards a real token body untouched", async () => {
    const result = await driveBridge(
      "/__airship/chutes/oauth/token",
      "grant_type=refresh_token&client_id=cid_airship&refresh_token=crt_a.b",
      () => new Response(JSON.stringify({ access_token: "cak_new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(result).toEqual({ status: 200, body: JSON.stringify({ access_token: "cak_new" }) });
  });
});

/**
 * Run one POST through the real middleware the Vite plugin installs.
 *
 * The bridge's route handling is what decides whether an empty upstream body
 * is legitimate, so the test drives the handler rather than the shared reader
 * it delegates to.
 */
async function driveBridge(
  route: string,
  body: string,
  upstream: (url: string, init?: RequestInit) => Response,
  options: Readonly<{
    method?: "GET" | "POST";
    clientSecret?: string;
  }> = {},
): Promise<{ status: number; body: string }> {
  const plugin = localChutesOAuthBridge({
    clientId: "cid_airship",
    clientSecret: options.clientSecret ?? "device-secret",
    fetch: async (input, init) => upstream(String(input), init),
  });
  let handler: ((
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => void | Promise<void>) | undefined;
  const configureServer = plugin.configureServer;
  if (typeof configureServer !== "function") throw new Error("The bridge installs no middleware.");
  configureServer.call(plugin as Plugin, {
    middlewares: { use: (fn: typeof handler) => { handler = fn; } },
  } as unknown as ViteDevServer);
  if (!handler) throw new Error("The bridge registered no request handler.");

  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  request.method = options.method ?? "POST";
  request.url = route;
  request.headers = {
    origin: "http://localhost:4173",
    "content-type": "application/x-www-form-urlencoded",
  };
  const chunks: string[] = [];
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (value?: unknown) => {
      if (typeof value === "string") chunks.push(value);
      else if (value instanceof Uint8Array) chunks.push(new TextDecoder().decode(value));
    },
  };
  await handler(request, response as unknown as ServerResponse, () => {
    throw new Error("The bridge did not claim its own route.");
  });
  return { status: response.statusCode, body: chunks.join("") };
}
