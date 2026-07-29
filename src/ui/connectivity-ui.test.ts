import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [app, access, billing, oauth] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./access-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./billing-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("../auth/chutes-oauth.ts", import.meta.url), "utf8"),
]);

describe("offline runtime UI contract", () => {
  it("owns browser connectivity and projects it into desktop and mobile posture", () => {
    expect(app).toContain("observeConnectivity(window, navigator, setOnline)");
    expect(app).toContain('data-connectivity={online ? "online" : "offline"}');
    // Offline used to be a fifth topbar pill on desktop and a separate chip
    // component on a phone, both fed from a bespoke `connectivitySeal`. It is
    // now one claim on the `local` axis, projected into one chip at every
    // width — so this asserts the axis carries the offline label and detail
    // rather than asserting that two components exist. Stronger: the previous
    // assertions passed while the phone chip was gated on being connected,
    // which meant a disconnected phone rendered no posture at all.
    // The axis now also declares the band that owns it. Connectivity is true of
    // this browser tab whichever conversation is open, so it is `tab`-scoped —
    // and asserting the scope here is what keeps a later refactor from moving
    // the offline claim into a band that unmounts with the conversation.
    expect(app).toMatch(/id: "local", scope: "tab", label: online \? "Browser \/ Edge runtime" : OFFLINE_RUNTIME_LABEL/u);
    expect(app).toMatch(/detail: online \? "[^"]+" : OFFLINE_RUNTIME_DETAIL/u);
    expect(app).toContain("<TopbarPostureChip axes={trustAxes} onOpen={() => setTrustSheetOpen(true)} />");
  });

  it("blocks only remote composer sends while retaining local slash execution", () => {
    expect(app).toContain("remoteComposerBlocked(");
    expect(app).toContain('composerPlan.kind !== "chat"');
    expect(app).toContain("disabled={!input.trim()");
    expect(app).toContain("|| composerOfflineBlocked");
    expect(app).toContain("|| modelSwitching");
    expect(app).toContain('turnTransport.id === "chutes-e2ee-v1"');
    expect(app).toContain("prompt preserved");
  });

  it("disables provider discovery and OAuth while preserving the pending OAuth credential", () => {
    expect(access).toContain("if (!online || !oauthBootstrap");
    /*
     * AMENDED — one conjunct added, deliberately.
     *
     * `oauthOrigin.available` answers "is this origin registered to sign in",
     * which is a different question from "can this build actually exchange a
     * code". A localhost-handler deployment whose handler is unconfigured
     * satisfied the first and failed the second, so the lane opened with the
     * OAuth tab marked "Primary" and a filled brass button that returned an
     * operator's restart instruction. The handler is now asked at load, and
     * neither arm may be claimed while the answer is still in flight.
     */
    expect(access).toContain("const chutesSignInAvailable = Boolean(oauthDiagnostic)\n    && oauthOrigin.available\n    && (!localOAuthHandler || handlerReadiness?.state === \"ready\");");
    expect(access).toContain("const signInChecking = localOAuthHandler && !handlerReadiness;");
    /*
     * AMENDED — the invariant is kept and finally satisfied.
     *
     * The OAuth *explanation* renders whenever the method is selected; only the
     * control that would fail is gated on availability. Gating the whole block
     * on `chutesSignInAvailable` made the boundary text, the registration
     * details and the one sentence that says WHY sign-in is unavailable
     * unreachable in exactly the build that needed them.
     *
     * `activeChutesMethod = chutesSignInAvailable ? chutesMethod : "api-key"`
     * reinstated that unreachability by a second route: it pinned the method to
     * `api-key`, and the tab that would change it carried `disabled`. Driven
     * live at 1440×900 against this build, the OAuth tab reported
     * `element is not enabled` and could not be clicked, so the block above was
     * still provable dead code — the fix had no rendering path. The method now
     * *defaults* to what can work and stays selectable, which is the shape
     * `initialConnectMethod()` already uses for the cloud lanes, and the two
     * assertions below pin that: no availability gate on the tab, and the panel
     * keyed on the selected method alone.
     */
    expect(access).toContain('const activeChutesMethod = chutesMethod ?? (chutesSignInAvailable ? "oauth" : "api-key");');
    expect(access).not.toContain("disabled={!chutesSignInAvailable}");
    expect(access).toContain('{activeChutesMethod === "oauth" ? (');
    expect(access).not.toContain('{chutesSignInAvailable && activeChutesMethod === "oauth" ? (');
    expect(access).toContain('{activeChutesMethod === "api-key" ? (');
    expect(access).toMatch(/disabled=\{busy \|\| !online \|\| !chutesSignInAvailable\}/u);
    expect(access).toContain("disabled={!online || !chutesSignInAvailable}");
    expect(access).toContain("disabled={busy || !online}>Discover models with key");
    expect(access).toContain('class="access-network-pause"');
  });

  /*
   * `invalid_client` means one of two opposite things, and the remedy for one
   * is wrong for the other: a localhost bridge has process credentials to
   * repair, a public PKCE client has a registration to re-check. The mapping
   * therefore has to read the mode the tab actually exchanged through, not the
   * mode the reader assumes.
   *
   * The classification lives beside the exchange it describes rather than in
   * App, so this asserts the whole path: App resolves the live mode and hands
   * it to the describer, the describer separates the two codes, and Access
   * renders distinct remedies. Asserting only App's copy of the literals is
   * what let the strings move out from under this test.
   */
  it("maps OAuth rejection to the active token boundary instead of prescribing the wrong client type", () => {
    expect(app).toContain("exchangeMode = oauth.chutesOAuthExchangeMode(registration)");
    expect(app).toContain("oauth?.describeChutesOAuthExchangeError(error, exchangeMode)");
    expect(oauth).toContain('exchangeMode === "local-confidential-bridge" ? "oauth:invalid-local" : "oauth:invalid-public"');
    expect(access).toContain('message === "oauth:invalid-local"');
    expect(access).toContain('message === "oauth:invalid-public"');
    expect(access).toContain("Chutes rejected the localhost app credentials.");
    expect(access).toContain("Chutes rejected this Browser/native registration.");
    expect(access).toContain("registered process credentials");
  });

  it("pauses account reads, retains the last observation, and disables refresh", () => {
    const offlineBranch = billing.slice(billing.indexOf("if (!online)"), billing.indexOf("const controller"));
    expect(offlineBranch).not.toContain("setSnapshot(undefined)");
    expect(billing).toContain("disabled={loading || !online}");
    expect(billing).toContain("Account reads paused");
    expect(billing).toContain("last observation held in page memory");
  });
});
