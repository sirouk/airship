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
