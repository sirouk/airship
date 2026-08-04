import { expect, test } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/*
 * Proof is not a global destination, and two surfaces used to disagree about it.
 *
 * `Trust` is how the navigation table *files* four destinations; it is not a
 * claim that they share a scope. Proof is `session` — the receipts of the turns
 * of the conversation you are standing in — while Vault, Connection and Account
 * are `global` services that outlive every conversation and every profile.
 *
 * The rail has always drawn that seam: its `GLOBAL` group label sits above
 * Vault, and `profile-silo` asserts `data-scope="global"` on exactly those
 * three and deliberately not on Proof. The Trust hub strip — the tab bar every
 * one of those four routes renders above itself, and the only navigation the
 * phone gets between them — built itself by filtering the same table on
 * `group === "Trust"` and threw the scope away, so it drew all four as flat
 * peers. A person on #proof was being told that the evidence for the
 * conversation they are in is a global option like the storage backend.
 *
 * This spec drives the strip and holds it to the rail's own answer, per label,
 * rather than to a copy of the four scopes. Two surfaces that read the same
 * table can only be kept honest by being compared to each other.
 */
test("the Trust hub strip scopes Proof to this conversation and agrees with the rail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail this strip is compared against is desktop-only");
  await page.goto("/#chat");
  await waitForShellSettled(page);

  // The rail's answer, read off the surface rather than off the module.
  const primary = page.getByRole("navigation", { name: "Primary" });
  const railScopes = await primary.evaluate((nav) => Object.fromEntries(
    [...nav.querySelectorAll<HTMLElement>(".nav-item")]
      .map((item) => [item.querySelector(".nav-item__label")?.textContent?.trim() ?? "", item.dataset.scope])
      .filter(([label, scope]) => label && scope),
  ));
  expect(railScopes.Proof).toBe("session");
  expect(railScopes.Vault).toBe("global");
  expect(railScopes.Connection).toBe("global");
  expect(railScopes.Account).toBe("global");

  await page.goto("/#proof");
  await waitForShellSettled(page);
  const strip = page.getByRole("navigation", { name: "Trust hub" });
  await expect(strip).toBeVisible();

  // Every tab states its scope, and states the same one the rail does.
  for (const [label, scope] of Object.entries(railScopes)) {
    const tab = strip.getByRole("button", { name: label, exact: true });
    if (await tab.count() === 0) continue;
    await expect(tab).toHaveAttribute("data-scope", String(scope));
  }
  await expect(strip.getByRole("button", { name: "Proof", exact: true })).toHaveAttribute("data-scope", "session");

  /*
   * And the seam is legible, not merely present in an attribute. The strip
   * reads left to right as the conversation's own evidence, the rail's own
   * `GLOBAL` label, then the three global services — one band in one place,
   * exactly as the rail files them.
   */
  const banded = await strip.evaluate((nav) => [...nav.children].map((child) => ({
    kind: child.tagName === "BUTTON" ? "tab" : "band",
    text: child.textContent?.trim() ?? "",
    scope: (child as HTMLElement).dataset.scope,
  })));
  expect(banded).toEqual([
    { kind: "tab", text: "Proof", scope: "session" },
    { kind: "band", text: "Global", scope: "global" },
    { kind: "tab", text: "Vault", scope: "global" },
    { kind: "tab", text: "Connection", scope: "global" },
    { kind: "tab", text: "Account", scope: "global" },
  ]);
  // Proof is on the near side of the label, not under it. Stated as geometry
  // because that is what a person actually reads.
  const [proofRight, bandLeft] = await strip.evaluate((nav) => [
    nav.querySelector<HTMLElement>("button[data-scope='session']")!.getBoundingClientRect().right,
    nav.querySelector<HTMLElement>(".trust-hub-tabs__band")!.getBoundingClientRect().left,
  ]);
  expect(proofRight).toBeLessThanOrEqual(bandLeft + 0.5);

  // Nothing was removed to make the point: all four still navigate.
  await strip.getByRole("button", { name: "Vault", exact: true }).click();
  await expect(page).toHaveURL(/#vault/);
  await expect(page.getByRole("navigation", { name: "Trust hub" }).getByRole("button", { name: "Vault", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation", { name: "Trust hub" }).getByRole("button", { name: "Proof", exact: true }).click();
  await expect(page).toHaveURL(/#proof/);
});

test("the phone reaches every Trust destination and still sees the scope seam", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the strip is the phone's only navigation between these four");
  await page.goto("/#proof");
  await waitForShellSettled(page);
  const strip = page.getByRole("navigation", { name: "Trust hub" });
  await expect(strip).toBeVisible();

  /*
   * The band is the cheapest thing on the strip — one word and a rule — and it
   * is the whole reason the strip is honest, so it survives the phone rather
   * than being the first thing a media query deletes. Measured at 390x664: the
   * strip's content is 375px with no band and 438px with this one, in a 390px
   * scroller that snaps and auto-centres the active tab. A second band would
   * have cost 147px more, which is why there is only one.
   */
  await expect(strip.locator(".trust-hub-tabs__band")).toHaveCount(1);
  await expect(strip.locator(".trust-hub-tabs__band")).toHaveText("Global");
  await expect(strip.getByRole("button", { name: "Proof", exact: true })).toHaveAttribute("data-scope", "session");

  for (const [label, hash] of [["Vault", /#vault/u], ["Connection", /#connection/u], ["Account", /#account/u], ["Proof", /#proof/u]] as const) {
    const tab = strip.getByRole("button", { name: label, exact: true });
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    await expect(page).toHaveURL(hash);
  }
});
