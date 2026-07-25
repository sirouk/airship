import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("progressive disclosure coherence contract", () => {
  it("does not render the account dashboard before a readable account exists", async () => {
    const source = await readFile(new URL("./billing-view.tsx", import.meta.url), "utf8");
    expect(source).toContain("Connect with scoped Chutes sign-in or a direct API-key session");
    expect(source).toContain("{accountReadable ? <>{snapshot?.issues.length");
    expect(source.indexOf("billing-gate-preview")).toBeLessThan(source.indexOf("{accountReadable ? <>"));
  });

  it("puts the source task before mobile posture detail", async () => {
    const source = await readFile(new URL("./sources-view.tsx", import.meta.url), "utf8");
    expect(source.indexOf('class="git-import"')).toBeLessThan(source.indexOf('class="git-sources-trust git-sources-trust-desktop"'));
    expect(source).toContain('class="git-sources-trust-disclosure"');
    expect(source).toContain("<SourceTrustFacts client={client} />");
  });

  it("advertises the bounded trust navigation contract", async () => {
    const source = await readFile(new URL("./platform-shell.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("./platform-shell.css", import.meta.url), "utf8");
    expect(source).toContain('aria-label="Trust hub, four horizontally scrollable views"');
    expect(styles).toContain("scroll-snap-type: x proximity");
    expect(styles).toContain("overscroll-behavior-inline: contain");
    expect(styles).toContain(".trust-hub-tabs button { min-height: 44px");
  });

  it("keeps the Google Drive setup on the active Airship design-token vocabulary", async () => {
    const styles = await readFile(new URL("./google-drive-setup.css", import.meta.url), "utf8");
    expect(styles).toContain("var(--density-panel-pad)");
    expect(styles).toContain("var(--surface-soft)");
    expect(styles).not.toMatch(/var\(--(?:space-\d|surface-[01]|text\b|muted\b)/u);
  });
});
