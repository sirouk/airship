import { expect, test, type Browser, type Page } from "@playwright/test";

async function openPreferences(page: Page): Promise<void> {
  const desktopControl = page.getByRole("button", { name: "Open Preferences" });
  if (await desktopControl.isVisible()) {
    await desktopControl.click();
    return;
  }
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).click();
}

async function enableLocalLabVault(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
}

async function expectLocalVaultAdopted(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.locator(".runtime-line")).toHaveAttribute("title", /Encrypted S3 vault active/u, { timeout });
  if ((page.viewportSize()?.width ?? 1_440) <= 640) {
    // The desktop status strip is intentionally hidden on narrow screens;
    // the same runtime state remains exposed through its live-region contract.
    await expect(page.getByRole("status").filter({ hasText: /Encrypted S3 vault active/u }).first())
      .toContainText("Encrypted S3 vault active");
    const sessionDetails = page.getByRole("button", { name: /Session\. Encrypted state synced\./u });
    await expect(sessionDetails).toBeVisible();
  } else {
    // The four axis pills are one chip that states the weakest claim. A healthy
    // vault is not the weakest claim, so it reads in the sheet the chip opens —
    // where it now arrives with its full detail sentence rather than a
    // hover-only tooltip.
    await page.locator(".topbar-posture-chip").click();
    const runtimeTrust = page.getByRole("dialog", { name: "Runtime trust" });
    await expect(runtimeTrust).toContainText("Local S3 Vault active");
    await runtimeTrust.getByRole("button", { name: "Close" }).click();
    // The meta row is gone; durability is the session-status chip's second
    // claim, stated in full in its accessible name and its popover.
    await expect(page.locator(".session-status-chip"))
      .toHaveAccessibleName(/Session\. Encrypted state synced\./u);
  }
}

for (const origin of ["http://localhost:4173", "http://127.0.0.1:4173"] as const) {
  test(`auto-adopts encrypted local MinIO from ${origin}`, async ({ page }, testInfo) => {
    await enableLocalLabVault(page);
    const namespace = isolatedNamespace(testInfo.project.name, origin.includes("localhost") ? "localhost" : "loopback");
    await page.goto(`${origin}/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
    await expectLocalVaultAdopted(page);
    await expect(page.locator(".topbar-center").getByText("Vault ready", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Vault blocked", { exact: true })).toHaveCount(0);
  });
}

test("durability preference moves safely between encrypted S3 and ephemeral page memory", async ({ page }, testInfo) => {
  await enableLocalLabVault(page);
  const namespace = isolatedNamespace(testInfo.project.name, "toggle");
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  await expectLocalVaultAdopted(page);

  await openPreferences(page);
  await page.getByRole("button", { name: "Durability" }).click();
  await page.getByRole("option", { name: "Page memory only" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".runtime-line")).toHaveAttribute("title", /Ephemeral mode/u, { timeout: 20_000 });
  await expect(page.getByText("Ephemeral mode is active.", { exact: false })).toBeVisible();

  await openPreferences(page);
  await page.getByRole("button", { name: "Durability" }).click();
  await page.getByRole("option", { name: "Local MinIO lab" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expectLocalVaultAdopted(page);
});

test("encrypted context publication is an explicit Vault action and survives reload", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one live publication contract is sufficient");
  test.setTimeout(90_000);
  const namespace = isolatedNamespace(testInfo.project.name, "context-publication");
  const page = await openFreshVaultPage(browser, namespace);
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#vault`);
  await expect(page.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("On-device index active", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Publish encrypted index" }).click();
  await expect(page.getByText("Encrypted context generation published.", { exact: false })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Encrypted generation published", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update encrypted index" })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Encrypted generation published", { exact: true })).toBeVisible();
  await expect(page.getByText("adopted without uploading new shards", { exact: false })).toBeVisible();
  await page.context().close();
});

test("fresh browser contexts resume one audited Vault session without creating reload sessions", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context durability contract is sufficient");
  test.setTimeout(90_000);
  const marker = `vault-resume-${Date.now().toString(36)}`;
  const namespace = isolatedNamespace(testInfo.project.name, marker);
  const counts: number[] = [];

  for (let index = 0; index < 3; index += 1) {
    const page = await openFreshVaultPage(browser, namespace);
    if (index === 0) {
      await page.getByRole("combobox", { name: "Message Airship" }).fill(marker);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByText("Airship is running this turn entirely on your device", { exact: false })).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 15_000 });
    }

    await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#sessions`);
    await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();
    await page.locator(".session-library-technical > summary").click();
    await expect(page.locator(".session-library-transcript").getByText(marker, { exact: true })).toBeVisible({ timeout: 20_000 });
    const countHeading = page.locator(".session-library-list-heading > span");
    await expect.poll(async () => Number.parseInt(await countHeading.textContent() ?? "", 10)).toBeGreaterThan(0);
    const countText = await countHeading.textContent();
    counts.push(Number.parseInt(countText ?? "", 10));
    await page.context().close();
  }

  expect(counts[0]).toBeGreaterThan(0);
  expect(new Set(counts)).toEqual(new Set([counts[0]!]));
});

