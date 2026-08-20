import { expect, test, type Page } from "@playwright/test";
import { setProfilePresentationDensity } from "./support/density";
import { waitForShellSettled } from "./support/settled";

const routes = [
  ["chat", /.+/], ["sessions", /^All conversations$/i], ["workspace", /^Workspace$/i],
  ["editor", /^Editor$/i], ["terminal", /^Terminal$/i], ["memory", /^Memory$/i],
  ["context", /^Memory$/i], ["profiles", /^Profiles$/i],
  ["capabilities", /^Capabilities$/i], ["skills", /^Skills$/i], ["vault", /^Vault$/i],
  // Providers currently begins with the provider-fabric section heading.
  ["connection", /^Cloud and local models$/iu],
] as const;

const widths = [768, 820, 1024] as const;
const densities = ["comfortable", "compact"] as const;
const RAIL_DESTINATIONS = ["Chat", "Workspace", "Memory", "Vault", "Providers"] as const;

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
    // The 88px two-column header plus its 42px guidance band are one 48px
    // row now; the selector moves, the "chrome exists and is slim" claim
    // this test makes does not.
    await expect(page.locator(".session-bar")).toBeVisible();
    await expect(page.getByRole("button", { name: /Session\./i })).toBeVisible();
    await page.getByRole("combobox", { name: "Message Airship" }).evaluate((element) => element.blur());
    const geometry = await page.evaluate(() => {
      const top = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>(".session-bar")?.getBoundingClientRect();
      const details = document.querySelector<HTMLElement>(".session-bar__chips")?.getBoundingClientRect();
      const nav = document.querySelector<HTMLElement>(".mobile-nav")?.getBoundingClientRect();
      const main = document.querySelector<HTMLElement>("main.main")?.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>(".composer")?.getBoundingClientRect();
      const approval = document.querySelector<HTMLElement>('.composer-approval-select .menu-select-trigger')?.getBoundingClientRect();
      return top && stage && details && nav && main && composer && approval ? {
        overflow: document.documentElement.scrollWidth - innerWidth,
        topHeight: top.height,
        stageHeight: stage.height,
        stageTop: stage.top,
        topBottom: top.bottom,
        detailsRight: details.right,
        navRight: nav.right,
        navTop: nav.top,
        mainTop: main.top,
        composerBottom: composer.bottom,
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
    // The overlap claim, made where the nav actually renders. It used to live in
    // the desktop breakpoint test against a class no element carries, guarded by
    // the lookup succeeding — so it never once executed. `geometry` is undefined
    // if the nav is missing, and the assertion above already fails on that.
    expect(geometry!.navTop, `${viewport.width}px nav below the main content`).toBeGreaterThanOrEqual(geometry!.mainTop);
    expect(geometry!.navTop, `${viewport.width}px nav clear of the composer`).toBeGreaterThanOrEqual(geometry!.composerBottom - 1);
    // Amended deliberately. A 44px touch row plus a 44px text row cannot fit in
    // 60px, and this same file asserts both of those minimums, so the old cap
    // was arithmetically unsatisfiable once the composer became two rows. The
    // invariant it was really protecting — that the composer never dominates a
    // phone screen — is re-expressed below as a share of the viewport, which is
    // harder to pass than the fixed number it replaces.
    expect(geometry!.composerHeight).toBeLessThanOrEqual(92);
    expect(geometry!.composerHeight).toBeLessThanOrEqual(viewport.height * 0.13);

    // Chrome budget: the conversation, not the session bar, must own the
    // majority of a phone's first screen. The guidance banner that used to be
    // the second term here no longer exists.
    const budget = await page.evaluate(() => {
      const height = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element && getComputedStyle(element).display !== "none" ? element.getBoundingClientRect().height : 0;
      };
      return {
        transcript: height(".transcript"),
        aboveTranscript: height(".topbar") + height(".session-bar"),
        viewport: innerHeight,
      };
    });
    expect(budget.aboveTranscript, `${viewport.width}px chrome above the transcript`).toBeLessThanOrEqual(viewport.height * 0.3);
    expect(budget.transcript, `${viewport.width}px transcript share`).toBeGreaterThan(viewport.height * 0.5);

    await page.getByRole("combobox", { name: "Message Airship" }).focus();
    const focused = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect();
      const approval = document.querySelector<HTMLElement>('.composer-approval-select .menu-select-trigger')!.getBoundingClientRect();
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
    await expect(page.getByRole("button", { name: /Session\. Ephemeral · content not saved\./u })).toBeVisible();
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
        header: bounds(".session-bar"),
        transcript: bounds(".transcript"),
        composerWrap: bounds(".composer-wrap"),
        composer: bounds(".composer"),
        approval: bounds('.composer-approval-select .menu-select-trigger'),
        attachment: bounds(".composer-attach"),
        nav: bounds(".mobile-nav"),
      };
    });

    expect(geometry.overflow, `${viewport.width}×${viewport.height} document overflow`).toBeLessThanOrEqual(1);
    expect(geometry.main).toBeDefined();
    expect(geometry.stage).toBeDefined();
    expect(geometry.header).toBeDefined();
    expect(geometry.transcript).toBeDefined();
    expect(geometry.composerWrap).toBeDefined();
    expect(geometry.composer).toBeDefined();
    expect(geometry.approval).toBeDefined();
    expect(geometry.attachment).toBeDefined();
    expect(geometry.nav).toBeDefined();
    expect(geometry.transcript!.height, `${viewport.width}×${viewport.height} transcript height`).toBeGreaterThanOrEqual(120);
    // Was `header + guidance <= 74`. The band is deleted, so there is no
    // second term; the one row it collapsed into is asserted against the
    // same ceiling, which it now clears by 26px instead of by 0.
    expect(geometry.header!.height, `${viewport.width}×${viewport.height} chat chrome`).toBeLessThanOrEqual(74);
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
      const approvalControl = document.querySelector<HTMLElement>('.composer-approval-select .menu-select-trigger')!.getBoundingClientRect();
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

  // AMENDED (DESIGN_DIRECTION.md §7.2). The mask machinery is kept verbatim
  // and is still correct; what changed is the content it measures. The rail
  // used to hold 785px of destinations plus a 250px conversation scroller and
  // a 310px profile scroller, so it overflowed at every laptop height and the
  // fade fired at 700, 800 and 900. With the conversation list and the profile
  // catalog re-homed into disclosures the content set is ~430px, which fits.
  //
  // Asserting that it *never* fires would delete a working affordance, so this
  // now asserts both halves of the contract: silent wherever the rail fits,
  // and still painting an honest "more below" at a height where it genuinely
  // does not.
  //
  // 700px is the measured floor after the recents list learned to open itself.
  // The list costs about 200px, so it now opens only where the rail can show it
  // AND the Global group (RAIL_RECENTS_AUTO_OPEN_MIN_HEIGHT) — a navigation
  // rail that hides its destinations to advertise a shortcut has made the wrong
  // trade. With it closed the rail's own content is 401px, which needs roughly
  // a 700px window to clear the chrome; below that the fade is telling the
  // truth rather than failing a contract. 480px is the synthetic short window
  // that proves the fade is alive.
  for (const height of [700, 800, 900, 1_080] as const) {
    await page.setViewportSize({ width: 1_440, height });
    await expect
      .poll(async () => rail.evaluate((element) => element.dataset.scrollEdges), {
        message: `rail affordance settles at ${height}px`,
      })
      .toBe("none");

    const state = await rail.evaluate((element) => ({
      overflow: element.scrollHeight - element.clientHeight,
      masked: getComputedStyle(element).maskImage !== "none",
      dividerShown: (() => {
        const divider = document.querySelector<HTMLElement>(".sidebar-spacer");
        return divider ? getComputedStyle(divider).display !== "none" : false;
      })(),
      // Every destination the rail files is inside the painted box, not just
      // inside the scroll extent. This is the invariant the old assertion was
      // a proxy for, asserted directly.
      hidden: [...element.querySelectorAll<HTMLElement>(".nav-item")].filter((item) => {
        const box = item.getBoundingClientRect();
        const railBox = element.getBoundingClientRect();
        return box.bottom > railBox.bottom + 1 || box.top < railBox.top - 1;
      }).map((item) => item.textContent?.trim()),
    }));
    expect(state.overflow, `${height}px rail fits without scrolling`).toBeLessThanOrEqual(1);
    expect(state.masked, `${height}px rail must not fake an overflow`).toBe(false);
    expect(state.dividerShown, `${height}px rail needs no pinned divider`).toBe(false);
    expect(state.hidden, `${height}px rail hides no destination`).toEqual([]);
  }

  // The "end" case uses the current Workspace children to make the short rail
  // genuinely overflow, rather than depending on routes the product removed.
  await page.setViewportSize({ width: 1_440, height: 480 });
  const expandWorkspace = page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Expand Workspace" });
  if (await expandWorkspace.count()) await expandWorkspace.click();
  await expect
    .poll(async () => rail.evaluate((element) => element.dataset.scrollEdges), {
      message: "rail advertises hidden content at 480px",
    })
    .toBe("end");
  const short = await rail.evaluate((element) => ({
    overflow: element.scrollHeight - element.clientHeight,
    masked: getComputedStyle(element).maskImage !== "none",
    dividerShown: getComputedStyle(document.querySelector<HTMLElement>(".sidebar-spacer")!).display !== "none",
  }));
  expect(short.overflow, "480px rail genuinely hides content").toBeGreaterThan(1);
  expect(short.masked, "480px rail paints an edge fade").toBe(true);
  expect(short.dividerShown, "480px pinned profile row is bounded").toBe(true);

  await rail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => rail.evaluate((element) => element.dataset.scrollEdges)).toBe("start");
  await rail.evaluate((element) => { element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2); });
  await expect.poll(async () => rail.evaluate((element) => element.dataset.scrollEdges)).toBe("both");
  await page.screenshot({ path: testInfo.outputPath("rail-scroll-affordance.png"), animations: "disabled" });
});

