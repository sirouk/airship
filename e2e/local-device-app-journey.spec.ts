import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";

const LOCAL_DEVICE_PARTITION = "airship-workspace-v1";

test.describe("Local Device Vault actual-app journey", () => {
  test("enrolls, adopts, publishes, backs up, reloads offline, and switches authorities safely", async ({ browser }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "One Chromium origin exercises the real OPFS/CryptoKey application journey.",
    );
    test.setTimeout(180_000);
    const context = await browser.newContext({ acceptDownloads: true });
    await seedPreferences(context, "ephemeral");
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const pageErrors = observePageErrors(page);
    const marker = `actual-app-device-${crypto.randomUUID()}`;

    try {
      await openActualVault(page);
      await selectVaultProvider(page, "Local Device");
      await expect(page.getByRole("heading", { name: "Local Device Vault", level: 2 })).toBeVisible();
      await expect(page.getByText("Local Device setup required", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Create new" }).click();
      const recoveryOutput = page.locator(".local-device-vault__ceremony output");
      await expect(recoveryOutput).toHaveText(/^airship-wrk-v1\.[A-Za-z0-9_-]{43}$/u);
      const recoveryKey = (await recoveryOutput.textContent())!;
      expect(await credentialPersistenceAudit(page, recoveryKey)).toEqual({
        localStorage: false,
        sessionStorage: false,
      });

      // Acknowledgement intentionally removes the checkbox and secret in the
      // same event, so click rather than waiting for a post-click checked state.
      await page.getByLabel(/I saved this recovery key outside Airship/u).click();
      await expect(recoveryOutput).toHaveCount(0);
      await expect(page.getByText("Recovery key hidden", { exact: true })).toBeVisible();
      expect((await page.locator("body").textContent())?.includes(recoveryKey)).toBe(false);

      const createVault = page.getByRole("button", { name: "Create encrypted Vault" });
      await expect(createVault).toBeEnabled();
      await createVault.click({ timeout: 10_000 });
      await expectLocalDeviceReady(page);
      await expect(page.getByText("On-device index active", { exact: true })).toBeVisible();

      await navigatePrimary(page, "Chat");
      await runLocalCommand(page, `/write docs/local-device-context.txt "${marker}"`);
      await navigatePrimary(page, "Vault");
      await page.getByRole("button", { name: "Publish encrypted index" }).click();
      await expect(page.getByText("Encrypted context generation published.", { exact: false }))
        .toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Encrypted generation published", { exact: true })).toBeVisible();

      const persistenceNotice = page.locator(".local-device-vault__notice");
      await page.getByRole("button", { name: "Request persistent storage" }).click();
      await expect(persistenceNotice).toContainText(
        /Persistent storage granted|normal eviction policy|does not expose a persistent-storage request/u,
      );

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download backup" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.airship-vault$/u);
      const backup = await downloadBytes(download);
      expect(backup.byteLength).toBeGreaterThan(0);
      const serializedBackup = new TextDecoder().decode(backup);
      expect(serializedBackup).not.toContain(marker);
      expect(serializedBackup).not.toContain(recoveryKey);
      await expect(persistenceNotice).toContainText(/Encrypted backup prepared/u);

      await page.reload();
      await expectLocalDeviceReady(page);
      await expect(page.getByText("Encrypted generation published", { exact: true })).toBeVisible();

      await context.setOffline(true);
      await navigatePrimary(page, "Chat");
      const offlineRead = await runLocalCommand(page, "/read docs/local-device-context.txt");
      await expect(offlineRead).toContainText(marker);

      await navigatePrimary(page, "Vault");
      await selectVaultProvider(page, "Ephemeral");
      await expect(page.getByText("No endpoint, credential authority, or workspace key is attached."))
        .toBeVisible({ timeout: 30_000 });
      await navigatePrimary(page, "Chat");
      const copiedRead = await runLocalCommand(page, "/read docs/local-device-context.txt");
      await expect(copiedRead).toContainText(marker);

      await navigatePrimary(page, "Vault");
      await selectVaultProvider(page, "Local Device");
      await expectLocalDeviceReady(page);
      await navigatePrimary(page, "Chat");
      const resumedRead = await runLocalCommand(page, "/read docs/local-device-context.txt");
      await expect(resumedRead).toContainText(marker);

      expect(pageErrors).toEqual([]);
    } finally {
      await context.setOffline(false).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  });

  test("restores into an empty browser authority without importing target bootstrap state", async ({ browser }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "One isolated Chromium target proves target-authoritative restore.",
    );
    test.setTimeout(180_000);
    const sourceMarker = `source-authority-${crypto.randomUUID()}`;
    const targetMarker = `target-bootstrap-${crypto.randomUUID()}`;
    const source = await createEncryptedSourceBackup(browser, sourceMarker);

    const targetContext = await browser.newContext();
    await seedPreferences(targetContext, "ephemeral");
    const page = await targetContext.newPage();
    page.setDefaultTimeout(15_000);
    const pageErrors = observePageErrors(page);
    try {
      await page.goto("/#chat");
      await expect(page.locator(".app-shell")).toBeVisible();
      await runLocalCommand(page, `/write target-only.txt "${targetMarker}"`);

      await navigatePrimary(page, "Vault");
      await selectVaultProvider(page, "Local Device");
      const restore = page.locator("details.local-device-vault__restore");
      await restore.locator("summary").click();
      await restore.locator('input[type="file"]').setInputFiles({
        name: "source.airship-vault",
        mimeType: "application/vnd.airship.vault-backup+json",
        buffer: Buffer.from(source.backup),
      });
      await restore.getByLabel("Recovery key for this backup").fill(source.recoveryKey);
      await restore.getByLabel(/Restore into empty browser storage/u).check();
      await restore.getByLabel(/I understand a successful restore/u).check();
      await restore.getByRole("button", { name: "Verify and restore" }).click();

      await expect(page.locator(".local-device-vault__notice"))
        .toContainText(/Atomic restore verified/u, { timeout: 30_000 });
      await expectLocalDeviceReady(page);
      await navigatePrimary(page, "Chat");
      const sourceRead = await runLocalCommand(page, "/read source-marker.txt");
      await expect(sourceRead).toContainText(sourceMarker);
      const targetRead = await runLocalCommand(page, "/read target-only.txt");
      await expect(targetRead).toContainText("File not found: /workspace/target-only.txt");
      expect(pageErrors).toEqual([]);
    } finally {
      await targetContext.close();
    }
  });

  test("keeps Local Device enrollment and provider controls inside the mobile viewport", async ({ browser }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "The mobile project owns the narrow-viewport Vault contract.",
    );
    const context = await browser.newContext();
    await seedPreferences(context, "ephemeral");
    const page = await context.newPage();
    try {
      await openActualVault(page);
      const picker = page.getByRole("button", { name: "Vault storage provider" });
      await picker.click();
      const listbox = page.getByRole("listbox", { name: "Vault storage provider" });
      await expect(listbox).toBeVisible();
      await expectInsideViewport(page, listbox);
      await listbox.getByRole("option", { name: /^Local Device\b/u }).click();

      await expect(page.getByRole("heading", { name: "Local Device Vault", level: 2 })).toBeVisible();
      await expectInsideViewport(page, page.locator(".local-device-vault"));
      await expectInsideViewport(page, page.getByRole("button", { name: "Open existing" }));
      await expectInsideViewport(page, page.getByRole("button", { name: "Create new" }));

      await page.getByRole("button", { name: "Create new" }).click();
      await expect(page.locator(".local-device-vault__ceremony output")).toBeVisible();
      await expectInsideViewport(page, page.locator(".local-device-vault__ceremony"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});

async function seedPreferences(
  context: BrowserContext,
  vaultBackend: "ephemeral" | "local-device",
): Promise<void> {
  await context.addInitScript((backend) => {
    try {
      if (!localStorage.getItem("airship.display-preferences.v1")) {
        localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
          mode: "dark",
          typeScale: "default",
          density: "comfortable",
          corners: "subtle",
          bodyFont: "system-sans",
          vaultBackend: backend,
          approvalMode: "full-access",
        }));
      }
    } catch {
      // Chromium executes init scripts once for its inaccessible initial
      // about:blank document and again for the real Airship origin.
    }
  }, vaultBackend);
}

async function openActualVault(page: Page): Promise<void> {
  await page.goto("/#vault");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vault", level: 1 })).toBeVisible();
}

async function navigatePrimary(page: Page, name: "Chat" | "Vault"): Promise<void> {
  await page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name, exact: true })
    .click();
}

