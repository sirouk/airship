import { expect, test, type Route } from "@playwright/test";

function isApprovalChunk(route: Route): boolean {
  const pathname = new URL(route.request().url()).pathname;
  return pathname === "/src/ui/approval-dock.tsx"
    || /\/assets\/approval-dock-[^/]+\.js$/u.test(pathname);
}

test("a missing approval chunk denies the effect without locking the shell", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the deferred-asset failure contract");

  const pageErrors: string[] = [];
  let blockedChunkRequests = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (
      pathname === "/src/ui/approval-dock.tsx"
      || /\/assets\/approval-dock-[^/]+\.js$/u.test(pathname)
    ) {
      blockedChunkRequests += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
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

  await page.goto("/#chat");
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const failure = page.getByRole("alert").filter({ hasText: /Approval (?:controls )?unavailable/u });
  await expect(failure).toContainText("Requests that require a person’s decision remain blocked");
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");

  const path = `approvals/chunk-failure-${crypto.randomUUID()}.txt`;
  await composer.fill(`/write ${path} should-not-run`);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText(/Permission denied for local \/write/u).last()).toBeVisible();
  await expect(failure).toContainText("The pending capability request was denied");
  await expect(failure).toContainText("Its effect did not run");
  await expect(page.getByRole("dialog", { name: /Allow write_file once/u })).toHaveCount(0);
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");

  // The denial is not just presentation: the write never reached the workspace.
  await composer.fill(`/read ${path}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(`File not found: /workspace/${path}`, { exact: true }).last()).toBeVisible();

  await failure.getByRole("button", { name: "Retry approval controls" }).click();
  await expect(failure.getByRole("button", { name: "Reload Airship" })).toBeVisible();
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");

  // Full Access is the person's standing instruction and never uses the dock.
  // A failed optional prompt surface must not claim that this mode is blocked.
  const approvalPolicy = page.getByRole("button", { name: "Conversation approval policy" });
  await approvalPolicy.click();
  await page.getByRole("listbox", { name: "Conversation approval policy" })
    .getByRole("option", { name: "Full Access", exact: true }).click();
  await expect(approvalPolicy).toContainText("Full Access");
  await expect(failure).toHaveCount(0);

  const fullAccessPath = `approvals/full-chunk-${crypto.randomUUID()}.txt`;
  await composer.fill(`/write ${fullAccessPath} bounded`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Local result · excluded from model context").last()).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Allow write_file once/u })).toHaveCount(0);
  await composer.fill(`/read ${fullAccessPath}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("bounded", { exact: true }).last()).toBeVisible();

  expect(blockedChunkRequests).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test("a successful approval-control retry returns focus to the working surface", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves recovery focus");
  let blocked = true;
  await page.route("**/*", async (route) => {
    if (blocked && isApprovalChunk(route)) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
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

  await page.goto("/#chat");
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible();
  const failure = page.getByRole("alert").filter({ hasText: "Approval controls unavailable" });
  const retry = failure.getByRole("button", { name: "Retry approval controls" });
  await expect(retry).toBeVisible();
  blocked = false;
  await retry.click();
  await expect(failure).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");
});

test("a request during approval retry keeps its safe denial above the stale failure", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves retry-state precedence");
  let chunkRequest = 0;
  let release!: () => void;
  let reached!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { reached = resolve; });
  await page.route("**/*", async (route) => {
    if (!isApprovalChunk(route)) {
      await route.continue();
      return;
    }
    chunkRequest += 1;
    if (chunkRequest === 1) {
      await route.abort("failed");
      return;
    }
    reached();
    await barrier;
    await route.continue();
  });
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

  await page.goto("/#chat");
  const failure = page.getByRole("alert").filter({ hasText: "Approval controls unavailable" });
  await failure.getByRole("button", { name: "Retry approval controls" }).click();
  await held;

  const path = `approvals/retry-wait-${crypto.randomUUID()}.txt`;
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill(`/write ${path} should-not-run`);
  await page.getByRole("button", { name: "Send message" }).click();
  const waiting = page.getByRole("status").filter({ hasText: "Approval controls are loading" });
  await expect(waiting).toBeVisible();
  await expect(page.locator(".pwa-update")).toHaveCount(1);
  await expect(failure).toHaveCount(0);
  await waiting.getByRole("button", { name: "Deny pending request" }).click();
  await expect(page.getByText(/Permission denied for local \/write/u).last()).toBeVisible();

  await composer.fill(`/read ${path}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(`File not found: /workspace/${path}`, { exact: true }).last()).toBeVisible();
  release();
  await expect(page.getByRole("alert").filter({ hasText: "Approval controls unavailable" })).toHaveCount(0);
});

test("a request arriving before approval controls load is visible and safely deniable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the delayed approval boundary");
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/*", async (route) => {
    if (isApprovalChunk(route)) await barrier;
    await route.continue();
  });
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

  await page.goto("/#chat");
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeVisible();
  const path = `approvals/delayed-${crypto.randomUUID()}.txt`;
  await composer.fill(`/write ${path} must-not-run`);
  await page.getByRole("button", { name: "Send message" }).click();

  const waiting = page.getByRole("status").filter({ hasText: "Approval controls are loading" });
  await expect(waiting).toContainText("One capability request is waiting");
  await expect(waiting).toContainText("No effect has run");
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");
  await waiting.getByRole("button", { name: "Deny pending request" }).click();
  await expect(page.getByText(/Permission denied for local \/write/u).last()).toBeVisible();
  await expect(waiting).toHaveCount(0);
  await expect(composer).toBeFocused();

  const loaded = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return pathname === "/src/ui/approval-dock.tsx" || /\/assets\/approval-dock-[^/]+\.js$/u.test(pathname);
  });
  release();
  await loaded;
  await expect(page.getByRole("dialog", { name: /Allow write_file once/u })).toHaveCount(0);
  await composer.fill(`/read ${path}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(`File not found: /workspace/${path}`, { exact: true }).last()).toBeVisible();
});