test("profile revisions recover from the encrypted Vault in a fresh browser context", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one cross-context profile durability contract is sufficient");
  test.setTimeout(90_000);
  const marker = `Flight Director ${Date.now().toString(36)}`;
  const namespace = isolatedNamespace(testInfo.project.name, "profile-catalog");

  const first = await openFreshVaultPage(browser, namespace);
  await first.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#profiles`);
  const name = first.getByRole("textbox", { name: "Name", exact: true });
  await name.fill(marker);
  await first.getByRole("button", { name: "Save new revision" }).click();
  await expect(first.getByText("Revision saved to the encrypted Vault. Existing sessions remain pinned.", { exact: true })).toBeVisible();
  await first.context().close();

  const second = await openFreshVaultPage(browser, namespace);
  await second.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#profiles`);
  await expect(second.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(marker);
  await expect(second.getByText("Storage status · encrypted Vault", { exact: true })).toBeVisible();
  await second.context().close();
});

/*
 * The one ordinary click that used to cost a whole vault.
 *
 * `session.renamed` carries no `turnId` — protocol-v1 defines it that way and
 * `auditSessionHistory` requires it — but the transcript renderer assumed every
 * event after `session.created` belonged to a turn and threw. That throw
 * escapes vault adoption before the runtime is swapped in, so nothing was
 * adopted at all: workspace, every session, every profile, memory and the
 * stored provider credential were unreachable behind an event UUID in the
 * topbar. Renaming also bumps `updatedAt`, which is the sort key that elects
 * the session adoption tries to resume, so the act elected itself as the target.
 *
 * Nothing here is poisoned or hand-crafted: it is the shipped Rename control,
 * then a reload.
 */
test("a renamed conversation still adopts its vault, and the rename is on screen", async ({ browser }, testInfo) => {
  const namespace = isolatedNamespace(testInfo.project.name, "rename");
  const first = await openFreshVaultPage(browser, namespace);
  await first.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#sessions`);
  await first.getByRole("button", { name: /encrypted vault/u }).first().click();
  await first.getByRole("button", { name: "Rename", exact: true }).first().click();
  const titleField = first.getByRole("textbox", { name: "Conversation title" });
  await expect(titleField).toBeVisible();
  await titleField.fill("Renamed before reload");
  await first.getByRole("button", { name: "Save rename" }).click();
  // The durable appends are creation, the profile's active-conversation
  // pointer, then the rename.
  // (The detail heading keeps showing the pre-rename title until the list is
  // refreshed — pre-existing, unrelated, and not what stranded the vault.)
  await expect(first.getByText("3 events", { exact: true }).first()).toBeVisible();
  await first.context().close();

  const second = await openFreshVaultPage(browser, namespace);
  // `openFreshVaultPage` already asserts the vault adopted. This is the part
  // the shipped build could not do: resume the renamed session rather than
  // strand everything behind it.
  await expect(second.locator(".runtime-line")).toHaveAttribute("title", /audited session resumed/u);
  await expect(second.locator(".runtime-line")).not.toHaveAttribute("title", /could not be replayed/u);

  // The durable record is re-presented, not skipped: its sentence, its
  // sequence, its type and its digest.
  // Address the rename marker by what it is, not by position. The Profile's
  // active-conversation pointer is also a durable marker and sits ahead of it.
  const marker = second.locator(".transcript-marker").filter({ hasText: "session.renamed" });
  await expect(marker).toContainText("Renamed to “Renamed before reload”");
  await expect(marker).toContainText("session.renamed");
  await expect(marker).toContainText(/Event \d+/u);
  await expect(marker).toContainText(/sha256:/u);

  // And no surface is left holding a bare identifier as its only explanation.
  await expect(second.getByText(/has no valid turn identity/u)).toHaveCount(0);
  await second.context().close();
});

async function openFreshVaultPage(browser: Browser, namespace: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
  const page = await context.newPage();
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  await expectLocalVaultAdopted(page);
  return page;
}

function isolatedNamespace(project: string, label: string): string {
  const suffix = `${project}-${label}-${Date.now().toString(36)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .slice(0, 72);
  return `airship-live-v2/e2e/${suffix}`;
}
