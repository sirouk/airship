import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function openEphemeralTerminal(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark",
    typeScale: "default",
    density: "comfortable",
    corners: "subtle",
    bodyFont: "system-sans",
    vaultBackend: "ephemeral",
    approvalMode: "full-access",
  })));
  await page.goto("/#terminal");
  await expect(page.getByRole("heading", { name: "Terminal", level: 1 })).toBeVisible();
  const setup = page.locator("details.terminal-route__setup");
  const boundary = page.getByText("This is not your device shell", { exact: false });
  if (await setup.locator("summary").isVisible()) {
    await expect(setup.locator("summary")).toContainText("Node.js · WebContainer · jsh");
    await setup.locator("summary").click();
    await expect(boundary).toBeVisible();
    await setup.locator("summary").click();
    await expect(boundary).toBeHidden();
  } else {
    await expect(boundary).toBeVisible();
  }
}

test("desktop terminal manages page-local tabs without claiming host Bash", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop terminal contract");
  await openEphemeralTerminal(page);

  const tabs = page.getByRole("tablist", { name: "Terminal tabs" });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Interactive process · this page")).toBeVisible();
  await expect(page.getByText("Metadata · Ephemeral · content not saved")).toBeVisible();
  await expect(page.getByText("Shared Git", { exact: true })).toHaveCount(0);

  await tabs.getByRole("button", { name: /Rename Terminal 1/ }).click();
  const name = page.getByRole("textbox", { name: "Rename Terminal 1" });
  await name.fill("Build console");
  await name.press("Enter");
  await expect(tabs.getByRole("tab", { name: /Build console/ })).toBeVisible();

  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".terminal-emulator .xterm")).toBeVisible();
  await page.getByRole("button", { name: "New terminal at current directory" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(page.getByText(/Input history · \d+/)).toBeVisible();
  await expect(page.getByText(/Audit lineage · \d+/)).toBeVisible();

  // `role="tab"` obliges the widget contract, not just the styling: ←/→ and
  // Home/End move selection *and* focus, and exactly one tab is in the tab
  // order. Without it a keyboard user reaches this strip and cannot leave the
  // tab they landed on, which is the whole defect the role was hiding.
  const tab = tabs.getByRole("tab");
  await tab.nth(2).focus();
  await expect(tab.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab.nth(1)).toBeFocused();
  await expect(tab.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tab.nth(2)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Home");
  await expect(tab.nth(0)).toBeFocused();
  await expect(tab.nth(0)).toHaveAttribute("aria-selected", "true");
  // One entry point, not one stop per tab: the roving tabindex the role means.
  await expect(tab.nth(0)).toHaveAttribute("tabindex", "0");
  await expect(tab.nth(1)).toHaveAttribute("tabindex", "-1");
  await expect(tab.nth(2)).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("End");
  await expect(tab.nth(2)).toBeFocused();
  await expect(tab.nth(2)).toHaveAttribute("aria-selected", "true");
  // A key the strip does not own is left alone rather than swallowed, so the
  // strip is not a keyboard trap.
  await page.keyboard.press("Tab");
  await expect(tab.nth(2)).not.toBeFocused();

  // Ending a live process is confirmed the same way deleting a file is, so the
  // tab count may not move until the modal's own verb is pressed.
  await page.getByRole("button", { name: "Close terminal tab" }).click();
  const closeConfirm = page.getByRole("dialog", { name: /^Close / });
  await expect(closeConfirm).toContainText("ends the process running in");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await closeConfirm.getByRole("button", { name: "Close terminal", exact: true }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".terminal-route__footer")).toContainText("bounded lineage remains only for this page/workspace lifetime");
  await page.screenshot({ path: testInfo.outputPath("workspace-terminal-desktop.png"), fullPage: true });
});

