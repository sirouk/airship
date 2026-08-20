import { expect, test, type Browser, type Page } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";

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
  // Desktop and phone render the same live runtime sentence in width-specific
  // carriers.
  await expect(page.locator(".runtime-line:not(.runtime-line--phone)")).toHaveAttribute("title", /Encrypted S3 vault active/u, { timeout });
  if ((page.viewportSize()?.width ?? 1_440) <= 640) {
    await expect(page.getByRole("status").filter({ hasText: /Encrypted S3 vault active/u }).first())
      .toContainText("Encrypted S3 vault active");
  }

  // Session durability is a current operational detail. The shared status mark
  // is visible at rest and the two-row panel keeps durability and lifecycle
  // separately readable.
  const sessionDetails = page.locator(".session-status-chip");
  await expect(sessionDetails).toHaveAccessibleName(/Session\. Encrypted state synced\..*2 details\./u, { timeout });
  const mark = sessionDetails.locator(".status-mark");
  await expect(mark).toHaveAttribute("data-state", "verified");
  await sessionDetails.click();
  const panel = page.getByRole("group", { name: "Session status" });
  await expect(panel).toContainText("Encrypted state synced");
  await expect(panel.locator(".detail-rows > *")).toHaveCount(2);
  await expect(panel.locator(".detail-rows .status-mark")).toHaveCount(2);
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel).toBeHidden();
  await expect(sessionDetails).toBeFocused();
}

for (const origin of ["http://localhost:4173", "http://127.0.0.1:4173"] as const) {
  test(`auto-adopts encrypted local MinIO from ${origin}`, async ({ page }, testInfo) => {
    await enableLocalLabVault(page);
    const namespace = isolatedNamespace(testInfo.project.name, origin.includes("localhost") ? "localhost" : "loopback");
    await page.goto(`${origin}/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
    await expectLocalVaultAdopted(page);
    await expect(page.locator(".topbar-destination")).toHaveText("Chat");
    await expect(page.locator(".session-status-chip .status-mark")).toHaveAttribute("data-state", "verified");
  });
}

test("durability preference moves safely between encrypted S3 and ephemeral page memory", async ({ page }, testInfo) => {
  await enableLocalLabVault(page);
  const namespace = isolatedNamespace(testInfo.project.name, "toggle");
  await page.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);
  await expectLocalVaultAdopted(page);

  await openPreferences(page);
  await page.getByRole("button", { name: "Durability" }).click();
  await page.getByRole("option", { name: "Ephemeral content" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".runtime-line:not(.runtime-line--phone)")).toHaveAttribute("title", /Ephemeral mode/u, { timeout: 20_000 });
  await expect(page.getByText("Ephemeral mode is active.", { exact: false })).toBeVisible();
  const ephemeralStatus = page.locator(".session-status-chip");
  await expect(ephemeralStatus).toHaveAccessibleName(/Session\. Ephemeral · content not saved\./u);
  await expect(ephemeralStatus.locator(".status-mark")).toHaveAttribute("data-state", "attention");
  await expect(ephemeralStatus).toContainText("Not saved");

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
      /*
       * Scoped to the transcript card. A settled turn now also emits one
       * `sr-only` polite announcement carrying an excerpt of the reply — the
       * arrival notice a screen reader had been getting nothing for — so the
       * sentence legitimately exists twice in the DOM for a few seconds. This
       * asserts the one a person sees; the announcement has its own unit
       * coverage in src/ui/chat/streaming-slot.test.ts.
       */
      await expect(page.locator("[data-transcript-card]")
        .getByText("Airship is running this turn entirely on your device", { exact: false })
        .first()).toBeVisible({ timeout: 15_000 });
    } else {
      /*
       * Scoped to the transcript card, for the same reason the branch above is.
       *
       * The conversation now takes its title from the first message, so the
       * marker is legitimately on screen four times — the session-bar title, the
       * rail's recents row, the conversation switcher, and the message itself.
       * A bare exact-text lookup matched all four and failed strict mode, which
       * reads as "the resumed conversation is missing" when what happened is
       * that three more surfaces started naming it correctly. This check is
       * about the restored message, so it addresses the transcript row.
       */
      await expect(page.locator("[data-transcript-card]").getByText(marker, { exact: true }).first())
        .toBeVisible({ timeout: 15_000 });
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
  // The third append is the rename, and it is journalled after the control
  // returns — so this is the durable write, not the render. The default 5s is
  // the render's budget, not a write's.
  await expect(first.getByText("3 events", { exact: true }).first()).toBeVisible({ timeout: 25_000 });
  await first.context().close();

  const second = await openFreshVaultPage(browser, namespace);
  // `openFreshVaultPage` already asserts the vault adopted. This is the part
  // the shipped build could not do: resume the renamed session rather than
  // strand everything behind it.
  await expect(second.locator(".runtime-line:not(.runtime-line--phone)")).toHaveAttribute("title", /audited session resumed/u);
  await expect(second.locator(".runtime-line:not(.runtime-line--phone)")).not.toHaveAttribute("title", /could not be replayed/u);

  // The marker's provenance line — sequence, kind, digest — is raw protocol
  // detail that only mounts at the instrumented rung, and this journey
  // asserts exactly that line: step the profile up, then return to the chat.
  await setProfilePresentationDensity(second, "Instrumented");
  await second.goto(`/?airshipLabNamespace=${encodeURIComponent(namespace)}#chat`);

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
