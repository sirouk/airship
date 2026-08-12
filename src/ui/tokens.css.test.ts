import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/*
 * The touch floor is a product law — "nothing a finger has to hit may be
 * smaller than 44px on either axis" — and `e2e/touch-target-floor.spec.ts`
 * measures it in a browser. It can only measure the viewports Playwright runs,
 * which is exactly how the rail escaped it: the floor was written on the width
 * axis, and a tablet is a coarse pointer at a desktop width.
 */
describe("the compact density floor under a coarse pointer", () => {
  it("floors the density tokens on the pointer axis, not only at phone widths", () => {
    const coarse = [...tokens.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/gu)].map((block) => block[1] ?? "");
    const floored = coarse.filter((block) => block.includes(':root[data-density="compact"]'));
    expect(floored).toHaveLength(1);
    expect(floored[0]).toContain("--density-control: var(--touch-target)");
    expect(floored[0]).toContain("--density-row: var(--touch-target)");
    // `.nav-item`'s height is `--density-control` and nothing else
    // (`:root[data-density] .nav-item`, which outranks shell.css's own rule), so
    // flooring the token is what floors every rail destination.
    expect(tokens).toContain(":root[data-density] .nav-item { min-height: var(--density-control); }");
    // Later than the base compact block, or the 36px declaration wins on order.
    expect(tokens.lastIndexOf(':root[data-density="compact"]'))
      .toBeGreaterThan(tokens.indexOf("--density-control: 36px"));
  });

  it("keeps the width-scoped copy that a narrow mouse-driven window needs", () => {
    // A resized desktop window is `(pointer: coarse)`-false at 390px wide, so
    // deleting this block would silently drop those controls back to 36px.
    const phone = tokens.match(/@media \(max-width: 640px\), \(max-width: 950px\) and \(max-height: 500px\) \{[\s\S]*?\n  :root\[data-density="compact"\] \{[^}]*\}/u)?.[0] ?? "";
    expect(phone).toContain("--density-control: var(--touch-target)");
    expect(phone).toContain("--density-row: var(--touch-target)");
  });
});
