import { expect, test, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";
import { setProfilePresentationDensity } from "./support/density";

/*
 * The rail's two navigation promises, driven rather than read.
 *
 * Both defects these specs pin were found by clicking, not by grepping, and
 * both were invisible to a suite that never opened a second conversation.
 *
 *  1. Clicking a thread in the rail sent the person to `#sessions` — the
 *     conversation library — instead of to the thread. Two causes, one route:
 *     every refusal inside the open path ended in `navigate("sessions")`, and
 *     the path refused far more often than it should have, because the row's
 *     `open` callback is baked in by an effect keyed on the trailing edge of a
 *     turn's event burst. Traced in the browser: BUSY=true at 65ms, the rail
 *     re-lists at 318ms, BUSY=false at 1594ms, the rail re-lists again at
 *     1843ms. Every row a person can see between 318ms and 1843ms was built
 *     mid-turn and answers "a turn is running" for the whole of it — including
 *     the 250ms after the composer is handed back, which is exactly when a
 *     person clicks the thread they want next.
 *
 *  2. `All conversations` was the last child of the thread scroller, so it was
 *     clipped out of reach by the very threads that make a library worth
 *     opening. Measured at 1440x1000 with nine of them: scroller 250→670, link
 *     at 730→766 — below the clip, on screen nowhere.
 *
 * So: send a real turn, click a real row, assert the destination. Never
 * `if (await row.count())` — a conditional that silently passes when the thing
 * it guards is missing is how this stayed green through both defects.
 */

function railRows(page: Page) {
  return page
    .getByRole("navigation", { name: "Primary" })
    .locator(".recent-conversation-row button.recent-conversation");
}

/** The disclosure opens itself once a profile has threads, so state what is needed. */
async function openRailRecents(page: Page): Promise<void> {
  const expand = page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
}

async function startTurn(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function finishTurn(page: Page, text: string): Promise<void> {
  await expect(page.locator(".transcript")).toContainText(text);
  // The composer's Stop, which exists exactly while *this* conversation holds a
  // turn. It used to be the rail's `+` that answered this, and the `+` no longer
  // knows: turns run per conversation, so starting another one is never
  // refused. The claim being made is unchanged — this conversation is finished.
  await expect(page.getByRole("button", { name: "Stop turn" })).toHaveCount(0);
  // Past the second re-list as well, so the next step starts from settled rows.
  await expect(railRows(page).filter({ hasText: text })).toHaveCount(1);
}

async function newConversation(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Primary" })
    .locator('button[aria-label="New conversation"]').click();
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible();
  await openRailRecents(page);
}

/**
 * Clicks a rail row at the instant the turn hands the composer back.
 *
 * The wait and the click are one in-page step on purpose. The window this spec
 * exists to defend is the 250ms between the composer being released and the
 * rail re-listing, and a wait that round-trips to the test runner before
 * clicking spends most of that window on the wire — which is precisely how an
 * earlier draft of this spec passed against the unfixed build. The click is a
 * real click on the real button; only its timing is taken out of the runner's
 * hands.
 */
async function clickRowWhenTheTurnReleases(page: Page, rowText: string): Promise<void> {
  await railRows(page).filter({ hasText: rowText }).first().waitFor();
  const clicked = await page.evaluate(async (needle: string) => {
    // Stop is present for as long as this conversation's turn is; its removal
    // is the composer being handed back. The rail's `+` used to stand in for
    // this and cannot any more — it is never disabled now.
    const answering = () => document.querySelector(".composer .send-button.stop");
    const started = performance.now();
    while (performance.now() - started < 20_000) {
      if (!answering()) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const row = [...document.querySelectorAll("#airship-recent-conversations .recent-conversation")]
      .find((candidate) => candidate.textContent?.includes(needle));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  }, rowText);
  expect(clicked, `the rail row "${rowText}" was on screen to be clicked`).toBe(true);
}

test("clicking a conversation in the rail opens that conversation, not the library", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail is a desktop surface");

  await page.goto("/#chat");
  await waitForShellSettled(page);
  // Past the service worker's boot reload: the address minted before it is
  // abandoned, so anything asserted against it describes a dead document.
  await waitForShellSettled(page);
  await openRailRecents(page);

  await startTurn(page, "rail journey: thread one");
  await finishTurn(page, "rail journey: thread one");
  const threadOne = page.url();
  expect(threadOne).toMatch(/#chat\/[^/?#]+$/);

  await newConversation(page);
  await startTurn(page, "rail journey: thread two");
  const threadTwo = page.url();
  expect(threadTwo).not.toBe(threadOne);

  // The gesture: the reply lands, and the person goes back to the other thread.
  await clickRowWhenTheTurnReleases(page, "rail journey: thread one");

  await expect(page).toHaveURL(threadOne);
  await expect(page.locator(".session-bar__title")).toHaveText("rail journey: thread one");
  // The specific wrong destination this lane exists to end.
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toHaveCount(0);

  // And back the other way, so the contract is not "the first row is special".
  await railRows(page).filter({ hasText: "rail journey: thread two" }).first().click();
  await expect(page).toHaveURL(threadTwo);
  await expect(page.locator(".session-bar__title")).toHaveText("rail journey: thread two");
});

test("a same-model rail click during a turn opens immediately and keeps the turn durable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail is a desktop surface");

  await page.goto("/#chat");
  await waitForShellSettled(page);
  await waitForShellSettled(page);
  /*
   * The sentence this journey settles on — the idle load strip's "Ready" —
   * retires at the house rung: only the busy strip renders there, so the
   * idle sentence the second half of this contract reads exists one rung
   * up. Prime it before the journey, like every spec that reads idle chrome.
   */
  await setProfilePresentationDensity(page, "Balanced");
  await page.goto("/#chat");
  await waitForShellSettled(page);
  await openRailRecents(page);

  await startTurn(page, "rail journey: original thread");
  await finishTurn(page, "rail journey: original thread");
  const original = page.url();

  await newConversation(page);
  await startTurn(page, "rail journey: busy thread");
  const busyThread = page.url();
  await expect(page.locator(".load-indicator")).toContainText("1 active");

  /* Same-model history is safe to activate immediately. The running turn's
     stream stays fenced to its original session, while its durable result can
     still be reopened after it settles. */
  await railRows(page).filter({ hasText: "rail journey: original thread" }).first().click();

  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toHaveCount(0);
  await expect(page).toHaveURL(original);
  await expect(page.locator(".session-bar__title")).toHaveText("rail journey: original thread");
  await expect(page.locator(".transcript")).not.toContainText("rail journey: busy thread");
  await expect(page.locator(".load-indicator")).toContainText("Ready");

  // The turn settled in its original session, not in the conversation that
  // happened to be visible while it ran.
  await railRows(page).filter({ hasText: "rail journey: busy thread" }).first().click();
  await expect(page).toHaveURL(busyThread);
  await expect(page.locator(".session-bar__title")).toHaveText("rail journey: busy thread");
  await expect(page.locator(".transcript")).toContainText("rail journey: busy thread");
});

test("All conversations stays reachable in the rail once the thread list overflows", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail is a desktop surface");
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/#chat");
  await waitForShellSettled(page);
  await waitForShellSettled(page);
  await openRailRecents(page);

  // Nine threads is the count the design review measured the link out of reach at.
  for (let index = 0; index < 8; index += 1) await newConversation(page);
  await expect(railRows(page)).toHaveCount(9);

  const ledger = page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "All conversations", exact: true });
  await expect(ledger).toBeVisible();

  /*
   * `toBeVisible` is not enough and never was: an element clipped by an
   * ancestor's `overflow` still has a box and still passes it. That is exactly
   * how a link sitting 60px below its scroller's bottom edge stayed "visible"
   * in a green suite while nobody could see or click it. Geometry decides.
   */
  const reach = await page.evaluate(() => {
    const panel = document.querySelector("#airship-recent-conversations");
    const list = panel?.querySelector(".recent-conversations__list");
    const link = [...(panel?.querySelectorAll("button") ?? [])]
      .find((button) => button.getAttribute("aria-label") === "All conversations");
    if (!(list instanceof HTMLElement) || !(link instanceof HTMLElement)) return undefined;
    const listBox = list.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    return {
      threadsOverflow: list.scrollHeight - list.clientHeight > 1,
      linkIsInsideTheScroller: list.contains(link),
      linkIsOnScreen: linkBox.top >= 0 && linkBox.bottom <= window.innerHeight && linkBox.width > 0,
      linkSitsBelowTheThreads: linkBox.top >= listBox.bottom - 1,
      // The row earns its permanent place by carrying the count the clipped
      // list can no longer be scrolled to the end to reveal.
      describesTheCount: link.getAttribute("title"),
    };
  });

  expect(reach).toBeDefined();
  // The precondition: without overflow this spec would prove nothing.
  expect(reach?.threadsOverflow).toBe(true);
  expect(reach?.linkIsInsideTheScroller).toBe(false);
  expect(reach?.linkSitsBelowTheThreads).toBe(true);
  expect(reach?.linkIsOnScreen).toBe(true);
  expect(reach?.describesTheCount).toBe("All conversations · 9 in this profile");

  await ledger.click();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible();
  expect(pageErrors, "expanding the measured rail must not create a resize-delivery error").toEqual([]);
});
