import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
const accessSource = await readFile(new URL("./access-view.tsx", import.meta.url), "utf8");
const activateSource = accessSource.slice(
  accessSource.indexOf("async function activate()"),
  accessSource.indexOf("async function enrichCatalog()"),
);

describe("remote credential loss continuity contract", () => {
  it("allows an exact Chutes authority to restore any requested model still present in its live catalog", () => {
    const reconnectGate = source.slice(
      source.indexOf("const chutesReconnectExact ="),
      source.indexOf("const activeExternalResolution ="),
    );
    expect(reconnectGate).toContain("availableModels.some((candidate) => candidate.id === accessReconnectIntent.model)");
    expect(reconnectGate).toContain("model: accessReconnectIntent.model");
    expect(reconnectGate).not.toContain("model: connection.model");
  });

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

describe("exact return transaction contract", () => {
  it("stages replay presentation and durable selection before publishing route authority", () => {
    const prepare = source.slice(
      source.indexOf("async function prepareReconnectSession("),
      source.indexOf("async function selectPreparedReconnectSession("),
    );
    expect(prepare.indexOf("await stageAuditedSessionPresentation(detail, audited, signal)"))
      .toBeGreaterThan(prepare.indexOf('audited.report.status !== "verified"'));

    const external = source.slice(
      source.indexOf("async function activateExternalInference("),
      source.indexOf("async function switchExternalModel("),
    );
    const selection = external.indexOf("await selectPreparedReconnectSession(");
    const routeCommit = external.indexOf("runtime.current = committedRuntime;");
    const presentationCommit = external.indexOf("publishSelectedAuditedSession(");
    expect(selection).toBeGreaterThan(-1);
    expect(selection).toBeLessThan(routeCommit);
    expect(routeCommit).toBeLessThan(presentationCommit);
    expect(external.slice(routeCommit, presentationCommit)).not.toContain("await ");
    expect(source.match(/await selectPreparedReconnectSession\(/gu)).toHaveLength(3);
    expect(source.match(/reconnectSession\.presentation/gu)).toHaveLength(3);
  });

  it("rechecks every live URL field and cancels selection when history leaves the return request", () => {
    const requirement = source.slice(
      source.indexOf("function requireCurrentReconnectIntent("),
      source.indexOf("function reconnectSelectionGuard("),
    );
    expect(requirement).toContain("parseAccessReconnectIntent(window.location.hash)");
    expect(requirement).toContain("reconnectIntentsEqual(current, intent)");
    const guard = source.slice(
      source.indexOf("function reconnectSelectionGuard("),
      source.indexOf("function resolveExternalInferencePreflight("),
    );
    expect(guard).toContain('["hashchange", "popstate", "airship:n"] as const');
    expect(guard).toContain("window.addEventListener(type, cancelIfChanged)");
    expect(guard).toContain("window.removeEventListener(type, cancelIfChanged)");
    expect(guard).toContain('callerSignal?.addEventListener("abort", cancelFromCaller');
    expect(guard).toContain("signal: controller.signal");
    const transition = source.slice(
      source.indexOf("async function runInferenceRouteTransition"),
      source.indexOf("async function connectChutes"),
    );
    expect(transition.indexOf("reconnectSelectionGuard(reconnectIntent, callerSignal)"))
      .toBeLessThan(transition.indexOf("return await operation(signal)"));
    expect(transition).toContain("if (signal?.aborted) setRuntimeStatus(statusBeforeTransition)");
    const prepare = source.slice(
      source.indexOf("async function prepareReconnectSession("),
      source.indexOf("async function selectPreparedReconnectSession("),
    );
    expect(prepare).toContain("candidateRuntime.journal.getSession(intent.returnSessionId, signal)");
    expect(prepare).toContain("stageAuditedSessionPresentation(detail, audited, signal)");
    const selection = source.slice(
      source.indexOf("async function selectPreparedReconnectSession("),
      source.indexOf("async function stageAuditedSessionPresentation("),
    );
    expect(selection).toContain("signal?.throwIfAborted()");
    expect(selection).toContain("candidateRuntime,");
    expect(selection).toContain("signal,");
    expect(source).toContain('window.dispatchEvent(new Event("airship:n"))');
    expect(source).toContain("transport.verifyModelAccess(model.id, reconnectSignal)");
  });

  it("keeps every boot failure on the document-level recovery screen", () => {
    expect(source).toContain("if (bootFailure || !catalog || !activeProfile || !activeTheme)");
    expect(source).toContain("this tab never became ready");
  });

  it("abandons by replacing the return entry so Back cannot resurrect it", () => {
    const abandon = source.slice(
      source.indexOf("function abandonReconnectRequest()"),
      source.indexOf("function navigatePrimary("),
    );
    expect(abandon).toContain('window.history.replaceState({ view: "access" }, "", "#connection")');
    expect(abandon).not.toContain("pushState");
    expect(abandon).toContain("setDestinationArrival");
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
    /*
     * AMENDED — one dependency added, deliberately.
     *
     * `oauthBootstrapRetryNonce` lets a failed OAuth-kind connect leg re-enter
     * this effect with the exchange the host still holds, instead of leaving
     * a full re-authorization as the only way back. The leg itself — read
     * without consuming, auto-connect flag armed before discovery — is
     * unchanged, and every assertion below pins the same ordering it pinned
     * before.
     */
    const bootstrap = accessSource.match(
      /const credential = oauthBootstrap\.readCredential\(\);[\s\S]*?\}, \[oauthBootstrap\?\.revision, connection\.kind, online, oauthBootstrapRetryNonce\]\);/u,
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
