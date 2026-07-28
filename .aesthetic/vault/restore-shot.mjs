import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto("http://127.0.0.1:4173/#vault", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.locator("details.local-device-vault__restore summary").click();
await page.locator("details.local-device-vault__restore").scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.screenshot({ path: ".aesthetic/vault/walkthrough/05-restore.png" });
console.log(await page.evaluate(() => [...document.querySelectorAll(".local-device-vault__restore label, .local-device-vault__restore input, .local-device-vault__restore button")]
  .map((n) => ({ t: (n.textContent ?? n.type ?? "").trim().slice(0, 36), h: Math.round(n.getBoundingClientRect().height) }))
  .filter((r) => r.h > 0 && r.h < 44)));
await browser.close();
