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
  /*
   * AMENDED — relocation, with the reachability check the relocation owes.
   *
   * `#capabilities` joined the shared `<RouteHeader density="tool">`: one 44px
   * bar in place of a 194px slab whose h1 was the forbidden
   * `clamp(30px, 4vw, 47px)`. At tool density the route's own sentence is the
   * ⓘ panel's body rather than a visible paragraph — the same move the nine
   * routes already on the primitive made. The sentence is not shortened, not
   * reworded and not conditional, so this asserts three things where it used
   * to assert one: the disclosure says what it holds *before* you open it, it
   * opens, and the sentence inside it is the whole sentence.
   */
  const about = page.getByRole("button", { name: /^About Capabilities\./u });
  await expect(about).toHaveAccessibleName(/what this view does/u);
  await about.click();
  await expect(page.getByText("No inference provider is required for local activation.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Every effect still follows the active approval policy/u)).toBeVisible();
  await page.getByRole("button", { name: "Browse slash tools" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/);
  await expect(page.locator(".session-bar__title")).toHaveText("Capability command");
  await expect(page.getByText("New profile-scoped conversation · capability command prefilled")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toHaveValue("/help ");
});
