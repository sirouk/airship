import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Selectors that name nothing.
 *
 * A rule or a test selector that matches no element is worse than absent: it
 * reads as a decision. `.compact-profile-select` styled a native `<select>`
 * wrapper retired when the topbar switcher became a `MenuSelect`, and what it
 * left behind was `display: none` at two phone breakpoints — which reads as
 * "the profile switcher is deliberately hidden on phones", the opposite of what
 * `menu-select.css` does with the live control. `.mobile-navigation` was a
 * guessed class in an e2e assertion whose `if (element)` guard then absorbed
 * its own failure, so the overlap check it made never once executed.
 *
 * This is a whole-tree scan rather than a list of files, because the cost of
 * both defects was that a stale name survived in a file nobody thought to look
 * at when the element was renamed.
 */
const RETIRED_SELECTORS = Object.freeze([
  "compact-profile-select",
  "mobile-navigation",
  /*
   * `profile-governs*` was the whole vocabulary of `profiles-governance.tsx`
   * and its sheet — a fully built, styled component with no caller anywhere,
   * beside a `profiles-governance.ts` label module that is very much alive and
   * that the specifier `"./profiles-governance"` was always resolving to. The
   * component and its sheet contributed nothing to `dist`, but one fragment of
   * them did ship: `shell.css` carried `profile-governs__cell small` in its
   * shared eyebrow list, which was the only `profile-governs` selector in any
   * built stylesheet and could only ever have matched the deleted component's
   * own element. All three are gone; this keeps the name from creeping back
   * into a sheet as a rule for an element that does not exist.
   */
  "profile-governs",
] as const);

const ROOTS = Object.freeze(["../../src", "../../e2e"] as const);

/**
 * Matched in *selector* position only: a leading `.` that is not part of a
 * module path, so `import … from "./mobile-navigation"` — a real file — is not
 * mistaken for the class that file's element never carried.
 */
const IN_SELECTOR_POSITION = new RegExp(String.raw`(?<![\w/])\.(?:${RETIRED_SELECTORS.join("|")})\b`, "u");

async function* sourceFiles(directory: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) yield* sourceFiles(child);
    else if (/\.(?:tsx?|css)$/u.test(entry.name)) yield child;
  }
}

describe("retired selectors leave no rules or assertions behind", () => {
  it("finds no reference to a class no element carries", async () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for await (const file of sourceFiles(new URL(`${root}/`, import.meta.url))) {
        // This file names them on purpose.
        if (file.pathname.endsWith("dead-selector-contract.test.ts")) continue;
        const source = await readFile(file, "utf8");
        for (const [index, line] of source.split("\n").entries()) {
          if (IN_SELECTOR_POSITION.test(line)) offenders.push(`${file.pathname}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
