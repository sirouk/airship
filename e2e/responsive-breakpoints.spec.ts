import { expect, test, type Page } from "@playwright/test";

const routes = [
  ["chat", /.+/], ["sessions", /^All conversations$/i], ["workspace", /^Editor$/i],
  ["editor", /^Editor$/i], ["terminal", /^Terminal$/i], ["memory", /^Memory$/i], ["context", /^Memory$/i],
  ["profiles", /^Profiles$/i], ["capabilities", /^Capabilities$/i], ["skills", /^Skills$/i],
  ["proof", /^Proof$/i], ["vault", /^Vault$/i],
  ["connection", /^Connect models$/i], ["account", /^Account standing$/i],
] as const;

const widths = [768, 820, 1024] as const;
const densities = ["comfortable", "compact"] as const;

test("the chat shell stays slim and non-overlapping on narrow and iPhone-class screens", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile geometry contract");
  for (const viewport of [{ width: 320, height: 700 }, { width: 430, height: 932 }] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/#chat");
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await expect(page.locator(".stage-header")).toBeVisible();
    await expect(page.getByRole("button", { name: /Session\./i })).toBeVisible();
    await page.getByRole("combobox", { name: "Message Airship" }).evaluate((element) => element.blur());
    await expect(page.locator(".composer")).not.toHaveClass(/composer--expanded/u);
    const geometry = await page.evaluate(() => {
      const top = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>(".stage-header")?.getBoundingClientRect();
      const details = document.querySelector<HTMLElement>(".mobile-session-details")?.getBoundingClientRect();
      const nav = document.querySelector<HTMLElement>(".mobile-nav")?.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>(".composer")?.getBoundingClientRect();
      return top && stage && details && nav && composer ? {
        overflow: document.documentElement.scrollWidth - innerWidth,
        topHeight: top.height,
        stageHeight: stage.height,
        stageTop: stage.top,
        topBottom: top.bottom,
        detailsRight: details.right,
        navRight: nav.right,
        composerHeight: composer.height,
        viewportWidth: innerWidth,
      } : undefined;
    });
    expect(geometry).toBeDefined();
    expect(geometry!.overflow).toBeLessThanOrEqual(1);
    expect(geometry!.topHeight).toBeLessThanOrEqual(68);
    expect(geometry!.stageHeight).toBeLessThan(viewport.height * 0.18);
    expect(geometry!.stageTop).toBeGreaterThanOrEqual(geometry!.topBottom - 1);
    expect(geometry!.detailsRight).toBeLessThanOrEqual(geometry!.viewportWidth + 1);
    expect(geometry!.navRight).toBeLessThanOrEqual(geometry!.viewportWidth + 1);
    expect(geometry!.composerHeight).toBeLessThanOrEqual(60);
    await page.getByRole("combobox", { name: "Message Airship" }).focus();
    const focusedComposerHeight = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().height);
    expect(focusedComposerHeight).toBeGreaterThan(geometry!.composerHeight + 20);
  }
});

