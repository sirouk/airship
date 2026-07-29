import { expect, test, type Page, type TestInfo } from "@playwright/test";

type Route = Readonly<{
  hash: string;
  label: string;
  heading: RegExp;
  primaryMobile?: boolean;
  deepLinkOnly?: boolean;
  /**
   * The route is laid out on its own centred measure rather than the shell's
   * outer gutter, so its heading is checked for symmetry instead of alignment.
   * See the shared-gutter assertion below for why that is not a weakening.
   */
  centredMeasure?: boolean;
}>;

const routes: readonly Route[] = Object.freeze([
  { hash: "chat", label: "Chat", heading: /.+/, primaryMobile: true },
  { hash: "sessions", label: "All conversations", heading: /^All conversations$/i },
  // AMENDED: `#workspace` hard-coded the heading "Editor" here while the rail
  // row, the eyebrow and every other spec called it Workspace. One component
  // served two destinations under one constant name, so this row asserted the
  // defect. Binding each row's heading to its own route name is strictly
  // stronger than the old constant: it now fails if either destination renders
  // the other's title, which the previous `/^Editor$/i` on both rows could not
  // detect. Matches the amendments already landed in workspace-workbench,
  // responsive-breakpoints and profile-draft-navigation.
  { hash: "workspace", label: "Workspace", heading: /^Workspace$/i, primaryMobile: true },
  { hash: "editor", label: "Editor", heading: /^Editor$/i },
  { hash: "terminal", label: "Terminal", heading: /^Terminal$/i },
  { hash: "memory", label: "Memory", heading: /^Memory$/i },
  { hash: "context", label: "Context index", heading: /^Memory$/i, deepLinkOnly: true },
  { hash: "profiles", label: "Profiles", heading: /^Profiles$/i },
  { hash: "capabilities", label: "Capabilities", heading: /^Capabilities$/i, deepLinkOnly: true },
  { hash: "skills", label: "Skills", heading: /^Skills$/i, deepLinkOnly: true },
  { hash: "proof", label: "Proof", heading: /^Proof$/i, primaryMobile: true },
  { hash: "vault", label: "Vault", heading: /^Vault$/i },
  // AMENDED AGAIN: `--connect-measure` now starts *below* the route bar. It
  // is the lane list's measure, not the page's: centring it on the whole view
  // put this route's <h1> at x=456 while the other nine sat at x=258, so the
  // one heading that moved on arrival was the one on the route a first-time
  // visitor lands on. The header rejoins the shared-gutter pool; the
  // `centredMeasure` symmetry branch below is retained because the lane list
  // is still on its own measure and the flag still fires the moment a route
  // puts its heading back inside one.
  { hash: "connection", label: "Connection", heading: /^Connect models$/i, centredMeasure: true },
  { hash: "account", label: "Account", heading: /^Account standing$/i },
]);

