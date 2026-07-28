import { chromium, devices } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 14 Pro Max"] });
await ctx.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
  mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "local-device", approvalMode: "ask-first" })));
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:4173/#vault", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.locator(".vault-provider-compare > summary").click();
await page.locator(".vault-provider-compare table").scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: ".aesthetic/vault/walkthrough/06-phone-compare.png" });
console.log(await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  firstCellLabel: getComputedStyle(document.querySelector(".vault-provider-compare td"), "::before").content,
})));
await browser.close();
