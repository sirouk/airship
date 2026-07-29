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
  it("gives the composer a positioning scheme for the offset it is handed", () => {
    // `bottom` on a statically positioned element is discarded, so the shell
    // reported that it had lifted the composer above the keyboard while the
    // composer had not moved.
    expect(shellStyles).toContain(':root[data-keyboard-open="true"] .composer-wrap { bottom: var(--visual-viewport-bottom, 0); }');
    const phoneBlock = routeStyles.slice(routeStyles.lastIndexOf(PHONE_QUERY));
    expect(phoneBlock).toMatch(/\.composer-wrap \{\s*position: relative;/u);
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
