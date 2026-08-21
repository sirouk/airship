import { expect, test, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/**
 * The four things a person has to be able to do with a decision: read it,
 * attribute it, reach it, and hear that it arrived.
 *
 * Measured before this landed. Every write approval drew the file's current
 * content as "∅" over a file that had content, and "Size delta: Not supplied"
 * beside it — neither derived from anything, and now that a write can land on a
 * person's own disk the wrong one is the expensive one. Two conversations
 * nobody had named were both "General conversation", so a scoped request named
 * both. "2 decisions waiting" printed one name, one clock and one button, and
 * the second request was unreachable until the first was answered while its own
 * five minutes ran out. And the bar was a `role="group"` with no live region at
 * all.
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

function composer(page: Page) { return page.getByRole("combobox", { name: "Message Airship" }); }
function rail(page: Page) { return page.getByRole("navigation", { name: "Primary" }); }
function approvalDialog(page: Page) { return page.getByRole("dialog", { name: /Allow write_file once/u }); }
function deferredBar(page: Page) { return page.getByRole("group", { name: "Capability request waiting for a decision" }); }

async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test("a write approval claims only what its arguments carry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the approval surface");
  test.setTimeout(180_000);
  const path = `approval/notes-${crypto.randomUUID()}.txt`;

  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });

  // Give the file real content first, so "the current content" exists.
  await send(page, `/write ${path} first-content-abcdef`);
  await expect(approvalDialog(page)).toBeVisible({ timeout: 20_000 });
  await approvalDialog(page).getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Local result · excluded from model context").last()).toBeVisible({ timeout: 20_000 });

  // Now overwrite it. The arguments carry the new content and nothing about
  // what it replaces, and the panel may not pretend otherwise.
  await send(page, `/write ${path} second-content-uvwxyz`);
  const dialog = approvalDialog(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const facts = dialog.locator(".approval-write-facts");
  await expect(facts).toContainText("New content, bounded. What it replaces is not read here.");
  await expect(facts).toContainText("second-content-uvwxyz");
  // No invented previous side, and no delta reported as a missing argument.
  await expect(facts).not.toContainText("∅");
  await expect(facts).not.toContainText("Size delta");
  await expect(dialog.locator(".approval-diff del")).toHaveCount(0);
  // What the panel does know is still on it, and still exact.
  await expect(facts).toContainText("Create or overwrite");
  await expect(facts).toContainText("21 bytes");

  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(approvalDialog(page)).toHaveCount(0);
});

test("two unnamed conversations are told apart, and both waiting decisions are reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the dock");
  test.setTimeout(180_000);

  await page.goto("/#chat");
  await waitForShellSettled(page);
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });

  await send(page, "/write dock/first.txt first-payload");
  const first = approvalDialog(page);
  await expect(first).toBeVisible({ timeout: 20_000 });
  const firstName = (await first.locator(".eyebrow").textContent() ?? "").trim();
  await first.press("Escape");
  await expect(approvalDialog(page)).toHaveCount(0);
  await expect(deferredBar(page)).toContainText("1 decision waiting");

  /*
   * The dock owns three regions of its own now: settled outcomes, the assertive
   * deadline, and the waiting bar's own polite channel. The bar had none, so a
   * decision filed because it came from a conversation nobody is reading was
   * announced only by the Escape handler — which never fires for one. Counted
   * among the dock's own siblings, so the transcript narrator's region (the one
   * this may not steal) is not what is being counted.
   */
  const dockRegions = await page.evaluate(() => {
    const scope = document.querySelector(".approval-deferred")?.parentElement;
    if (!scope) return { polite: -1, alert: -1 };
    const own = [...scope.children];
    return {
      polite: own.filter((node) => node.matches('span.sr-only[role="status"][aria-live="polite"]')).length,
      alert: own.filter((node) => node.matches('span.sr-only[role="alert"]')).length,
    };
  });
  expect(dockRegions).toEqual({ polite: 2, alert: 1 });
  // And the bar itself is still not a live region: its countdown ticks once a
  // second and must never be announced as text churn.
  await expect(deferredBar(page)).not.toHaveAttribute("aria-live", /.*/u);

  await rail(page).locator('button[aria-label="New conversation"]').click();
  await expect(composer(page)).toBeVisible();
  await send(page, "/write dock/second.txt second-payload");
  const second = approvalDialog(page);
  await expect(second).toBeVisible({ timeout: 20_000 });
  const secondName = (await second.locator(".eyebrow").textContent() ?? "").trim();
  // Neither has been named by a person, and they are still not the same name.
  expect(firstName).not.toBe(secondName);
  expect(firstName).toContain("General conversation");
  expect(secondName).toContain("General conversation");
  await second.press("Escape");
  await expect(approvalDialog(page)).toHaveCount(0);

  // Two waiting decisions, two names, two clocks, two controls.
  const bar = deferredBar(page);
  await expect(bar).toContainText("2 decisions waiting");
  await expect(bar.getByRole("listitem")).toHaveCount(2);
  const buttons = bar.getByRole("button");
  await expect(buttons).toHaveCount(2);
  const labels = await buttons.allInnerTexts();
  expect(new Set(labels).size, `both controls are named for their own conversation: ${labels.join(" / ")}`).toBe(2);
  for (const line of await bar.getByRole("listitem").allInnerTexts()) {
    expect(line).toMatch(/write_file · .+ · expires in \d\d:\d\d/u);
  }
  // Every control clears the coarse-pointer floor, including the second row.
  for (const control of await buttons.all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(testInfo.project.name === "mobile-chromium" ? 44 : 32);
  }

  // The second one can be answered first: it was unreachable before.
  await buttons.nth(1).click();
  const resumed = approvalDialog(page);
  await expect(resumed).toBeVisible({ timeout: 20_000 });
  await expect(resumed.locator(".eyebrow")).toHaveText(secondName);
  await resumed.getByRole("button", { name: "Deny" }).click();
  await expect(deferredBar(page)).toContainText("1 decision waiting");
  await expect(deferredBar(page).getByRole("button")).toHaveCount(1);
});
