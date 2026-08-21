import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The motion layer's contract.
 *
 * Airship shipped 87 `:hover` rules against one `:active`, and an overlay layer
 * in which every panel reported `transition: all 0s; animation: none`. Neither
 * was a taste problem. A press that is never acknowledged is a product that
 * looks broken for the five to twenty-nine seconds an answer takes, and an
 * overlay that blinks into place never says which control produced it — which
 * is the entire claim an anchored disclosure makes.
 *
 * Both fixes are CSS, so both can be reverted by one careless edit in a sheet
 * nobody was reading. These assertions are the only thing between that edit and
 * a year of nobody noticing, which is exactly how the streaming caret was lost.
 */

/** Every duration this layer is allowed to spend, in milliseconds. */
const LONGEST_DEFENSIBLE_ENTRANCE_MS = 180;

/** The control families that must acknowledge a press. */
const PRESSED_FAMILIES = Object.freeze([
  ".nav-item",
  ".topbar button",
  ".small-button",
  ".starter-chip",
  ".workbench-dialog button",
  ".approval-dock button",
] as const);

/** The overlays that must have an entrance. */
const OVERLAYS = Object.freeze([
  ".command-palette",
  ".preferences-dialog",
  ".approval-dock",
  ".workbench-notice",
  ".transcript-jump",
] as const);

async function sheet(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

/**
 * Comments in these sheets quote the very selectors under test, so a census run
 * over the raw text counts the explanation as if it were a rule.
 */
function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/** The press tint, which is what identifies the rule that acknowledges a press. */
const PRESS_TINT = "background-color: color-mix(in srgb, var(--accent) 14%, transparent)";

/**
 * The selector list of the rule that makes `declaration` — not every selector
 * in the sheet that happens to mention the same family somewhere else. A census
 * run over the whole file passes when the press rule loses a family and the
 * reduced-motion counterpart keeps it, which is the exact edit these tests exist
 * to catch.
 */
function selectorsOfRuleDeclaring(css: string, declaration: string): string {
  const at = css.indexOf(declaration);
  if (at < 0) return "";
  const open = css.lastIndexOf("{", at);
  const previous = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("*/", open));
  return css.slice(previous + 1, open);
}

describe("the pressed frame", () => {
  it("acknowledges a press on every consequential control family", async () => {
    const css = declarationsOnly(await sheet("shell.css"));
    const pressed = selectorsOfRuleDeclaring(css, PRESS_TINT);
    const missing = PRESSED_FAMILIES.filter((family) => !pressed.includes(`${family}:active`));
    expect(missing).toEqual([]);
  });

  it("declares the press after the hover it has to outrank", async () => {
    // `.nav-item:hover` and `.nav-item:active` are the same specificity, and a
    // mouse held down is hovering as well as active. Declared first, the press
    // tint would be silently swallowed on the rail — the single most-pressed
    // family in the product.
    const css = await sheet("shell.css");
    expect(css.indexOf(".nav-item:active")).toBeGreaterThan(css.indexOf(".nav-item:hover"));
  });

  it("outranks the one hover that lives in a later sheet by specificity instead", async () => {
    // `.starter-chip:hover` is in `chat.css`, which no position in `shell.css`
    // can follow. The bare `:active` still covers keyboard and touch, where
    // hover was never in play; `:hover:active` covers the mouse.
    const chat = declarationsOnly(await sheet("chat.css"));
    expect(chat).toContain(".starter-chip:hover");
    const shell = declarationsOnly(await sheet("shell.css"));
    expect(selectorsOfRuleDeclaring(shell, PRESS_TINT)).toContain(".starter-chip:hover:active");
  });

  it("keeps the acknowledgement and drops only the movement under reduced motion", async () => {
    const css = declarationsOnly(await sheet("shell.css"));
    const reduced = reducedMotionBlocks(css);
    const pressReduction = reduced.find((block) => block.includes(".nav-item:active"));
    expect(pressReduction, "the press must have a reduced-motion counterpart").toBeDefined();
    expect(pressReduction).toContain("transform: none");
    // The tint is the message. Retracting it too would leave reduced-motion
    // users with the silence the whole item exists to end.
    expect(pressReduction).not.toContain("background-color");
    for (const family of PRESSED_FAMILIES) expect(pressReduction).toContain(`${family}:active`);
  });
});

describe("the overlay entrance", () => {
  it("gives every overlay an arrival", async () => {
    const css = declarationsOnly(await sheet("shell.css"));
    const entrance = css.slice(css.indexOf("@keyframes overlay-fade"));
    expect(entrance).toContain("from { opacity: 0; }");
    const withoutEntrance = OVERLAYS.filter((overlay) => !css.includes(`${overlay},`) && !css.includes(`${overlay} {`));
    expect(withoutEntrance).toEqual([]);
  });

  it("carries the travel in one property so reduced motion retracts it once", async () => {
    const css = declarationsOnly(await sheet("shell.css"));
    // The phone override raises the rise to a full sheet height. If reduced
    // motion retracted the animation rather than the property, that override
    // would quietly reinstate the largest movement in the product.
    expect(css).toContain("--overlay-rise: translateY(100%)");
    const reduced = reducedMotionBlocks(css).find((block) => block.includes("--overlay-rise"));
    expect(reduced).toContain("--overlay-rise: none");
    for (const overlay of OVERLAYS) expect(reduced).toContain(overlay);
    expect(css.indexOf("--overlay-rise: none")).toBeGreaterThan(css.indexOf("--overlay-rise: translateY(100%)"));
  });

  it("fades a menu open and never moves the option under the finger", async () => {
    // `.menu-select-popover` is the Preferences durability control and the
    // composer's approval-policy control — the menu whose value decides whether
    // the agent writes files and runs shell commands without asking. It takes
    // the layer's fade and refuses its rise: a menu is opened and immediately
    // tapped, so an entrance that travels is an entrance during which the option
    // under a thumb is not the option that will be selected.
    const css = declarationsOnly(await sheet("menu-select.css"));
    expect(css).toContain("animation:overlay-fade 120ms ease;");
    expect(css).not.toContain("overlay-rise");
    expect(css).not.toContain("transform-origin");
  });

  it("never spends long enough to be read as waiting", async () => {
    const css = declarationsOnly(await sheet("shell.css"));
    const layer = css.slice(css.indexOf(".platform-scrim,"));
    const durations = [...layer.matchAll(/(\d+)ms/gu)].map((match) => Number(match[1]));
    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBeLessThanOrEqual(LONGEST_DEFENSIBLE_ENTRANCE_MS);
  });
});

