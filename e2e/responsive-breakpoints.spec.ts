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

test("a cold conversation-history URL remains authoritative while its deferred view loads", async ({ page }) => {
  await page.goto("/#sessions");
  await expect(page).toHaveURL(/#sessions$/u);
  await expect(page.getByRole("main").getByRole("heading", { name: "All conversations", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#sessions$/u);
});

test("the chat shell stays slim and non-overlapping on narrow and iPhone-class screens", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile geometry contract");
  for (const viewport of [{ width: 320, height: 700 }, { width: 430, height: 932 }] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/#chat");
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect a model", exact: true })).toBeVisible();
    await expect(page.locator(".stage-header")).toBeVisible();
    await expect(page.getByRole("button", { name: /Session\./i })).toBeVisible();
    await page.getByRole("combobox", { name: "Message Airship" }).evaluate((element) => element.blur());
    const geometry = await page.evaluate(() => {
      const top = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>(".stage-header")?.getBoundingClientRect();
      const details = document.querySelector<HTMLElement>(".mobile-session-details")?.getBoundingClientRect();
      const nav = document.querySelector<HTMLElement>(".mobile-nav")?.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>(".composer")?.getBoundingClientRect();
      const approval = document.querySelector<HTMLElement>('[aria-label="Conversation approval policy"]')?.getBoundingClientRect();
      return top && stage && details && nav && composer && approval ? {
        overflow: document.documentElement.scrollWidth - innerWidth,
        topHeight: top.height,
        stageHeight: stage.height,
        stageTop: stage.top,
        topBottom: top.bottom,
        detailsRight: details.right,
        navRight: nav.right,
        composerHeight: composer.height,
        approvalX: approval.x,
        approvalY: approval.y,
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

    // Chrome budget: the conversation, not the session card and guidance
    // banner, must own the majority of a phone's first screen.
    const budget = await page.evaluate(() => {
      const height = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element && getComputedStyle(element).display !== "none" ? element.getBoundingClientRect().height : 0;
      };
      return {
        transcript: height(".transcript"),
        aboveTranscript: height(".topbar") + height(".stage-header") + height(".chat-live-guidance"),
        viewport: innerHeight,
      };
    });
    expect(budget.aboveTranscript, `${viewport.width}px chrome above the transcript`).toBeLessThanOrEqual(viewport.height * 0.3);
    expect(budget.transcript, `${viewport.width}px transcript share`).toBeGreaterThan(viewport.height * 0.5);

    await page.getByRole("combobox", { name: "Message Airship" }).focus();
    const focused = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect();
      const approval = document.querySelector<HTMLElement>('[aria-label="Conversation approval policy"]')!.getBoundingClientRect();
      return { composerHeight: composer.height, approvalX: approval.x, approvalY: approval.y };
    });
    expect(Math.abs(focused.composerHeight - geometry!.composerHeight)).toBeLessThanOrEqual(1);
    expect(Math.abs(focused.approvalX - geometry!.approvalX)).toBeLessThanOrEqual(1);
    expect(Math.abs(focused.approvalY - geometry!.approvalY)).toBeLessThanOrEqual(1);
  }
});

test("short phone landscapes keep a bounded transcript and never autofocus or overlap the composer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile landscape geometry contract");
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));

  for (const viewport of [{ width: 932, height: 430 }, { width: 667, height: 375 }] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`/?landscapeWidth=${String(viewport.width)}#chat`);
    const textarea = page.getByRole("combobox", { name: "Message Airship" });
    const approval = page.getByRole("button", { name: "Conversation approval policy" });
    await expect(textarea).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    await expect(page.getByRole("button", { name: /Session\. Ephemeral · this page only\./u })).toBeVisible();
    await expect(textarea).not.toBeFocused();

    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return undefined;
        const { x, y, width, height, top, right, bottom, left } = element.getBoundingClientRect();
        return { x, y, width, height, top, right, bottom, left };
      };
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        main: bounds(".main"),
        stage: bounds(".chat-stage"),
        header: bounds(".stage-header"),
        guidance: bounds(".chat-live-guidance"),
        transcript: bounds(".transcript"),
        composerWrap: bounds(".composer-wrap"),
        composer: bounds(".composer"),
        approval: bounds('[aria-label="Conversation approval policy"]'),
        attachment: bounds(".composer-attach"),
        nav: bounds(".mobile-nav"),
      };
    });

    expect(geometry.overflow, `${viewport.width}×${viewport.height} document overflow`).toBeLessThanOrEqual(1);
    expect(geometry.main).toBeDefined();
    expect(geometry.stage).toBeDefined();
    expect(geometry.header).toBeDefined();
    expect(geometry.guidance).toBeDefined();
    expect(geometry.transcript).toBeDefined();
    expect(geometry.composerWrap).toBeDefined();
    expect(geometry.composer).toBeDefined();
    expect(geometry.approval).toBeDefined();
    expect(geometry.attachment).toBeDefined();
    expect(geometry.nav).toBeDefined();
    expect(geometry.transcript!.height, `${viewport.width}×${viewport.height} transcript height`).toBeGreaterThanOrEqual(120);
    expect(geometry.header!.height + geometry.guidance!.height, `${viewport.width}×${viewport.height} chat chrome`).toBeLessThanOrEqual(74);
    expect(geometry.transcript!.bottom).toBeLessThanOrEqual(geometry.composerWrap!.top + 1);
    expect(geometry.composerWrap!.bottom).toBeLessThanOrEqual(geometry.main!.bottom + 1);
    expect(geometry.main!.bottom).toBeLessThanOrEqual(geometry.nav!.top + 1);
    expect(geometry.composer!.left).toBeGreaterThanOrEqual(geometry.stage!.left);
    expect(geometry.composer!.right).toBeLessThanOrEqual(geometry.stage!.right + 1);
    expect(geometry.approval!.height).toBeGreaterThanOrEqual(44);
    expect(geometry.attachment!.height).toBeGreaterThanOrEqual(44);

    await textarea.focus();
    await textarea.fill("Plan");
    const focused = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect();
      const approvalControl = document.querySelector<HTMLElement>('[aria-label="Conversation approval policy"]')!.getBoundingClientRect();
      return {
        composerHeight: composer.height,
        composerBottom: composer.bottom,
        approvalX: approvalControl.x,
        approvalY: approvalControl.y,
      };
    });
    expect(Math.abs(focused.composerHeight - geometry.composer!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(focused.approvalX - geometry.approval!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(focused.approvalY - geometry.approval!.y)).toBeLessThanOrEqual(1);
    expect(focused.composerBottom).toBeLessThanOrEqual(geometry.main!.bottom + 1);
  }
});

