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
    expect(app).toContain("label={connectivitySeal.label}");
    expect(app).toContain("const mobilePostureSeal = worstTrustAxis(trustAxes)");
    expect(app).toContain("OFFLINE_RUNTIME_LABEL");
    expect(app).toContain("setTrustSheetOpen(true)");
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
    expect(access).toContain("disabled={busy || !oauthDiagnostic || !online || !oauthOrigin.available}");
    expect(access).toContain("disabled={busy || !online}>Discover models with key");
    expect(access).toContain('class="access-network-pause"');
  });

  it("pauses account reads, retains the last observation, and disables refresh", () => {
    const offlineBranch = billing.slice(billing.indexOf("if (!online)"), billing.indexOf("const controller"));
    expect(offlineBranch).not.toContain("setSnapshot(undefined)");
    expect(billing).toContain("disabled={loading || !online}");
    expect(billing).toContain("Account reads paused");
    expect(billing).toContain("last observation held in page memory");
  });
});
