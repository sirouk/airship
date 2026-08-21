import { expect, test } from "@playwright/test";

/**
 * "Select all" must select all of it, whenever it is pressed.
 *
 * Found by a documentation auditor as an intermittent failure of
 * `bundle-grants-no-approval-mode.spec.ts`: the move-work panel's "Select all"
 * committed the rows it could see at the instant it was pressed. The sessions
 * route starts its journal read on mount and the panel is a lazily fetched
 * chunk, so on a warm cache the panel is on screen while the read is still in
 * flight — and pressing the control then committed the empty list. The rows
 * arrived, the legend read "Conversations (0 of 1)", "Write bundle file" stayed
 * disabled, and nothing said why. The control did the exact opposite of its
 * label, silently.
 *
 * The harness holds the first journal read open so that window is a fact rather
 * than a coin toss. Everything else is the product: the real route, the real
 * lazily imported panel, one real conversation.
 */
test("Select all still means all when the rows arrive after the press", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One Chromium context owns the instrumented sessions harness.");
  await page.goto("/");
  await page.evaluate(async () => {
    document.body.replaceChildren(Object.assign(document.createElement("main"), { id: "slow-session-list-root" }));
    const { mountSlowSessionListHarness } = await import("/e2e/fixtures/slow-session-list-harness.tsx");
    await mountSlowSessionListHarness(document.querySelector("#slow-session-list-root")!);
  });

  // The route is still reading the journal, and says so.
  await expect(page.getByText("Reading journal…")).toBeVisible();
  await page.getByRole("button", { name: "Move work" }).click();
  await expect(page.getByRole("heading", { name: "Move work in or out" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Reading journal…")).toBeVisible();
  const legend = page.locator(".work-bundle__set legend").first();
  await expect(legend).toHaveText("Conversations (0 of 0)");

  // Pressed before the panel knows what it is about.
  await page.getByRole("button", { name: "Select all" }).click();

  // Now the read lands and the row the panel is about appears.
  await page.evaluate(() => globalThis.airshipSlowSessionListRelease());
  await expect(page.locator(".work-bundle__title")).toHaveText("Only conversation");

  // The press meant "all", and all is what is selected.
  await expect(legend).toHaveText("Conversations (1 of 1)");
  await expect(page.locator(".work-bundle__list input[type=checkbox]")).toBeChecked();
  const write = page.getByRole("button", { name: "Write bundle file" });
  await expect(write).toBeEnabled();

  // And the file it writes holds that conversation, which is the whole claim.
  const download = page.waitForEvent("download");
  await write.click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bundle = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { conversations: { session: { title: string } }[] };
  expect(bundle.conversations.map((entry) => entry.session.title)).toEqual(["Only conversation"]);
});

/**
 * The other half of the same rule: "Clear" clears, and stays cleared.
 *
 * Pressing Clear before the rows arrive commits the empty list too — but empty
 * is what Clear means, so the answer a later render brings does not contradict
 * it. This is asserted rather than assumed, because the fix for "Select all"
 * must not turn "Clear" into a control that a later row silently re-selects.
 */
test("Clear pressed before the rows arrive stays cleared when they do", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One Chromium context owns the instrumented sessions harness.");
  await page.goto("/");
  await page.evaluate(async () => {
    document.body.replaceChildren(Object.assign(document.createElement("main"), { id: "slow-session-list-root" }));
    const { mountSlowSessionListHarness } = await import("/e2e/fixtures/slow-session-list-harness.tsx");
    await mountSlowSessionListHarness(document.querySelector("#slow-session-list-root")!);
  });
  await page.getByRole("button", { name: "Move work" }).click();
  await expect(page.getByRole("heading", { name: "Move work in or out" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Clear" }).click();
  await page.evaluate(() => globalThis.airshipSlowSessionListRelease());
  await expect(page.locator(".work-bundle__title")).toHaveText("Only conversation");
  await expect(page.locator(".work-bundle__set legend").first()).toHaveText("Conversations (0 of 1)");
  await expect(page.getByRole("button", { name: "Write bundle file" })).toBeDisabled();
});

/**
 * The same window, said out loud.
 *
 * A list that has not finished arriving is not an empty journal. Opened during
 * the read, the panel used to state "There is nothing here to take out yet." —
 * a claim about a read that had not landed, beside a control that had just
 * committed that claim as an answer.
 */
test("an unfinished read is not reported as an empty journal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One Chromium context owns the instrumented sessions harness.");
  await page.goto("/");
  await page.evaluate(async () => {
    document.body.replaceChildren(Object.assign(document.createElement("main"), { id: "slow-session-list-root" }));
    const { mountSlowSessionListHarness } = await import("/e2e/fixtures/slow-session-list-harness.tsx");
    await mountSlowSessionListHarness(document.querySelector("#slow-session-list-root")!);
  });
  await page.getByRole("button", { name: "Move work" }).click();
  await expect(page.getByRole("heading", { name: "Move work in or out" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".work-bundle__note").first()).toHaveText("Still reading the conversations on this device.");
  await expect(page.getByText("There is nothing here to take out yet.")).toHaveCount(0);
  await page.evaluate(() => globalThis.airshipSlowSessionListRelease());
  await expect(page.locator(".work-bundle__title")).toHaveText("Only conversation");
  // The read landed and the list is not empty, so neither sentence applies.
  await expect(page.getByText("Still reading the conversations on this device.")).toHaveCount(0);
  await expect(page.getByText("There is nothing here to take out yet.")).toHaveCount(0);
});
