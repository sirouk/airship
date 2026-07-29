import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
const accessSource = await readFile(new URL("./access-view.tsx", import.meta.url), "utf8");
const activateSource = accessSource.slice(
  accessSource.indexOf("async function activate()"),
  accessSource.indexOf("async function enrichCatalog()"),
);

describe("remote credential loss continuity contract", () => {
  it("routes OAuth refresh failure through the non-destructive authority release", () => {
    const refreshEffect = source.match(/if \(connection\.kind !== "chutes-oauth"\)[\s\S]*?\}, \[connection\.kind, oauthTokenRevision\]\);/u)?.[0];
    expect(refreshEffect).toContain("releaseChutesAuthority");
    expect(refreshEffect?.match(/releaseChutesAuthority\(/gu)).toHaveLength(1);
    expect(refreshEffect).not.toContain("disconnectChutes()");
  });

  it("clears credential-bearing transport authority without replacing conversation state", () => {
    const release = source.match(/function releaseChutesAuthority\(status: string\): void \{[\s\S]*?\n  \}\n\n  async function disconnectChutes/u)?.[0];
    expect(release).toBeTruthy();
    expect(release).toContain("active.transport = withoutCredential(active.transport)");
    expect(release).toContain("setConnection(DISCONNECTED_CHUTES_CONNECTION)");
    expect(release).toContain("clearAttestationEvidence(true)");
    expect(release).not.toContain("createProfileSession");
    expect(release).not.toContain("activateSession");
    expect(release).not.toContain("setMessages");
    expect(release).not.toContain("setLastReceipt");
    expect(release).not.toContain("setEventCount");
    expect(release).not.toContain("runtime.current.model =");
  });

  /*
   * Sign-out has to end the grant, not just Airship's copy of it.
   *
   * Revocation shipped behind a broker production never mounts, and the
   * transport's identically named `revokeCredential` made the gap invisible at
   * the call site, so an OAuth sign-out left a refresh token valid at the
   * provider for its whole remaining lifetime.
   */
  it("asks the provider to drop the released grant without making teardown wait for it", () => {
    const release = source.match(/function releaseChutesAuthority\(status: string\): void \{[\s\S]*?\n  \}\n\n  async function disconnectChutes/u)?.[0] ?? "";
    // The token set has to be captured before the same function clears it.
    expect(release.indexOf("const releasedTokens = oauthTokens.current;"))
      .toBeLessThan(release.indexOf("oauthTokens.current = undefined;"));
    expect(release).toContain("revokeChutesToken");
    expect(release).toContain("CHUTES_ACTIVE_REGISTRATION");
    // Refresh token first: it is the one with a long life if it has leaked.
    expect(release.indexOf("releasedTokens.refreshToken"))
      .toBeLessThan(release.indexOf("releasedTokens.accessToken"));
    // Detached, so a hung or refused revocation cannot hold sign-out open, and
    // never awaited by the synchronous release itself.
    expect(release).toContain("void (async () => {");
    expect(release).toMatch(/\}\)\(\)\.catch\(\(\) => undefined\);/u);
    // Every await lives inside that detached closure, never in the release.
    expect(release.indexOf("await revokeChutesToken"))
      .toBeGreaterThan(release.indexOf("void (async () => {"));
    expect(release).toContain(".catch(() => undefined)");
    // The endpoint answers 200 for tokens it never issued, so no surface may
    // read this outcome as proof the provider session ended.
    expect(release).not.toMatch(/setRuntimeStatus\([^)]*revok/iu);
  });

  it("blocks a disconnected remote turn before transport invocation while retaining the prompt", () => {
    expect(source).toContain("if (turnRuntime.inferenceBinding && !inferenceConnected)");
    expect(source).toContain("resolveExternalInferencePreflight(");
    expect(source).toContain('externalPreflight.state !== "ready"');
    expect(source).toContain("your prompt, messages, journal, and workspace remain here.");
  });
});

describe("Chutes credential ownership handoff contract", () => {
  it("relinquishes the candidate transport before the connect handoff is awaited", () => {
    expect(activateSource).toBeTruthy();
    const relinquished = activateSource.indexOf("candidateTransport.current = undefined;");
    const handoff = activateSource.indexOf("await onConnect(");
    expect(relinquished).toBeGreaterThan(-1);
    expect(handoff).toBeGreaterThan(-1);
    // `onConnect` navigates to the conversation, so this view can unmount while
    // that promise is still pending. A candidate reference surviving the await
    // lets the unmount cleanup revoke the credential authority App has already
    // committed, which cancels every later turn before its first request.
    expect(relinquished).toBeLessThan(handoff);
  });

  it("releases only a replaced discovery transport or a handoff that never committed", () => {
    expect(activateSource).toContain("The strict-proof Chutes transport replaced discovery.");
    expect(activateSource).toContain("The Chutes connection was not committed.");
    expect(activateSource.match(/revokeCredential\(/gu)).toHaveLength(2);
  });

  it("keeps view cleanup from revoking a transport it no longer owns", () => {
    const clear = accessSource.slice(
      accessSource.indexOf("function clearEphemeral()"),
      accessSource.indexOf("useEffect(() => () => clearEphemeral(), []);"),
    );
    expect(clear).toContain("candidateTransport.current?.revokeCredential(");
    expect(clear).toContain("candidateTransport.current = undefined;");
  });
});

describe("completed Chutes sign-in survives a remount and finishes itself", () => {
  it("reads the pending OAuth credential without consuming it", () => {
    const read = source.match(/function readPendingOAuthCredential\(\): string \| undefined \{[\s\S]*?\n  \}/u)?.[0];
    expect(read).toBeTruthy();
    // Consuming the ref here is what stranded an authorized exchange: this view
    // is conditionally mounted, so the read that discovery makes on mount was
    // also the read that destroyed the credential for every later mount.
    expect(read).not.toContain("pendingOAuthCredential.current = undefined");
    expect(source).not.toContain("takePendingOAuthCredential");
  });

  it("clears the pending credential only where the authority actually changes", () => {
    const clears = source.match(/pendingOAuthCredential\.current = undefined;/gu);
    // Exactly four: a new exchange begins, the code exchange fails, the
    // connection commits, the authority is released. Every one of them is a
    // point where the credential stopped being valid; nothing else may consume
    // the handoff merely by looking at it.
    expect(clears).toHaveLength(4);
    const connect = source.slice(
      source.indexOf("async function connectChutes("),
      source.indexOf("function releaseChutesAuthority(status: string): void"),
    );
    expect(connect).toContain("pendingOAuthCredential.current = undefined;");
    const release = source.slice(source.indexOf("function releaseChutesAuthority(status: string): void"));
    expect(release).toContain("pendingOAuthCredential.current = undefined;");
  });

  it("carries the returning redirect through verification without a second press", () => {
    const bootstrap = accessSource.match(
      /const credential = oauthBootstrap\.readCredential\(\);[\s\S]*?\}, \[oauthBootstrap\?\.revision, connection\.kind, online\]\);/u,
    )?.[0];
    expect(bootstrap).toBeTruthy();
    expect(bootstrap).toContain("autoConnectAfterDiscovery.current = true;");
    const auto = accessSource.slice(
      accessSource.indexOf("if (!autoConnectAfterDiscovery.current) return;"),
      accessSource.indexOf("async function activate()"),
    );
    expect(auto).toContain("void activate();");
    // Cleared before the call, so a refused credential lands on the manual
    // panel with the provider's own words instead of looping.
    expect(auto.indexOf("autoConnectAfterDiscovery.current = false;"))
      .toBeLessThan(auto.indexOf("void activate();"));
  });
});