test("every desktop and mobile route remains usable in the live local lab", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
  const runtimeErrors: string[] = [];
  let activeRoute = "bootstrap";
  page.on("pageerror", (error) => runtimeErrors.push(`[${activeRoute}] pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const expectedConditionalS3Response = message.location().url.startsWith("http://127.0.0.1:9900/")
      && /status of (?:404|412)/u.test(message.text());
    /*
     * The Chutes sign-in readiness probe, answering.
     *
     * `#connection` asks the localhost token handler at load whether it can
     * exchange a code, because the alternative is what shipped: an OAuth tab
     * marked "Primary" above a filled brass button that returned an operator's
     * restart instruction when pressed. A lab with no process-held client
     * secret answers 503, the browser logs the response, and the lane renders
     * that answer — it is a reading, not a failure. Scoped to the one endpoint
     * and the one status so a genuine 503 anywhere else still fails this audit.
     */
    const expectedSignInReadinessResponse = message.location().url.endsWith("/__airship/chutes/oauth/token")
      && /status of 503/u.test(message.text());
    if (!expectedConditionalS3Response && !expectedSignInReadinessResponse) {
      runtimeErrors.push(`[${activeRoute}] console: ${message.text()} (${message.location().url || "unknown source"})`);
    }
  });

  const namespace = `airship-live-v2/e2e/route-audit-${testInfo.project.name}-${Date.now().toString(36)}`;
  // Prove that the verified object-store runtime, rather than a merely ready
  // probe or a hidden responsive duplicate, is authoritative before auditing
  // the routes that consume it. Adoption can include a genuine .git migration.
  const labUrl = (hash: string): string => `/?airshipLabNamespace=${encodeURIComponent(namespace)}#${hash}`;
  await page.goto(labUrl("vault"));
  await expect(page.getByRole("main").getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 60_000 });
  const mobile = testInfo.project.name === "mobile-chromium";
  const gutterOffsets: number[] = [];
  const headingTypography: { route: string; size: string; family: string; step: string }[] = [];

  for (const route of routes) {
    activeRoute = route.hash;
    await navigate(page, route, mobile, labUrl);
    await expect(page).toHaveURL(new RegExp(
      route.hash === "chat"
        ? "#chat/[^/?#]+$"
        : `#${route.hash}(?:\\?.*)?$`,
    ));
    const main = page.getByRole("main");
    const heading = main.getByRole("heading", { name: route.heading }).first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(main.getByRole("alert", { name: /could not be displayed/i })).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const mainElement = document.querySelector<HTMLElement>("main.main");
      const headingElement = mainElement?.querySelector<HTMLElement>("h1, h2");
      if (!mainElement || !headingElement) return undefined;
      const mainBox = mainElement.getBoundingClientRect();
      const headingBox = headingElement.getBoundingClientRect();
      // The route's own outermost block: the heading's nearest ancestor that is
      // a direct child of `main`. A route on its own centred measure insets
      // this box symmetrically inside the shell's content column.
      let measureElement: HTMLElement = headingElement;
      while (measureElement.parentElement && measureElement.parentElement !== mainElement) {
        measureElement = measureElement.parentElement;
      }
      const measureBox = measureElement.getBoundingClientRect();
      const contentLeft = mainBox.left + mainElement.clientLeft;
      return {
        gutter: headingBox.left - mainBox.left,
        measureLeftInset: measureBox.left - contentLeft,
        measureRightInset: (contentLeft + mainElement.clientWidth) - measureBox.right,
        measureNarrowerThanShell: measureBox.width < mainElement.clientWidth - 1,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        mainOverflow: mainElement.scrollWidth - mainElement.clientWidth,
        headingLeft: headingBox.left,
        headingRight: headingBox.right,
        viewportWidth: window.innerWidth,
        // One heading recipe, measured rather than asserted from a class name:
        // the legacy slab this replaced was `clamp(30px, 4vw, 47px)`, so it
        // reported 47px on desktop and 29.75px on a phone while the route bar
        // beside it reported one size at both.
        headingFontSize: getComputedStyle(headingElement).fontSize,
        headingFontFamily: getComputedStyle(headingElement).fontFamily,
        displayStep: getComputedStyle(document.documentElement).getPropertyValue("--fs-display").trim(),
      };
    });
    expect(geometry, `${route.label} has route geometry`).toBeDefined();
    expect(geometry!.documentOverflow, `${route.label} must not overflow the viewport`).toBeLessThanOrEqual(1);
    expect(geometry!.mainOverflow, `${route.label} must contain horizontal overflow`).toBeLessThanOrEqual(1);
    expect(geometry!.headingLeft, `${route.label} heading starts inside viewport`).toBeGreaterThanOrEqual(0);
    expect(geometry!.headingRight, `${route.label} heading ends inside viewport`).toBeLessThanOrEqual(geometry!.viewportWidth + 1);
    // A centred-measure route is exempt from the shared gutter only while it is
    // genuinely on a narrower measure. The trigger is the width, not the inset,
    // so a measure that stopped centring and stranded against one edge fails
    // the symmetry assertion instead of quietly qualifying for the pool.
    // Below 1050px the connect measure releases to full width and the route
    // rejoins the pool rather than losing coverage.
    const onOwnMeasure = Boolean(route.centredMeasure) && geometry!.measureNarrowerThanShell;
    if (onOwnMeasure) {
      expect(
        Math.abs(geometry!.measureLeftInset - geometry!.measureRightInset),
        `${route.label} centres its own measure inside the route shell`,
      ).toBeLessThanOrEqual(1);
    }
    if (route.hash !== "chat" && !onOwnMeasure) gutterOffsets.push(geometry!.gutter);
    if (route.hash !== "chat") {
      headingTypography.push({
        route: route.label,
        size: geometry!.headingFontSize,
        family: geometry!.headingFontFamily,
        step: geometry!.displayStep,
      });
    }

    const unnamedButtons = await main.locator("button:visible").evaluateAll((buttons) => buttons
      .filter((button) => {
        const element = button as HTMLElement;
        return !(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.textContent?.trim() || element.title);
      })
      .length);
    expect(unnamedButtons, `${route.label} has no unnamed visible buttons`).toBe(0);
    if (route.hash === "vault") {
      await expect(main.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(main).toContainText("Cross-device sync is not evaluated by this probe.");
      await expect(main).toContainText("Private local object state");
      await expect(main).not.toContainText("Private cloud state");
    }
    if (["proof", "vault", "connection", "account"].includes(route.hash)) {
      const activeTrustTab = main.getByRole("navigation", { name: "Trust hub" }).locator("button[aria-current='page']");
      await expect(activeTrustTab).toBeInViewport();
    }
    const screenshotPath = testInfo.outputPath(`${testInfo.project.name}-${route.hash}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: !mobile, animations: "disabled" });
    await testInfo.attach(`${testInfo.project.name}-${route.hash}`, { path: screenshotPath, contentType: "image/png" });
  }

  expect(Math.max(...gutterOffsets) - Math.min(...gutterOffsets), "route headings share one outer gutter").toBeLessThanOrEqual(1);

  /*
   * One heading recipe across every route, at one step of the ramp.
   *
   * Six routes rendered a second page-header primitive whose h1 was
   * `font-size: clamp(30px, 4vw, 47px)` — the construction `tokens.css`
   * forbids by name, citing WCAG 1.4.4, because a px-literal clamp pins the
   * largest text in the product against the reader's Type scale preference.
   * Measured before this landed: 47px on `#profiles`, `#capabilities` and
   * `#skills` against 29.75px everywhere else, and 28.9px for the same three
   * on a phone. The assertion is against `--fs-display` itself rather than a
   * number, so it keeps holding when the preference moves the ramp.
   */
  const displaySteps = new Set(headingTypography.map((entry) => entry.step));
  expect(displaySteps.size, "one --fs-display value across the audit").toBe(1);
  const headingSizes = new Set(headingTypography.map((entry) => entry.size));
  expect(
    [...headingSizes],
    `every route title is one step: ${JSON.stringify(headingTypography)}`,
  ).toHaveLength(1);
  const headingFamilies = new Set(headingTypography.map((entry) => entry.family.split(",")[0]!.trim()));
  expect([...headingFamilies], "every route title is set in the one display face").toHaveLength(1);
  expect(runtimeErrors, runtimeErrors.join("\n")).toEqual([]);

  await page.goto(labUrl("attestations"));
  await expect(page).toHaveURL(/#proof\?section=attestations$/);
  await expect(page.getByRole("heading", { name: "Proof", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Attestation evidence" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Endpoint & receipt evidence", level: 2 })).toBeVisible();

  // The legacy route caused a fresh document navigation. Re-check the actual
  // adopted adapter on its evidence surface; mobile intentionally hides some
  // desktop session metadata, so text visibility in the chat header is not a
  // reliable durability oracle.
  await page.goto(labUrl("vault"));
  await expect(page.getByRole("main").getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 60_000 });
  await navigate(page, routes[0]!, mobile, labUrl);
  await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible();
});

