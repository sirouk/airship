import { chromium } from "playwright";
const browser = await chromium.launch();
for (const [name, port] of [["before", 4174], ["after", 4173]]) {
  for (const width of [430, 641, 700, 768, 834, 1024, 1280, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/#chat`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-bar");
    await page.waitForTimeout(500);
    const d = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
      const chip = r(".topbar-posture-chip"), connect = r(".topbar-connect-action");
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      return { chip, connect, overflow, chipText: document.querySelector(".topbar-posture-chip")?.innerText.replace(/\n/g, " ") ?? null };
    });
    const overlap = d.chip && d.connect && d.chip.r > d.connect.l && d.chip.l < d.connect.r;
    console.log(`${name} ${width}px chipW=${d.chip?.w ?? "-"} overlap=${overlap} hOverflow=${d.overflow} :: ${d.chipText}`);
    await context.close();
  }
}
await browser.close();
