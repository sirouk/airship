import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [app, connections, boundary, navigation, profileDomain, runDetails, deferredRunDetails] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./provider-connections-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("../inference/transport-boundary-label.ts", import.meta.url), "utf8"),
  readFile(new URL("./navigation-model.ts", import.meta.url), "utf8"),
  readFile(new URL("../profiles/domain.ts", import.meta.url), "utf8"),
  readFile(new URL("./chat/run-details.tsx", import.meta.url), "utf8"),
  readFile(new URL("./chat/deferred-run-details.tsx", import.meta.url), "utf8"),
]);

describe("provider-neutral product coherence", () => {
  it("uses one truthful transport-boundary vocabulary in shell and connection route", () => {
    expect(boundary).toContain('case "provider-tls": return "Provider TLS · browser direct"');
    expect(boundary).toContain('case "loopback-local": return "This machine · loopback"');
    expect(app).toContain('import { providerBoundaryLabel } from "../inference/transport-boundary-label"');
    expect(connections).toContain('import { providerBoundaryLabel } from "../inference/transport-boundary-label"');
    expect(app).toContain("providerBoundaryLabel(route.pin.provider.transportBoundary)");
    expect(connections).toContain("providerBoundaryLabel(entry.provider.transportBoundary)");
  });

  it("offers official, API-key, and local providers through one connection surface", () => {
    expect(connections).toContain("browserInferenceFabric");
    expect(connections).toContain("Cloud providers");
    expect(connections).toContain("API-key methods");
    expect(connections).toContain("Local model servers");
    expect(connections).toContain("onActivate(route");
    expect(connections).not.toMatch(/strict-proof|attestation|confidential-authority/iu);
  });

  it("profiles govern concrete runtime and workspace boundaries, not proof floors", () => {
    const manager = app.slice(app.indexOf("function ProfileManagerView({"));
    for (const field of [
      "workspaceBinding",
      "memoryScope",
      "approvalMode",
      "webEgress",
      "webBodies",
      "skillModes",
    ]) expect(`${manager}
${profileDomain}`).toContain(field);
    expect(manager).not.toMatch(/minimumPosture|postureFloor|proofLevel/iu);
    expect(profileDomain).not.toMatch(/postureFloor|proofLevel/iu);
    expect(profileDomain).toContain("Digest-only historical input");
  });

  it("presents receipts as operable local run metadata without upgraded claims", () => {
    const card = app.slice(app.indexOf("function MessageCard("), app.indexOf("function ProfileManagerView({"));
    expect(app).toContain('import { DeferredRunDetails } from "./chat/deferred-run-details"');
    expect(card).toContain("message.receipt ? <DeferredRunDetails receipt={message.receipt} /> : null");
    expect(deferredRunDetails).toContain(
      'const loadRunDetails = () => import("./run-details").then(({ RunDetails }) => RunDetails);',
    );
    expect(deferredRunDetails).toContain(
      "export const DeferredRunDetails = createDeferredComponent(loadRunDetails);",
    );
    expect(runDetails).toContain("<Popover");
    expect(runDetails).toContain('triggerClass="receipt-chip"');
    expect(runDetails).toContain("Run details. Provider");
    expect(runDetails).toContain("receipt.receiptId");
    expect(runDetails).toContain("receipt.responseDigest");
    expect(runDetails).toContain("Authenticity not proven");
    expect(runDetails).not.toContain('role="note"');
    expect(runDetails).not.toContain("title={");
    expect(runDetails).not.toMatch(/attestation|navigate|proof|verdict|sealed/iu);
  });

  it("keeps one global Providers destination and no retired trust route", () => {
    expect(navigation).toContain('access: "#connection"');
    expect(navigation).toContain('destination("access", "Providers", "Setup", "global")');
    expect(navigation).not.toMatch(/#proof|#attestations|#billing|TrustHub/iu);
    expect(app).not.toMatch(/<ProofScreen|<AttestationsScreen|<BillingScreen/u);
  });

  it("states source capabilities once without duplicating desktop and phone facts", async () => {
    const source = await readFile(new URL("./sources-view.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("./sources-view.css", import.meta.url), "utf8");
    expect(source.match(/class="git-sources-facts-disclosure"/gu)).toHaveLength(1);
    expect(source.match(/<SourceFacts /gu)).toHaveLength(1);
    expect(source).not.toContain("git-sources-facts-desktop");
    expect(source.match(/capabilities\.remote\.detail/gu)).toHaveLength(1);
    expect(styles).not.toMatch(/\.git-sources-facts-disclosure\s*\{[^}]*display:\s*none/u);
  });

  it("keeps Google Drive setup on the active design-token vocabulary", async () => {
    const styles = await readFile(new URL("./google-drive-setup.css", import.meta.url), "utf8");
    expect(styles).toContain("var(--density-panel-pad)");
    expect(styles).toContain("var(--surface-soft)");
    expect(styles).not.toMatch(/var\(--(?:space-\d|surface-[01]|text|muted)/u);
  });
});
