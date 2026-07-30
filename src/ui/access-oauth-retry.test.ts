import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./access-view.tsx", import.meta.url), "utf8");

const activate = source.slice(
  source.indexOf("async function activate()"),
  source.indexOf("async function enrichCatalog()"),
);
const bootstrapEffect = source.match(
  /const credential = oauthBootstrap\.readCredential\(\);[\s\S]*?\}, \[oauthBootstrap\?\.revision, connection\.kind, online, oauthBootstrapRetryNonce\]\);/u,
)?.[0] ?? "";

describe("failed OAuth connect leg offers a retry instead of a full re-authorization", () => {
  it("marks only the OAuth-kind failure branch as retryable", () => {
    /*
     * An OAuth-kind candidate can only have come from the bootstrap leg: the
     * manual field refuses oauth-user-token credentials. So this branch is
     * exactly "a completed exchange failed to connect" — the state the retry
     * exists for.
     */
    expect(activate).toContain('credential.kind === "oauth-user-token" && oauthBootstrap');
    const oauthFailure = activate.indexOf("setOauthConnectRetry(true)");
    expect(oauthFailure).toBeGreaterThan(-1);
    expect(oauthFailure).toBeGreaterThan(activate.indexOf('credential.kind === "oauth-user-token"'));
    // The API-key refusal branch is a different remedy — correct the key in
    // the field it came from — and must not sprout this control.
    const refusal = activate.slice(activate.indexOf("setKeyRefusal("), oauthFailure);
    expect(refusal).not.toContain("setOauthConnectRetry");
  });

  it("renders the retry control against the failure and focuses it", () => {
    expect(source).toContain("Retry connection");
    expect(source).toContain("{oauthConnectRetry && error && oauthBootstrap ? (");
    expect(source).toContain("ref={oauthRetryButton}");
    expect(source).toContain("onClick={retryOAuthConnect}");
    expect(activate).toContain("requestAnimationFrame(() => oauthRetryButton.current?.focus())");
    // The retry arrives with the error it answers; it has no disconnected
    // state to render from.
    expect(source).not.toContain("{oauthConnectRetry ? (");
  });

  it("re-invokes the bootstrap leg with the exchange the host still holds", () => {
    const retry = source.slice(
      source.indexOf("function retryOAuthConnect()"),
      source.indexOf("async function selectActiveModel("),
    );
    expect(retry).toContain("setOauthBootstrapRetryNonce((value) => value + 1)");
    expect(bootstrapEffect).toBeTruthy();
    // The dependency list carries the nonce, so the retry — and nothing else —
    // re-reads the pending credential and re-arms the auto-connect flag.
    expect(bootstrapEffect).toContain("oauthBootstrap.readCredential()");
    expect(bootstrapEffect).toContain("autoConnectAfterDiscovery.current = true;");
    // Every fresh discovery and every successful disconnect takes the stale
    // control down with it.
    expect(source.match(/setOauthConnectRetry\(false\)/gu)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("failure paths never focus the unmounted entry field", () => {
  it("mounts the API-key tab before focusing its input on credential switch", () => {
    /*
     * `credentialInput` renders only inside
     * `{activeChutesMethod === "api-key" ? (…)}`; a focus RAF fired while the
     * OAuth tab stood landed on `undefined` and fell to the document body.
     * The tab switch has to precede the RAF, in the ordering the refused-key
     * path already proves.
     */
    const clear = source.slice(
      source.indexOf("async function clearConnection("),
      source.indexOf("async function selectActiveModel("),
    );
    const tabSwitch = clear.indexOf('setChutesMethod("api-key")');
    const focus = clear.indexOf("requestAnimationFrame(() => credentialInput.current?.focus())");
    expect(tabSwitch).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(-1);
    expect(tabSwitch).toBeLessThan(focus);
  });

  it("focuses something that exists on the generic OAuth failure branch", () => {
    const generic = activate.slice(activate.indexOf("} else {", activate.indexOf("setKeyRefusal(")));
    // The input gets focus only when mounted; otherwise the retry control or
    // the lane card takes it — never an unmounted element.
    expect(generic).toContain("} else if (credentialInput.current) {");
    expect(generic).toContain("focusConnectSurface()");
  });
});
