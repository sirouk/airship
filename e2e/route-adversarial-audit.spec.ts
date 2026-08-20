import { expect, test, type Page, type TestInfo } from "@playwright/test";

type Route = Readonly<{
  hash: string;
  label: string;
  heading: RegExp;
  headingLevel?: 1 | 2;
  primaryMobile?: boolean;
  deepLinkOnly?: boolean;
}>;

const routes: readonly Route[] = Object.freeze([
  { hash: "chat", label: "Chat", heading: /.+/, primaryMobile: true },
  { hash: "sessions", label: "All conversations", heading: /^All conversations$/i },
  { hash: "workspace", label: "Workspace", heading: /^Workspace$/i, primaryMobile: true },
  { hash: "editor", label: "Editor", heading: /^Editor$/i },
  { hash: "terminal", label: "Terminal", heading: /^Terminal$/i },
  { hash: "memory", label: "Memory", heading: /^Memory$/i, primaryMobile: true },
  { hash: "context", label: "Context", heading: /^Memory$/i, deepLinkOnly: true },
  { hash: "profiles", label: "Profiles", heading: /^Profiles$/i },
  { hash: "capabilities", label: "Capabilities", heading: /^Capabilities$/i },
  { hash: "skills", label: "Skills", heading: /^Skills$/i },
  { hash: "vault", label: "Vault", heading: /^Vault$/i },
  // Providers currently starts with its provider-fabric section heading while
  // the persistent shell header carries the destination name.
  { hash: "connection", label: "Providers", heading: /^Cloud and local models$/iu, headingLevel: 2, primaryMobile: true },
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
    /*
     * 404 and 412 are the conditional-write protocol answering. 403 joined them
     * when the Vault probe began reclaiming the objects it creates: the lab's
     * MinIO credential grants Get/Put/List and not Delete, so every probe key
     * is refused. That refusal is a supported deployment, not a fault — the
     * reclamation receipt records the retained keys and the runtime reports
     * `deletionAvailableInRuntime: false` rather than claiming a sweep it did
     * not get — and the browser logs the response either way.
     */
    const expectedConditionalS3Response = message.location().url.startsWith("http://127.0.0.1:9900/")
      && /status of (?:403|404|412)/u.test(message.text());
    if (!expectedConditionalS3Response) {
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
    const heading = main.getByRole("heading", {
      name: route.heading,
      level: route.headingLevel ?? 1,
    }).first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(main.getByRole("alert", { name: /could not be displayed/i })).toHaveCount(0);

    const geometry = await heading.evaluate((headingElement) => {
      const mainElement = headingElement.closest<HTMLElement>("main.main");
      if (!mainElement) return undefined;
      const mainBox = mainElement.getBoundingClientRect();
      const headingBox = headingElement.getBoundingClientRect();
      return {
        gutter: headingBox.left - mainBox.left,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        mainOverflow: mainElement.scrollWidth - mainElement.clientWidth,
        headingLeft: headingBox.left,
        headingRight: headingBox.right,
        viewportWidth: window.innerWidth,
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
    if (route.hash !== "chat") gutterOffsets.push(geometry!.gutter);
    if (route.hash !== "chat" && (route.headingLevel ?? 1) === 1) {
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
    if (["vault", "connection"].includes(route.hash)) {
      await expect(main.getByRole("navigation")).toHaveCount(0);
    }
    const screenshotPath = testInfo.outputPath(`${testInfo.project.name}-${route.hash}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: !mobile, animations: "disabled" });
    await testInfo.attach(`${testInfo.project.name}-${route.hash}`, { path: screenshotPath, contentType: "image/png" });
  }

  expect(Math.max(...gutterOffsets) - Math.min(...gutterOffsets), "route headings share one outer gutter").toBeLessThanOrEqual(1);

  /*
   * One heading recipe across every route-level h1, at one step of the ramp.
   * Providers currently exposes its content section as an h2 under the shell's
   * destination label, so it is measured for geometry above but not called an h1.
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
    `every route-level h1 is one step: ${JSON.stringify(headingTypography)}`,
  ).toHaveLength(1);
  const headingFamilies = new Set(headingTypography.map((entry) => entry.family.split(",")[0]!.trim()));
  expect([...headingFamilies], "every route-level h1 uses the one display face").toHaveLength(1);
  expect(runtimeErrors, runtimeErrors.join("\n")).toEqual([]);

  // Already-shipped aliases still land on current product surfaces and emit
  // the canonical hashes. Each cold navigation keeps the isolated lab namespace.
  await page.goto(labUrl("sources"));
  await expect(page).toHaveURL(/#editor$/u);
  await expect(page.getByRole("heading", { name: "Editor", level: 1 })).toBeVisible();

  await page.goto(labUrl("access"));
  await expect(page).toHaveURL(/#connection$/u);
  await expect(page.locator(".topbar-destination")).toHaveText("Providers");
  await expect(page.getByRole("heading", { name: "Cloud and local models", level: 2 })).toBeVisible();

  // Cold alias navigation must not dislodge the adopted storage runtime.
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
      await openProfileHub(page);
      return;
    } else if (route.hash === "skills" || route.hash === "capabilities") {
      // The rail has no `profiles` row, so it has no nested rows under one
      // either: these two are tabs of the profile hub, and the pointer path is
      // the pinned profile row's `Manage profiles` followed by the strip. Enter
      // through the hub only when it is not already mounted — the audit visits
      // Profiles immediately before these, and re-entering would assert a
      // gesture nobody makes.
      const hub = page.getByRole("navigation", { name: "Agent configuration" });
      if (!(await hub.count())) await openProfileHub(page);
      await hub.getByRole("button", { name: route.label, exact: true }).click();
      return;
    }
    await primary.getByRole("button", { name: route.label, exact: true }).click();
    return;
  }
  if (route.primaryMobile) {
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", {
      name: new RegExp(`^${route.label}(?:\\b|$)`, "i"),
    }).click();
    return;
  }
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await mobileNavigation.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button").filter({ hasText: route.label }).first().click();
}

/** The one pointer entrance to the profile hub: the rail's pinned profile row. */
async function openProfileHub(page: Page): Promise<void> {
  await page.locator(".sidebar .profile-switcher").getByRole("button", { name: "Manage profiles" }).click();
}
