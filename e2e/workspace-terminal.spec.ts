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
  await expect(page.getByText("Metadata · Ephemeral · this page only")).toBeVisible();
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

  await page.getByRole("button", { name: "Close terminal tab" }).click();
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
  await expect(page.getByText(/Starting|Running|Failed|Restart required/, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Close terminal tab" })).toBeVisible();
  const newHere = page.getByRole("button", { name: "New terminal at current directory" });
  await expect(newHere).toBeVisible();
  expect((await newHere.boundingBox())?.height).toBeGreaterThanOrEqual(44);
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
  await expect(dock.locator(".terminal-panel__bar code")).toHaveText("/workspace/docs");
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
  await expect(dock.locator(".terminal-panel__bar code")).toHaveText("/workspace/docs");

  await dock.getByRole("button", { name: "Open full Terminal view" }).click();
  await expect(page).toHaveURL(/#terminal$/);
  await expect(page.getByRole("heading", { name: "Terminal", level: 1 })).toBeVisible();
  await expect(page.locator(".terminal-panel__bar code")).toHaveText("/workspace/docs");
  await expect(page.getByText("Profile general", { exact: true })).toBeVisible();
});
