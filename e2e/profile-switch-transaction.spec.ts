import { expect, test, type Page } from "@playwright/test";

/**
 * A profile switch is one commit, and a refused switch says so out loud.
 *
 * The switch publishes two things: authority (the runtime, the Git client, the
 * slash/tool registry) and identity (`profileId`). Those used to be published
 * either side of the validation that can reject the switch, so a rejection left
 * profile A's UI and conversation running on profile B's workspace, tools and
 * Git client. Every call site is `void`-invoked with no catch and there is no
 * global rejection handler, so the inconsistency was silent as well as wrong.
 *
 * `.app-shell` carries both halves as attributes: `data-active-profile` is the
 * published identity and `data-session-profile` is the profile pinned into the
 * manifest of the conversation the runtime is actually running. Those two
 * disagreeing after a switch settles is exactly the split state the finding
 * describes, so that equality is the assertion here.
 *
 * What is not asserted here, honestly: the specific rejection the finding used
 * as its example (profile B's newest compatible conversation carrying an
 * unterminated turn) cannot be staged from the browser — the demo transport
 * always reaches a terminal event, so no journey produces TURN_INCOMPLETE. The
 * second test drives the one refusal a browser *can* reach, a switch asked for
 * while another is still in flight, and pins the two clauses that must hold in
 * every outcome: the halves agree, and nothing was left on the floor.
 */
type RejectionWindow = typeof window & { __airshipProfileRejections?: string[] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
      vaultBackend: "ephemeral", approvalMode: "ask-first",
    }));
    (window as RejectionWindow).__airshipProfileRejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      (window as RejectionWindow).__airshipProfileRejections?.push(
        reason instanceof Error ? reason.message : String(reason),
      );
    });
  });
});

async function readRejections(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as RejectionWindow).__airshipProfileRejections ?? []);
}

async function expectCoherentCockpit(page: Page): Promise<string> {
  const shell = page.locator(".app-shell");
  await expect(page.locator(".profile-cockpit-transition")).toHaveCount(0);
  /*
   * Polled rather than read once: `data-session-profile` comes from the active
   * session record, which lands a render after the identity is published. The
   * contract is about the settled state, and a genuine split never settles.
   */
  await expect.poll(async () => {
    const active = await shell.getAttribute("data-active-profile");
    const session = await shell.getAttribute("data-session-profile");
    return active && session ? `${active}|${session}` : "pending";
  }).toMatch(/^(\w[\w-]*)\|\1$/u);
  return (await shell.getAttribute("data-active-profile"))!;
}

async function switchProfile(page: Page, name: RegExp): Promise<void> {
  await page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" }).click();
  const listbox = page.getByRole("listbox", { name: "Agent profile" });
  await expect(listbox).toBeVisible();
  await listbox.getByRole("option", { name }).click();
}

test("A → B → A publishes authority and identity together and never reports a failure", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail profile switcher is the desktop control");
  await page.goto("/#chat");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-active-profile", "general");
  expect(await expectCoherentCockpit(page)).toBe("general");

  await switchProfile(page, /Research/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(/Research profile/u);
  expect(await expectCoherentCockpit(page)).toBe("research");

  await switchProfile(page, /General/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(/General profile/u);
  expect(await expectCoherentCockpit(page)).toBe("general");

  // The status line is the only place a switch can report itself, so a clean
  // round trip must never have written a failure into it.
  await expect(page.locator(".runtime-line__text")).not.toContainText("Profile switch failed");
  expect(await readRejections(page)).toEqual([]);
});

test("a switch asked for during a switch is handled, not dropped", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the rail profile switcher is the desktop control");
  await page.goto("/#chat");
  expect(await expectCoherentCockpit(page)).toBe("general");

  await page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" }).click();
  await expect(page.getByRole("listbox", { name: "Agent profile" })).toBeVisible();

  /*
   * Both options clicked inside one task, which is what makes this
   * deterministic: `changeProfile` runs synchronously as far as its first
   * `await`, and it raises the in-flight guard before that point, so the second
   * selection is refused by the guard rather than racing it. The refusal is
   * thrown *before* the function's own rollback boundary, which is why it used
   * to escape as an unhandled rejection from a `void`-invoked call site.
   */
  await page.evaluate(() => {
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Agent profile"] [role="option"]')];
    const pick = (label: string) => options.find((option) => option.getAttribute("aria-label") === label);
    pick("Research")?.click();
    pick("Developer")?.click();
  });

  // `builder-systems` is Developer's shipped id — the name changed, the id was
  // kept so pinned sessions and persisted profile history still resolve.
  const settled = await expectCoherentCockpit(page);
  expect(["research", "builder-systems"]).toContain(settled);
  expect(await readRejections(page)).toEqual([]);
});
