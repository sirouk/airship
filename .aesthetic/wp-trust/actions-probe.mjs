import { chromium, devices } from "playwright";
const browser = await chromium.launch();
for (const [name, port] of [["before", 4174], ["after", 4173]]) {
  const context = await browser.newContext({ ...devices["iPad Pro 11"], browserName: "chromium" });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/#chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-bar");
  await page.waitForTimeout(800);
  const html = await page.evaluate(() => Array.from(document.querySelectorAll(".topbar-actions > *")).map((e) => `${e.tagName}.${e.className} w=${Math.round(e.getBoundingClientRect().width)}`));
  console.log(name, JSON.stringify(html, null, 1));
  await context.close();
}
await browser.close();
