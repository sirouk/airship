import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [app, access, billing] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./access-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./billing-view.tsx", import.meta.url), "utf8"),
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
    expect(app).toMatch(/id: "local", label: online \? "Browser \/ Edge runtime" : OFFLINE_RUNTIME_LABEL/u);
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
    // Sign-in is no longer rendered-but-disabled when the exchange is not
    // configured: an unconfigured build does not offer it at all, so the only
    // remaining reason to disable it is the network.
    expect(access).toContain("const chutesSignInAvailable = Boolean(oauthDiagnostic) && oauthOrigin.available;");
    expect(access).toContain('const activeChutesMethod = chutesSignInAvailable ? chutesMethod : "api-key";');
    expect(access).toContain('{chutesSignInAvailable && activeChutesMethod === "oauth" ? (');
    expect(access).toContain('{activeChutesMethod === "api-key" ? (');
    expect(access).toMatch(/disabled=\{busy \|\| !online\}\n\s+onClick=\{startChutesSignIn\}/u);
    expect(access).toContain("disabled={!online || !chutesSignInAvailable}");
    expect(access).toContain("disabled={busy || !online}>Discover models with key");
    expect(access).toContain('class="access-network-pause"');
  });

  it("maps OAuth rejection to the active token boundary instead of prescribing the wrong client type", () => {
    expect(app).toContain('exchangeMode === "local-confidential-bridge"');
    expect(app).toContain('"oauth:invalid-local"');
    expect(app).toContain('"oauth:invalid-public"');
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
