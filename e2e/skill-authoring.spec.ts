import { expect, test, type Page } from "@playwright/test";

/**
 * A skill someone wrote can be created, read back, revised and removed.
 *
 * `createSkillRevision` had no authoring caller anywhere in the tree: the Skills
 * route rendered six release-owned instructions and three toggles. This spec is
 * the whole loop, because each half was individually plausible and the join is
 * where the defect lived — removal went dead after one ordinary click, and the
 * refusal named a profile that does not use the skill.
 */

const SKILL_NAME = "Ledger voice";
const SKILL_ID = "custom.ledger-voice";

async function openSkills(page: Page, namespace: string): Promise<void> {
  await page.goto(`/?airshipLabNamespace=${namespace}#skills`);
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible({ timeout: 20_000 });
}

function card(page: Page) {
  return page.locator(".skill-card").filter({ hasText: SKILL_ID });
}

async function createSkill(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  const editor = page.locator(".skill-editor");
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.getByLabel("Name").fill(SKILL_NAME);
  await editor.getByLabel("Description").fill("Answer in the ledger's voice.");
  await editor.getByLabel("Instruction").fill("Write in the ledger's voice: short, dated, and sourced.");
  await editor.getByRole("button", { name: "Create skill" }).click();
  await expect(editor).toBeHidden();
  await expect(card(page)).toBeVisible();
}

test("a skill can be written, revised and removed at global scope", async ({ page }) => {
  await openSkills(page, "skill-authoring-global");
  await createSkill(page);
  await expect(card(page).getByRole("heading", { name: SKILL_NAME })).toBeVisible();

  await card(page).getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".skill-editor");
  await expect(editor).toBeVisible();
  // The revision reads back what was committed, not a blank form: the panel is
  // keyed by target, so its mount-only initializer sees this skill's fields.
  await expect(editor.getByLabel("Instruction")).toHaveValue(/ledger's voice/u);
  // A skill's ID is its identity in every manifest that already named it.
  await expect(editor.getByLabel("Skill ID")).toBeDisabled();
  await editor.getByLabel("Instruction").fill("Write in the ledger's voice, and cite the entry.");
  await editor.getByRole("button", { name: "Save revision" }).click();
  await expect(editor).toBeHidden();

  await card(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
});

test("a profile override does not permanently disable removal", async ({ page }) => {
  /*
   * The defect both refuters found independently. `setProfileSkill` wrote
   * `skillModes[id] = "inherit"` for every mode, `Object.hasOwn` counted that
   * inert key as a reference, and Remove refused forever with a sentence naming
   * a profile the skill does not reach — with no surface anywhere that could
   * clear the key, because `validateProfileCatalog` rejects an orphan one.
   */
  await openSkills(page, "skill-authoring-profile");
  await createSkill(page);

  // Research, not the active General: changing the ACTIVE profile's skill policy
  // deliberately opens a new pinned conversation and navigates to Chat
  // (`setProfileSkill`), so this route would be gone before the second half of
  // the claim could be measured. The defect is about the stored mode, not about
  // which profile stores it.
  await page.getByLabel("Skill scope").click();
  await page.getByRole("option", { name: "Research", exact: true }).click();
  const scoped = card(page);
  await expect(scoped).toBeVisible();

  const mode = scoped.getByLabel(`Research mode for ${SKILL_NAME}`);
  await mode.click();
  await page.getByRole("option", { name: "Always on", exact: true }).click();
  // While a profile genuinely decides on this skill, Remove refuses — and says
  // which profile, where the refused control is rather than in a tooltip.
  await expect(scoped.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
  await expect(scoped).toContainText("Research");

  await mode.click();
  await page.getByRole("option", { name: "Inherit global", exact: true }).click();
  // …and the moment it stops deciding, Remove is available again.
  await expect(scoped.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
  await scoped.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
});

test("the authoring panel does not scroll the page sideways at 320px", async ({ page }) => {
  /*
   * 320px is the responsive floor this repository already defends elsewhere. A
   * grid item defaults to `min-width: auto`, so a long instruction line widens
   * its own track and stretches every sibling with it — a failure invisible at
   * the one width the suite otherwise measures. Not a coarse-pointer assertion:
   * `setViewportSize` changes the viewport, not the pointer type.
   */
  await page.setViewportSize({ width: 320, height: 812 });
  await openSkills(page, "skill-authoring-narrow");
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  await expect(page.locator(".skill-editor")).toBeVisible({ timeout: 20_000 });
  await page.locator(".skill-editor").getByLabel("Instruction")
    .fill("A".repeat(400));

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: (() => {
      const main = document.querySelector("main.main");
      return main ? main.scrollWidth - main.clientWidth : 0;
    })(),
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.main).toBeLessThanOrEqual(0);
});

test.describe("the authoring panel under a finger", () => {
  /*
   * The floor is a coarse-pointer rule, and `e2e/touch-target-floor.spec.ts`
   * carries this exact guard for the same reason: a fine pointer never matches
   * `@media (pointer: coarse)`, so asserting 44px on desktop-chromium measures
   * a rule that is deliberately not in force. Playwright only accepts
   * `test.skip` with a predicate inside a describe block, which is what this
   * block is for.
   */
  test.skip(({ isMobile }) => !isMobile, "the floor is a coarse-pointer rule");

  test("every authoring control clears the 44px floor", async ({ page }) => {
    await openSkills(page, "skill-authoring-touch");
    await page.getByRole("button", { name: "New skill", exact: true }).click();
    await expect(page.locator(".skill-editor")).toBeVisible({ timeout: 20_000 });

    const undersized = await page.evaluate(() => {
      const panel = document.querySelector(".skill-editor");
      if (!panel) return ["the authoring panel did not render"];
      return [...panel.querySelectorAll("button,input,textarea")].flatMap((element) => {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height) return [];
        return Math.min(box.width, box.height) < 44
          ? [`${element.tagName.toLowerCase()} ${Math.round(box.width)}x${Math.round(box.height)}`]
          : [];
      });
    });
    expect(undersized).toEqual([]);
  });
});
