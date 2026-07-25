import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

describe("chat role layout", () => {
  it("places user messages on the right and agent messages on the left without changing DOM order", () => {
    const userRules = [...styles.matchAll(/\.message\.user\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const baseMessage = [...styles.matchAll(/\.message\s*\{([^}]+)\}/gu)]
      .map((match) => match[1] ?? "")
      .find((rule) => rule.includes("grid-template-columns")) ?? "";
    const desktopUser = userRules.find((rule) => rule.includes("grid-template-columns: minmax(0, 1fr) 31px")) ?? "";

    expect(baseMessage).toContain("margin: 0 auto 18px 0");
    expect(desktopUser).toContain("grid-template-columns: minmax(0, 1fr) 31px");
    expect(desktopUser).toContain("margin-right: 0");
    expect(desktopUser).toContain("margin-left: auto");
  });

  it("preserves the differentiated sides at the mobile breakpoint", () => {
    const userRules = [...styles.matchAll(/\.message\.user\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const mobileUser = userRules.at(-1) ?? "";

    expect(userRules.length).toBeGreaterThanOrEqual(2);
    expect(mobileUser).toContain("grid-template-columns: minmax(0, 1fr) 26px");
    expect(mobileUser).toContain("width: 88%");
    expect(mobileUser).toContain("margin-left: auto");
  });

  it("reserves a stable message-action rail across hover and keyboard focus", () => {
    const actions = styles.match(/\.message-actions\s*\{([^}]+)\}/u)?.[1] ?? "";
    const revealed = styles.match(/\.message:hover \.message-actions, \.message:focus-within \.message-actions\s*\{([^}]+)\}/u)?.[1] ?? "";

    expect(actions).toContain("height: var(--message-action-height)");
    expect(actions).toContain("opacity: 0");
    expect(actions).not.toContain("max-height");
    expect(revealed).toContain("opacity: 1");
    expect(revealed).not.toMatch(/height|margin|padding/u);
  });

  it("keeps the session title, model, trust state, and journal identity in a responsive hierarchy", () => {
    expect(styles).toContain("grid-template-columns: minmax(180px, 1fr) minmax(270px, 420px)");
    expect(styles).toContain(".stage-header-title,");
    expect(styles).toContain(".stage-header-model {");
    expect(styles).toContain(".session-meta-trust,");
    expect(styles).toContain(".session-meta-record {");
  });
});
