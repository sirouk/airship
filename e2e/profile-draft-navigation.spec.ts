import { expect, test, type Page } from "@playwright/test";

const DISCARD_PROMPT = "Discard unsaved profile edits?";

async function respondToDiscardPrompt(
  page: Page,
  action: () => Promise<void>,
  response: "dismiss" | "accept",
): Promise<void> {
  const prompt = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toBe(DISCARD_PROMPT);
    if (response === "accept") await dialog.accept();
    else await dialog.dismiss();
  });
  await Promise.all([prompt, action()]);
}

test("sidebar, profile scope, and command palette navigation protect unsaved profile edits", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop navigation surfaces");
  await page.goto("/#profiles");
  const editor = page.locator(".profile-editor");
  const name = editor.getByRole("textbox", { name: "Name" });
  const original = await name.inputValue();
  const draft = `${original} · unsaved navigation draft`;
  await name.fill(draft);

  const primary = page.getByRole("navigation", { name: "Primary" });
  await respondToDiscardPrompt(
    page,
    () => primary.getByRole("button", { name: "Workspace", exact: true }).click(),
    "dismiss",
  );
  await expect(page).toHaveURL(/#profiles$/u);
  await expect(name).toHaveValue(draft);

  // AMENDED. The rail's per-profile rows were a group of one whose children
  // duplicated the pinned profile card, and they are gone; the profile catalog
  // is the route's own card list and the pinned row's menu. The guard being
  // tested is unchanged and lives on the surviving surface — switching profile
  // scope with an unsaved draft still asks, dismissing still keeps the draft,
  // accepting still discards it — and it is now exercised where a person
  // actually switches scope rather than on a duplicate entry point.
  const cards = page.locator(".profile-card");
  await respondToDiscardPrompt(
    page,
    () => cards.filter({ hasText: "Research" }).click(),
    "dismiss",
  );
  await expect(page).toHaveURL(/#profiles$/u);
  await expect(name).toHaveValue(draft);

  // Accepting has to *land* somewhere else to prove the draft was discarded, so
  // the accepted transition is the one that actually changes the scope.
  await respondToDiscardPrompt(
    page,
    () => cards.filter({ hasText: "Research" }).click(),
    "accept",
  );
  await expect(name).not.toHaveValue(draft);
  await expect(page.locator(".profile-card.active")).toContainText("Research");
  const researchOriginal = await name.inputValue();
  expect(researchOriginal).not.toBe(original);
  await name.fill(draft);

  await page.getByRole("button", { name: "Open command palette" }).click();
  const palette = page.getByRole("dialog", { name: "Airship command palette" });
  await palette.getByRole("combobox").fill("Terminal");
  await respondToDiscardPrompt(
    page,
    () => palette.getByRole("option", { name: /^Terminal/u }).click(),
    "dismiss",
  );
  await expect(page).toHaveURL(/#profiles$/u);
  await expect(name).toHaveValue(draft);

  await respondToDiscardPrompt(
    page,
    () => primary.getByRole("button", { name: "Workspace", exact: true }).click(),
    "accept",
  );
  await expect(page).toHaveURL(/#workspace$/u);
  // AMENDED: the `#workspace` H1 read "Editor". Asserting the route's own name
  // is stronger — it fails if the two destinations share one heading again.
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
});

test("mobile More navigation protects the same unsaved profile draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile More navigation");
  await page.goto("/#profiles");
  const name = page.locator(".profile-editor").getByRole("textbox", { name: "Name" });
  const draft = `${await name.inputValue()} · mobile unsaved draft`;
  await name.fill(draft);

  const mobileNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await mobileNav.getByRole("button", { name: "More", exact: true }).click();
  let more = page.getByRole("dialog", { name: "More" });
  await respondToDiscardPrompt(
    page,
    () => more.getByRole("button", { name: /^Terminal/u }).click(),
    "dismiss",
  );
  await expect(page).toHaveURL(/#profiles$/u);
  await expect(name).toHaveValue(draft);

  await mobileNav.getByRole("button", { name: "More", exact: true }).click();
  more = page.getByRole("dialog", { name: "More" });
  await respondToDiscardPrompt(
    page,
    () => more.getByRole("button", { name: /^Terminal/u }).click(),
    "accept",
  );
  await expect(page).toHaveURL(/#terminal$/u);
  await expect(page.getByRole("heading", { name: "Terminal", exact: true })).toBeVisible();
});
