// Re-runs exactly the #vault assertions from e2e/route-adversarial-audit.spec.ts
// (lines 47-48 and 94-99) against the live lab, isolated from the foreign
// #workspace failure that stops the full spec earlier.
import { chromium, devices, expect } from "@playwright/test";
const base = "http://127.0.0.1:4173";
const ns = `airship-live-v2/e2e/vaultwp-${Date.now().toString(36)}`;
for (const profile of [{ name: "desktop", viewport: { width: 1440, height: 1000 } }, { name: "mobile", ...devices["iPhone 13"] }]) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...profile, name: undefined });
  await ctx.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  })));
  const page = await ctx.newPage();
  await page.goto(`${base}/?airshipLabNamespace=${encodeURIComponent(ns)}#vault`, { waitUntil: "domcontentloaded" });
  const main = page.getByRole("main");
  const results = [];
  const check = async (label, fn) => { try { await fn(); results.push(`  PASS  ${label}`); } catch (e) { results.push(`  FAIL  ${label}: ${String(e).split("\n")[0]}`); } };
  await check("main shows 'Encrypted runtime active'", () => expect(main.getByText("Encrypted runtime active", { exact: true })).toBeVisible({ timeout: 60_000 }));
  await check("heading /^Vault$/i visible", () => expect(main.getByRole("heading", { name: /^Vault$/i }).first()).toBeVisible({ timeout: 10_000 }));
  await check("contains 'Cross-device sync is not evaluated by this probe.'", () => expect(main).toContainText("Cross-device sync is not evaluated by this probe."));
  await check("contains 'Private local object state'", () => expect(main).toContainText("Private local object state"));
  await check("does not contain 'Private cloud state'", () => expect(main).not.toContainText("Private cloud state"));
  await check("no alert /could not be displayed/", () => expect(main.getByRole("alert", { name: /could not be displayed/i })).toHaveCount(0));
  await check("no unnamed visible buttons", async () => {
    const unnamed = await main.locator("button:visible").evaluateAll((buttons) => buttons.filter((b) => !(b.getAttribute("aria-label") || b.getAttribute("aria-labelledby") || b.textContent?.trim() || b.title)).length);
    expect(unnamed).toBe(0);
  });
  const geometry = await page.evaluate(() => {
    const m = document.querySelector("main.main");
    const h = m?.querySelector("h1, h2");
    return { documentOverflow: document.documentElement.scrollWidth - window.innerWidth, mainOverflow: m.scrollWidth - m.clientWidth, headingLeft: h.getBoundingClientRect().left, headingRight: h.getBoundingClientRect().right, viewportWidth: window.innerWidth, gutter: h.getBoundingClientRect().left - m.getBoundingClientRect().left };
  });
  await check("no document overflow", () => expect(geometry.documentOverflow).toBeLessThanOrEqual(1));
  await check("no main overflow", () => expect(geometry.mainOverflow).toBeLessThanOrEqual(1));
  await check("heading inside viewport", () => { expect(geometry.headingLeft).toBeGreaterThanOrEqual(0); expect(geometry.headingRight).toBeLessThanOrEqual(geometry.viewportWidth + 1); });
  console.log(`${profile.name} (#vault, gutter ${geometry.gutter.toFixed(1)}px)`);
  console.log(results.join("\n"));
  await browser.close();
}
