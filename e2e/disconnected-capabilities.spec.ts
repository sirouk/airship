import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

test("disconnected Chat keeps local commands live and offers one clear inference handoff", async ({ page }) => {
  await page.goto("/#chat");
  // The 42px band is deleted; both of its sentences render verbatim in the
  // transcript intro, which is where an empty conversation says what it
  // can and cannot do. Same strings, same test.
  const guidance = page.locator(".transcript-intro");
  await expect(guidance).toContainText("Workspace, editor, terminal and Git work right now");
  await expect(guidance).toContainText("needs a model provider");

  await page.getByRole("combobox", { name: "Message Airship" }).fill("/help");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Local command · excluded from model context").last()).toBeVisible();
  const localResult = page.getByRole("article", { name: "Airship message" }).last();
  await expect(localResult.locator(".message-capability-tier")).toContainText(/Browser (?:baseline|enhanced)/u);

  // One connect verb, and now exactly one control carrying it at every width:
  // the band's button, the desktop axis pill and the phone-only chip were three
  // renderings of one action. The banner button's visible text and accessible
  // name are the same string, so this reads what a sighted user reads.
  await expect(page.getByRole("button", { name: "Connect a model", exact: true })).toHaveCount(1);
  await page.getByRole("banner").getByRole("button", { name: "Connect a model", exact: true }).click();
  await expect(page).toHaveURL(/#connection$/);
  await expect(page.getByRole("heading", { name: "Connect models" })).toBeVisible();
});

test("Capabilities states that runtime activation is provider-independent", async ({ page }) => {
  await page.goto("/#capabilities");
  await expect(page.getByRole("heading", { name: "Capabilities" })).toBeVisible();
  await expect(page.getByText(/No inference provider.*required for local activation/u)).toBeVisible();
  await expect(page.getByText(/Every effect still follows the active approval policy/u)).toBeVisible();
  await page.getByRole("button", { name: "Browse slash tools" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toHaveValue("/help ");
});