test("mobile workspace and terminal controls preserve their content lanes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile work surface geometry contract");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#workspace");
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();

  const workspaceHeading = await page.locator(".workspace-heading").evaluate((heading) => {
    const copy = heading.querySelector<HTMLElement>("p")!.getBoundingClientRect();
    const status = heading.querySelector<HTMLElement>(".durability-indicator")!.getBoundingClientRect();
    const box = heading.getBoundingClientRect();
    return {
      copyWidth: copy.width,
      headingWidth: box.width,
      statusTop: status.top,
      copyBottom: copy.bottom,
      statusRight: status.right,
      headingRight: box.right,
    };
  });
  expect(workspaceHeading.copyWidth).toBeGreaterThan(workspaceHeading.headingWidth * .9);
  expect(workspaceHeading.statusTop).toBeGreaterThanOrEqual(workspaceHeading.copyBottom - 1);
  expect(workspaceHeading.statusRight).toBeLessThanOrEqual(workspaceHeading.headingRight + 1);

  const architecture = page.getByRole("treeitem", { name: /architecture\.md/u });
  const architectureRow = architecture.locator("xpath=..");
  const treeGeometry = await architectureRow.evaluate((row) => {
    const metadata = row.querySelector<HTMLElement>(".tree-row small")!.getBoundingClientRect();
    const action = row.querySelector<HTMLElement>(".tree-overflow")!.getBoundingClientRect();
    return { metadataRight: metadata.right, actionLeft: action.left, actionWidth: action.width };
  });
  expect(treeGeometry.metadataRight).toBeLessThanOrEqual(treeGeometry.actionLeft + 1);
  expect(treeGeometry.actionWidth).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("mobile-workspace-content-lanes.png"), animations: "disabled" });

  await page.goto("/#terminal");
  await expect(page.getByRole("heading", { name: "Terminal", level: 1 })).toBeVisible();
  const terminalControls = await page.locator(".terminal-route__actions button").evaluateAll((buttons) => buttons.map((button) => ({
    height: button.getBoundingClientRect().height,
    overflow: button.scrollHeight - button.clientHeight,
  })));
  expect(terminalControls).toHaveLength(2);
  for (const control of terminalControls) {
    expect(control.height).toBeLessThanOrEqual(44);
    expect(control.overflow).toBeLessThanOrEqual(1);
  }
  const setup = page.locator(".terminal-route__setup > summary");
  await expect(setup).toBeVisible();
  const setupGeometry = await setup.evaluate((summary) => {
    const label = summary.querySelector<HTMLElement>("span")!.getBoundingClientRect();
    const detail = summary.querySelector<HTMLElement>("small")!.getBoundingClientRect();
    return { labelBottom: label.bottom, detailTop: detail.top, overflow: summary.scrollWidth - summary.clientWidth };
  });
  expect(setupGeometry.detailTop).toBeGreaterThanOrEqual(setupGeometry.labelBottom - 1);
  expect(setupGeometry.overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("mobile-terminal-content-lanes.png"), animations: "disabled" });
});

for (const density of densities) {
  test(`${density} layout remains coherent at tablet and small-laptop breakpoints`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "controlled viewport geometry uses the desktop browser context");
    test.setTimeout(120_000);
    await page.addInitScript((selectedDensity) => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark", typeScale: "default", density: selectedDensity, corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "ask-first",
    })), density);

    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const [hash, headingName] of routes) {
        await page.goto(`/#${hash}`);
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { name: headingName }).first()).toBeVisible({ timeout: 10_000 });
        await expect(page.locator("html")).toHaveAttribute("data-density", density);

        const geometry = await page.evaluate(() => {
          const main = document.querySelector<HTMLElement>("main.main");
          const heading = main?.querySelector<HTMLElement>("h1, .stage-header h1");
          const mobileNav = document.querySelector<HTMLElement>(".mobile-navigation");
          const topbar = document.querySelector<HTMLElement>(".topbar");
          if (!main || !heading || !topbar) return undefined;
          const mainBox = main.getBoundingClientRect();
          const headingBox = heading.getBoundingClientRect();
          const topbarBox = topbar.getBoundingClientRect();
          const mobileBox = mobileNav && getComputedStyle(mobileNav).display !== "none" ? mobileNav.getBoundingClientRect() : undefined;
          return {
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
            mainOverflow: main.scrollWidth - main.clientWidth,
            headingLeft: headingBox.left,
            headingRight: headingBox.right,
            headingTop: headingBox.top,
            topbarBottom: topbarBox.bottom,
            mobileTop: mobileBox?.top,
            mainLeft: mainBox.left,
            viewportWidth: innerWidth,
            rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          };
        });
        expect(geometry, `${width}px ${hash} rendered measurable geometry`).toBeDefined();
        expect(geometry!.documentOverflow, `${width}px ${hash} document overflow`).toBeLessThanOrEqual(1);
        expect(geometry!.mainOverflow, `${width}px ${hash} main overflow`).toBeLessThanOrEqual(1);
        expect(geometry!.headingLeft, `${width}px ${hash} heading left`).toBeGreaterThanOrEqual(geometry!.mainLeft - 1);
        expect(geometry!.headingRight, `${width}px ${hash} heading right`).toBeLessThanOrEqual(width + 1);
        expect(geometry!.headingTop, `${width}px ${hash} heading below topbar`).toBeGreaterThanOrEqual(geometry!.topbarBottom - 1);
        if (geometry!.mobileTop !== undefined) expect(geometry!.mobileTop).toBeGreaterThan(100);
        if (density === "comfortable") expect(geometry!.rootFont).toBeGreaterThanOrEqual(17);
        else expect(geometry!.rootFont).toBeLessThan(17);

        if (width <= 820) {
          const rail = page.locator(".sidebar");
          await expect(rail).toBeVisible();
          const railWidth = await rail.evaluate((element) => element.getBoundingClientRect().width);
          expect(railWidth).toBeGreaterThanOrEqual(100);
          await expect(rail.locator("#airship-recent-conversations")).toBeHidden();
          await expect(rail.locator("#airship-profile-navigation")).toBeHidden();
        }

        if (["proof", "vault", "connection", "account"].includes(hash)) {
          const activeTab = main.getByRole("navigation", { name: "Trust hub" }).locator("button[aria-current='page']");
          await expect(activeTab).toBeInViewport();
          const tabBox = await activeTab.boundingBox();
          expect(tabBox).not.toBeNull();
          expect(tabBox!.x).toBeGreaterThanOrEqual(-1);
          expect(tabBox!.x + tabBox!.width).toBeLessThanOrEqual(width + 1);
        }
      }

      for (const hash of ["chat", "workspace", "editor", "profiles", "proof?section=attestations", "connection"] as const) {
        await page.goto(`/#${hash}`);
        await page.screenshot({ path: testInfo.outputPath(`${density}-${width}-${hash}.png`), animations: "disabled" });
      }
    }
  });
}

