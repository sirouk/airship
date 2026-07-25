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
    expect(source).toContain("models, inference, profile, and account reads that Chutes authorizes");
    expect(source).not.toContain("Checking the credential and discovering models");
    expect(source).not.toContain("validated by prefix");
    expect(source).not.toContain("Check API key and models");
  });

  it("retains connected model selection and the disconnected advanced-key branch", () => {
    expect(source).toContain("onSelectModel");
    expect(source).toContain("selectActiveModel");
    expect(source).toContain('<details class="api-key-alternative">');
    expect(source).toContain("isChutesConnected(connection) ? (");
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