async function navigate(page: Page, route: Route, mobile: boolean, labUrl: (hash: string) => string): Promise<void> {
  // FIXED: the deep-link branch used to `goto("/#<hash>")`, a fresh document
  // navigation that dropped `airshipLabNamespace`. The audit therefore left its
  // own isolated MinIO namespace part-way through the loop and re-booted
  // against the shared `airship-live-v2/local-user` prefix, so every route
  // after `#context` audited a runtime the test had not established. Carrying
  // the namespace keeps the reload honest — it still exercises a real cold boot
  // against the object store, but against the store this run owns.
  if (route.deepLinkOnly) { await page.goto(labUrl(route.hash)); return; }
  if (!mobile) {
    const primary = page.getByRole("navigation", { name: "Primary" });
    // AMENDED: three destinations are no longer resting rail rows. `All
    // conversations` is the pinned last row of the rail's conversation
    // disclosure, `Editor`/`Terminal` are behind the Workspace expander, and
    // `Profiles` is the pinned profile row's `Manage profiles`. Every one is
    // still reached from the rail by pointer, one gesture deeper, and this
    // helper is what asserts that — a missing disclosure fails the whole audit.
    if (route.hash === "sessions") {
      // The audit visits every route repeatedly, and the disclosure stays open
      // between visits — so expand only when it is actually collapsed, exactly
      // as the Workspace expander below already does.
      const expander = primary.getByRole("button", { name: "Expand recent conversations" });
      if (await expander.count()) await expander.click();
    } else if (route.hash === "editor" || route.hash === "terminal") {
      const expander = primary.getByRole("button", { name: "Expand Workspace" });
      if (await expander.count()) await expander.click();
    } else if (route.hash === "profiles") {
      await page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Manage profiles" }).click();
      return;
    }
    await primary.getByRole("button", { name: route.label, exact: true }).click();
    return;
  }
  if (route.primaryMobile) {
    const mobileLabel = route.hash === "proof" ? "Trust" : route.label;
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", {
      name: new RegExp(`^${mobileLabel}(?:\\b|$)`, "i"),
    }).click();
    return;
  }
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await mobileNavigation.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: route.label }).first().click();
}
