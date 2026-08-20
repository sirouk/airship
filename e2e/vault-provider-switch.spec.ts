import { expect, test, type Page } from "@playwright/test";

const EPHEMERAL_PREFERENCES = JSON.stringify({
  mode: "dark",
  typeScale: "default",
  density: "comfortable",
  corners: "subtle",
  bodyFont: "system-sans",
  vaultBackend: "ephemeral",
  approvalMode: "ask-first",
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((preferences) => {
    localStorage.setItem("airship.display-preferences.v1", preferences);
  }, EPHEMERAL_PREFERENCES);
});

async function openVault(page: Page): Promise<void> {
  await page.goto("/#vault");
  await expect(page).toHaveURL(/#vault$/u);
  await expect(page.getByRole("heading", { name: "Vault", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vault storage provider" })).toContainText("Ephemeral");
}

test("@unconfigured offers only Ephemeral and Local Device as stock storage choices", async ({ page }) => {
  await openVault(page);

  const trigger = page.getByRole("button", { name: "Vault storage provider" });
  await trigger.click();
  const listbox = page.getByRole("listbox", { name: "Vault storage provider" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(2);
  await expect(listbox.getByRole("option", { name: "Ephemeral", exact: true })).toBeVisible();
  const localDevice = listbox.getByRole("option", { name: "Local Device", exact: true });
  await expect(localDevice).toBeVisible();
  await expect(localDevice).toHaveAccessibleDescription("Encrypted, offline, and persistent in this browser profile");

  // Google Drive exists only when this build has a real client registration.
  // S3/MinIO and Walrus are adapters, not stock product destinations.
  await expect(listbox.getByRole("option", { name: "Google Drive", exact: true })).toHaveCount(0);
  await expect(listbox.getByRole("option", { name: /S3|MinIO|Walrus/u })).toHaveCount(0);

  const labels = await listbox.getByRole("option").evaluateAll((options) => options.map((option) =>
    option.querySelector("strong")?.textContent?.trim() ?? ""));
  expect(labels).toEqual(["Ephemeral", "Local Device"]);
});

test("the storage selector switches between its two stock modes by keyboard", async ({ page }) => {
  await openVault(page);

  const trigger = page.getByRole("button", { name: "Vault storage provider" });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Ephemeral", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Local Device", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(trigger).toContainText("Local Device");
  await expect(page.getByText("Keep this browser’s work on this device", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem("airship.display-preferences.v1") ?? "null")?.vaultBackend
  )).toBe("local-device");

  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await expect(page.getByRole("option", { name: "Ephemeral", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(trigger).toContainText("Ephemeral");
  await expect(page.getByText("No endpoint, credential authority, or workspace key is attached.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem("airship.display-preferences.v1") ?? "null")?.vaultBackend
  )).toBe("ephemeral");
});

test("each stock storage option keeps its name, explanation, and full control inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openVault(page);
  await page.getByRole("button", { name: "Vault storage provider" }).click();

  const listbox = page.getByRole("listbox", { name: "Vault storage provider" });
  for (const name of ["Ephemeral", "Local Device"] as const) {
    const option = listbox.getByRole("option", { name, exact: true });
    const measurement = await option.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const title = element.querySelector("strong")?.getBoundingClientRect();
      const description = element.querySelector("small")?.getBoundingClientRect();
      return {
        box: { left: box.left, right: box.right, height: box.height },
        titleY: title?.y,
        descriptionY: description?.y,
      };
    });
    expect(measurement.box.left, `${name} begins inside the viewport`).toBeGreaterThanOrEqual(7);
    expect(measurement.box.right, `${name} ends inside the viewport`).toBeLessThanOrEqual(313);
    expect(measurement.box.height, `${name} is a phone-size target`).toBeGreaterThanOrEqual(44);
    expect(measurement.titleY, `${name} has a measurable title`).toBeDefined();
    expect(measurement.descriptionY, `${name} has a measurable explanation`).toBeDefined();
    expect(measurement.descriptionY!, `${name} explanation follows its title`).toBeGreaterThan(measurement.titleY!);
  }

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    selector: (() => {
      const element = document.querySelector<HTMLElement>(".vault-provider-selector");
      return element ? element.scrollWidth - element.clientWidth : Number.POSITIVE_INFINITY;
    })(),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.selector).toBeLessThanOrEqual(1);
});
