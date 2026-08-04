import { expect, test, type Page } from "@playwright/test";
import { threadViewportStorageKey } from "../src/ui/chat/thread-viewport";

const ALPHA_TITLE = "General silo checkpoint";
const ALPHA_DRAFT = "alpha unsent profile-local draft";
const BETA_DRAFT = "beta unsent profile-local draft";
const ALPHA_MEMORY_QUERY = "alpha-private-memory-query";
const BETA_MEMORY_QUERY = "beta-private-memory-query";
const ALPHA_BRANCH = "profile-silo-alpha";
const ALPHA_WORKTREE = `/workspace/worktrees/${ALPHA_BRANCH}`;

test("Profile is the primary A → B → A cockpit silo while global services stay global", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one full desktop cockpit journey exercises every profile surface");
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "full-access",
    }));
    (window as typeof window & { __airshipProfileLeaks?: string[] }).__airshipProfileLeaks = [];
    new MutationObserver(() => {
      const shell = document.querySelector<HTMLElement>(".app-shell");
      if (!shell || document.querySelector(".profile-cockpit-transition")) return;
      const profile = shell.dataset.activeProfile;
      const sessionProfile = shell.dataset.sessionProfile;
      if (profile && sessionProfile && profile !== sessionProfile) {
        (window as typeof window & { __airshipProfileLeaks?: string[] }).__airshipProfileLeaks?.push(`${profile}:${sessionProfile}`);
      }
      const proofSession = shell.dataset.proofSession;
      const mappedProofProfile = proofSession
        ? (window as typeof window & { __airshipSessionProfiles?: Record<string, string> }).__airshipSessionProfiles?.[proofSession]
        : undefined;
      if (location.hash.startsWith("#proof") && profile && mappedProofProfile && mappedProofProfile !== profile) {
        (window as typeof window & { __airshipProfileLeaks?: string[] }).__airshipProfileLeaks?.push(`proof:${profile}:${mappedProofProfile}`);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  });

  await page.goto("/#chat");
  const shell = page.locator(".app-shell");
  await expect(shell).toHaveAttribute("data-active-profile", "general");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
  const alphaUrl = page.url();
  const alphaSessionId = alphaUrl.split("#chat/")[1]!;
  await page.evaluate((sessionId) => {
    (window as typeof window & { __airshipSessionProfiles?: Record<string, string> }).__airshipSessionProfiles = {
      [sessionId]: "general",
    };
  }, alphaSessionId);

  await renameConversation(page, ALPHA_TITLE);
  await createScrollableTranscript(page);
  const transcript = page.locator(".transcript");
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill(ALPHA_DRAFT);
  await page.waitForTimeout(220);
  await favoriteActiveConversation(page, ALPHA_TITLE);
  await assertConversationSearch(page, ALPHA_TITLE, true, "General");

  await openPrimary(page, "Workspace");
  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  await page.getByRole("textbox", { name: "Edit README.md" }).fill("Alpha unsaved workspace draft.\n");
  await createAndSelectAlphaWorktree(page);

  await openPrimary(page, "Terminal");
  await renameTerminal(page, "Terminal 1", "Alpha primary");
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await renameTerminal(page, "Terminal 2", "Alpha selected");
  await expect(page.getByRole("tab", { name: /Alpha selected/u })).toHaveAttribute("aria-selected", "true");

  await openPrimary(page, "Memory");
  await page.getByRole("searchbox", { name: "Search every memory surface" }).fill(ALPHA_MEMORY_QUERY);
  const alphaIndex = page.locator("#memory-index");
  await openMemoryIndex(page);
  await expect.poll(() => alphaIndex.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);

  await openPrimary(page, "Proof");
  await expectProofSession(page, alphaSessionId);

  // These services are deliberately outside the Profile silo. Their rail rows
  // retain the global scope and their page authority is not duplicated under A.
  const primary = page.getByRole("navigation", { name: "Primary" });
  for (const globalDestination of ["Vault", "Connection", "Account"] as const) {
    await expect(primary.getByRole("button", { name: globalDestination, exact: true })).toHaveAttribute("data-scope", "global");
  }

  await selectProfile(page, "Research", "research");
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
  const betaUrl = page.url();
  const betaSessionId = betaUrl.split("#chat/")[1]!;
  await page.evaluate((sessionId) => {
    const scope = window as typeof window & { __airshipSessionProfiles?: Record<string, string> };
    scope.__airshipSessionProfiles = { ...scope.__airshipSessionProfiles, [sessionId]: "research" };
  }, betaSessionId);
  expect(betaUrl).not.toBe(alphaUrl);
  await expect(composer).toHaveValue("");

  // Exact IDs are not cross-Profile capabilities. The local command may fork
  // an older conversation owned by Research, but it cannot use General as a
  // confused-deputy source or activate a General-manifest child under B.
  await composer.fill(`/sessions fork ${alphaSessionId}`);
  await composer.press("Enter");
  /*
   * Scoped to the card a person reads. A failed local command is now also
   * announced once through a polite `sr-only` region — the Atlas found screen
   * readers heard nothing at exactly the moments that mattered — so the same
   * sentence legitimately exists twice, seen and heard. Both are asserted:
   * dropping the announcement to satisfy a locator would take the fix away.
   */
  await expect(page.getByLabel("Airship message — failed turn").getByText(/belongs to another Profile.*fork/u))
    .toBeVisible();
  await expect(page.locator("[role=status].sr-only").filter({ hasText: /belongs to another Profile/u }))
    .toHaveCount(1);
  await expect(page).toHaveURL(betaUrl);
  await expect(shell).toHaveAttribute("data-active-profile", "research");
  await expect(shell).toHaveAttribute("data-session-profile", "research");

  await composer.fill(BETA_DRAFT);
  await page.waitForTimeout(220);

  await expandConversations(page);
  const betaTree = primary.getByRole("group", { name: "Profile conversations" });
  await expect(betaTree).toContainText("Research conversations");
  await expect(betaTree).not.toContainText(ALPHA_TITLE);
  await assertConversationSearch(page, ALPHA_TITLE, false, "Research");

  await openPrimary(page, "Workspace");
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  /*
   * Research does not hold a different *selection* over General's repository —
   * it holds its own. Its namespace was seeded with its own initial commit, so
   * the linked worktree General created a moment ago does not exist here at
   * all. The worktree selector renders only for a repository with more than one
   * worktree, so its absence is the observable form of that: there is nothing
   * to choose between, because General's branch is not in this object database.
   */
  const betaActivity = page.getByRole("complementary", { name: "Workspace activity" });
  await expect(betaActivity.getByRole("button", { name: "Workspace repository" })).toContainText("Airship Workspace");
  await expect(betaActivity).toContainText("main");
  await expect(page.getByRole("button", { name: "Workspace worktree" })).toHaveCount(0);
  await expect(betaActivity).not.toContainText(ALPHA_BRANCH);
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await expect(page.getByRole("tab", { name: /README\.md/u })).toHaveCount(0);
  await page.getByRole("treeitem", { name: /architecture\.md/u }).click();
  await page.getByRole("textbox", { name: "Edit architecture.md" }).fill("Beta unsaved workspace draft.\n");

  await openPrimary(page, "Terminal");
  const betaTabs = page.getByRole("tablist", { name: "Terminal tabs" });
  await expect(betaTabs.getByRole("tab")).toHaveCount(1);
  await expect(betaTabs).not.toContainText("Alpha primary");
  await expect(betaTabs).not.toContainText("Alpha selected");
  await renameTerminal(page, "Terminal 1", "Beta primary");

  await openPrimary(page, "Memory");
  const betaQuery = page.getByRole("searchbox", { name: "Search every memory surface" });
  await expect(betaQuery).toHaveValue("");
  await expect.poll(() => page.locator("#memory-index").evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
  await betaQuery.fill(BETA_MEMORY_QUERY);

  await openPrimary(page, "Proof");
  await expectProofSession(page, betaSessionId);
  await expect(page.getByText(alphaSessionId, { exact: true })).toHaveCount(0);

  // A copied Proof UUID is likewise only an address, not authorization. Until
  // ownership is verified the route renders B's safe fallback; a General ID
  // is then canonicalized away without exposing its audit/session metadata.
  await page.evaluate((sessionId) => {
    window.location.hash = `proof?session=${encodeURIComponent(sessionId)}`;
  }, alphaSessionId);
  await expect(page).toHaveURL(new RegExp(`#proof\\?session=${betaSessionId}$`, "u"));
  await expectProofSession(page, betaSessionId);
  await expect(page.getByText(alphaSessionId, { exact: true })).toHaveCount(0);

  // The same global service pages remain mounted from one global authority;
  // changing Profile never creates a profile-local copy or alters their scope.
  await openPrimary(page, "Vault");
  await expect(page.getByRole("heading", { name: "Vault", level: 1 })).toBeVisible();
  await openPrimary(page, "Connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  await openPrimary(page, "Account");
  await expect(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();

  await selectProfile(page, "General", "general");
  await expect(page).toHaveURL(alphaUrl);
  await expect(composer).toHaveValue(ALPHA_DRAFT);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(4);

  await expandConversations(page);
  const alphaTree = primary.getByRole("group", { name: "Profile conversations" });
  await expect(alphaTree.getByRole("button", { name: `Remove from favorites ${ALPHA_TITLE}` })).toBeVisible();
  await expect(alphaTree).not.toContainText("Research conversation");
  await assertConversationSearch(page, ALPHA_TITLE, true, "General");

  await openPrimary(page, "Workspace");
  await expect(page.getByRole("tab", { name: /README\.md, Unsaved/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "Edit README.md" })).toHaveValue("Alpha unsaved workspace draft.\n");
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await expect(page.getByRole("button", { name: "Workspace worktree" })).toContainText(new RegExp(`${ALPHA_BRANCH}.*${ALPHA_WORKTREE}`, "u"));

  await openPrimary(page, "Terminal");
  const restoredAlphaTabs = page.getByRole("tablist", { name: "Terminal tabs" });
  await expect(restoredAlphaTabs.getByRole("tab")).toHaveCount(2);
  await expect(restoredAlphaTabs).toContainText("Alpha primary");
  await expect(restoredAlphaTabs.getByRole("tab", { name: /Alpha selected/u })).toHaveAttribute("aria-selected", "true");
  await expect(restoredAlphaTabs).not.toContainText("Beta primary");

  await openPrimary(page, "Memory");
  await expect(page.getByRole("searchbox", { name: "Search every memory surface" })).toHaveValue(ALPHA_MEMORY_QUERY);
  await expect.poll(() => page.locator("#memory-index").evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);

  await openPrimary(page, "Proof");
  await expectProofSession(page, alphaSessionId);
  await expect(page.getByText(betaSessionId, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __airshipProfileLeaks?: string[] }).__airshipProfileLeaks ?? []))
    .toEqual([]);
  const crossViewportValues = await page.evaluate((keys) => keys.map((key) => sessionStorage.getItem(key)), [
    threadViewportStorageKey("general", betaSessionId),
    threadViewportStorageKey("research", alphaSessionId),
  ]);
  expect(crossViewportValues).toEqual([null, null]);
});

