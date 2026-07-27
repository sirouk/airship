import { expect, test } from "@playwright/test";

test("opt-in live WebContainer executes Node entirely in the browser tab", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative live browser process");
  test.skip(process.env.AIRSHIP_LIVE_WEBCONTAINER !== "1", "Set AIRSHIP_LIVE_WEBCONTAINER=1 for the provider-backed live browser probe.");
  test.setTimeout(90_000);
  await page.goto("/#workspace");
  const result = await page.evaluate(async () => {
    const [{ activateNodeWebContainer, deactivateNodeWebContainer }, { MemoryWorkspace }] = await Promise.all([
      import("/src/execution/node-webcontainer-pack.ts"),
      import("/src/workspace/memory.ts"),
    ]);
    const workspace = new MemoryWorkspace();
    await workspace.write("package.json", JSON.stringify({ name: "airship-live-node", private: true }), { expectedRevision: null });
    const adapter = await activateNodeWebContainer(new AbortController().signal, 30_000);
    try {
      const execution = await adapter.execute({
        runtime: "node-webcontainer",
        workspace,
        workspaceRoot: "/workspace",
        command: "node",
        args: ["--eval", "console.log(JSON.stringify({ runtime: process.release.name, answer: 6 * 7 }))"],
        env: { AIRSHIP_MODE: "browser-live-probe" },
        timeoutMs: 120_000,
        writeBack: false,
        signal: new AbortController().signal,
      });
      return { isolated: globalThis.crossOriginIsolated, execution };
    } finally {
      await deactivateNodeWebContainer();
    }
  });
  expect(result.isolated).toBe(true);
  expect(result.execution).toMatchObject({ runtime: "node-webcontainer", exitCode: 0 });
  expect(result.execution.stdout).toContain('"runtime":"node"');
  expect(result.execution.stdout).toContain('"answer":42');
});

test("opt-in live Workspace Terminal accepts an interactive command", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative live browser process");
  test.skip(process.env.AIRSHIP_LIVE_WEBCONTAINER !== "1", "Set AIRSHIP_LIVE_WEBCONTAINER=1 for the provider-backed live browser probe.");
  test.setTimeout(120_000);
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.text().includes("This process already exited")) runtimeErrors.push(message.text());
  });
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
  const liveBaseUrl = process.env.AIRSHIP_LIVE_BASE_URL ?? "";
  await page.goto(`${liveBaseUrl}/#terminal`);
  await expect(page.locator(".terminal-panel__bar strong", { hasText: "Running" })).toBeVisible({ timeout: 90_000 });
  console.log("terminal-live: running");

  const emulator = page.locator(".terminal-emulator");
  const input = emulator.locator(".xterm-helper-textarea");
  await input.focus();
  await expect(input).toBeFocused();
  console.log("terminal-live: focused");
  await page.keyboard.type("node -e \"console.log('AIRSHIP_TERMINAL_42')\"");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Command history · 1", { exact: true })).toBeVisible({ timeout: 30_000 });
  console.log("terminal-live: history");
  await expect(emulator.locator(".xterm-accessibility-tree")).toContainText("AIRSHIP_TERMINAL_42", { timeout: 30_000 });
  console.log("terminal-live: output");

  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "node -e \"console.log('AIRSHIP_PASTE_43')\"");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Command history · 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(emulator.locator(".xterm-accessibility-tree")).toContainText("AIRSHIP_PASTE_43", { timeout: 30_000 });
  console.log("terminal-live: paste");

  await input.focus();
  await page.keyboard.press("Control+C");
  await expect(page.locator(".terminal-panel__bar strong", { hasText: "Running" })).toBeVisible();
  await page.setViewportSize({ width: 1180, height: 780 });
  await expect(page.locator(".terminal-panel__bar strong", { hasText: "Running" })).toBeVisible();
  console.log("terminal-live: interrupt + resize");

  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.locator(".terminal-panel__bar strong", { hasText: "Running" })).toBeVisible({ timeout: 30_000 });
  await input.focus();
  await page.keyboard.type("node -e \"console.log('AIRSHIP_RESTART_44')\"");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Command history · 3", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(emulator.locator(".xterm-accessibility-tree")).toContainText("AIRSHIP_RESTART_44", { timeout: 30_000 });
  console.log("terminal-live: restart");

  await page.getByRole("button", { name: "Close terminal tab" }).click();
  await expect(page.getByRole("tablist", { name: "Terminal tabs" }).getByRole("tab")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
  console.log("terminal-live: closed");
});
