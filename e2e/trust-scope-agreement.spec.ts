import { expect, test } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/* Global services stay discoverable in the primary rail; route content no
   longer carries a second top-of-page navigation strip that duplicates it. */
test("global routes keep their identity without a duplicate top navigation", async ({ page }) => {
  await page.goto("/#vault");
  await waitForShellSettled(page);
  await expect(page.getByRole("heading", { name: "Vault", exact: true, level: 1 })).toBeVisible();
  await expect(page.locator(".trust-hub-tabs")).toHaveCount(0);

  for (const [label, hash] of [["Connection", /#connection/u], ["Account", /#account/u]] as const) {
    const primaryEntry = page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: label, exact: true });
    if (await primaryEntry.isVisible()) {
      await primaryEntry.click();
    } else {
      // Phone navigation files global routes in the More sheet; the desktop
      // rail remains the direct path. Both surfaces must agree that no route
      // needs the retired top strip.
      await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More", exact: true }).click();
      // The entry's accessible name includes its one-line explanation (for
      // example, "Connection · Model providers and credentials"). Match the
      // route label at the start without throwing away that useful description.
      const moreEntry = page.getByRole("dialog", { name: "More" }).getByRole("button", { name: new RegExp(`^${label}\\b`, "u") });
      await moreEntry.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
      await moreEntry.click();
    }
    await expect(page).toHaveURL(hash);
    await expect(page.locator(".trust-hub-tabs")).toHaveCount(0);
  }
});

test("the rail retains explicit scope labels for session and global destinations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the primary rail is compared at desktop width");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  const scopes = await page.getByRole("navigation", { name: "Primary" }).evaluate((nav) => Object.fromEntries(
    [...nav.querySelectorAll<HTMLElement>(".nav-item")]
      .map((item) => [item.querySelector(".nav-item__label")?.textContent?.trim() ?? "", item.dataset.scope])
      .filter(([label, scope]) => label && scope),
  ));
  expect(scopes.Proof).toBe("session");
  expect(scopes.Vault).toBe("global");
  expect(scopes.Connection).toBe("global");
  expect(scopes.Account).toBe("global");
});
