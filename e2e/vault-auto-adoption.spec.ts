import { expect, test, type Browser, type Page } from "@playwright/test";

async function openPreferences(page: Page): Promise<void> {
  const desktopControl = page.getByRole("button", { name: "Open Preferences" });
  if (await desktopControl.isVisible()) {
    await desktopControl.click();
    return;
  }
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).click();
}

for (const origin of ["http://localhost:4173", "http://127.0.0.1:4173"] as const) {
  test(`auto-adopts encrypted local MinIO from ${origin}`, async ({ page }, testInfo) => {
    const namespace = isolatedNamespace(testInfo.project.name, origin.includes("localhost") ? "localhost" : "loopback");
    await page.goto(`${origin}/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
    await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Vault blocked", { exact: true })).toHaveCount(0);
  });
}

test("durability preference moves safely between encrypted S3 and ephemeral page memory", async ({ page }, testInfo) => {
  const namespace = isolatedNamespace(testInfo.project.name, "toggle");
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  await openPreferences(page);
  await page.getByRole("button", { name: "Durability" }).click();
  await page.getByRole("option", { name: "Ephemeral · page memory only" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Ephemeral · this page only", { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  await openPreferences(page);
  await page.getByRole("button", { name: "Durability" }).click();
  await page.getByRole("option", { name: "Encrypted S3 · local MinIO" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
});

test("fresh browser contexts resume one audited Vault session without creating reload sessions", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context durability contract is sufficient");
  test.setTimeout(90_000);
  const marker = `vault-resume-${Date.now().toString(36)}`;
  const namespace = isolatedNamespace(testInfo.project.name, marker);
  const counts: number[] = [];

  for (let index = 0; index < 3; index += 1) {
    const page = await openFreshVaultPage(browser, namespace);
    if (index === 0) {
      await page.getByRole("combobox", { name: "Message Airship" }).fill(marker);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByText("Airship is running this turn entirely on your device", { exact: false })).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 15_000 });
    }

    await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#sessions`);
    await expect(page.getByRole("heading", { name: "Session library", level: 1 })).toBeVisible();
    const countHeading = page.locator(".session-library-list-heading > span");
    await expect.poll(async () => Number.parseInt(await countHeading.textContent() ?? "", 10)).toBeGreaterThan(0);
    const countText = await countHeading.textContent();
    counts.push(Number.parseInt(countText ?? "", 10));
    await page.context().close();
  }

  expect(counts[0]).toBeGreaterThan(0);
  expect(new Set(counts)).toEqual(new Set([counts[0]!]));
});

async function openFreshVaultPage(browser: Browser, namespace: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return page;
}

function isolatedNamespace(project: string, label: string): string {
  const suffix = `${project}-${label}-${Date.now().toString(36)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .slice(0, 72);
  return `airship-live-v2/e2e/${suffix}`;
}
