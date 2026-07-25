import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

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

  it("blocks a disconnected remote turn before transport invocation while retaining the prompt", () => {
    expect(source).toContain("if (turnRuntime.inferenceBinding && !inferenceConnected)");
    expect(source).toContain("resolveExternalInferencePreflight(");
    expect(source).toContain('externalPreflight.state !== "ready"');
    expect(source).toContain("your prompt, messages, journal, and workspace remain here.");
  });
});