/*
 * Converges on open instead of clicking the disclosure once and asserting.
 *
 * The Memory route opens this section itself the first time a query settles
 * (`src/ui/memory-view.tsx:692-695`). The single unconditional click this
 * replaces won every workstation run and lost on the integration gate of run
 * 30851082563: it arrived after the auto-open, *closed* the section, and
 * `openIndex(false)` latches `indexDismissed` (`src/ui/memory-view.tsx:729-733`),
 * so nothing re-opened it. The poll then had nothing to wait for and failed all
 * three attempts.
 *
 * That is why raising the global `expect` budget from 5s to 15s did not fix
 * this. The wait was not short; the thing being waited for had already been
 * cancelled by the test itself. A race does not become correct by being given
 * more time.
 *
 * `conversation-navigation.spec.ts:670` already converges here for the same
 * reason. `live-semantic-embedding.spec.ts:114` still reads once and clicks
 * once; it is excluded from this matrix (`playwright.config.ts:9-14`) so it
 * cannot redden this gate, and belongs to the lane that owns it.
 */
async function openMemoryIndex(page: Page): Promise<void> {
  const index = page.locator("#memory-index");
  const isOpen = () => index.evaluate((element: HTMLDetailsElement) => element.open);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isOpen()) return;
    await index.locator("summary").click();
    // Long enough for the route's own open to land and be observed, so the next
    // attempt cannot fight a toggle that is still in flight.
    await page.waitForTimeout(150);
  }
  await expect.poll(isOpen, { timeout: 10_000 }).toBe(true);
}

