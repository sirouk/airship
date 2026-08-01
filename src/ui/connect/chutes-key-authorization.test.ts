import { describe, expect, it, vi } from "vitest";
import { CHUTES_API_BASE } from "../../models/types";
import { CHUTES_KEY_CHECK_URL, verifyChutesKey } from "./chutes-key-authorization";

const SIGNAL = new AbortController().signal;

describe("asking Chutes about the key before showing anything that implies an answer", () => {
  it("checks the account endpoint on the same host every other Chutes request uses", () => {
    // A literal, because importing the constant merges chunks the release gate
    // classifies separately. Bound here so the literal cannot drift from it.
    expect(new URL(CHUTES_KEY_CHECK_URL).origin).toBe(new URL(CHUTES_API_BASE).origin);
    expect(CHUTES_KEY_CHECK_URL).toBe(`${CHUTES_API_BASE}/users/me`);
  });

  it("sends the key as a bearer token and nothing else", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cpk_real");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      return new Response("{}", { status: 200 });
    });
    await expect(verifyChutesKey("cpk_real", SIGNAL, fetchImpl as unknown as typeof fetch))
      .resolves.toEqual({ state: "accepted" });
  });

  it("reports a refusal as a refusal, in the provider's own words", async () => {
    /*
     * Measured against the live endpoint with `cpk_notarealkey000000`:
     * HTTP 401 and `{"detail":"Missing or invalid authorization header(s)"}`,
     * in about 100ms — against the ~10s the model-authorization leg takes,
     * which is why the whole priced picker used to render before it.
     */
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ detail: "Missing or invalid authorization header(s)" }),
      { status: 401 },
    ));
    const verdict = await verifyChutesKey("cpk_fake", SIGNAL, fetchImpl as unknown as typeof fetch);
    expect(verdict.state).toBe("refused");
    expect(verdict).toMatchObject({ providerResponse: expect.stringContaining("Missing or invalid authorization") });
  });

  it("never turns a provider fault into a verdict about the key", async () => {
    for (const status of [500, 502, 503]) {
      const verdict = await verifyChutesKey(
        "cpk_real",
        SIGNAL,
        vi.fn(async () => new Response("upstream down", { status })) as unknown as typeof fetch,
      );
      expect(verdict.state, String(status)).toBe("unreachable");
    }
    const offline = await verifyChutesKey(
      "cpk_real",
      SIGNAL,
      vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch,
    );
    expect(offline).toEqual({ state: "unreachable", detail: "Failed to fetch" });
  });

  it("re-raises an abort rather than reporting the provider unreachable", async () => {
    await expect(verifyChutesKey(
      "cpk_real",
      SIGNAL,
      vi.fn(async () => { throw new DOMException("Aborted.", "AbortError"); }) as unknown as typeof fetch,
    )).rejects.toThrow("Aborted.");
  });

  it("bounds what a provider can push into the page", async () => {
    const verdict = await verifyChutesKey(
      "cpk_fake",
      SIGNAL,
      vi.fn(async () => new Response("x".repeat(50_000), { status: 403 })) as unknown as typeof fetch,
    );
    expect(verdict).toMatchObject({ state: "refused" });
    expect(verdict.state === "refused" && verdict.providerResponse.length).toBeLessThanOrEqual(512);
  });
});