test("the left rail advertises its own overflow only while content is hidden", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop rail geometry contract");
  await page.goto("/#chat");
  const rail = page.locator(".primary-nav");
  await expect(rail).toBeVisible();

  for (const height of [700, 800, 900, 1_080] as const) {
    await page.setViewportSize({ width: 1_440, height });
    // The affordance is measured, not assumed: whatever the rail's real
    // overflow is at this height, the painted state has to agree with it.
    await expect
      .poll(async () => rail.evaluate((element) => {
        const scrollable = element.scrollHeight - element.clientHeight > 1;
        return element.dataset.scrollEdges === (scrollable ? "end" : "none");
      }), { message: `rail affordance settles at ${height}px` })
      .toBe(true);

    const state = await rail.evaluate((element) => ({
      scrollable: element.scrollHeight - element.clientHeight > 1,
      edges: element.dataset.scrollEdges,
      masked: getComputedStyle(element).maskImage !== "none",
      dividerShown: (() => {
        const divider = document.querySelector<HTMLElement>(".sidebar-spacer");
        return divider ? getComputedStyle(divider).display !== "none" : false;
      })(),
    }));
    if (state.scrollable) {
      expect(state.edges, `${height}px rail hides content`).toBe("end");
      expect(state.masked, `${height}px rail paints an edge fade`).toBe(true);
      expect(state.dividerShown, `${height}px pinned profile card is bounded`).toBe(true);
    } else {
      expect(state.edges, `${height}px rail fits`).toBe("none");
      expect(state.masked, `${height}px rail must not fake an overflow`).toBe(false);
      expect(state.dividerShown, `${height}px rail needs no pinned divider`).toBe(false);
    }
  }

  await page.setViewportSize({ width: 1_440, height: 800 });
  await rail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => rail.evaluate((element) => element.dataset.scrollEdges)).toBe("start");
  await rail.evaluate((element) => { element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2); });
  await expect.poll(async () => rail.evaluate((element) => element.dataset.scrollEdges)).toBe("both");
  await page.screenshot({ path: testInfo.outputPath("rail-scroll-affordance.png"), animations: "disabled" });
});

