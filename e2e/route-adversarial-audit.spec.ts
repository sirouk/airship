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
  // AMENDED: `#connection` is the one route the design gives its own measure —
  // `--connect-measure: 760px` with `margin-inline: auto`, inherited by every
  // descendant including the route bar (DESIGN_DIRECTION §5.5, "One measure",
  // which replaced four competing widths with one). Its heading therefore
  // cannot start on the shell's outer gutter above 1050px, and holding it to
  // that line would be asserting against the spec. The replacement below is
  // stronger, not weaker: the blanket gutter check only ever said "26px from
  // the left", which a route stranded hard against one edge could satisfy by
  // accident; the symmetry check says the measure is genuinely centred, which
  // is the property the "One measure" decision was made to obtain, and it
  // still fails if the route regains a stray second page edge.
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
    if (!expectedConditionalS3Response) runtimeErrors.push(`[${activeRoute}] console: ${message.text()} (${message.location().url || "unknown source"})`);
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
      await primary.getByRole("button", { name: "Expand recent conversations" }).click();
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
