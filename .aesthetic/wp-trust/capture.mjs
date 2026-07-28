import { mkdir } from "node:fs/promises";
import { chromium, devices } from "playwright";

/*
 * Capture harness for the trust-label package.
 *
 * It drives the two dev servers side by side — 4173 is the working tree, 4174
 * is a worktree pinned at commit 3c38165 (round 1) — so every "before" frame is
 * the interface as it shipped before this package, at the same viewport, in the
 * same state. It also measures the chrome band above the route content, because
 * a trust-label change that quietly costs a band of pixels is not a trust-label
 * change.
 */

const VIEWPORTS = [
  { id: "desktop", viewport: { width: 1440, height: 900 }, device: undefined },
  { id: "ipad", device: devices["iPad Pro 11"] },
  { id: "iphone", device: devices["iPhone 14 Pro Max"] },
];

const target = process.argv[2] ?? "after";
const port = target === "before" ? 4174 : 4173;
const out = new URL(`./${target}/`, import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const results = [];

for (const entry of VIEWPORTS) {
  const context = await browser.newContext(entry.device ? { ...entry.device, browserName: "chromium" } : { viewport: entry.viewport });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/#chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-bar", { timeout: 30_000 });
  await page.waitForTimeout(900);

  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { top: box.top, height: box.height, width: box.width };
    };
    const transcript = document.querySelector(".transcript");
    return {
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      topbar: rect(".topbar"),
      sessionBar: rect(".session-bar"),
      transcriptTop: transcript ? transcript.getBoundingClientRect().top : null,
      postureChip: document.querySelector(".topbar-posture-chip")?.innerText ?? null,
      elsewhere: document.querySelector(".topbar-posture-chip__elsewhere")?.innerText ?? null,
      statusChip: document.querySelector(".session-status-chip")?.getAttribute("aria-label") ?? null,
      postureChipLabel: document.querySelector(".topbar-posture-chip")?.getAttribute("aria-label") ?? null,
      topbarOverlap: (() => {
        const chip = document.querySelector(".topbar-posture-chip");
        const action = document.querySelector(".topbar-connect-action");
        if (!chip || !action) return null;
        const a = chip.getBoundingClientRect();
        const b = action.getBoundingClientRect();
        return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
      })(),
    };
  });
  results.push({ viewport: entry.id, ...geometry });

  await page.screenshot({ path: new URL(`${entry.id}-chat.png`, out).pathname, fullPage: false });

  // The trust sheet: the L1 disclosure the topbar chip opens.
  const chip = page.locator(".topbar-posture-chip");
  if (await chip.count()) {
    // `force`: the shipped topbar lets the brass `Connect a model` action
    // overlap the posture chip below 1024px. That is a layout defect this
    // package did not introduce and does not own; the harness records it
    // rather than waiting 30s for it to resolve itself.
    await chip.click({ force: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: new URL(`${entry.id}-trust-sheet.png`, out).pathname });
    const sheetRows = await page.locator(".trust-sheet .claim-rows > button").count();
    results[results.length - 1].sheetRows = sheetRows;
    results[results.length - 1].sheetText = await page.locator(".trust-sheet").innerText().catch(() => null);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  // The session status popover: the conversation band's own L1.
  const statusChip = page.locator(".session-status-chip");
  if (await statusChip.count()) {
    await statusChip.click({ force: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: new URL(`${entry.id}-session-popover.png`, out).pathname });
    results[results.length - 1].popoverText = await page.locator(".session-status-popover .popover__panel").innerText().catch(() => null);
    await page.keyboard.press("Escape");
  }

  await page.goto(`http://127.0.0.1:${port}/#proof`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: new URL(`${entry.id}-proof.png`, out).pathname, fullPage: false });
  results[results.length - 1].proofText = await page.locator(".proof-inspector").first().innerText().catch(() => null);

  await context.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