test("the rail keeps three states, remembers its width, and reaches every filed destination by keyboard", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop rail state contract");
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/#chat");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveAttribute("data-rail-state", "standard");
  /*
   * Readiness before the chord, because `standard` is also what the rail says
   * before anything is listening.
   *
   * The assertion above is satisfied by the pre-hydration shell, so pressing
   * immediately after it can send the chord into a document with no keydown
   * handler attached — the press is simply lost and the rail stays standard.
   * In isolation this file wins the race; run whole, it lost it. The composer
   * is the shell's own signal that the chat route is mounted and interactive.
   */
  await expect(page.getByRole("combobox", { name: "Message Airship" })).toBeVisible({ timeout: 20_000 });
  /*
   * And the shell's effects have actually run.
   *
   * The composer being on screen is a render; the chord needs a `keydown`
   * listener, which a sibling effect registers. `data-rail` on the document
   * element is written by one of those effects, so its presence is the shell
   * saying its effect pass is done — and a chord sent before that is simply
   * discarded, which is how this test failed intermittently with the rail
   * still 232px wide.
   */
  await expect(page.locator("html")).toHaveAttribute("data-rail", /.+/u, { timeout: 20_000 });

  // The chord and the chevron are the same control; the palette entry is the
  // third, because a shortcut nobody can find is a shortcut that does not
  // exist. All three write the same remembered preference.
  await page.keyboard.press("Meta+\\");
  await expect(sidebar).toHaveAttribute("data-rail-state", "rail");
  expect(await sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(60);

  // Collapsed does not mean anonymous: every destination keeps its accessible
  // name, so an icon rail never ships a column of unlabelled glyphs.
  const navigation = page.getByRole("navigation", { name: "Primary" });
  for (const label of RAIL_DESTINATIONS) {
    await expect(navigation.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  // Collapsing owns a closed conversation panel. Wait for that state before
  // testing the mutually exclusive label peek: rendering the 320px conversation
  // panel and the 268px label panel together is explicitly forbidden.
  const recentDisclosure = navigation.locator(".chat-nav-disclosure");
  await expect(recentDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).not.toHaveAttribute("data-recents", "flyout");

  /*
   * Peek is an overlay, not a reflow — and it is not a pointer.
   *
   * AMENDED: this asserted that hovering the collapsed rail widened it to
   * 268px. `cfda29f` withdrew that half on purpose: the rail sits on the path
   * to the composer, it treated every crossing as a request to open, and the
   * judgement was that it "is clunky and jumps around". So hovering must now
   * leave the rail exactly where it is, and the keyboard half is what opens it.
   * The original claim is not dropped — a peek still must not move the
   * conversation — it is now made about the half that still exists.
   *
   * Sampled rather than asserted once, because this is a negative: a single
   * read taken before the 240ms delay and 140ms transition a peek used to run
   * would pass against a rail that was about to open. Eight reads across ~1.2s
   * is the same measurement the commit that withdrew the behaviour recorded.
   */
  const mainBefore = await page.locator("main.main").boundingBox();
  await sidebar.hover();
  const hoverWidths: number[] = [];
  for (let sample = 0; sample < 8; sample += 1) {
    hoverWidths.push(await page.locator(".rail").evaluate((element) => Math.round(element.getBoundingClientRect().width)));
    await page.waitForTimeout(150);
  }
  expect(hoverWidths).toEqual([60, 60, 60, 60, 60, 60, 60, 60]);
  expect((await page.locator("main.main").boundingBox())!.x).toBe(mainBefore!.x);
  await page.mouse.move(900, 500);

  // The keyboard half stays, and it is the overlay the original claim was about:
  // the panel widens over the conversation rather than widening the grid track.
  // Escape leaves the composer for main, and Shift+Tab reaches the rail's last
  // control in document order. This is the product's real keyboard exit and
  // proves keyboard modality instead of manufacturing focus in script.
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("main.main")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const expandRail = page.getByRole("button", { name: "Expand navigation rail" });
  await expect(expandRail).toBeFocused();
  await expect.poll(() => expandRail.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect.poll(async () => (await page.locator(".rail").boundingBox())?.width).toBe(268);
  const mainAfter = await page.locator("main.main").boundingBox();
  expect(mainAfter!.x).toBe(mainBefore!.x);

  await page.reload();
  await expect(page.locator(".sidebar")).toHaveAttribute("data-rail-state", "rail");
  await page.getByRole("button", { name: "Expand navigation rail" }).click();
  await expect(page.locator(".sidebar")).toHaveAttribute("data-rail-state", "standard");
  await page.reload();
  await expect(page.locator(".sidebar")).toHaveAttribute("data-rail-state", "standard");

  // One composite widget: the rail is three tab stops, and the arrows do the
  // walking. Reach is added, never substituted — every row is still a button.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Chat", exact: true }).focus();
  /*
   * Walks until the rail stops moving rather than a fixed eight presses. The
   * row count is not a constant: the recents list opens itself where there is
   * room, and each conversation in it is a row the arrows must pass through.
   * A fixed number of presses reached Providers when the list was closed and
   * stopped short when recents were open — the traversal was working and the
   * counting was failing.
   */
  const walk: (string | null)[] = [];
  let previous: string | null = null;
  for (let index = 0; index < 40; index += 1) {
    const here = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.getAttribute("aria-label") ?? null);
    walk.push(here);
    if (here !== null && here === previous) break;
    previous = here;
    await page.keyboard.press("ArrowDown");
  }
  expect(walk, `arrow traversal reached: ${walk.join(" → ")}`).toContain("Providers");
  expect(walk).toContain("Vault");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Workspace", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Collapse Workspace" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Editor", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Workspace", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("rail-states.png"), animations: "disabled" });
});

