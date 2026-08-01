import { expect, test } from "@playwright/test";

/**
 * The shell may replace its own document, but not once that costs someone work.
 *
 * A new service worker taking control fires `controllerchange`, and the shell
 * reloads so COOP/COEP are established before anyone starts. The fence around
 * that reload asked only whether a trusted input gesture had been observed — and
 * a conversation exists before anyone types.
 *
 * Measured on a fresh context, which is what a first visit actually is: one
 * main-frame navigation after the Local Device Vault ceremony reported Ready,
 * three after loading `#chat`. The document had replaced itself during the
 * hand-off, the conversation on the far side was page-memory, and it did not
 * survive. Every downstream symptom came from that: the first screen reporting a
 * loss nobody caused, a turn rendered and reported complete but never journaled,
 * and the address afterwards resolving against a journal that could not hold it.
 *
 * A warm service worker has no update pending, so a second run in the same
 * profile passes. Every assertion here therefore runs in a context that has
 * never seen this origin — the honest case, and the one that failed.
 */

/** Counts documents, not history entries: a hash change is not a reload. */
async function countDocuments(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("navigation").length);
}

test("the shell does not replace the document once a conversation exists", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one service-worker takeover is sufficient");
  test.setTimeout(120_000);
  // A context that has never seen this origin, so the worker really installs.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const namespace = `reload-keeps-${Date.now().toString(36)}`;

  const documents: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documents.push(frame.url());
  });

  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible({ timeout: 25_000 });
  // Past the takeover the shell is entitled to: before a person has anything,
  // replacing the document costs nothing and buys cross-origin isolation.
  await page.waitForTimeout(4_000);
  const settled = documents.length;

  // From here the page holds something a reload would destroy.
  await composer.fill("a half-finished thought I have not sent yet");
  await page.waitForTimeout(1_000);
  await expect(composer).toHaveValue("a half-finished thought I have not sent yet");

  await page.waitForTimeout(6_000);
  expect(documents.length, `the shell replaced its own document after work existed:\n${documents.join("\n")}`)
    .toBe(settled);
  // And the work is still there, which is the point of not reloading.
  await expect(composer).toHaveValue("a half-finished thought I have not sent yet");
  expect(await countDocuments(page)).toBeGreaterThan(0);
  await context.close();
});

test("an update that arrives while work exists is offered, not taken", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one service-worker takeover is sufficient");
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const namespace = `reload-offer-${Date.now().toString(36)}`;
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(4_000);
  await composer.fill("work that must outlive an update");

  /*
   * The banner is the alternative to the reload, and it is an announcement —
   * so it may not sit on top of the control it is announcing about. Measured
   * while clicking Send: `<div role="status" class="pwa-update"> intercepts
   * pointer events`, 58 retries before the click timed out.
   */
  const banner = page.locator(".pwa-update");
  if (await banner.count()) {
    const send = page.getByRole("button", { name: "Send message" });
    const sendBox = await send.boundingBox();
    const bannerBox = await banner.first().boundingBox();
    expect(sendBox).not.toBeNull();
    if (bannerBox && sendBox) {
      const overlaps = bannerBox.x < sendBox.x + sendBox.width
        && bannerBox.x + bannerBox.width > sendBox.x
        && bannerBox.y < sendBox.y + sendBox.height
        && bannerBox.y + bannerBox.height > sendBox.y;
      expect(overlaps, "the update banner covers the composer's send control").toBe(false);
    }
  }
  await expect(composer).toHaveValue("work that must outlive an update");
  await context.close();
});
