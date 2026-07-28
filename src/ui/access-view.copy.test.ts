import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./access-view.tsx", import.meta.url), "utf8");

describe("Chutes connection method copy", () => {
  it("pins the connection to the transport's actual security posture", () => {
    expect(source).toContain("posture: transport.posture");
    expect(source).not.toContain('posture: "encrypted-unattested"');
  });

  it("names scoped sign-in without presenting cak_ as a manual credential", () => {
    expect(source).toContain("Chutes sign-in · scoped user session");
    expect(source).toContain('prefix="cpk_"');
    expect(source).not.toContain('prefix="cak_"');
    expect(source).not.toContain("cak_ · OAuth user token");
  });

  it("describes both OAuth boundaries without claiming the extension holds a secret", () => {
    expect(source).toContain('exchangeMode: "local-confidential-bridge" | "public-pkce"');
    expect(source).toContain('oauthDiagnostic?.exchangeMode === "local-confidential-bridge"');
    expect(source).toContain("The app secret stays in the localhost process, outside browser JavaScript.");
    expect(source).toContain("no client secret is used.");
    expect(source).toContain("only the same-origin handler performs token operations");
    expect(source).toContain('fetch("/__airship/chutes/oauth/token"');
    expect(source).toContain("The local Chutes OAuth handler is not configured.");
    expect(source).not.toContain("extension adds the client secret");
  });

  it("uses capability names instead of credential prefixes as table headers", () => {
    expect(source).toContain('<th scope="col">Sign-in eligible</th><th scope="col">Key eligible</th><th scope="col">Active method</th>');
    expect(source).toContain("These are credential-class eligibility rules, not observed grants");
    expect(source).not.toContain('<th scope="col">cak_</th>');
    expect(source).not.toContain('<th scope="col">cpk_</th>');
  });

  it("describes the advanced key action as model discovery", () => {
    expect(source).toContain("Discovering encrypted-inference models available to this connection…");
    expect(source).toContain("Discover models with key");
    expect(source).toContain("read models, inference, profile, and account when Chutes authorizes them");
    expect(source).not.toContain("Checking the credential and discovering models");
    expect(source).not.toContain("validated by prefix");
    expect(source).not.toContain("Check API key and models");
  });

  it("retains connected model selection and the disconnected key branch", () => {
    expect(source).toContain("onSelectModel");
    expect(source).toContain("selectActiveModel");
    expect(source).toContain('role="tablist" aria-label="Chutes connection method"');
    expect(source).toContain('<section class="api-key-alternative"');
    // The three-way branch is unchanged; it is now preceded inside the same
    // panel by the OAuth notice, which used to have its only all-tone home on
    // the page-level boundary aside that moved into the lane's disclosure.
    expect(source).toContain("{isChutesConnected(connection) ? (");
    expect(source).toContain('<p class={`oauth-boundary-status ${oauthNotice.tone}`}');
  });

  it("gives a cold visitor a route when the sign-in exchange is unconfigured", () => {
    // The measured terminal drop-off: a gold "Recommended" button that returned
    // an operator-addressed error, with the working path collapsed beneath it
    // behind the word "Advanced".
    expect(source).toContain('export const CHUTES_ACCOUNT_URL = "https://chutes.ai/app";');
    expect(source).toContain("Create a key at chutes.ai → API keys ↗");
    expect(source).toContain("Chutes personal keys start with cpk_.");
    expect(source).not.toContain("Advanced: use a Chutes API key instead");
    expect(source).not.toContain("Continue to Chutes");
    expect(source).not.toContain("Recommended for this local lab");
    expect(source).not.toContain("Recommended. Connect profile, billing, and inference");
    // The operator sentence survives, but only inside the deployment detail.
    expect(source).toContain("Deployment detail: {oauthOrigin.reason}");
  });

  it("keeps in-page movement off the hash router", () => {
    // The two jump buttons are gone with the sections they pointed at, but the
    // rule they existed to satisfy is not: nothing on this route may navigate
    // by hash, because the hash is the router and `href="#section"` resolved to
    // an unknown route and ejected people to Chat. This is the stronger form —
    // it forbids the anchors outright rather than checking two call sites, and
    // it pins the remaining programmatic move to the panel a person just
    // filled in rather than to a 589px jump down the document.
    expect(source).not.toContain('<a href="#');
    expect(source).toContain('document.getElementById("connect-surface-card")');
    expect(source).toContain("requestAnimationFrame(() => focusConnectSurface())");
  });

  it("consumes a live extension observation and never manufactures one", () => {
    // The bridge package's probe is the only source of presence: no compiled-in
    // record, and no "present" literal anywhere in this view.
    expect(source).toContain("observeExtensionBridge = probeExtensionBridge");
    expect(source).toContain("void observeExtensionBridge().then(");
    expect(source).toContain("bridge,");
    expect(source).not.toContain('state: "present"');
    expect(source).not.toContain('state: "available"');
    expect(source).toContain("observeHostExtensionSupport(typeof navigator === \"undefined\" ? \"\" : navigator.userAgent)");
  });

  it("offers one honest extension install route and provider-specific key fallback", () => {
    expect(source).toContain("VITE_AIRSHIP_EXTENSION_INSTALL_URL");
    expect(source).toContain('role="tablist" aria-label="Chutes connection method"');
    expect(source).toContain("focusDirectProviders(provider?");
    expect(source).toContain("`provider-setup-${provider}`");
  });

  it("keeps the whole connect surface reachable once Chutes is connected", () => {
    // A connected person must still be able to add a second provider, so the
    // surface may not sit inside the connected branch — only the Chutes lane's
    // own panel may.
    const surface = source.indexOf("<ConnectSurface");
    expect(surface).toBeGreaterThan(0);
    expect(source.match(/<ConnectSurface/gu)).toHaveLength(1);
    expect(surface).toBeLessThan(source.indexOf("{isChutesConnected(connection) ? ("));
  });

  it("admits only source-declared text generation models to agent sessions", () => {
    expect(source.match(/inputModalities: \["text"\]/gu)).toHaveLength(2);
    expect(source.match(/outputModalities: \["text"\]/gu)).toHaveLength(2);
    expect(source).toContain("no text-in/text-out models explicitly eligible");
  });

  it("collects proof without breaking encrypted chat and does not offer an impossible strict policy", () => {
    expect(source).toContain('attestationMode: "optional"');
    expect(source).toContain('attestationMode: "required"');
    expect(source).toContain("attestationGate: createChutesAttestationGate");
    expect(source).toContain("Verify &amp; record");
    expect(source).toContain("Strict fail-closed · unavailable");
    expect(source).toContain("disabled={!CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available}");
  });

  it("makes OAuth completion and the proof-policy finish step explicit without requiring a waiver", () => {
    expect(source).toContain("Chutes sign-in complete · finish connection");
    expect(source).toContain("No second credential or attestation waiver is required");
    expect(source).toContain("This policy is not proof");
    expect(source).toContain("Finish: verify &amp; connect");
    expect(source).not.toContain("I understand this endpoint is not independently attested");
    expect(source).not.toContain("Encrypted · TEE unverified");
  });

  it("presents Chutes as one inference connection and mounts additional providers accessibly", () => {
    // Six levels of page chrome became one `<RouteHeader>`. The eyebrow and the
    // H1 are the same two strings, passed as props: the eyebrow is the ⓘ
    // panel's heading and the title is still a real `<h1>` carrying the id the
    // section's `aria-labelledby` points at. Asserting the props is stronger
    // than asserting the markup was — it also pins the heading id, which the
    // old assertion only got for free from the literal tag.
    expect(source).toContain('eyebrow="Inference connections"');
    expect(source).toContain('title="Connect models"');
    expect(source).toContain('headingId="access-connection-title"');
    expect(source).toContain("<span>Chutes connection</span>");
    expect(source).toContain('aria-label="Additional cloud and local inference providers"');
  });

  it("keeps every sentence the collapsed page chrome carried", () => {
    // The information-fate line for the heading collapse, asserted rather than
    // asserted-by-hand: both paragraphs and the eyebrow's own claim survive
    // verbatim, one rung down, and the count chip's sentence is the thing its
    // number now demonstrates.
    expect(source).toContain("Use Chutes for application-encrypted inference, or connect browser-direct cloud and local models here. Credentials remain in page memory.");
    expect(source).toContain("Everything else in Airship — workspace, editor, terminal and Git — already works without this. Only chat needs a model, and connecting one never closes the others.");
    expect(source).toContain("Connect one, or several at once. Connecting one never closes the others.");
  });

  it("keeps the whole OAuth boundary aside, verbatim, inside the flow it describes", () => {
    expect(source).toContain("How this works · what the handler can see");
    expect(source).toContain("Local token-handler boundary");
    expect(source).toContain("Public-client OAuth boundary");
    expect(source).toContain("The localhost handler receives only the one-time code, PKCE verifier, and memory-only token requests.");
    expect(source).toContain("The client ID is public. A one-time PKCE verifier survives only the authorization redirect");
    expect(source).toContain("<summary>Registration details</summary>");
    expect(source).toContain("Start sign-in again");
    // An error is never behind a closed triangle: the diagnostic alert is a
    // sibling of the Sign in button, and the notice is the first thing in the
    // Chutes panel, above the branch that decides which control renders.
    expect(source.indexOf('role="alert">{oauthDiagnosticError}')).toBeGreaterThan(source.indexOf("Sign in to Chutes\n"));
    expect(source.indexOf('<p class={`oauth-boundary-status ${oauthNotice.tone}`}')).toBeLessThan(source.indexOf("{isChutesConnected(connection) ? ("));
  });

  it("keys the proof-policy disclosure on the capability and keeps both descriptions", () => {
    // The 465×108px tile for a permanently disabled option collapses, but only
    // while `available === false`, and both option descriptions plus the
    // capability's own reason stay verbatim inside a summary that says what it
    // contains. The honesty line never enters a disclosure.
    expect(source).toContain("if (!CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available)");
    expect(source).toContain("Strict fail-closed is unavailable in this build. Why, and what each policy does");
    expect(source).toContain("CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.reason");
    expect(source).toContain("Recommended. Evaluate still-current endpoint evidence before every turn");
    expect(source).toContain('<p class="proof-policy__caveat">This policy is not proof.');
  });
});
