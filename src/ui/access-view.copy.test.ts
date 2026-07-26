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
    expect(source).toContain("chutesPanel={isChutesConnected(connection) ? (");
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

  it("keeps the section jump controls off the hash router", () => {
    expect(source).not.toContain('<a href="#connect-surface-card">');
    expect(source).not.toContain('<a href="#additional-inference-providers">');
    expect(source).toContain("onClick={focusConnectSurface}");
    expect(source).toContain("onClick={() => focusDirectProviders()}");
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
    expect(surface).toBeLessThan(source.indexOf("chutesPanel={isChutesConnected(connection) ? ("));
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
    expect(source).toContain("<span>Inference connections</span>");
    expect(source).toContain('<h1 id="access-connection-title">Connect models</h1>');
    expect(source).toContain("<span>Chutes connection</span>");
    expect(source).toContain('aria-label="Additional cloud and local inference providers"');
  });
});
