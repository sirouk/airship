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
  await expect(page.getByText("This is not your device shell", { exact: false })).toBeVisible();
}

test("desktop terminal manages page-local tabs without claiming host Bash", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop terminal contract");
  await openEphemeralTerminal(page);

  const tabs = page.getByRole("tablist", { name: "Terminal tabs" });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Processes stay hot while this page lives")).toBeVisible();
  await expect(page.getByText("Reload requires process restart")).toBeVisible();

  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".terminal-emulator .xterm")).toBeVisible();

  await page.getByRole("button", { name: "Close terminal tab" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".terminal-route__footer")).toContainText("page-local process was terminated");
  await page.screenshot({ path: testInfo.outputPath("workspace-terminal-desktop.png"), fullPage: true });
});

test("mobile terminal keeps process controls and horizontal tabs usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile terminal contract");
  await openEphemeralTerminal(page);

  await page.getByRole("button", { name: "New terminal" }).click();
  const tabs = page.getByRole("tablist", { name: "Terminal tabs" });
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close terminal tab" })).toBeVisible();
  await expect(page.locator(".terminal-panel")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("workspace-terminal-mobile.png"), fullPage: true });
});