test("styled menus stay anchored and usable at intermediate widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "controlled viewport menu contract");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#sessions");
    const provider = page.getByRole("button", { name: "Filter by provider" });
    await provider.click();
    const menu = page.getByRole("listbox", { name: "Filter by provider" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.keyboard.press("Escape");
  }
});

for (const density of densities) {
  test(`${density} short desktop keeps profile pinned while navigation scrolls`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "desktop sidebar contract");
    await page.addInitScript((selectedDensity) => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark", typeScale: "default", density: selectedDensity, corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "ask-first",
    })), density);
    await page.setViewportSize({ width: 1_024, height: 560 });
    await page.goto("/#chat");
    const sidebar = page.locator(".sidebar");
    const navigation = sidebar.getByRole("navigation", { name: "Primary" });
    const profile = sidebar.locator(".profile-switcher");
    await expect(profile).toBeVisible();
    const initial = await Promise.all([sidebar.boundingBox(), navigation.boundingBox(), profile.boundingBox()]);
    expect(initial.every(Boolean)).toBe(true);
    expect(initial[2]!.y + initial[2]!.height).toBeLessThanOrEqual(560);
    expect(initial[1]!.y + initial[1]!.height).toBeLessThanOrEqual(initial[2]!.y + 1);

    await navigation.getByRole("button", { name: "Account", exact: true }).click();
    await expect(page).toHaveURL(/#account$/);
    await expect(profile).toBeVisible();
    const after = await profile.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.y + after!.height).toBeLessThanOrEqual(560);

    const picker = profile.getByRole("button", { name: "Agent profile" });
    await picker.click();
    const listbox = page.getByRole("listbox", { name: "Agent profile" });
    await expect(listbox).toBeVisible();
    const listboxBox = await listbox.boundingBox();
    expect(listboxBox).not.toBeNull();
    expect(listboxBox!.y).toBeGreaterThanOrEqual(0);
    expect(listboxBox!.y + listboxBox!.height).toBeLessThanOrEqual(560 + 1);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: testInfo.outputPath(`${density}-short-sidebar.png`), animations: "disabled" });
  });
}

test("profile approval picker exposes all three policies at a constrained viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop profile policy contract");
  await page.setViewportSize({ width: 768, height: 620 });
  await page.goto("/#profiles");
  const boundaries = page.locator("details.profile-editor-disclosure").filter({ hasText: "Profile boundaries" });
  await boundaries.locator("summary").click();
  const picker = boundaries.getByRole("button", { name: "Profile approval policy" });
  for (const option of ["Auto Approve", "Full Access", "Ask First"] as const) {
    await picker.click();
    const listbox = page.getByRole("listbox", { name: "Profile approval policy" });
    await expect(listbox).toBeVisible();
    await listbox.getByRole("option", { name: option, exact: true }).click();
    await expect(picker).toContainText(option);
  }
});
