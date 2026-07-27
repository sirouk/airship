import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark",
    typeScale: "default",
    density: "comfortable",
    corners: "subtle",
    bodyFont: "system-sans",
    vaultBackend: "ephemeral",
    approvalMode: "ask-first",
  })));
});

async function expectContainedLayout(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - innerWidth,
    mainOverflow: (document.querySelector<HTMLElement>("main.main")?.scrollWidth ?? 0)
      - (document.querySelector<HTMLElement>("main.main")?.clientWidth ?? 0),
  }));
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.mainOverflow).toBeLessThanOrEqual(1);
}

test("the real browser runtime stays coherent across the required device classes", async ({ page }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/#chat");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { name: /General/i }).first()).toBeVisible();
  await expect(page.getByText(/Inference local/i)).toHaveCount(0);

  // Derive the responsive contract from the same observable viewport that
  // drives the product CSS; project names are reporting metadata, not UI
  // behavior.
  const isPhone = (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 640;
  if (isPhone) {
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: "Connect a model", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Session\./i })).toBeVisible();
    const stageHeight = await page.locator(".session-bar").evaluate((element) => element.getBoundingClientRect().height);
    expect(stageHeight).toBeLessThan(150);
  } else {
    await expect(page.getByText("Browser / Edge runtime", { exact: true })).toBeVisible({ timeout: 10_000 });
  }

  const message = page.getByRole("combobox", { name: "Message Airship" });
  // Use the canonical command name. `/ls` deliberately opens slash-command
  // completion first, so one Enter there accepts the completion rather than
  // executing a side effect.
  await message.fill("/list-files");
  await message.press("Escape");
  await message.press("Enter");
  await expect(page.getByText(/README\.md/i).last()).toBeVisible({ timeout: 15_000 });

  await page.goto("/#editor");
  await expect(page.getByRole("heading", { name: "Editor", exact: true })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Workspace files" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Source Control/i })).toBeVisible();

  await page.goto("/#terminal");
  await expect(page.getByRole("heading", { name: "Terminal", exact: true })).toBeVisible();
  await expect(page.getByLabel(/browser terminal/i)).toBeVisible({ timeout: 15_000 });
  const setup = page.locator("details.terminal-route__setup");
  if (isPhone) {
    const mobileTerminal = await page.evaluate(() => ({
      panelTop: document.querySelector<HTMLElement>(".terminal-panel")?.getBoundingClientRect().top ?? innerHeight,
      viewportHeight: innerHeight,
      disclosureHeight: document.querySelector<HTMLElement>(".terminal-route__setup > summary")?.getBoundingClientRect().height ?? 0,
    }));
    expect(mobileTerminal.panelTop / mobileTerminal.viewportHeight).toBeLessThan(.5);
    expect(mobileTerminal.disclosureHeight).toBeGreaterThanOrEqual(44);
  }
  if ((await setup.getAttribute("open")) === null) await setup.locator("summary").click();
  const sharedGit = page.locator(".terminal-git-bridge");
  await expect(sharedGit).toContainText("Authoritative Editor/source-control state");
  await sharedGit.getByRole("textbox").fill("git status");
  await sharedGit.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".terminal-route__footer")).toContainText(
    "Shared Git command completed against the authoritative browser repository.",
  );

  await expectContainedLayout(page);
  expect(runtimeErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-terminal.png`),
    animations: "disabled",
  });
});

test("high-value controls remain usable without credentials on every device class", async ({ page }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/#chat");
  const profileTrigger = page.locator("button[aria-label='Agent profile']:visible").first();
  await expect(profileTrigger).toBeVisible();
  await profileTrigger.click();
  const profileMenu = page.getByRole("listbox", { name: "Agent profile" });
  await expect(profileMenu).toBeVisible();
  await profileMenu.getByRole("option", { name: /Builder \/ Systems/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(/Builder \/ Systems profile/u);

  await page.goto("/#profiles");
  const cards = page.locator(".profile-card");
  await expect(cards).toHaveCount(3);
  const boundaries = page.locator("details.profile-editor-disclosure").filter({ hasText: "Profile boundaries" });
  if (!(await boundaries.getAttribute("open"))) await boundaries.locator("summary").click();
  await boundaries.getByRole("button", { name: "Profile approval policy" }).click();
  const approvals = page.getByRole("listbox", { name: "Profile approval policy" });
  await expect(approvals).toBeVisible();
  await expect(approvals.getByRole("option", { name: "Ask First", exact: true })).toBeVisible();
  await expect(approvals.getByRole("option", { name: "Auto Approve", exact: true })).toBeVisible();
  await expect(approvals.getByRole("option", { name: "Full Access", exact: true })).toBeVisible();
  await approvals.getByRole("option", { name: "Ask First", exact: true }).click();

  page.on("dialog", (dialog) => void dialog.accept());
  await cards.filter({ hasText: "Research" }).click();
  await expect(cards.filter({ hasText: "Research" })).toHaveClass(/active/u);
  const danger = page.locator("details.profile-danger-disclosure");
  if (!(await danger.getAttribute("open"))) await danger.locator("summary").click();
  const remove = page.getByRole("button", { name: "Remove profile" });
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(cards.filter({ hasText: "Research" })).toHaveCount(0);
  await expect(page.getByText(/Removed from new work/u)).toBeVisible();
  await expectContainedLayout(page);

  await page.goto("/#vault");
  const provider = page.getByRole("button", { name: "Vault storage provider" });
  await provider.click();
  const providers = page.getByRole("listbox", { name: "Vault storage provider" });
  await expect(providers).toBeVisible();
  await expect(providers.getByRole("option", { name: /Google Drive/ })).toBeVisible();
  await expect(providers.getByRole("option", { name: /S3-compatible \/ MinIO/ })).toBeVisible();
  await expect(providers.getByRole("option", { name: /^Ephemeral/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectContainedLayout(page);

  await page.goto("/#proof");
  if (testInfo.project.name.startsWith("iphone-")) {
    const trustRail = await page.locator(".trust-hub-tabs").evaluate((element) => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, background: style.backgroundColor };
    });
    expect(trustRail.height).toBeLessThanOrEqual(46);
    expect(trustRail.background).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)$/u);
  }
  await page.getByRole("tab", { name: "Attestation evidence" }).click();
  await expect(page.getByRole("heading", { name: "Endpoint & receipt evidence", level: 2 })).toBeVisible();
  await expectContainedLayout(page);

  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connect models", level: 1 })).toBeVisible();
  const chutes = page.locator('.connect-lane[data-lane="chutes"]');
  await chutes.getByRole("button", { name: /Chutes/u }).first().click();
  // This acceptance build does not configure Chutes OAuth. It must lead with
  // the functional API-key path instead of rendering a broken sign-in action.
  await expect(chutes.getByRole("button", { name: "Sign in to Chutes", exact: true })).toHaveCount(0);
  await expect(chutes.getByRole("tab", { name: /^API key/u })).toHaveAttribute("aria-selected", "true");
  await expect(chutes.getByRole("textbox", { name: "Chutes API key", exact: true })).toBeVisible();
  await expect(chutes.getByRole("link", { name: /Create a key at chutes\.ai/u })).toBeVisible();
  await expect(chutes.getByRole("button", { name: "Discover models with key" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Choose a Chutes model" })).toHaveCount(0);
  await expectContainedLayout(page);

  expect(runtimeErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath(`${testInfo.project.name}-connection.png`),
    animations: "disabled",
  });
});

test("the desktop browser terminal executes Node and reconciles a real file into Editor and SCM", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative live browser process");
  test.setTimeout(120_000);
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/#terminal");
  await expect(page.locator(".terminal-panel__bar strong", { hasText: "Running" })).toBeVisible({ timeout: 90_000 });
  const emulator = page.locator(".terminal-emulator");
  const input = emulator.locator(".xterm-helper-textarea");
  await expect(emulator.locator(".xterm-accessibility-tree")).toContainText("❯", { timeout: 30_000 });
  await input.focus();
  await expect(input).toBeFocused();
  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "node -e \"require('fs').writeFileSync('master-terminal.txt','real-browser-process'); console.log(Buffer.from('QUlSU0hJUF9NQVNURVJfVEVSTUlOQUxfT0s=','base64').toString())\"");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(emulator.locator(".xterm-accessibility-tree")).toContainText("QUlSU0hJUF9NQVNURVJfVEVSTUlOQUxfT0s=", { timeout: 30_000 });
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Command history · 1", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(emulator.locator(".xterm-accessibility-tree")).toContainText("AIRSHIP_MASTER_TERMINAL_OK", { timeout: 30_000 });

  await page.getByRole("button", { name: "Reconcile workspace" }).click();
  await expect(page.locator(".terminal-route__footer")).toContainText("Synced 1 revision-fenced workspace change", { timeout: 30_000 });
  await expectContainedLayout(page);

  await page.goto("/#editor");
  const file = page.getByRole("treeitem", { name: /master-terminal\.txt/ });
  await expect(file).toBeVisible();
  await file.click();
  await expect(page.getByRole("textbox", { name: "Edit master-terminal.txt" })).toHaveValue("real-browser-process");
  await page.getByRole("tab", { name: /Source Control/ }).click();
  await expect(page.getByRole("button", { name: "Stage master-terminal.txt" })).toBeVisible();
  await expectContainedLayout(page);
  expect(runtimeErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("desktop-chromium-terminal-reconciled.png"),
    animations: "disabled",
  });
});