test("an empty conversation centres its zero state without ever clipping it", async ({ page }) => {
  /* The first-run zero state — the intro with its offerings — is suggestion
     class: at the minimal house rung the transcript keeps only its
     consequence lines and the `no-turns` centring never applies, so the
     geometry this journey protects is the Balanced transcript's. The test's
     own gotos re-navigate back to #chat at each viewport. */
  await setProfilePresentationDensity(page, "Balanced");
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
  // `.app-shell` is visible in the document the boot reload is about to
  // replace; see `waitForShellSettled` for the three navigations a cold visit
  // makes. Measuring focus before it fails with "Execution context destroyed".
  await waitForShellSettled(page);
  const describeFocus = () => page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      tag: active?.tagName ?? "",
      label: active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? "",
      visible: active ? active.getBoundingClientRect().height : 0,
    };
  });

  // The shell claims the composer at mount, so the common case is zero stops.
  // Polled: the claim happens in an effect after the chat stage mounts, so
  // sampling once could catch `<body>` still holding focus — which is what it
  // did, intermittently, reporting the whole page's text as the focused label.
  await expect.poll(async () => (await describeFocus()).label, { timeout: 20_000 }).toBe("Message Airship");

  // Reset to a document with no prior focus. `blur()` alone is not enough:
  // Chromium keeps the sequential-navigation starting point at the element
  // that was blurred, so Tab would resume mid-document instead of at the top.
  const restartTabbingFromTheTop = () => page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await restartTabbingFromTheTop();
  await page.keyboard.press("Tab");
  const first = await describeFocus();
  expect(first.label).toBe("Skip to conversation");
  // A skip control the user cannot see is not an affordance.
  expect(first.visible).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Tab");
  expect((await describeFocus()).label).toBe("Skip to composer");
  await page.keyboard.press("Enter");
  expect((await describeFocus()).label).toBe("Message Airship");

  // ADDED: the first link's name is route-dependent — `.main` is the transcript
  // on `#chat` and an arbitrary view everywhere else — so pin both halves of
  // that claim rather than only the chat half. On a route with no conversation
  // and no composer the generic name is the accurate one, and the second stop
  // must not offer a composer that does not exist.
  await page.goto("/#vault");
  await expect(page.locator(".app-shell")).toBeVisible();
  await restartTabbingFromTheTop();
  await page.keyboard.press("Tab");
  const offChat = await describeFocus();
  expect(offChat.label).toBe("Skip to main content");
  expect(offChat.visible).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Tab");
  expect((await describeFocus()).label).not.toBe("Skip to composer");
});

