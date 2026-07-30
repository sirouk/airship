import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

/**
 * The touch message actions were built out of two role overrides.
 *
 * `role="button"` on the `<summary>` was a presentation fix — it suppressed the
 * disclosure triangle that `list-style: none` and the
 * `::-webkit-details-marker` rule in `chat.css` already suppress — and the
 * price was the native details mapping: the trigger stopped reporting whether
 * it was open. `role="menu"`/`role="menuitem"` around the actions were used as
 * a naming and grouping device, which declares a widget contract (focus moves
 * in on open, roving tabindex, Up/Down/Home/End, Escape closes and restores
 * focus) that no code in that subtree implements.
 *
 * The correct form is what a `<details>` already is plus a named `group`. This
 * is asserted at source because the defect is in the markup the component
 * always emits: a role override cannot be reached by a render path, and the
 * mobile contract in `e2e/message-hover.spec.ts` — which asserts the same thing
 * through the accessibility tree and all four actions — only runs in the mobile
 * project.
 */
const disclosure = (() => {
  const open = app.indexOf('<details class="message-actions-touch">');
  if (open < 0) throw new Error("the touch message-action disclosure is gone");
  const close = app.indexOf("</details>", open);
  return app.slice(open, close);
})();

describe("touch message actions are a disclosure, not a declared menu", () => {
  it("leaves the summary's native role and expanded state alone", () => {
    const summary = disclosure.slice(disclosure.indexOf("<summary"), disclosure.indexOf("</summary>"));
    expect(summary).toContain('aria-label="Message actions"');
    expect(summary).not.toMatch(/(?:^|\s)role\s*=/u);
    // A hand-rolled expanded state would be the same mistake from the other
    // side: `<details>` publishes it, and a stale attribute beside it lies.
    expect(summary).not.toContain("aria-expanded");
  });

  it("groups plain buttons instead of promising menu keyboard semantics", () => {
    expect(disclosure).toContain('<div role="group" aria-label="Message actions">');
    expect(disclosure).not.toContain('role="menu"');
    expect(disclosure).not.toContain('role="menuitem"');
  });

  it("still carries every action the pointer toolbar carries", () => {
    for (const action of ["Copy", "Retry", "Edit &amp; branch", "Fork from here"]) {
      expect(disclosure, action).toContain(action);
    }
  });
});
