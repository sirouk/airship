import { expect, type Page } from "@playwright/test";

/**
 * A first visit navigates three times, and only the third one is the app.
 *
 * Traced on this build, a cold load of `/#chat` goes: document at 29ms, the
 * minted conversation address at 127ms, a full document reload at 153ms — the
 * service worker taking control so the cross-origin isolation headers apply —
 * and a second, different minted address at 212ms. Anything a spec does inside
 * that window is done to a page that is about to be replaced: `page.evaluate`
 * fails with "Execution context was destroyed", a keystroke lands in a document
 * with no handlers attached and is silently dropped, and a focus assertion
 * describes a shell that no longer exists.
 *
 * Three specs chased that as three different bugs. It is one boundary, and this
 * is the wait for it. `networkidle` is what actually spans the reload — the new
 * document restarts the request graph, so idle cannot be reached until the
 * surviving document is the one being measured.
 */
export async function waitForShellSettled(
  page: Page,
  options: Readonly<{ composer?: boolean; timeout?: number }> = {},
): Promise<void> {
  const timeout = options.timeout ?? 30_000;
  await page.waitForLoadState("networkidle", { timeout });
  // The composer is the chat shell's own statement that it is mounted and
  // listening, and it is the strongest available signal — but only the chat
  // route has one. Waiting for it unconditionally turned this helper into a
  // 30-second timeout on #workspace, #sources and #editor, which is a worse
  // failure than the race it was added to remove. Callers can still force
  // either answer; by default the route decides.
  const wantsComposer = options.composer ?? new URL(page.url()).hash.startsWith("#chat");
  if (!wantsComposer) return;
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout });
}