async function openPrimary(page: Page, name: string): Promise<void> {
  const primary = page.getByRole("navigation", { name: "Primary" });
  let target = primary.getByRole("button", { name, exact: true });
  if ((name === "Terminal" || name === "Editor") && await target.count() === 0) {
    await primary.getByRole("button", { name: "Expand Workspace" }).click();
    target = primary.getByRole("button", { name, exact: true });
  }
  await target.click();
}

async function selectProfile(page: Page, name: string, profileId: string): Promise<void> {
  await page.locator(".sidebar .profile-menu").getByRole("button", { name: "Agent profile" }).click();
  await page.getByRole("listbox", { name: "Agent profile" }).getByRole("option", { name, exact: true }).click();
  const shell = page.locator(".app-shell");
  await expect(shell).toHaveAttribute("data-active-profile", profileId);
  await expect(shell).toHaveAttribute("data-session-profile", profileId);
  await expect(page.locator(".profile-cockpit-transition")).toHaveCount(0);
}

async function renameConversation(page: Page, title: string): Promise<void> {
  await page.locator(".session-bar__identity-button").dblclick();
  const input = page.getByRole("textbox", { name: "Conversation title" });
  await input.fill(title);
  await input.press("Enter");
  await expect(page.locator(".session-bar__title")).toHaveText(title);
}