test("mobile workspace and terminal controls preserve their content lanes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile work surface geometry contract");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#workspace");
  // AMENDED: `#workspace` said "Editor". The route now names itself.
  await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();

  // AMENDED: `.workspace-heading` was a 150px slab — eyebrow, 47px serif H1,
  // paragraph and a durability pill — and this measured that its three pieces
  // stacked without colliding. The slab is a 44px bar now, so the replacement
  // measures the thing that band was costing: the share of a phone viewport
  // spent before the first file row, plus the promise that the route's own
  // sentence is still reachable rather than deleted.
  const workbenchTop = await page.locator(".workbench-shell").evaluate((shell) => shell.getBoundingClientRect().top);
  expect(workbenchTop).toBeLessThanOrEqual(844 * .34);
  await expect(page.getByRole("button", { name: /About Workspace/u })).toBeVisible();
  await expect(page.locator(".route-header__status")).toContainText("Ephemeral");

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

  /*
   * The document can absorb an inner route spill in its 13px shell gutter and
   * still report zero page overflow. Measure the route's own contract at the
   * 320px floor: every direct grid child must remain inside the 294px track.
   */
  await page.setViewportSize({ width: 320, height: 844 });
  const terminalRouteGeometry = await page.locator(".terminal-route").evaluate((route) => {
    const edge = route.getBoundingClientRect().right;
    return {
      selfOverflow: route.scrollWidth - route.clientWidth,
      childSpill: [...route.children].map((child) => child.getBoundingClientRect().right - edge),
    };
  });
  expect(terminalRouteGeometry.selfOverflow).toBeLessThanOrEqual(1);
  expect(Math.max(...terminalRouteGeometry.childSpill)).toBeLessThanOrEqual(1);
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
        // `/.+/` also matches the Boot screen's Airship heading. Wait for the
        // routed landmark before measuring Chat so cold bootstrap cannot make
        // a missing `.main` look like responsive geometry.
        await expect(page.locator("main.main")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-density", density);
        /*
         * Waits for the three elements this test is about to measure, rather
         * than for three proxies for them.
         *
         * The visibility checks above passed while `.topbar` and the routed
         * `h1` were still arriving, so the measurement returned `undefined` and
         * the failure read "768px chat rendered measurable geometry" — an
         * absence, when the truth was a race. Probed at this width with a
         * settle, every one of them is present. The `toBeDefined` assertion
         * below is kept: if an element is genuinely missing this still fails,
         * it just no longer fails for arriving late.
         */
        await page.waitForFunction(() => {
          const routed = document.querySelector("main.main");
          return Boolean(routed && routed.querySelector("h1, .session-bar h1, .provider-fabric__heading h2") && document.querySelector(".topbar"));
        }, undefined, { timeout: 15_000 });

        const geometry = await page.evaluate((routeHash) => {
          const main = document.querySelector<HTMLElement>("main.main");
          const heading = main?.querySelector<HTMLElement>("h1, .session-bar h1, .provider-fabric__heading h2");
          // FIXED: this queried a guessed class that no element carries — the
          // nav renders as `.mobile-nav` — so the lookup always missed and the
          // `mobileTop !== undefined` guard below silently absorbed its own
          // failure. The unconditional geometry claim lives in the phone test
          // above, which runs at a width where the nav actually renders.
          const mobileNav = document.querySelector<HTMLElement>(".mobile-nav");
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
          // AMENDED. The old floor of 100px described the retired tablet block,
          // which bought its 104px by `display: none`-ing the conversation
          // disclosure, the new-conversation button, the recent-conversation
          // list and the profile switcher — four controls deleted at a
          // breakpoint. The intermediate rail is the product's own `rail`
          // state now: 60px with a fine pointer, 84px where there is no hover
          // to reveal a label with. The replacement invariant is stronger,
          // because it asserts what the old one only assumed: the rail is
          // present, and every destination it files is still named and
          // clickable rather than hidden.
          expect(railWidth).toBeGreaterThanOrEqual(60);
          const navigation = rail.getByRole("navigation", { name: "Primary" });
          for (const label of RAIL_DESTINATIONS) {
            await expect(navigation.getByRole("button", { name: label, exact: true })).toBeVisible();
          }
          // The profile switcher survives this breakpoint now; it used to be
          // deleted here outright (P9).
          await expect(rail.locator(".profile-switcher").getByRole("button", { name: "Agent profile" })).toBeVisible();
          /*
           * Both catalogs are disclosures. The profile catalog is closed at rest
           * at every width; the recents list now opens itself the first time a
           * profile turns out to have conversations, and only where the rail can
           * show it without pushing the Global group off the screen.
           *
           * So what is asserted here is the property that actually matters at a
           * breakpoint: whichever way the disclosure sits, every destination is
           * still reachable — checked in full a few lines above — and the rail
           * does not overflow to buy the shortcut.
           */
          await expect(rail.locator("#airship-profile-navigation")).toBeHidden();
          await expect(rail.getByRole("navigation", { name: "Primary" }))
            .not.toHaveAttribute("data-scroll-edges", /start|end/u);
        }

        if (["vault", "connection"].includes(hash)) {
          await expect(main.getByRole("navigation")).toHaveCount(0);
        }
      }

      for (const hash of ["chat", "workspace", "editor", "memory", "sessions", "connection"] as const) {
        await page.goto(`/#${hash}`);
        await page.screenshot({ path: testInfo.outputPath(`${density}-${width}-${hash}.png`), animations: "disabled" });
      }
    }
  });
}

