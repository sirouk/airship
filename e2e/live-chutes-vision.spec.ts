import { expect, test } from "@playwright/test";

const credential = process.env.AIRSHIP_CHUTES_API_KEY;
const visionModel = process.env.AIRSHIP_CHUTES_VISION_MODEL?.trim() || "moonshotai/Kimi-K2.6-TEE";

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
  await expect(page.getByRole("heading", { name: "Connection", exact: true })).toBeVisible();
  await page.getByText("Use a Chutes API key instead", { exact: true }).click();
  await page.getByLabel("Chutes API key").fill(credential!);
  await page.getByRole("button", { name: "Discover models with key" }).click();

  const candidate = page.locator(".connection-candidate");
  await expect(candidate).toBeVisible({ timeout: 30_000 });
  const candidatePicker = candidate.locator(".model-picker-trigger");
  await expect(candidatePicker).toBeEnabled({ timeout: 30_000 });
  await candidatePicker.click();
  const picker = page.getByRole("dialog", { name: "Choose a Chutes model" });
  await picker.getByRole("searchbox", { name: "Search models" }).fill(visionModel);
  const option = picker.getByRole("option").filter({ hasText: visionModel }).first();
  await expect(option).toContainText(/Tools/i, { timeout: 15_000 });
  await expect(option).toContainText(/confidential candidate/i);
  await option.click();
  const proofPolicy = page.getByRole("group", { name: "Turn proof policy" });
  const verifyAndRecord = proofPolicy.getByRole("button", { name: /^Verify & record Recommended\./ });
  await expect(verifyAndRecord).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Finish: verify & connect" }).click();
  await expect(page.getByText("Chutes API key · direct session").first()).toBeVisible({ timeout: 60_000 });

  // connectChutes already navigates to Chat. Do not use page.goto here: a
  // document reload must erase Airship's memory-only credential by design.
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
  const input = page.locator('input[type="file"][accept="image/*"]');
  await input.setInputFiles({
    name: "airship-vision-smoke.png",
    mimeType: "image/png",
    // A valid 96×96 opaque RGB PNG. Tiny 1×1 inputs are legal PNGs but are
    // below the patch/window floor of common vision preprocessors and can
    // produce a provider-side 500 before inference begins.
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAjUlEQVR42u3QMQEAAAQAMCTRP5MwEnhdW4TldAe3UiBIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEEIEiRIkCBBggQJQpAgQYIECRIkCEGCBAkSJEiQIAQJEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEgQggQJEiRIkCBBghAkSJAgQYIECUKQIEF/FlLTAdyKtVlSAAAAAElFTkSuQmCC", "base64"),
  });
  await expect(page.getByText("encrypted vision ready", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Describe the color of the attached image in one sentence.");
  await page.getByRole("button", { name: "Send message" }).click();

  const latestAssistant = page.locator(".message.assistant").last();
  await expect(latestAssistant).not.toHaveClass(/error/, { timeout: 120_000 });
  // A newly-created assistant card already contains labels and a thinking
  // surface. Completion is the receipt boundary, not merely a non-empty card.
  await expect(latestAssistant.locator(".receipt-chip")).toBeVisible({ timeout: 120_000 });
  await expect(latestAssistant.locator(".message-status")).toHaveCount(0);
  await expect(latestAssistant.locator(".message-parts .message-part.text, .message-body > p").first())
    .not.toBeEmpty();
  await expect(page.getByText(/failed|text.only/i)).toHaveCount(0);

  // Exercise the independent evidence path in the same real browser session.
  // This intentionally asserts an endpoint record, not a conversation upgrade:
  // the provider's current evidence contract does not sign the transcript.
  await page.goto("/#attestations");
  await expect(page).toHaveURL(/#proof\?section=attestations/);
  await expect(page.getByRole("heading", { name: "Endpoint & receipt evidence" })).toBeVisible();
  const endpointRecord = page.locator(".attestation-record-list button").filter({ hasText: "ENDPOINT" }).first();
  await expect(endpointRecord).toBeVisible({ timeout: 120_000 });
  await endpointRecord.click();
  await expect(page.locator(".attestation-record-heading")).toContainText("Endpoint acquisition");
  await expect(page.locator(".attestation-matrix button")).toHaveCount(8);
  await expect(page.locator(".attestation-matrix")).toContainText("Protected CPU runtime");
  await expect(page.getByText(/cross-origin unreadable|evidence refresh failed/i)).toHaveCount(0);
});
