import { expect, test } from "@playwright/test";

const credential = process.env.AIRSHIP_CHUTES_API_KEY;

/**
 * Opt-in release smoke test against the real Chutes service. It deliberately
 * reads the disposable credential from the process environment and never
 * persists or prints it. Run with `npm run test:e2e:live`.
 */
test("a catalog-declared vision model receives an encrypted inline image", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one paid remote invocation is sufficient");
  test.skip(!credential, "AIRSHIP_CHUTES_API_KEY is required for the paid live smoke test");
  test.setTimeout(180_000);

  await page.goto("/#access");
  await expect(page.getByRole("heading", { name: "Chutes access" })).toBeVisible();
  await page.getByText("Advanced: use a Chutes API key instead").click();
  await page.getByLabel("Chutes API key").fill(credential!);
  await page.getByRole("button", { name: "Discover models with key" }).click();

  const candidate = page.locator(".connection-candidate");
  await expect(candidate).toBeVisible({ timeout: 30_000 });
  const candidatePicker = candidate.locator(".model-picker-trigger");
  await expect(candidatePicker).toBeEnabled({ timeout: 30_000 });
  await candidatePicker.click();
  const picker = page.getByRole("dialog", { name: "Choose a Chutes model" });
  await picker.getByRole("searchbox", { name: "Search models" }).fill("Kimi-K2.6-TEE");
  const option = picker.getByRole("option").filter({ hasText: /Kimi-K2\.6-TEE/i }).first();
  await expect(option).toContainText(/Tools/i, { timeout: 15_000 });
  await expect(option).toContainText(/attestation candidate/i);
  await option.click();
  await page.getByLabel(/I understand this endpoint is not independently attested/).check();
  await page.getByRole("button", { name: "Connect selected model" }).click();
  await expect(page.getByText("Chutes API key · direct session").first()).toBeVisible({ timeout: 60_000 });

  await page.goto("/#chat");
  const input = page.locator('input[type="file"][accept="image/*"]');
  await input.setInputFiles({
    name: "airship-vision-smoke.png",
    mimeType: "image/png",
    // A valid 1×1 opaque red PNG. The assertion tests transport, not OCR.
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(page.getByText("encrypted vision ready", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Describe the color of the attached image in one sentence.");
  await page.getByRole("button", { name: "Send message" }).click();

  const latestAssistant = page.locator(".message.assistant").last();
  await expect(latestAssistant).not.toHaveClass(/error/, { timeout: 120_000 });
  await expect(latestAssistant.locator(".message-body, .message-content").first()).not.toBeEmpty({ timeout: 120_000 });
  await expect(page.getByText(/failed|text.only/i)).toHaveCount(0);

  // Exercise the independent evidence path in the same real browser session.
  // This intentionally asserts an endpoint record, not a conversation upgrade:
  // the provider's current evidence contract does not sign the transcript.
  await page.goto("/#attestations");
  await expect(page.getByRole("heading", { name: "Attestations" })).toBeVisible();
  await expect(page.locator(".attestation-record-list button").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".attestation-record-heading")).toContainText("Endpoint acquisition");
  await expect(page.locator(".attestation-matrix button")).toHaveCount(8);
  await expect(page.locator(".attestation-matrix")).toContainText("Protected CPU runtime");
  await expect(page.getByText(/cross-origin unreadable|evidence refresh failed/i)).toHaveCount(0);
});
