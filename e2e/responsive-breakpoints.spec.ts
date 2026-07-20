import { expect, test, type Page } from "@playwright/test";

const routes = [
  ["chat", /.+/], ["sessions", /^Session library$/i], ["workspace", /^Editor$/i],
  ["editor", /^Editor$/i], ["terminal", /^Terminal$/i], ["memory", /^Memory$/i], ["context", /^Memory$/i],
  ["profiles", /^Profiles$/i], ["capabilities", /^Capabilities$/i], ["skills", /^Skills$/i],
  ["proof", /^Proof$/i], ["vault", /^Vault$/i],
  ["connection", /^Chutes access$/i], ["account", /^Account standing$/i],
] as const;

const widths = [768, 820, 1024] as const;
const densities = ["comfortable", "compact"] as const;

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

test("approval mode picker changes all three policies at a constrained viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop preferences contract");
  await page.setViewportSize({ width: 768, height: 620 });
  await page.goto("/#chat");
  await page.getByRole("button", { name: "Open Preferences" }).click();
  const dialog = page.getByRole("dialog", { name: "Preferences" });
  const picker = dialog.getByLabel("Agent approvals");
  for (const [option, summary] of [
    [/Auto Approve/, "Auto Approve."],
    [/Full Access/, "Full Access."],
    [/Ask First/, "Ask First."],
  ] as const) {
    await picker.click();
    const listbox = page.getByRole("listbox", { name: "Agent approvals" });
    await expect(listbox).toBeVisible();
    await listbox.getByRole("option", { name: option }).click();
    await expect(dialog.getByText(summary, { exact: true })).toBeVisible();
  }
});