describe("the anchored disclosure's arrival", () => {
  it("is a state the panel can transition out of, not an attribute that deletes it", async () => {
    const source = await readFile(new URL("./popover.tsx", import.meta.url), "utf8");
    const markup = source.slice(source.indexOf('class="popover__panel"'));
    expect(markup).not.toContain("hidden={!open}");
    expect(markup).toContain('data-open={open ? "true" : "false"}');
    expect(markup).toContain("inert={!open}");
  });

  it("still contributes no box, no tab stop and no accessibility node while closed", async () => {
    // The whole reason this is `display: none` deferred by `allow-discrete`
    // rather than `opacity: 0`: a visually hidden panel is still a 320px box
    // inside a scrolling transcript, still focusable, and still read aloud.
    const css = declarationsOnly(await sheet("popover.css"));
    const closed = css.slice(css.indexOf('.popover__panel[data-open="false"]'));
    expect(closed.slice(0, closed.indexOf("}"))).toContain("display: none");
    expect(css).toContain("display 120ms allow-discrete");
  });

  it("grows from the control that produced it", async () => {
    const css = declarationsOnly(await sheet("popover.css"));
    expect(css).toContain("transform-origin: var(--popover-origin, top center)");
    expect(css).toContain("--popover-origin: top left");
    expect(css).toContain("--popover-origin: top right");
    expect(css).toContain("--popover-origin: bottom center");
  });

  it("retracts the sheet's travel too, not only the anchored panel's", async () => {
    // The sheet declares its own `--popover-lift` at higher specificity, so a
    // reduced-motion rule naming only `.popover__panel` would leave the one
    // panel that travels furthest as the only panel still travelling.
    const css = declarationsOnly(await sheet("popover.css"));
    const reduced = reducedMotionBlocks(css).find((block) => block.includes("--popover-lift"));
    expect(reduced).toContain('.popover[data-mode="sheet"] .popover__panel');
    expect(reduced).toContain("--popover-lift: none");
  });
});

describe("reduced motion has one policy", () => {
  it("keeps the global duration reset as the only one, and adds only what it cannot reach", async () => {
    // The product's reduced-motion policy is a single `*` reset in `routes.css`
    // that collapses every duration to 0.01ms. A second global reset would be
    // two policies, and the loser would be silent. Everything this package adds
    // is scoped to named selectors and declares only the two things a duration
    // reset cannot retract: a static `:active` transform, and the *distance* a
    // keyframe starts from.
    const routes = declarationsOnly(await sheet("routes.css"));
    const globals = reducedMotionBlocks(routes).filter((block) => /(^|\s)\*\s*,/u.test(block));
    expect(globals).toHaveLength(1);
    expect(globals[0]).toContain("transition-duration: 0.01ms !important");
    expect(globals[0]).toContain("animation-duration: 0.01ms !important");

    for (const name of ["shell.css", "popover.css", "menu-select.css"]) {
      for (const block of reducedMotionBlocks(declarationsOnly(await sheet(name)))) {
        expect(block, `${name} must not declare a second global reset`).not.toMatch(/(^|\s)\*\s*[,{]/u);
        // Restating the durations here would duplicate the policy, and two
        // copies of a policy is how one of them silently stops being true.
        expect(block).not.toMatch(/(transition|animation)-duration\s*:/u);
      }
    }
  });

  it("retracts what a duration reset cannot: the press transform and the two travels", async () => {
    const shell = declarationsOnly(await sheet("shell.css"));
    const press = reducedMotionBlocks(shell).find((block) => block.includes(".nav-item:active"));
    expect(press).toContain("transform: none");
    expect(reducedMotionBlocks(shell).find((block) => block.includes("--overlay-rise")))
      .toContain("--overlay-rise: none");
    expect(reducedMotionBlocks(declarationsOnly(await sheet("popover.css")))
      .find((block) => block.includes("--popover-lift"))).toContain("--popover-lift: none");
  });
});

/** Every `@media (prefers-reduced-motion: reduce)` body in a sheet. */
function reducedMotionBlocks(css: string): readonly string[] {
  const blocks: string[] = [];
  const opener = /@media \(prefers-reduced-motion:\s*reduce\)\s*\{/gu;
  for (const match of css.matchAll(opener)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push(css.slice(start, index - 1));
  }
  return Object.freeze(blocks);
}
