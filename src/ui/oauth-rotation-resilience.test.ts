import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

const refreshEffect = source.match(
  /if \(connection\.kind !== "chutes-oauth"\)[\s\S]*?\}, \[connection\.kind, oauthTokenRevision\]\);/u,
)?.[0] ?? "";

describe("scheduled OAuth rotation failure resilience", () => {
  it("releases the authority only on the endpoint's own rejection, never on a bad minute of network", () => {
    /*
     * One transient fetch failure used to destroy the entire connection and
     * fire revocation POSTs, because the catch released unconditionally. The
     * classification must gate the single release call site.
     */
    expect(refreshEffect).toContain("oauth?.isChutesOAuthProviderRejection(error)");
    expect(refreshEffect.match(/releaseChutesAuthority\(/gu)).toHaveLength(1);
    const classification = refreshEffect.indexOf("isChutesOAuthProviderRejection");
    const release = refreshEffect.indexOf("releaseChutesAuthority(");
    expect(classification).toBeGreaterThan(-1);
    expect(classification).toBeLessThan(release);
  });

  it("retries a transient failure on a bounded backoff with the connection intact", () => {
    expect(refreshEffect).toContain("OAUTH_ROTATION_RETRY_DELAYS");
    expect(refreshEffect).toContain("retries < OAUTH_ROTATION_RETRY_DELAYS.length");
    // The retry reschedules and returns BEFORE either the error status or the
    // release can run — a retried failure leaves no visible trace, because
    // nothing the user can act on has happened.
    const retry = refreshEffect.indexOf("scheduleRotation(retryDelay)");
    expect(retry).toBeGreaterThan(-1);
    expect(retry).toBeLessThan(refreshEffect.indexOf("releaseChutesAuthority("));
  });

  it("bounds the retry schedule and keeps teardown timers singular", () => {
    const constants = source.match(/const OAUTH_ROTATION_RETRY_DELAYS = Object\.freeze\(\[[^\]]+\]\);/u)?.[0];
    expect(constants).toBeTruthy();
    const delays = constants!.match(/\d[\d_]*(?=,|\])/gu)!.map((value) => Number(value.replaceAll("_", "")));
    expect(delays.length).toBeGreaterThanOrEqual(1);
    expect(delays.length).toBeLessThanOrEqual(4);
    expect(delays.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(10 * 60_000);
    // One live timer variable, cleared unconditionally on teardown, so a
    // retry chain cannot double-schedule against the success-path re-run.
    expect(refreshEffect).toContain("window.clearTimeout(timer)");
    expect(refreshEffect.match(/window\.setTimeout/gu)).toHaveLength(1);
  });
});
