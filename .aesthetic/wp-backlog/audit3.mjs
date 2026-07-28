import { chromium, devices } from "@playwright/test";
const base = "http://127.0.0.1:4173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 14 Pro Max"] });
const page = await ctx.newPage();
await page.goto(`${base}/#chat`, { waitUntil: "domcontentloaded" });
await page.locator(".app-shell").waitFor({ timeout: 30000 });
await page.getByRole("combobox", { name: "Message Airship" }).fill("Vault probe");
await page.getByRole("button", { name: "Send message" }).click();
await page.waitForTimeout(700);
await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1600);
await page.locator(".session-library-filter-toggle").click();
await page.waitForTimeout(300);
await page.locator(".session-filter-menu button").first().click();
await page.waitForTimeout(300);
const opts = await page.locator("[role=option]").allInnerTexts();
console.log("provider options", JSON.stringify(opts));
if (opts.length > 1) { await page.locator("[role=option]").nth(1).click(); await page.waitForTimeout(800); }
await page.locator(".session-library-filter-toggle").click();
await page.waitForTimeout(300);
console.log("toggle label with a filter set:", JSON.stringify(await page.locator(".session-library-filter-toggle").innerText()));
console.log("collapsed filters display:", await page.evaluate(() => getComputedStyle(document.querySelector(".session-library-filters")).display));

// Memory route keyboard walk
await page.goto(`${base}/#memory`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const walk = [];
for (let i = 0; i < 14; i += 1) {
  await page.keyboard.press("Tab");
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { t: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 26), outline: cs.outlineStyle === "none" ? null : cs.outlineWidth + " " + cs.outlineColor, h: Math.round(r.height) };
  });
  if (info) walk.push(info);
}
console.log("memory tab walk", JSON.stringify(walk));
await browser.close();
