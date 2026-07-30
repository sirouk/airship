import { describe, expect, it } from "vitest";
import {
  ChutesOAuthProviderRejectionError,
  CHUTES_LOCAL_REGISTRATION,
  isChutesOAuthProviderRejection,
  refreshChutesOAuthToken,
  resolveChutesOAuthRegistration,
} from "./chutes-oauth";

const PUBLIC_REGISTRATION = resolveChutesOAuthRegistration({
  development: false,
  publicClientId: CHUTES_LOCAL_REGISTRATION.clientId,
  publicOrigin: "https://airship.example",
});

function refreshWith(fetch: typeof globalThis.fetch): Promise<unknown> {
  return refreshChutesOAuthToken({
    clientId: PUBLIC_REGISTRATION.clientId,
    registration: PUBLIC_REGISTRATION,
    refreshToken: "crt_old.refresh",
    fetch,
  });
}

/*
 * Scheduled rotation decides teardown on this split: the token endpoint's own
 * refusal means the grant is already dead and the connection must go, while a
 * transport failure says nothing about the grant and must be retried with the
 * connection intact. Both paths previously threw indistinguishable `Error`s,
 * so one timed-out POST destroyed a working Chutes connection.
 */
describe("Chutes OAuth token-request failure classification", () => {
  it("marks the endpoint's own 400 invalid_grant as provider-authoritative", async () => {
    const failure = await refreshWith(async () => Response.json(
      { error: "invalid_grant", error_description: "The grant was revoked." },
      { status: 400 },
    )).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(ChutesOAuthProviderRejectionError);
    expect(isChutesOAuthProviderRejection(failure)).toBe(true);
    expect((failure as Error).message).toBe("Chutes OAuth token request failed with HTTP 400 (invalid_grant).");
  });

  it("marks a 401 refusal the same way", async () => {
    const failure = await refreshWith(async () => Response.json(
      { error: "invalid_client" },
      { status: 401 },
    )).catch((caught: unknown) => caught);

    expect(isChutesOAuthProviderRejection(failure)).toBe(true);
  });

  it("does not mark a 5xx, because infrastructure failure says nothing about the grant", async () => {
    const failure = await refreshWith(async () => Response.json(
      { error: "server_unavailable" },
      { status: 502 },
    )).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ChutesOAuthProviderRejectionError);
    expect(isChutesOAuthProviderRejection(failure)).toBe(false);
  });

  it("does not mark a 400 that the endpoint returned without a JSON body judgement", async () => {
    const failure = await refreshWith(async () =>
      new Response("not json", { status: 400, headers: { "content-type": "text/plain" } })
    ).catch((caught: unknown) => caught);

    expect((failure as Error).message).toBe("Chutes OAuth token request failed with HTTP 400.");
    expect(isChutesOAuthProviderRejection(failure)).toBe(false);
  });

  it("does not mark a refused fetch or a plain TypeError from the network layer", async () => {
    const failure = await refreshWith(async () => {
      throw new TypeError("Failed to fetch");
    }).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(TypeError);
    expect(isChutesOAuthProviderRejection(failure)).toBe(false);
  });

  it("classifies through the flag, not instanceof, so a re-thrown copy still reads", () => {
    const rethrown = new Error("Chutes OAuth token request failed with HTTP 400 (invalid_grant).") as Error & {
      providerRejected: boolean;
    };
    rethrown.providerRejected = true;

    expect(isChutesOAuthProviderRejection(rethrown)).toBe(true);
    expect(rethrown).not.toBeInstanceOf(ChutesOAuthProviderRejectionError);
    expect(isChutesOAuthProviderRejection(new Error("Chutes OAuth token request timed out."))).toBe(false);
    expect(isChutesOAuthProviderRejection(undefined)).toBe(false);
  });
});
