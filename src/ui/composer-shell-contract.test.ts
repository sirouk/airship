import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Selectors whose correctness depends on markup in another file.
 *
 * Every defect pinned here had the same shape as the streaming caret's: a rule
 * that reads correct in isolation, markup that reads correct in isolation, and
 * a combinator between them that can never match — so the feature is simply
 * never painted, and no test notices because no test reads both files. These
 * assertions read both.
 */
const [chatStyles, routeStyles, shellStyles, menuStyles, appSource] = await Promise.all([
  readFile(new URL("./chat.css", import.meta.url), "utf8"),
  readFile(new URL("./routes.css", import.meta.url), "utf8"),
  readFile(new URL("./platform-shell.css", import.meta.url), "utf8"),
  readFile(new URL("./menu-select.css", import.meta.url), "utf8"),
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
]);

/** The phone query `routes.css` withdraws the rail on. */
const PHONE_QUERY = "@media (max-width: 640px), (max-width: 950px) and (max-height: 500px)";

describe("the composer's scroll fade", () => {
  it("selects the textarea through the ancestor chain the composer actually renders", () => {
    // `.composer-wrap > .composer > .composer-input-row > textarea`. The rules
    // carried a `.composer` step *inside* `.composer-input-row`, which inverts
    // the real nesting, so the fade never rendered and a scrolled draft kept
    // showing a half-sliced top line.
    const wrap = appSource.indexOf('<div class="composer-wrap">');
    const composer = appSource.indexOf("class={`composer${busy ?");
    const inputRow = appSource.indexOf('<div class="composer-input-row">');
    expect(wrap, "the composer wrapper is rendered").toBeGreaterThan(-1);
    expect(composer, "the composer element is rendered").toBeGreaterThan(wrap);
    expect(inputRow, "the input row opens inside the composer, not around it").toBeGreaterThan(composer);
    const fadeRules = [...chatStyles.matchAll(/^(\.composer-input-row\[data-scrolled=[^\n{]*)\{/gmu)];
    expect(fadeRules.length, "the fade rules must exist").toBeGreaterThan(0);
    for (const [, selector] of fadeRules) {
      expect(selector, "a `.composer` step here can never match").not.toContain(".composer ");
    }
    expect(chatStyles).toContain('.composer-input-row[data-scrolled="both"] textarea');
  });
});

/*
 * The composer footer's child combinators, checked against the row's markup.
 *
 * `.composer-tools > span` styled the credential-posture caption back when
 * that caption was a bare `<span>`. Replacing it with `ComposerPostureChip`
 * left the rule matching nothing: the chip's Popover root is a `<div>`
 * (popover.tsx `useRef<HTMLDivElement>`), MenuSelect's root is a `<div>`, and
 * `.composer-attach`'s span is a grandchild of the row, not a child. That is
 * the same family as the phone rule `.composer-tools span:nth-child(2)
 * { display: none }`, which rendered the credential posture at 0x0px for three
 * waves: an inert selector reads as a deliberate decision about a row that has
 * none, so the next reader styles around it instead of deleting it.
 */
describe("the composer footer's child selectors", () => {
  it("targets no direct child the row does not render", () => {
    const row = appSource.indexOf('<div class="composer-tools">');
    expect(row, "the composer tool row is rendered").toBeGreaterThan(-1);
    // Bounded to the row itself: the next sibling comment in app.tsx is the
    // Enter-contract legend, which closes the row.
    const rowMarkup = appSource.slice(row, appSource.indexOf("<ComposerKeyhintLegend", row));
    expect(rowMarkup, "the row is bounded by its next sibling").not.toBe("");
    for (const styles of [chatStyles, routeStyles]) {
      // Comments stripped first: a removed rule is named in the comment that
      // records why it went, and a tombstone is not a selector.
      const rules = styles.replace(/\/\*[\s\S]*?\*\//gu, "");
      for (const [, tag] of rules.matchAll(/\.composer-tools\s*>\s*([a-z][\w-]*)/gu)) {
        // A rule may only name a direct child the row literally opens. Every
        // other child is a component, and a component's root element is not
        // knowable from this file — which is exactly why child combinators do
        // not belong on them.
        expect(rowMarkup, `.composer-tools > ${tag} names an element the row does not open`)
          .toContain(`<${tag} class="composer-`);
      }
    }
    // The retired rule specifically, since its removal is the fix under test.
    expect(chatStyles.replace(/\/\*[\s\S]*?\*\//gu, "")).not.toContain(".composer-tools > span");
  });
});

describe("the answer/narration typographic hierarchy", () => {
  it("reaches the element that actually carries the prose", async () => {
    // The two wrapper rules set inheritable properties; `.markdown` re-declares
    // all three on itself, and a declaration beats inheritance every time — so
    // narration and answer rendered identically until the prose opted back in.
    const markdown = await readFile(new URL("./chat/message-parts-view.css", import.meta.url), "utf8");
    expect(markdown).toMatch(/^\.markdown \{[^}]*color:/mu);
    expect(chatStyles).toMatch(
      /\.message-parts \.message-part\.text > \.markdown \{[^}]*color: inherit;[^}]*font-size: inherit;[^}]*line-height: inherit;/u,
    );
  });
});

describe("the phone shell's soft-keyboard compensation", () => {
  it("shrinks the shell to the visual viewport instead of repainting the composer", () => {
    // The whole point of the assertion, and the thing the unit test in
    // `platform-shell.test.ts` models: the compensation has to move a *box*,
    // not a paint. Two rules shipped that did not — `position: relative; bottom`
    // on `.composer-wrap` lifted the composer's painted box while leaving the
    // track it came from, and a keyboard-conditional `padding-bottom` on
    // `.transcript` only added scrollable extent below a card that stayed
    // hidden. Neither raised the transcript's border-box floor, which is the
    // box `scrollToLastRealCard` and every geometry spec measure against.
    const phoneBlock = routeStyles.slice(routeStyles.lastIndexOf(PHONE_QUERY));
    expect(phoneBlock).toMatch(/#app \{\s*height: calc\(100dvh - var\(--visual-viewport-bottom, 0px\)\);/u);
    expect(phoneBlock, "a static `bottom` is discarded; a relative one repaints only")
      .not.toMatch(/\.composer-wrap \{\s*position:/u);
    expect(phoneBlock).not.toMatch(/:root\[data-keyboard-open="true"\] \.transcript \{/u);
    expect(shellStyles).not.toContain(".composer-wrap { bottom:");
  });

  it("collapses the nav's grid track rather than only hiding the nav", () => {
    // The band is an explicit `grid-template-rows` track on `.app-shell`, so
    // suppressing the element alone left 56px of dead ground under the lifted
    // composer.
    expect(shellStyles).toContain(':root[data-keyboard-open="true"] .fixed-mobile-nav { display: none; }');
    expect(shellStyles).not.toMatch(/\.fixed-mobile-nav \{ visibility: hidden/u);
    const phoneBlock = routeStyles.slice(routeStyles.lastIndexOf(PHONE_QUERY));
    expect(phoneBlock).toMatch(/:root\[data-keyboard-open="true"\] \.app-shell \{\s*grid-template-rows:[^;]*\s0;/u);
  });
});

describe("the phone profile switcher", () => {
  it("appears wherever the rail is withdrawn, not on a different narrow band", () => {
    // Two definitions of "phone" coexisted: the rail withdrew on the shell
    // query while the replacement switcher revealed on a plain 860px. The bands
    // overlap in portrait and not at 861–950px landscape, so a 932×430 phone
    // had no way to change profile at all.
    expect(menuStyles).toContain("@media (max-width:860px), (max-width:950px) and (max-height:500px) { .compact-profile-menu { display:block; } }");
  });
});
