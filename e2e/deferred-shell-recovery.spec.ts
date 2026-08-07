import { expect, test, type Page, type Route } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  });
});

test("a failed boot chunk stops checking and offers a successful fresh reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves document-level module recovery");
  let blocked = true;
  let blockedRequests = 0;
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (blocked && (pathname === "/src/inference/fabric.ts" || /\/assets\/fabric-[^/]+\.js$/u.test(pathname))) {
      blockedRequests += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.goto("/#chat");
  await expect(page.getByRole("heading", { name: "The local kernel did not start" })).toBeVisible();
  await expect(page.getByText("this tab never became ready", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload Airship" })).toBeVisible();
  expect(blockedRequests).toBeGreaterThan(0);

  blocked = false;
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "Reload Airship" }).click(),
  ]);
  await expectReadyShell(page);
});

for (const surface of ["Command Center", "Preferences"] as const) {
  test(`${surface} chunk failure never inerts an empty shell and recovers after reload`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the shared overlay boundary");
    let blocked = true;
    let blockedRequests = 0;
    await page.route("**/*", (route) => blockDeferredChunk(route, {
      sourcePath: "/src/ui/platform-overlays.tsx",
      assetStem: "platform-overlays",
      blocked: () => blocked,
      onBlocked: () => { blockedRequests += 1; },
    }));

    await page.goto("/#chat");
    await expectReadyShell(page);
    await expect.poll(() => blockedRequests).toBeGreaterThan(0);
    await openSurface(page, surface);

    const failure = page.getByRole("alert").filter({ hasText: `${surface} unavailable` });
    await expect(failure).toContainText("The shell remains usable");
    await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");
    await expect(page.getByRole("dialog", { name: surface === "Command Center" ? "Airship command palette" : "Preferences" })).toHaveCount(0);

    const retry = failure.getByRole("button", { name: `Retry ${surface}` });
    await expect(retry).toBeFocused();
    await retry.press("Enter");
    const failedAgain = page.getByRole("alert").filter({ hasText: `${surface} unavailable` });
    await expect(failedAgain.getByRole("button", { name: "Reload Airship" })).toBeVisible();
    await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");

    blocked = false;
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      failedAgain.getByRole("button", { name: "Reload Airship" }).click(),
    ]);
    await expectReadyShell(page);
    await openSurface(page, surface);
    await expect(page.getByRole("dialog", { name: surface === "Command Center" ? "Airship command palette" : "Preferences" })).toBeVisible();
  });
}

test("a delayed shared chunk opens only the latest requested overlay", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop proves overlay exclusivity and focus restoration");
  const held = await holdDeferredChunk(page, "/src/ui/platform-overlays.tsx", "platform-overlays");
  await page.goto("/#chat");
  await expectReadyShell(page);

  await openSurface(page, "Command Center");
  await expect(page.getByRole("status").filter({ hasText: "Opening Command Center" })).toBeVisible();
  const preferencesOpener = page.getByRole("button", { name: "Open Preferences" });
  await preferencesOpener.click();
  await expect(page.getByRole("status").filter({ hasText: "Opening Preferences" })).toBeVisible();

  held.release();
  const preferences = page.getByRole("dialog", { name: "Preferences" });
  await expect(preferences).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Airship command palette" })).toHaveCount(0);
  await preferences.getByRole("button", { name: "Done" }).click();
  await expect(preferencesOpener).toBeFocused();
  expect(held.requests()).toBeGreaterThan(0);
});

test("a delayed overlay keeps its mobile Cancel target at the product floor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile coarse-pointer geometry contract");
  const held = await holdDeferredChunk(page, "/src/ui/platform-overlays.tsx", "platform-overlays");
  await page.goto("/#chat");
  await expectReadyShell(page);
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: /^Command Center/u }).click();

  const notice = page.getByRole("status").filter({ hasText: "Opening Command Center" });
  const cancel = notice.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  const box = await cancel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(notice).toHaveCount(0);
  const more = page.getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("button", { name: "More", exact: true });
  await expect(more).toBeFocused();
  const loaded = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return pathname === "/src/ui/platform-overlays.tsx" || /\/assets\/platform-overlays-[^/]+\.js$/u.test(pathname);
  });
  held.release();
  await loaded;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(more).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Airship command palette" })).toHaveCount(0);
});

