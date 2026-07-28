import { chromium } from "@playwright/test";
const base = "http://127.0.0.1:4173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${base}/#chat`, { waitUntil: "domcontentloaded" });
await page.locator(".app-shell").waitFor({ timeout: 30000 });
for (const p of ["Refactor the retrieval index", "Vault probe rerun"]) {
  await page.getByRole("combobox", { name: "Message Airship" }).fill(p);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
  await page.waitForTimeout(200);
}
await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1600);
await page.locator(".session-library-search input").fill("zzqqxx");
await page.waitForTimeout(1200);
console.log(JSON.stringify(await page.evaluate(() => ({
  strip: document.querySelectorAll(".session-library-out-of-results").length,
  buttons: [...document.querySelectorAll(".session-library-actions button")].map((b) => ({ t: b.textContent.trim().slice(0, 20), disabled: b.disabled })),
}))));
await browser.close();
