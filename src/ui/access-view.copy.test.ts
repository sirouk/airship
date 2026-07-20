import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./access-view.tsx", import.meta.url), "utf8");

describe("Chutes connection method copy", () => {
  it("names scoped sign-in without presenting cak_ as a manual credential", () => {
    expect(source).toContain("Chutes sign-in · scoped user session");
    expect(source).toContain('prefix="cpk_"');
    expect(source).not.toContain('prefix="cak_"');
    expect(source).not.toContain("cak_ · OAuth user token");
  });

  it("uses capability names instead of credential prefixes as table headers", () => {
    expect(source).toContain('<th scope="col">Chutes sign-in</th><th scope="col">API key</th>');
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

  it("connects production Chutes sessions through the required attestation gate", () => {
    expect(source).toContain('attestationMode: "required"');
    expect(source).not.toContain('attestationMode: "optional"');
    expect(source).toContain("attestationGate: createChutesAttestationGate");
  });
});
