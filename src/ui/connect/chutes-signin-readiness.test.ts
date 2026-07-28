import { describe, expect, it } from "vitest";
import {
  CHUTES_HANDLER_UNCONFIGURED,
  CHUTES_HANDLER_UNREACHABLE,
  CHUTES_OAUTH_HANDLER_URL,
  probeChutesSignInHandler,
  readChutesSignInReadiness,
} from "./chutes-signin-readiness";

describe("Chutes sign-in readiness", () => {
  it("reads the handler's own answers and keeps the operator sentence verbatim", () => {
    expect(readChutesSignInReadiness(204)).toEqual({ state: "ready" });
    expect(readChutesSignInReadiness(503)).toEqual({ state: "blocked", reason: CHUTES_HANDLER_UNCONFIGURED });
    expect(readChutesSignInReadiness("network-error")).toEqual({ state: "blocked", reason: CHUTES_HANDLER_UNREACHABLE });
    // The sentences the lane keeps one rung down name the process and the
    // missing thing. They may not be paraphrased.
    expect(CHUTES_HANDLER_UNCONFIGURED).toBe("The local Chutes OAuth handler is not configured. Restart the Airship lab with its process-held client secret.");
    expect(CHUTES_HANDLER_UNREACHABLE).toBe("The local Chutes OAuth handler is unavailable. Restart the Airship lab with its OAuth registration configured.");
  });

  it("never reads an unexpected status as ready", () => {
    for (const status of [200, 201, 302, 400, 401, 404, 500, 502]) {
      const readiness = readChutesSignInReadiness(status);
      expect(readiness.state, String(status)).toBe("blocked");
      expect(readiness.state === "blocked" && readiness.reason).toContain(`HTTP ${String(status)}`);
    }
  });

  it("resolves a named blocked reading instead of rejecting when the probe throws", async () => {
    const thrown = await probeChutesSignInHandler(() => Promise.reject(new TypeError("Failed to fetch")));

    expect(thrown).toEqual({ state: "blocked", reason: CHUTES_HANDLER_UNREACHABLE });
  });

  it("asks the same endpoint the press-time check asks, without credentials", async () => {
    let seen: readonly [string, RequestInit | undefined] | undefined;
    const readiness = await probeChutesSignInHandler((input, init) => {
      seen = [String(input), init];
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    expect(readiness).toEqual({ state: "ready" });
    expect(seen?.[0]).toBe(CHUTES_OAUTH_HANDLER_URL);
    expect(seen?.[1]?.credentials).toBe("omit");
    expect(seen?.[1]?.cache).toBe("no-store");
  });
});