test("an empty conversation centres its zero state without ever clipping it", async ({ page }) => {
  const readTranscript = () => page.locator(".transcript").evaluate((element) => {
    const first = element.firstElementChild as HTMLElement | null;
    const box = element.getBoundingClientRect();
    return {
      centred: element.classList.contains("no-turns"),
      firstOffsetTop: first?.offsetTop ?? -1,
      firstTopWithin: first ? first.getBoundingClientRect().top - box.top : -1,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
  });

  // Tall desktop: the zero state fits, so it is genuinely centred.
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto("/#chat");
  await expect(page.locator(".transcript.no-turns")).toBeVisible();
  const tall = await readTranscript();
  expect(tall.centred).toBe(true);
  expect(tall.firstTopWithin, "the welcome card leaves the top of the transcript").toBeGreaterThan(120);

  // Short and phone-class viewports overflow. `safe center` must fall back to
  // start alignment; bare `center` puts the first card at a negative offset a
  // scroll container can never reach.
  for (const viewport of [{ width: 1_100, height: 520 }, { width: 390, height: 844 }] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/#chat");
    await expect(page.locator(".transcript.no-turns")).toBeVisible();
    const short = await readTranscript();
    expect(short.firstTopWithin, `${viewport.width}x${viewport.height} first card is reachable`).toBeGreaterThanOrEqual(-1);
    expect(short.firstOffsetTop, `${viewport.width}x${viewport.height} first card offset`).toBeGreaterThanOrEqual(0);
  }
});

test("the composer is two tab stops from the start of the document", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "skip links are a pointer-free desktop path");
  await page.goto("/#chat");
  await expect(page.locator(".app-shell")).toBeVisible();
  const describeFocus = () => page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      tag: active?.tagName ?? "",
      label: active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? "",
      visible: active ? active.getBoundingClientRect().height : 0,
    };
  });

  // The shell claims the composer at mount, so the common case is zero stops.
  expect((await describeFocus()).label).toBe("Message Airship");

  // Reset to a document with no prior focus. `blur()` alone is not enough:
  // Chromium keeps the sequential-navigation starting point at the element
  // that was blurred, so Tab would resume mid-document instead of at the top.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press("Tab");
  const first = await describeFocus();
  expect(first.label).toBe("Skip to conversation");
  // A skip control the user cannot see is not an affordance.
  expect(first.visible).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Tab");
  expect((await describeFocus()).label).toBe("Skip to composer");
  await page.keyboard.press("Enter");
  expect((await describeFocus()).label).toBe("Message Airship");
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

        const geometry = await page.evaluate((routeHash) => {
          const main = document.querySelector<HTMLElement>("main.main");
          const heading = main?.querySelector<HTMLElement>("h1, .stage-header h1");
          const mobileNav = document.querySelector<HTMLElement>(".mobile-navigation");
          const topbar = document.querySelector<HTMLElement>(".topbar");
          if (!main || !heading || !topbar) return undefined;
          const mainBox = main.getBoundingClientRect();
          const routeAnchor = routeHash === "context"
            ? main.querySelector<HTMLElement>("#memory-index > summary") ?? heading
            : heading;
          const headingBox = routeAnchor.getBoundingClientRect();
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
        }, hash);
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
