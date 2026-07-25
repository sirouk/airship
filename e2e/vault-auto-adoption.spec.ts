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

async function enableLocalLabVault(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
}

async function expectLocalVaultAdopted(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.locator(".runtime-line")).toHaveAttribute("title", /Encrypted S3 vault active/u, { timeout });
  if ((page.viewportSize()?.width ?? 1_440) <= 640) {
    // The desktop status strip is intentionally hidden on narrow screens;
    // the same runtime state remains exposed through its live-region contract.
    await expect(page.getByRole("status").filter({ hasText: /Encrypted S3 vault active/u }).first())
      .toContainText("Encrypted S3 vault active");
  } else {
    await expect(page.locator(".topbar-center").getByText("Cloud Vault active", { exact: true })).toBeVisible();
    await expect(page.getByText("Encrypted state synced", { exact: true }).first()).toBeVisible();
  }
}

for (const origin of ["http://localhost:4173", "http://127.0.0.1:4173"] as const) {
  test(`auto-adopts encrypted local MinIO from ${origin}`, async ({ page }, testInfo) => {
    await enableLocalLabVault(page);
    const namespace = isolatedNamespace(testInfo.project.name, origin.includes("localhost") ? "localhost" : "loopback");
    await page.goto(`${origin}/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
    await expectLocalVaultAdopted(page);
    await expect(page.locator(".topbar-center").getByText("Vault ready", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Vault blocked", { exact: true })).toHaveCount(0);
  });
}

test("durability preference moves safely between encrypted S3 and ephemeral page memory", async ({ page }, testInfo) => {
  await enableLocalLabVault(page);
  const namespace = isolatedNamespace(testInfo.project.name, "toggle");
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  await expectLocalVaultAdopted(page);

  await openPreferences(page);
  await page.getByRole("button", { name: "Durability" }).click();
  await page.getByRole("option", { name: "Ephemeral · page memory only" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".runtime-line")).toHaveAttribute("title", /Ephemeral mode/u, { timeout: 20_000 });
  await expect(page.getByText("Ephemeral mode is active.", { exact: false })).toBeVisible();

  await openPreferences(page);
  await page.getByRole("button", { name: "Durability" }).click();
  await page.getByRole("option", { name: "Encrypted S3 · local MinIO" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expectLocalVaultAdopted(page);
});

test("encrypted context publication is an explicit Vault action and survives reload", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one live publication contract is sufficient");
  test.setTimeout(90_000);
  const namespace = isolatedNamespace(testInfo.project.name, "context-publication");
  const page = await openFreshVaultPage(browser, namespace);
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#vault`);
  await expect(page.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("On-device index active", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Publish encrypted index" }).click();
  await expect(page.getByText("Encrypted context generation published.", { exact: false })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Encrypted generation published", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update encrypted index" })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Encrypted generation published", { exact: true })).toBeVisible();
  await expect(page.getByText("adopted without uploading new shards", { exact: false })).toBeVisible();
  await page.context().close();
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
    await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();
    await page.locator(".session-library-technical > summary").click();
    await expect(page.locator(".session-library-transcript").getByText(marker, { exact: true })).toBeVisible({ timeout: 20_000 });
    const countHeading = page.locator(".session-library-list-heading > span");
    await expect.poll(async () => Number.parseInt(await countHeading.textContent() ?? "", 10)).toBeGreaterThan(0);
    const countText = await countHeading.textContent();
    counts.push(Number.parseInt(countText ?? "", 10));
    await page.context().close();
  }

  expect(counts[0]).toBeGreaterThan(0);
  expect(new Set(counts)).toEqual(new Set([counts[0]!]));
});

test("profile revisions recover from the encrypted Vault in a fresh browser context", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context profile durability contract is sufficient");
  test.setTimeout(90_000);
  const marker = `Flight Director ${Date.now().toString(36)}`;
  const namespace = isolatedNamespace(testInfo.project.name, "profile-catalog");

  const first = await openFreshVaultPage(browser, namespace);
  await first.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#profiles`);
  const name = first.getByRole("textbox", { name: "Name", exact: true });
  await name.fill(marker);
  await first.getByRole("button", { name: "Save new revision" }).click();
  await expect(first.getByText("Revision saved to the encrypted Vault. Existing sessions remain pinned.", { exact: true })).toBeVisible();
  await first.context().close();

  const second = await openFreshVaultPage(browser, namespace);
  await second.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#profiles`);
  await expect(second.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(marker);
  await expect(second.getByText("Storage status · encrypted Vault", { exact: true })).toBeVisible();
  await second.context().close();
});

async function openFreshVaultPage(browser: Browser, namespace: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
  const page = await context.newPage();
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  await expectLocalVaultAdopted(page);
  return page;
}

function isolatedNamespace(project: string, label: string): string {
  const suffix = `${project}-${label}-${Date.now().toString(36)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .slice(0, 72);
  return `airship-live-v2/e2e/${suffix}`;
}
