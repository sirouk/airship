import { expect, test } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";

/*
 * Minimal is the house default. Raising the Profile's information rung mounts
 * more presentation around the same locally recorded turn. Balanced adds
 * neutral Run details; Instrumented adds raw completion detail. Reasoning is a
 * separate Profile fold and stays present at every rung.
 */
test("minimal, balanced and instrumented re-render the same recorded turn", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/#chat", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".transcript");
  await expect(page.locator("html")).toHaveAttribute("data-presentation-density", "minimal");

  // Minimal keeps consequence and demo honesty, but retires commentary,
  // suggestions, telemetry and raw detail by not mounting them.
  await expect(page.locator(".transcript-intro__unsaved")).toContainText("not being saved");
  await expect(page.locator(".transcript-intro__lead")).toContainText(/demo/u);
  await expect(page.locator(".transcript-intro__lead strong")).toHaveCount(0);
  await expect(page.locator(".transcript-intro__runtime")).toHaveCount(0);
  await expect(page.locator(".transcript-intro__tier")).toHaveCount(0);
  await expect(page.locator(".transcript-starters")).toHaveCount(0);

  await page.getByRole("combobox", { name: "Message Airship" }).fill("/reason whether suggestions stay quiet");
  await page.getByRole("button", { name: "Send message" }).click();
  const minimalAnswer = page.locator('[data-transcript-card][data-message-role="assistant"]').last();
  // The trace address lands only when the receipt is finalized, so this waits
  // for the recorded turn without depending on density-gated chrome.
  await expect(minimalAnswer).toHaveAttribute("data-turn-id", /.+/u, { timeout: 30_000 });
  const turnId = await minimalAnswer.getAttribute("data-turn-id");
  expect(turnId).toBeTruthy();
  const threadHash = new URL(page.url()).hash;

  // Reasoning no longer disappears when streaming settles. Its Profile fold is
  // independent of density and remains collapsed by default.
  await expect(minimalAnswer.locator("details.reasoning-aside")).toHaveCount(1);
  await expect(minimalAnswer.locator(".reasoning-aside__body")).toBeHidden();
  await expect(minimalAnswer.locator(".message-capability-tier")).toHaveCount(0);
  await expect(minimalAnswer.locator(".receipt-chip")).toHaveCount(0);
  await expect(minimalAnswer.locator(".message-part.part-footer")).toHaveCount(0);

  // Balanced mounts the neutral per-turn trace and other useful telemetry, but
  // raw completion detail remains one rung higher.
  await setProfilePresentationDensity(page, "Balanced");
  await page.evaluate(() => { window.location.hash = "chat"; });
  await expect.poll(() => new URL(page.url()).hash).toBe(threadHash);
  await expect(page.locator("html")).toHaveAttribute("data-presentation-density", "balanced");
  const balancedAnswer = page.locator(`[data-transcript-card][data-turn-id="${turnId!}"]`);
  await expect(balancedAnswer.locator("details.reasoning-aside")).toHaveCount(1);
  await expect(balancedAnswer.locator(".reasoning-aside__body")).toBeHidden();
  await expect(balancedAnswer.locator(".message-capability-tier")).toHaveCount(1);
  await expect(balancedAnswer.locator(".message-part.part-footer")).toHaveCount(0);
  const run = balancedAnswer.getByRole("button", { name: /^Run details\./u });
  await expect(run).toBeVisible();
  await expect(run).toHaveText(/^Run · airship-demo · [0-9a-f]{8}$/u);
  if (testInfo.project.name === "mobile-chromium") {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const runTarget = await run.boundingBox();
    expect(runTarget).not.toBeNull();
    expect(runTarget!.width).toBeGreaterThanOrEqual(44);
    expect(runTarget!.height).toBeGreaterThanOrEqual(44);
  }
  const runName = await run.getAttribute("aria-label");
  if (testInfo.project.name === "mobile-chromium") {
    await run.tap();
  } else {
    await run.focus();
    await run.press("Enter");
  }
  const runTrace = balancedAnswer.getByRole("group", { name: "Run details" });
  await expect(runTrace).toBeVisible();
  await expect(runTrace.locator('[data-field="origin"]')).toContainText("Local run record");
  await expect(runTrace.locator('[data-field="created"] time')).toHaveText(/^20\d{2}-\d{2}-\d{2}T/u);
  await expect(runTrace.locator('[data-field="completed"] time')).toHaveText(/^20\d{2}-\d{2}-\d{2}T/u);
  await expect(runTrace.locator('[data-field="request-digest"] code')).toHaveText(/^sha256:/u);
  await expect(runTrace.locator('[data-field="response-digest"] code')).toHaveText(/^sha256:/u);
  await expect(runTrace.locator(".receipt-trace__scope")).toHaveText(
    "Structural linkage only. Digests not recomputed. Authenticity not proven.",
  );
  const receiptId = await runTrace.locator('[data-field="receipt-id"] code').innerText();
  expect(receiptId).toMatch(/^urn:receipt:/u);
  await runTrace.getByRole("button", { name: "Done" }).click();
  await expect(runTrace).toBeHidden();
  await expect(run).toBeFocused();

  // Instrumented adds the raw completion footer without changing the turn or
  // opening the independent reasoning fold.
  await setProfilePresentationDensity(page, "Instrumented");
  await page.evaluate(() => { window.location.hash = "chat"; });
  await expect.poll(() => new URL(page.url()).hash).toBe(threadHash);
  await expect(page.locator("html")).toHaveAttribute("data-presentation-density", "instrumented");
  const instrumentedAnswer = page.locator(`[data-transcript-card][data-turn-id="${turnId!}"]`);
  await expect(instrumentedAnswer.locator(".message-part.part-footer")).toContainText(/Turn completed/u);
  await expect(instrumentedAnswer.locator(".reasoning-aside__body")).toBeHidden();
  const instrumentedRun = instrumentedAnswer.getByRole("button", { name: /^Run details\./u });
  await expect(instrumentedRun).toHaveAttribute("aria-label", runName!);
  await instrumentedRun.click();
  const instrumentedPanel = instrumentedAnswer.getByRole("group", { name: "Run details" });
  await expect(instrumentedPanel.locator('[data-field="receipt-id"] code')).toHaveText(receiptId);
  await instrumentedPanel.getByRole("button", { name: "Done" }).click();

  if (testInfo.project.name === "mobile-chromium") {
    // The same coarse-pointer journey continues into Sessions. Its expansion
    // must keep both the receipt identity and the limited assessment scope.
    await page.getByRole("button", { name: /Open conversation details\./u }).tap();
    await expect(page).toHaveURL(/#sessions$/u);
    const integrity = page.locator(".session-integrity__row");
    await expect(integrity).toBeVisible();
    if (await integrity.getAttribute("aria-expanded") === "false") await integrity.tap();
    const receiptTrace = page.getByRole("region", { name: "Receipt details" });
    await expect(receiptTrace).toContainText(receiptId);
    await expect(receiptTrace).toContainText(
      "Structural linkage only · digests not recomputed · authenticity not proven",
    );
  }
});