test("dense tablet controls recompose before their content becomes unreadable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "controlled tablet geometry uses the desktop browser context");
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto("/#capabilities");
  const deviceGrid = page.locator(".capability-device-grid");
  await expect(deviceGrid.locator(".capability-device-card")).toHaveCount(4, { timeout: 20_000 });
  const deviceGeometry = await deviceGrid.evaluate((grid) => {
    const boundary = grid.getBoundingClientRect();
    const cards = [...grid.querySelectorAll<HTMLElement>(".capability-device-card")].map((card) => {
      const rect = card.getBoundingClientRect();
      const header = card.querySelector<HTMLElement>("header");
      return {
        width: rect.width,
        rightSpill: rect.right - boundary.right,
        selfOverflow: card.scrollWidth - card.clientWidth,
        headerOverflow: header ? header.scrollWidth - header.clientWidth : 0,
      };
    });
    return { selfOverflow: grid.scrollWidth - grid.clientWidth, cards };
  });
  expect(deviceGeometry.selfOverflow).toBeLessThanOrEqual(1);
  for (const card of deviceGeometry.cards) {
    expect(card.width).toBeGreaterThan(240);
    expect(card.rightSpill).toBeLessThanOrEqual(1);
    expect(card.selfOverflow).toBeLessThanOrEqual(1);
    expect(card.headerOverflow).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath("capabilities-768.png"), animations: "disabled" });

  await page.goto("/#profiles");
  const danger = page.locator("details.profile-danger-disclosure");
  await danger.locator("summary").click();
  const archive = danger.locator(".profile-archive-zone");
  await expect(archive).toBeVisible();
  const archiveGeometry = await archive.evaluate((zone) => {
    const boundary = zone.getBoundingClientRect();
    const children = [...zone.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return { width: rect.width, rightSpill: rect.right - boundary.right };
    });
    return {
      columns: getComputedStyle(zone).gridTemplateColumns.trim().split(/\s+/u),
      width: boundary.width,
      children,
    };
  });
  expect(archiveGeometry.columns).toHaveLength(1);
  expect(archiveGeometry.children).toHaveLength(3);
  expect(archiveGeometry.children[0]!.width / archiveGeometry.width).toBeGreaterThan(0.85);
  for (const child of archiveGeometry.children) expect(child.rightSpill).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("profile-archive-768.png"), animations: "disabled" });
});

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
    /*
     * The active profile is the workspace boundary, so it is read before any
     * destination and must never scroll away from the top of the rail. This
     * asserted the opposite arrangement while the switcher sat at the bottom;
     * the shape it protects is the same either way — the switcher is pinned and
     * the destination list is the part that moves.
     */
    const initial = await Promise.all([sidebar.boundingBox(), navigation.boundingBox(), profile.boundingBox()]);
    expect(initial.every(Boolean)).toBe(true);
    expect(initial[2]!.y).toBeGreaterThanOrEqual(0);
    expect(initial[2]!.y + initial[2]!.height).toBeLessThanOrEqual(560);
    // First control in the rail: the switcher ends where the destinations begin.
    expect(initial[2]!.y + initial[2]!.height).toBeLessThanOrEqual(initial[1]!.y + 1);

    // The destination list is the scrolling region, and driving it to its end
    // must not move the switcher — that is the whole meaning of "pinned". The
    // rail may or may not overflow at a given density, so this asserts the
    // relationship rather than requiring the overflow to exist.
    await navigation.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const pinned = await profile.boundingBox();
    expect(pinned!.y).toBeCloseTo(initial[2]!.y, 0);

    await navigation.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(page).toHaveURL(/#connection$/);
    await expect(profile).toBeVisible();
    const after = await profile.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.y).toBeGreaterThanOrEqual(0);
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
  // Profile boundaries open by default — the editor's disclosures used to all
  // arrive shut, and the picker behind this one needed a summary click to be
  // seen at all. The click stayed as a fixture step and began closing the
  // section it was meant to open.
  const boundaries = page.locator("details.profile-editor-disclosure").filter({ hasText: "Profile boundaries" });
  await expect(boundaries.getByRole("button", { name: "Profile approval policy" })).toBeVisible();
  const picker = boundaries.getByRole("button", { name: "Profile approval policy" });
  for (const option of ["Auto Approve", "Full Access", "Ask First"] as const) {
    await picker.click();
    const listbox = page.getByRole("listbox", { name: "Profile approval policy" });
    await expect(listbox).toBeVisible();
    await listbox.getByRole("option", { name: option, exact: true }).click();
    await expect(picker).toContainText(option);
  }
});
