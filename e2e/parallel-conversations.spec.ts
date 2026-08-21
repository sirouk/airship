import { expect, test, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/*
 * Two conversations, both answering, and an approval that belongs to the one
 * you are not looking at.
 *
 * The engine has run turns per conversation for some time — `activeTurns` is a
 * Map, the approval delegate is a Map, the prompt queue is a Map. The shell
 * threw all of it away: `createConversation` returned silently while a turn
 * ran, the rail's `+` and both profile switchers were disabled, five palette
 * verbs refused with a page-wide "stop the active turn first", and one
 * unanswered `/write` held a page-wide admission latch that refused a send in
 * every other thread. A run measured on that shell took 22.7s for 13s of work,
 * because the second conversation had to wait for the first.
 *
 * `/write` is the honest way to hold a turn open here: it is a real turn in a
 * real conversation, journaled like any other, and it stops on a person rather
 * than on a clock. That makes "the first conversation is still running" a fact
 * this spec controls rather than a race it hopes to win.
 */

const DISPLAY_PREFERENCES = JSON.stringify({
  mode: "dark",
  typeScale: "default",
  density: "comfortable",
  corners: "subtle",
  bodyFont: "system-sans",
  vaultBackend: "ephemeral",
  approvalMode: "ask-first",
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((preferences) => {
    localStorage.setItem("airship.display-preferences.v1", preferences);
  }, DISPLAY_PREFERENCES);
});

function composer(page: Page) {
  return page.getByRole("combobox", { name: "Message Airship" });
}

function rail(page: Page) {
  return page.getByRole("navigation", { name: "Primary" });
}

function railRow(page: Page, title: string) {
  return rail(page).locator(".recent-conversation-row").filter({ hasText: title });
}

/** The rail's live reading: how many conversations this page is answering. */
function railActivity(page: Page) {
  return page.locator('.load-indicator[data-placement="rail"]');
}

function deferredBar(page: Page) {
  return page.getByRole("group", { name: "Capability request waiting for a decision" });
}

function approvalDialog(page: Page) {
  return page.getByRole("dialog", { name: /Allow write_file once/u });
}

async function openRailRecents(page: Page): Promise<void> {
  const expand = rail(page).getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
}

async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function rename(page: Page, title: string): Promise<void> {
  await page.locator(".session-bar__identity-button").dblclick();
  const input = page.getByRole("textbox", { name: "Conversation title" });
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press("Enter");
  await expect(page.locator(".session-bar__title")).toHaveText(title);
}

test("a second conversation starts, answers and settles while the first still holds a turn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the parallel-turn journey");

  const alphaPath = `parallel/alpha-${crypto.randomUUID()}.txt`;
  const bravoPath = `parallel/bravo-${crypto.randomUUID()}.txt`;

  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });

  // ── Alpha opens a turn and parks on its approval ─────────────────────────
  await send(page, `/write ${alphaPath} alpha-payload`);
  await expect(approvalDialog(page)).toBeVisible({ timeout: 20_000 });
  const alphaUrl = page.url();
  // The conversation on screen still interrupts, and now says which one it is.
  await expect(approvalDialog(page).locator(".eyebrow")).toHaveText(/General conversation/u);

  // Rename used to throw "Wait for the current turn to finish"; a rename is a
  // journal record about the conversation, never a claim on its turn.
  await approvalDialog(page).press("Escape");
  await expect(approvalDialog(page)).toHaveCount(0);
  await rename(page, "Alpha");

  // Put down, not decided: still live, still counted, and now attributable.
  await expect(deferredBar(page)).toContainText("1 decision waiting");
  await expect(deferredBar(page)).toContainText("write_file · Alpha");
  await expect(deferredBar(page).getByRole("button", { name: "Review write_file in Alpha" })).toBeVisible();
  // Alpha's turn is genuinely still running, and the shell is usable anyway.
  await expect(page.getByRole("button", { name: "Stop turn" })).toBeVisible();
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");

  await openRailRecents(page);
  await expect(railRow(page, "Alpha")).toContainText("Working…");
  await expect(railActivity(page)).toContainText("1 active");

  // ── Bravo is started while Alpha answers ────────────────────────────────
  const plus = rail(page).locator('button[aria-label="New conversation"]');
  await expect(plus).toBeEnabled();
  await plus.click();
  await expect(composer(page)).toBeVisible();
  await expect.poll(() => page.url()).not.toBe(alphaUrl);
  await rename(page, "Bravo");

  // Alpha is a background conversation now, and the bar still names it.
  await expect(deferredBar(page).getByRole("button", { name: "Review write_file in Alpha" })).toBeVisible();
  await openRailRecents(page);
  await expect(railRow(page, "Alpha")).toContainText("Working…");
  await expect(railRow(page, "Bravo")).not.toContainText("Working…");

  // ── Bravo's own turn runs at the same time ──────────────────────────────
  await send(page, `/write ${bravoPath} bravo-payload`);
  await expect(approvalDialog(page)).toBeVisible({ timeout: 20_000 });
  await expect(approvalDialog(page).locator(".eyebrow")).toHaveText(/Bravo/u);
  // Two conversations, two turns, at the same time.
  await expect(railActivity(page)).toContainText("2 active");

  await approvalDialog(page).getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Local result · excluded from model context").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".transcript")).toContainText(bravoPath);
  // Bravo settled; Alpha is still working, and the rail says so.
  await expect(railActivity(page)).toContainText("1 active");
  await openRailRecents(page);
  await expect(railRow(page, "Alpha")).toContainText("Working…");

  // ── The background conversation's decision is answered from the bar ──────
  await deferredBar(page).getByRole("button", { name: "Review write_file in Alpha" }).click();
  const resumed = approvalDialog(page);
  await expect(resumed).toBeVisible({ timeout: 20_000 });
  // Answered where the person is standing, and the dialog says whose it is.
  await expect(resumed.locator(".eyebrow")).toHaveText(/Alpha/u);
  await expect(page.locator(".session-bar__title")).toHaveText("Bravo");
  await resumed.getByRole("button", { name: "Allow once" }).click();
  await expect(deferredBar(page)).toHaveCount(0);

  // ── Both transcripts end correctly, each with its own provenance ─────────
  await expect(page.locator(".transcript")).toContainText(bravoPath);
  await expect(page.locator(".transcript")).not.toContainText(alphaPath);
  await send(page, `/read ${bravoPath}`);
  await expect(page.getByText("bravo-payload", { exact: true }).last()).toBeVisible({ timeout: 20_000 });

  await openRailRecents(page);
  await expect(railRow(page, "Alpha")).not.toContainText("Working…");
  await railRow(page, "Alpha").locator("button.recent-conversation").click();
  await expect(page.locator(".session-bar__title")).toHaveText("Alpha", { timeout: 20_000 });
  await expect.poll(() => page.url(), { timeout: 20_000 }).toBe(alphaUrl);
  await expect(page.locator(".transcript")).toContainText(alphaPath, { timeout: 20_000 });
  await expect(page.locator(".transcript")).not.toContainText(bravoPath);
  // The effect the person allowed from the other conversation actually ran,
  // in Alpha's own workspace, under Alpha's own turn.
  await send(page, `/read ${alphaPath}`);
  await expect(page.getByText("alpha-payload", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
});
