import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const routes = await readFile(new URL("./routes.css", import.meta.url), "utf8");
const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

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

  it("wraps rather than cutting to one line, because the list is how two profiles are told apart", () => {
    // The posture chip beside it takes the one-line ellipsis — a posture label
    // is one of a fixed handful of words. A name is not, and two names sharing
    // a prefix must not cut to the same string in a list you pick from.
    expect(rule(".profile-card strong")).not.toContain("white-space: nowrap");
    expect(routes).toContain(".profile-card .posture-chip .seal__label { max-width: 15rem; overflow: hidden; text-overflow: ellipsis;");
  });

  it("clamps the wrap, on the inner display the clamp actually needs", () => {
    /*
     * Wrapping alone only moved the cost: the same name took seven lines at
     * landscape-932 and ten in the phone column.
     *
     * `-webkit-box` is not a legacy accident: the clamp only takes effect on
     * that inner display, so it has to win over the `display: block` the shared
     * `.profile-card strong, .profile-card small` rule above sets. The standard
     * `line-clamp` rides with the prefixed one for the engines that have it.
     */
    const name = rule(".profile-card strong");
    expect(name).toContain("display: -webkit-box");
    expect(name).toContain("-webkit-box-orient: vertical");
    expect(name).toContain("overflow: hidden");
    expect(routes.indexOf(".profile-card strong {")).toBeGreaterThan(routes.indexOf(".profile-card strong,\n.profile-card small {"));
  });

  it("spends the clamp where cards share a flex line, and relaxes it where they do not", () => {
    /*
     * The number is not one number, because the coupling it answers exists in
     * one band only.
     *
     * In the narrow band `.profile-card-list` is `display: flex; flex-wrap:
     * wrap`, and a flex line stretches every item to its tallest — so at
     * landscape-932, where three cards fit a line, one long name sets the height
     * of Research and Developer too, on the layout with the least height to
     * spend. Three lines is the floor that buys that back.
     *
     * Everywhere else the catalog is the stacked one-column grid, where a card's
     * height is nobody's business but its own and the panel scrolls with the
     * page. Clamping at three there bought nothing and cost the tail of the
     * name: measured at laptop-1024 it saved 38px on one card of a panel that
     * ended 46px above a fold the page scrolls past anyway, and spent the last
     * 27 characters of the name to do it. Five renders the 119-character name
     * this was written against whole at laptop-1024 and desktop-1440, and still
     * bounds the narrowest stacked column, tablet-768, at five lines of ten.
     */
    expect(rule(".profile-card strong")).toContain("-webkit-line-clamp: 5");
    expect(rule(".profile-card strong")).toContain("line-clamp: 5");

    /*
     * The override rides with the `display: flex` that creates the coupling, so
     * a future change to one is read beside the other. Both live in the band
     * whose landscape arm — 950px wide by 500px tall — is landscape-932 itself,
     * the viewport the three-line floor is really for; a rule keyed on width
     * alone would miss it and leave that card unclamped.
     */
    const band = "@media (max-width: 640px), (max-width: 950px) and (max-height: 500px) {";
    expect(routes).toContain(band);
    const narrow = routes.slice(
      routes.indexOf(band),
      routes.indexOf(".profile-card .posture-chip { display: none; }"),
    );
    const coupling = narrow.slice(narrow.lastIndexOf("  .profile-card-list {"));
    expect(coupling).toContain("display: flex");
    expect(coupling).toContain("flex-wrap: wrap");
    expect(coupling).toContain("-webkit-line-clamp: 3");
    expect(coupling).toContain("line-clamp: 3");
  });

  it("keeps the clamped remainder recoverable without selecting the card", () => {
    // A clamp that hides text with nowhere to read it is the defect the wrap
    // was chosen over in the first place. The element carries the whole name.
    expect(app).toContain("<strong title={profile.name}>{profile.name}</strong>");
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

describe("the revision strip spends its width where the strip has something to say", () => {
  /*
   * Four equal quarters gave a cell holding one digit the same room as a cell
   * holding a provider and a model name. A quarter was 97px at 768 against a
   * 104px label, so "MINIMUM PROOF" rendered as "MINIMUM PROO" — a label naming
   * a posture the reader cannot then look up — while "airship-demo · airship…"
   * was still truncated at 1920, with three cells beside it sitting on width
   * their own contents did not use.
   */
  it("sizes the three fixed cells to their contents and gives the remainder to the unbounded one", () => {
    expect(rule(".revision-strip"))
      .toContain("grid-template-columns: minmax(0, 1fr) repeat(3, minmax(0, auto))");
    // The runtime value is the first cell, so the flexible track is the one
    // holding the identifier rather than whichever cell happens to be widest.
    expect(app).toContain("<small>Runtime</small>{selected.providerId} · {selected.model}");
  });

  it("ellipsises a label that still runs out of room rather than cutting a letter off it", () => {
    /*
     * `text-overflow` is not inherited, and the cell's own ellipsis governs only
     * the cell's inline content — so this block-level label was left to the
     * cell's `overflow: hidden`, which cuts mid-letter. A hard cut reads as a
     * shorter word; an ellipsis reads as a truncated one, and only the second is
     * true. Track sizing should keep every label whole; this is the fallback.
     */
    const label = rule(".revision-strip small");
    expect(label).toContain("overflow: hidden");
    expect(label).toContain("text-overflow: ellipsis");
    // Inherited from the cell, which is why the label never declared it — and
    // nowrap without a clipping recipe is exactly what chopped the F off PROOF.
    expect(rule(".revision-strip > span")).toContain("white-space: nowrap");
  });
});

describe("the profile boundaries stay legible where the phone made two columns of them", () => {
  /*
   * `.profile-boundary-grid` is collapsed to one column in the narrow block, but
   * the editor's own grid is templated by `.profile-editor-disclosure >
   * .profile-boundary-grid` — 0,2,1 against 0,1,0 — so the collapse never
   * reached the grid a person opens, and order could not settle it, because
   * specificity is settled first. At 430 the base `auto-fit` therefore still
   * made two 169px columns and held "Current workspa…".
   */
  it("collapses the editor's own grid at the specificity the base rule set", () => {
    const narrow = /@media \(max-width: 640px\) \{\s*\.profile-editor-disclosure > \.profile-boundary-grid \{([^}]+)\}/u
      .exec(routes)?.[1] ?? "";
    expect(narrow).toContain("grid-template-columns: 1fr");
    // The base rule it has to outrank is still the one being outranked.
    expect(rule(".profile-editor-disclosure > .profile-boundary-grid"))
      .toContain("grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))");
  });

  it("leaves landscape alone, where four columns still fit and height is what is scarce", () => {
    /*
     * The enclosing query has a landscape arm — 950px wide by 500px tall — and
     * stacking six fields there would spend most of a 430px-high screen on a
     * disclosure opened for a glance. The collapse is nested at width alone, so
     * the arm that fires on height cannot reach it.
     */
    const at = routes.indexOf("@media (max-width: 640px) {\n    .profile-editor-disclosure");
    expect(at).toBeGreaterThan(-1);
    expect(routes.slice(at, at + 200)).not.toContain("max-height");
  });
});
