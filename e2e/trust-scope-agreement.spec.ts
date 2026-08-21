import { expect, test, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

type SetupRoute = Readonly<{
  label: "Vault" | "Providers";
  hash: RegExp;
  heading: RegExp;
  headingLevel: 1 | 2;
}>;

const SETUP_ROUTES: readonly SetupRoute[] = Object.freeze([
  { label: "Vault", hash: /#vault$/u, heading: /^Vault$/u, headingLevel: 1 },
  { label: "Providers", hash: /#connection$/u, heading: /^Cloud and local models$/u, headingLevel: 2 },
]);

/* Global setup services stay discoverable in the shell. Their route content
   does not carry a second navigation landmark that duplicates the shell. */
test("setup routes keep their identity without duplicate route navigation", async ({ page }) => {
  await page.goto("/#chat");
  await waitForShellSettled(page);

  for (const route of SETUP_ROUTES) {
    await navigateToSetupRoute(page, route.label);
    await expect(page).toHaveURL(route.hash);
    await expect(page.locator(".topbar-destination")).toHaveText(route.label);
    await expect(page.getByRole("main").getByRole("heading", {
      name: route.heading,
      level: route.headingLevel,
    })).toBeVisible();
    await expect(page.getByRole("main").getByRole("navigation")).toHaveCount(0);
  }
});

test("the rail states the current session, workspace, and global route scopes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the primary rail is compared at desktop width");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });
  const scopes = await navigation.evaluate((nav) => Object.fromEntries(
    [...nav.querySelectorAll<HTMLElement>(".nav-item")]
      .map((item) => [item.querySelector(".nav-item__label")?.textContent?.trim() ?? "", item.dataset.scope])
      .filter(([label, scope]) => label && scope),
  ));

  expect(scopes.Chat).toBe("session");
  expect(scopes.Workspace).toBe("workspace");
  expect(scopes.Memory).toBe("session");
  expect(scopes.Vault).toBe("global");
  expect(scopes.Providers).toBe("global");
  await expect(navigation.getByText("Global", { exact: true })).toBeVisible();
});

async function navigateToSetupRoute(page: Page, label: SetupRoute["label"]): Promise<void> {
  const desktopEntry = page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: label, exact: true });
  if (await desktopEntry.isVisible()) {
    await desktopEntry.click();
    return;
  }

  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  const directEntry = mobileNavigation.getByRole("button", { name: label, exact: true });
  if (await directEntry.isVisible()) {
    await directEntry.click();
    return;
  }

  await mobileNavigation.getByRole("button", { name: "More", exact: true }).click();
  const moreEntry = page.getByRole("dialog", { name: "More" })
    .getByRole("button")
    .filter({ hasText: label })
    .first();
  await moreEntry.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await moreEntry.click();
}