async function createScrollableTranscript(page: Page): Promise<void> {
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  const assistants = page.locator('[data-transcript-card][data-message-role="assistant"]');
  let assistantCount = await assistants.count();
  for (let index = 1; index <= 5; index += 1) {
    await composer.fill(`Profile silo transcript turn ${String(index)}. Explain isolation with enough detail to keep this historical turn visible.`);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => assistants.count()).toBeGreaterThan(assistantCount);
    assistantCount = await assistants.count();
    await expect(composer).toHaveValue("");
  }
}

async function expandConversations(page: Page): Promise<void> {
  const primary = page.getByRole("navigation", { name: "Primary" });
  const expand = primary.getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
  await expect(primary.getByRole("group", { name: "Profile conversations" })).toBeVisible();
}

async function favoriteActiveConversation(page: Page, title: string): Promise<void> {
  await expandConversations(page);
  const tree = page.getByRole("navigation", { name: "Primary" }).getByRole("group", { name: "Profile conversations" });
  await tree.getByRole("button", { name: `Add to favorites ${title}` }).click();
  await expect(tree.getByRole("button", { name: `Remove from favorites ${title}` })).toBeVisible();
}

async function assertConversationSearch(page: Page, query: string, expected: boolean, profileName: string): Promise<void> {
  await openPrimary(page, "Chat");
  await expandConversations(page);
  await page.getByRole("group", { name: "Profile conversations" }).getByRole("button", { name: "All conversations" }).click();
  await expect(page.locator(".session-library-profile-scope")).toHaveText(`Profile · ${profileName}`);
  await page.getByRole("searchbox", { name: "Search titles, models and profiles" }).fill(query);
  if (expected) await expect(page.getByRole("button", { name: new RegExp(query, "u") }).first()).toBeVisible();
  else await expect(page.getByText(`No conversation matches “${query}”`, { exact: true })).toBeVisible();
}

async function createAndSelectAlphaWorktree(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /Source Control/u }).click();
  await page.getByRole("button", { name: "Advanced source controls" }).click();
  const dialog = page.getByRole("dialog", { name: "Advanced source controls" });
  const repositoryControls = dialog.locator("details.git-repository-controls");
  if (!(await repositoryControls.evaluate((element: HTMLDetailsElement) => element.open))) {
    await repositoryControls.locator("summary").click();
  }
  await repositoryControls.getByLabel("New branch").fill(ALPHA_BRANCH);
  await repositoryControls.getByRole("button", { name: "Create branch" }).click();
  await approveIfNeeded(page, /git_branch-create/u);
  await expect(dialog.getByText(`Created local branch ${ALPHA_BRANCH}.`)).toBeVisible();
  await repositoryControls.getByLabel("Worktree branch").fill(ALPHA_BRANCH);
  await repositoryControls.getByLabel("Workspace path").fill(ALPHA_WORKTREE);
  await repositoryControls.getByRole("button", { name: "Create worktree" }).click();
  await approveIfNeeded(page, /git_worktree-create/u);
  await expect(dialog.getByText(`Created worktree for ${ALPHA_BRANCH}.`)).toBeVisible();
  await dialog.getByRole("button", { name: "Close advanced source controls" }).click();

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const worktree = page.getByRole("button", { name: "Workspace worktree" });
  await worktree.click();
  await page.getByRole("listbox", { name: "Workspace worktree" }).getByRole("option", { name: new RegExp(ALPHA_BRANCH, "u") }).click();
  await expect(worktree).toContainText(new RegExp(`${ALPHA_BRANCH}.*${ALPHA_WORKTREE}`, "u"));
}

async function approveIfNeeded(page: Page, operation: RegExp): Promise<void> {
  const approval = page.getByRole("dialog", { name: new RegExp(`Allow ${operation.source} once`, "u") });
  if (await approval.isVisible()) await approval.getByRole("button", { name: "Allow once" }).click();
}

async function renameTerminal(page: Page, current: string, next: string): Promise<void> {
  const tabs = page.getByRole("tablist", { name: "Terminal tabs" });
  await tabs.getByRole("button", { name: new RegExp(`Rename ${current}`, "u") }).click();
  const input = page.getByRole("textbox", { name: `Rename ${current}` });
  await input.fill(next);
  await input.press("Enter");
  await expect(tabs.getByRole("tab", { name: new RegExp(next, "u") })).toBeVisible();
}

async function expectProofSession(page: Page, sessionId: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Proof", level: 1 })).toBeVisible();
  const journal = page.locator("details.proof-journal");
  const summary = journal.locator(":scope > summary");
  await expect(summary).toContainText(/structure passed|invalid/u);
  if (!(await journal.evaluate((element: HTMLDetailsElement) => element.open))) {
    await summary.click();
  }
  const commitment = page.locator(".audit-commitment");
  await expect(commitment).toContainText(sessionId);
  await expect(commitment.getByText(sessionId, { exact: true })).toBeVisible();
}
