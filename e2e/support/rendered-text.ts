import { expect, type Locator } from "@playwright/test";

/**
 * Text a person can actually read, as opposed to text a locator can find.
 *
 * `toContainText`, `toHaveText` and `textContent()` all read `textContent`,
 * which a closed `<details>` fills exactly as if it were open. Measured on the
 * built tree: the folder tier's panel had a `textContent` of 1,041 characters
 * and an `innerText` of 46 — "Folder on this device / None open / Open a
 * folder…" — and four e2e assertions about the mount path, the approval fences
 * and the Terminal passed against the 995 characters nobody could see.
 *
 * `innerText` is the browser's own answer to "what is rendered": it drops
 * `display: none`, `visibility: hidden`, `content-visibility: hidden` and the
 * collapsed contents of a closed disclosure, and it keeps text that is merely
 * scrolled out of view — which is right, because scrolling is reading and
 * folding is not.
 */
export function renderedText(locator: Locator): Promise<string> {
  return locator.evaluate((node) => (node as HTMLElement).innerText);
}

/** `renderedText`, polled, so a promise that arrives with a state change counts. */
export async function expectRenderedText(locator: Locator, expected: string | RegExp, timeout = 15_000): Promise<void> {
  await expect
    .poll(() => renderedText(locator), { timeout, message: `rendered text of ${String(locator)}` })
    .toContain(expected as string);
}

/**
 * The invariant that keeps the assertions above honest: nothing in this subtree
 * is text-content-only.
 *
 * Whitespace is stripped from both sides rather than normalised, because
 * `innerText` inserts line breaks at block boundaries that `textContent` does
 * not have. What is compared is the characters themselves — if any of them are
 * inside something the browser did not render, the two differ and this fails.
 */
export async function expectNothingHiddenFromView(locator: Locator): Promise<void> {
  const [rendered, all] = await Promise.all([
    locator.evaluate((node) => (node as HTMLElement).innerText.replace(/\s+/gu, "")),
    locator.evaluate((node) => (node.textContent ?? "").replace(/\s+/gu, "")),
  ]);
  expect(rendered, "every character of textContent must also be rendered text").toBe(all);
}