test("mobile terminal keeps process controls and horizontal tabs usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile terminal contract");
  await openEphemeralTerminal(page);

  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Terminal tabs" });
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  const [setupBounds, tabsBounds] = await Promise.all([
    page.locator("details.terminal-route__setup summary").boundingBox(),
    tabs.boundingBox(),
  ]);
  expect(setupBounds).not.toBeNull();
  expect(tabsBounds).not.toBeNull();
  expect(
    setupBounds!.y + setupBounds!.height,
    "the setup control ends before the terminal tabs begin",
  ).toBeLessThanOrEqual(tabsBounds!.y);
  await expect(page.getByText(/Starting|Running|Failed|Restart required/, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Close terminal tab" })).toBeVisible();
  const newHere = page.getByRole("button", { name: "New terminal at current directory" });
  await expect(newHere).toBeVisible();
  expect((await newHere.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  // The phone rule sheds the words, not the glyphs. Written against
  // `button span` it also hid the `＋`, whose mark happens to live in a span —
  // a 44px box with nothing in it. Height alone cannot see that, so the mark
  // is measured: `toBeVisible` is false for a `display:none` span, and the
  // width proves the box is not merely present but painted.
  const newHereGlyph = newHere.locator('span[aria-hidden="true"]');
  await expect(newHereGlyph).toBeVisible();
  await expect(newHereGlyph).toHaveText("＋");
  expect((await newHereGlyph.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  // And the word is what the rule is allowed to take.
  await expect(newHere.locator('span:not([aria-hidden="true"])')).toBeHidden();
  // The same rule governs the whole bar. `useInnerText` is the point: rendered
  // text is what a phone user has, and `textContent` would happily report the
  // very word the rule just hid.
  const close = page.getByRole("button", { name: "Close terminal tab" });
  expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(close).toContainText("×", { useInnerText: true });
  await expect(close).not.toContainText("Close", { useInnerText: true });
  await expect(page.getByText(/Input history · \d+/)).toBeVisible();
  await expect(page.getByText(/Audit lineage · \d+/)).toBeVisible();
  await expect(page.locator(".terminal-panel")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("workspace-terminal-mobile.png"), fullPage: true });
});

test("Workspace opens, resizes, collapses, and promotes one profile-scoped terminal dock", async ({ page }, testInfo) => {
  test.skip(!["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name), "browser workspace-terminal contract");
  await page.goto("/#workspace");
  await expect(page.getByRole("region", { name: "Workspace editor" })).toBeVisible();
  const dock = page.getByRole("region", { name: "Workspace terminal dock" });
  await expect(dock).toHaveAttribute("data-open", "false");
  await page.getByRole("button", { name: "Actions for docs" }).click();
  await page.getByRole("menuitem", { name: "Open terminal here" }).click();

  await expect(page).toHaveURL(/#workspace$/);
  await expect(dock).toHaveAttribute("data-open", "true");
  // The shell's own chrome leads with the path `pwd` prints, and names the
  // workspace spelling beside it rather than printing a `/workspace` the
  // WebContainer cannot resolve.
  await expect(dock.locator(".terminal-panel__bar code")).toHaveText("/home/airship-node/airship-workspace/docs");
  await expect(dock.locator(".terminal-panel__mirror")).toHaveText("= /workspace/docs");
  await expect(dock.getByText("Profile General", { exact: true })).toBeVisible();
  await expect(dock.getByText(/WebContainer · jsh · page-local, not Bash\/Linux/u)).toBeVisible();

  const splitter = dock.getByRole("separator", { name: "Terminal dock height" });
  if (testInfo.project.name === "desktop-chromium") {
    const beforeDrag = Number(await splitter.getAttribute("aria-valuenow"));
    const bounds = await splitter.boundingBox();
    if (!bounds) throw new Error("Terminal dock splitter has no pointer geometry.");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 28);
    await page.mouse.up();
    await expect.poll(async () => Number(await splitter.getAttribute("aria-valuenow"))).toBeLessThan(beforeDrag);
  }
  const initialHeight = Number(await splitter.getAttribute("aria-valuenow"));
  await splitter.focus();
  await splitter.press("ArrowDown");
  await expect(splitter).toHaveAttribute("aria-valuenow", String(Math.max(220, initialHeight - 24)));
  await splitter.press("Home");
  await expect(splitter).toHaveAttribute("aria-valuenow", "220");

  const tabCount = await dock.getByRole("tablist", { name: "Terminal tabs" }).getByRole("tab").count();
  await dock.getByRole("button", { name: "Collapse terminal dock" }).click();
  await expect(dock).toHaveAttribute("data-open", "false");
  await expect(dock.locator(".terminal-panel")).toHaveCount(0);
  await dock.locator(".workspace-terminal-dock__collapsed button").first().click();
  await expect(dock).toHaveAttribute("data-open", "true");
  await expect(dock.getByRole("tablist", { name: "Terminal tabs" }).getByRole("tab")).toHaveCount(tabCount);
  await expect(dock.locator(".terminal-panel__bar code")).toHaveText("/home/airship-node/airship-workspace/docs");

  await dock.getByRole("button", { name: "Open full Terminal view" }).click();
  await expect(page).toHaveURL(/#terminal$/);
  await expect(page.getByRole("heading", { name: "Terminal", level: 1 })).toBeVisible();
  await expect(page.locator(".terminal-panel__bar code")).toHaveText("/home/airship-node/airship-workspace/docs");
  await expect(page.locator(".terminal-panel__mirror")).toHaveText("= /workspace/docs");
  await expect(page.getByText("Profile general", { exact: true })).toBeVisible();
});
