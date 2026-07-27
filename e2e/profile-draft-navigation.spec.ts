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

  await respondToDiscardPrompt(
    page,
    () => primary.getByRole("button", { name: "Research", exact: true }).click(),
    "dismiss",
  );
  await expect(page).toHaveURL(/#profiles$/u);
  await expect(name).toHaveValue(draft);

  await respondToDiscardPrompt(
    page,
    () => primary.getByRole("button", { name: "General", exact: true }).click(),
    "accept",
  );
  await expect(name).toHaveValue(original);
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
  await expect(page.getByRole("heading", { name: "Editor" })).toBeVisible();
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