async function selectVaultProvider(
  page: Page,
  name: "Local Device" | "Ephemeral",
): Promise<void> {
  const picker = page.getByRole("button", { name: "Vault storage provider" });
  await expect(picker).toBeEnabled({ timeout: 30_000 });
  await picker.click();
  await page.getByRole("listbox", { name: "Vault storage provider" })
    .getByRole("option", { name: new RegExp(`^${name}\\b`, "u") })
    .click();
  await expect(picker).toContainText(name, { timeout: 30_000 });
}

async function expectLocalDeviceReady(page: Page): Promise<void> {
  await expect(page.getByText("Encrypted device Vault ready", { exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Local Device · encrypted and offline", { exact: true }))
    .toBeVisible();
  await expect(page.locator(".local-device-vault__header [data-ready='true']")).toHaveText("Ready");
}

async function runLocalCommand(page: Page, command: string) {
  const before = await page.locator(".message.assistant").count();
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(command);
  await page.getByRole("button", { name: "Send message" }).click();
  const response = page.locator(".message.assistant").nth(before);
  const approval = page.getByRole("dialog", { name: /Allow .* once/u });
  const policyOutcome = await Promise.race([
    approval.waitFor({ state: "visible", timeout: 15_000 }).then(() => "approval" as const),
    response.getByText("Local result · excluded from model context", { exact: true })
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "complete" as const),
  ]).catch(() => "pending" as const);
  if (policyOutcome === "approval") {
    await approval.getByRole("button", { name: "Allow once" }).click();
  }
  await expect(response).toContainText("Local result · excluded from model context", {
    timeout: 30_000,
  });
  return response;
}

async function credentialPersistenceAudit(
  page: Page,
  secret: string,
): Promise<Readonly<{ localStorage: boolean; sessionStorage: boolean }>> {
  return page.evaluate((value) => ({
    localStorage: Object.keys(localStorage)
      .some((key) => `${key}\0${localStorage.getItem(key) ?? ""}`.includes(value)),
    sessionStorage: Object.keys(sessionStorage)
      .some((key) => `${key}\0${sessionStorage.getItem(key) ?? ""}`.includes(value)),
  }), secret);
}

async function downloadBytes(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function observePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y).toBeLessThan(viewport!.height);
}

async function createEncryptedSourceBackup(
  browser: Browser,
  marker: string,
): Promise<Readonly<{ backup: Uint8Array; recoveryKey: string }>> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/e2e/fixtures/provider-fabric-harness.html");
    return await page.evaluate(async ({ marker, partition }) => {
      const [{ WorkspaceRecoveryMaterial }, { openLocalDeviceVault }] = await Promise.all([
        import("/src/vault/recovery.ts"),
        import("/src/vault/local-device.ts"),
      ]);
      const material = await WorkspaceRecoveryMaterial.generate();
      const recoveryKey = material.displayValue;
      const handle = await openLocalDeviceVault({
        partition,
        workspaceKey: material.workspaceKey,
        disposition: "create-new",
      });
      await handle.runtime.workspace.write("/workspace/source-marker.txt", marker);
      const backup = await handle.exportEncryptedBackup();
      handle.close();
      material.clear();
      return { backup, recoveryKey };
    }, { marker, partition: LOCAL_DEVICE_PARTITION });
  } finally {
    await context.close();
  }
}
