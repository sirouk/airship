import { chromium, devices } from "playwright";
const browser = await chromium.launch();
for (const [name, port] of [["before", 4174], ["after", 4173]]) {
  const context = await browser.newContext({ ...devices["iPad Pro 11"], browserName: "chromium" });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/#chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-bar");
  await page.waitForTimeout(800);
  const data = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width) }; };
    return { chip: r(".topbar-posture-chip"), center: r(".topbar-center"), actions: r(".topbar-actions"), connect: r(".topbar-connect-action"), brand: r(".brand"), topbar: r(".topbar") };
  });
  console.log(name, JSON.stringify(data));
  await context.close();
}
await browser.close();