test("keyboard-shortcut chunk failure leaves navigation usable and exposes recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the deferred shortcut boundary");
  let blocked = true;
  await page.route("**/*", (route) => blockDeferredChunk(route, {
    sourcePath: "/src/ui/keyboard-shortcuts-sheet.tsx",
    assetStem: "keyboard-shortcuts-sheet",
    blocked: () => blocked,
  }));

  await page.goto("/#chat");
  await expectReadyShell(page);
  await openShortcutsFromPalette(page);

  const failure = page.getByRole("alert").filter({ hasText: "Keyboard shortcuts unavailable" });
  await expect(failure).toContainText("The shell remains usable");
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("dialog", { name: "Shortcuts" })).toHaveCount(0);

  const opener = page.getByRole("button", { name: "Open command palette" });
  blocked = false;
  await failure.getByRole("button", { name: "Retry Keyboard shortcuts" }).click();
  const shortcuts = page.getByRole("dialog", { name: "Shortcuts" });
  await expect(shortcuts).toBeVisible();
  await shortcuts.getByRole("button", { name: "Done" }).click();
  await expect(opener).toBeFocused();
});

test("Skills chunk failure preserves configuration navigation and recovers in place", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the deferred Skills route boundary");
  let blocked = true;
  let blockedRequests = 0;
  await page.route("**/*", (route) => blockDeferredChunk(route, {
    sourcePath: "/src/ui/skills-manager-view.tsx",
    assetStem: "skills-manager-view",
    blocked: () => blocked,
    onBlocked: () => { blockedRequests += 1; },
  }));

  await page.goto("/#skills");
  const failure = page.getByRole("alert").filter({ hasText: "The Skills interface could not be loaded" });
  await expect(failure.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  expect(blockedRequests).toBeGreaterThan(0);

  const navigation = page.getByRole("navigation", { name: "Agent configuration" });
  await expect(navigation.getByRole("button", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Profiles", exact: true })).toBeEnabled();

  blocked = false;
  await failure.getByRole("button", { name: "Retry loading Skills" }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Skills", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "New skill", exact: true })).toBeVisible();
});

async function expectReadyShell(page: Page): Promise<void> {
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 20_000 });
  // The phone shell keeps a second `.runtime-line__text` in the DOM at every
  // width (twin-carrier policy); the non-phone carrier is the one this
  // desktop lane can read.
  await expect(page.locator(".runtime-line:not(.runtime-line--phone) .runtime-line__text")).toHaveText("Local kernel ready", { timeout: 20_000 });
}

async function openSurface(page: Page, surface: "Command Center" | "Preferences"): Promise<void> {
  await page.getByRole("button", {
    name: surface === "Command Center" ? "Open command palette" : "Open Preferences",
  }).click();
}

async function openShortcutsFromPalette(page: Page): Promise<void> {
  await openSurface(page, "Command Center");
  const palette = page.getByRole("dialog", { name: "Airship command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("button", { name: /all shortcuts/u }).click();
}

async function blockDeferredChunk(
  route: Route,
  options: Readonly<{
    sourcePath: string;
    assetStem: string;
    blocked(): boolean;
    onBlocked?(): void;
  }>,
): Promise<void> {
  const pathname = new URL(route.request().url()).pathname;
  if (
    options.blocked()
    && (pathname === options.sourcePath || new RegExp(`/assets/${options.assetStem}-[^/]+\\.js$`, "u").test(pathname))
  ) {
    options.onBlocked?.();
    await route.abort("failed");
    return;
  }
  await route.continue();
}

async function holdDeferredChunk(page: Page, sourcePath: string, assetStem: string): Promise<Readonly<{
  release(): void;
  requests(): number;
}>> {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === sourcePath || new RegExp(`/assets/${assetStem}-[^/]+\\.js$`, "u").test(pathname)) {
      requests += 1;
      await barrier;
    }
    await route.continue();
  });
  return Object.freeze({ release, requests: () => requests });
}
