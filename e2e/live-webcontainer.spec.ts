import { expect, test } from "@playwright/test";
import type { JsonValue } from "../src/core/contracts";

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

test("a baseline conversation activates Node, installs Vite, and builds without a fork", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative live browser process");
  test.skip(process.env.AIRSHIP_LIVE_WEBCONTAINER !== "1", "Set AIRSHIP_LIVE_WEBCONTAINER=1 for the provider-backed live browser probe.");
  test.setTimeout(300_000);
  await page.goto("/#chat");
  const result = await page.evaluate(async () => {
    const [{ ToolRegistry }, { registerLazyExecutionTools }, { MemoryWorkspace }] = await Promise.all([
      import("/src/tools/registry.ts"),
      import("/src/tools/execution-tool-proxies.ts"),
      import("/src/workspace/memory.ts"),
    ]);
    const workspace = new MemoryWorkspace();
    const root = "/workspace/vite-hello";
    const canary = "Hello from Airship Vite";
    await workspace.write(`${root}/package.json`, JSON.stringify({
      name: "airship-vite-hello",
      private: true,
      version: "1.0.0",
      type: "module",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.0.13" },
    }, null, 2));
    await workspace.write(
      `${root}/index.html`,
      '<!doctype html><html><body><main id="app"></main><script type="module" src="/src/main.js"></script></body></html>',
    );
    await workspace.write(
      `${root}/src/main.js`,
      `document.querySelector("#app").textContent = ${JSON.stringify(canary)};\n`,
    );
    const registry = new ToolRegistry();
    registerLazyExecutionTools(registry, workspace);
    const controller = new AbortController();
    const baseContext = {
      sessionId: "vite-baseline-session",
      turnId: "vite-one-turn",
      capabilityTier: "web-baseline" as const,
      signal: controller.signal,
    };
    const approvalPolicy = { async review() { return "allow" as const; } };
    const run = async (name: string, args: JsonValue, operationId: string) => {
      const context = { ...baseContext, operationId };
      const decision = await registry.review(name, args, context, approvalPolicy);
      if (decision !== "allow") throw new Error(`${name} was not approved in the acceptance fixture.`);
      return registry.executeApproved(name, args, context);
    };
    try {
      const activation = await run(
        "install_execution_runtime",
        { runtime: "node-webcontainer", timeoutMs: 30_000 },
        "activate-node",
      );
      const install = await run(
        "execute_node_project",
        {
          workspaceRoot: root,
          command: "npm",
          args: ["install", "--no-audit", "--no-fund"],
          timeoutMs: 120_000,
          writeBack: true,
        },
        "npm-install",
      );
      const build = await run(
        "execute_node_project",
        {
          workspaceRoot: root,
          command: "npm",
          args: ["run", "build"],
          timeoutMs: 120_000,
          writeBack: true,
        },
        "vite-build",
      );
      const files = await workspace.list(`${root}/dist`);
      const asset = files.find(({ path }) => /\/dist\/assets\/index-[^/]+\.js$/u.test(path));
      return {
        activation: { content: JSON.parse(activation.content), metadata: activation.metadata },
        install: JSON.parse(install.content),
        build: JSON.parse(build.content),
        packageLock: (await workspace.read(`${root}/package-lock.json`))?.content,
        distIndex: (await workspace.read(`${root}/dist/index.html`))?.content,
        builtAssetPath: asset?.path,
        builtAsset: asset ? (await workspace.read(asset.path))?.content : undefined,
        canary,
      };
    } finally {
      const pack = await import("/src/execution/node-webcontainer-pack.ts");
      await pack.deactivateNodeWebContainer();
    }
  });

  expect(result.activation.content).toMatchObject({
    state: "ready",
    usableNow: true,
    sessionCompatibility: "ready-in-current-session",
  });
  expect(result.activation.metadata).toMatchObject({
    probe: "npm --version",
    npmVersion: expect.stringMatching(/^\d+\.\d+/u),
    usableNow: true,
    requiresNewConversation: false,
    initialCapabilityTier: "web-baseline",
    liveCapabilityTier: "web-enhanced",
    capabilityTier: "web-enhanced",
    alreadyReady: false,
  });
  expect(result.install).toMatchObject({
    runtime: "node-webcontainer",
    exitCode: 0,
    provenance: { capabilityTier: "web-enhanced", authority: "browser" },
    value: { projectLifetime: "page", dependencyPersistence: "ephemeral-page" },
  });
  expect(result.build).toMatchObject({
    runtime: "node-webcontainer",
    exitCode: 0,
    provenance: { capabilityTier: "web-enhanced", authority: "browser" },
    value: { projectLifetime: "page", dependencyPersistence: "ephemeral-page" },
  });
  expect(result.build.value.runtimeProjectId).toBe(result.install.value.runtimeProjectId);
  expect(result.packageLock).toContain('"lockfileVersion"');
  expect(result.distIndex).toContain("assets/index-");
  expect(result.builtAssetPath).toMatch(/\/dist\/assets\/index-[^/]+\.js$/u);
  expect(result.builtAsset).toContain(result.canary);
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
  // Killing a live PTY is gated now; the confirm names the cwd it ends.
  await page.getByRole("dialog", { name: /^Close / }).getByRole("button", { name: "Close terminal", exact: true }).click();
  await expect(page.getByRole("tablist", { name: "Terminal tabs" }).getByRole("tab")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
  console.log("terminal-live: closed");
});
