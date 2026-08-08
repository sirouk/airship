import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const routes = await readFile(new URL("./routes.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\n${escaped} \\{([^}]+)\\}`, "u").exec(routes)?.[1] ?? "";
}

/*
 * The Profiles catalog holds names their authors typed, and nothing between the
 * text and the panel edge clipped them. Held as stylesheet text because the
 * defect is a cascade fact — which declarations reach `.profile-card strong`
 * and `.profile-archive-zone .danger:disabled` — and jsdom performs no layout,
 * so a rendered assertion here would be a test that cannot fail.
 */
describe("a profile name stays inside its own card", () => {
  it("gives the name somewhere to break, so an unbreakable one cannot leave the track", () => {
    /*
     * The middle track is already `minmax(0, 1fr)`, so the track may shrink —
     * but a 49-character single-word name has a min-content width of the whole
     * string and painted straight out of the card: past the viewport edge at
     * 390, and across the panel divider at 1440, where it ran under the Profile
     * revision panel's NAME and ROLE labels.
     */
    expect(rule(".profile-card")).toContain("grid-template-columns: 34px minmax(0, 1fr) auto");
    expect(rule(".profile-card strong")).toContain("overflow-wrap: anywhere");
  });

  it("wraps rather than truncates, because the list is how two profiles are told apart", () => {
    // The posture chip beside it does truncate — a posture label is one of a
    // fixed handful of words. A name is not, and two names sharing a prefix
    // must not ellipsise to the same string in a list you pick from.
    expect(rule(".profile-card strong")).not.toContain("text-overflow: ellipsis");
    expect(routes).toContain(".profile-card .posture-chip .seal__label { max-width: 15rem; overflow: hidden; text-overflow: ellipsis;");
  });
});

describe("the archive zone's destructive verb tells the truth about its state", () => {
  /*
   * `.profile-archive-zone .danger` restates the failed hue and border
   * unconditionally, so it won over `button:disabled` in `tokens.css` and
   * Remove profile read as live while `disabled` was set — in the same frame
   * where Switch to this profile, disabled for the same preview, was correctly
   * greyed out. Two disabled controls, one styled live and one styled dead.
   */
  it("hands the disabled state back to the baseline the enabled rule overrides", () => {
    const disabled = rule(".profile-archive-zone .danger:disabled");
    expect(rule(".profile-archive-zone .danger")).toContain("color: var(--v-failed)");
    expect(disabled).toContain("color: var(--ink-disabled)");
    expect(disabled).toContain("background: var(--surface-disabled)");
    expect(disabled).toContain("border-color: var(--line)");
    expect(disabled).toContain("cursor: not-allowed");
    // Ordered after the rule it corrects; a `:disabled` block above it would
    // lose to the unconditional one on source order at equal specificity.
    expect(routes.indexOf(".profile-archive-zone .danger:disabled"))
      .toBeGreaterThan(routes.indexOf(".profile-archive-zone .danger {"));
  });
});

describe("the profile boundary selects are enrolled in the touch floor", () => {
  /*
   * Two rules in this sheet are written from the same 38px recipe — the Skills
   * route's triggers and the six governance selects on Profiles — and only the
   * first was listed in the coarse-pointer block, so the second stayed 38px
   * under the same finger against the product's own 44px law in `tokens.css`.
   */
  it("floors them with the neighbours that share their recipe rather than a number of their own", () => {
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/gu;
    const floor = [...routes.matchAll(coarse)]
      .map((match) => match[1] ?? "")
      .find((block) => block.includes(".profile-boundary-grid .menu-select-trigger")) ?? "";

    expect(floor).toContain(".skills-toolbar .menu-select-trigger");
    expect(floor).toContain(".skill-controls .menu-select-trigger");
    expect(floor).toContain("min-height: var(--touch-target)");
    // The designed height at a fine pointer is unchanged: the floor is the
    // disagreement a finger settles, not a replacement for the density.
    expect(rule(".profile-boundary-grid .menu-select-trigger")).toContain("min-height: 38px");
  });
});
