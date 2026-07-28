#!/usr/bin/env node
/**
 * Development-only capture harness for the type-ramp / route-header pass.
 *
 * Drives every route at the two viewport classes the review prescribes and
 * writes a screenshot per route plus a measurement JSON, so a before/after
 * pair can be diffed by eye *and* by number. It never receives credentials.
 *
 * Usage: node scripts/type-ramp-capture.mjs <outDir> [baseUrl]
 */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".visualize/type-ramp";
const baseUrl = (process.argv[3] ?? "http://localhost:4173/").replace(/\/$/, "");

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", ...devices["iPhone 14 Pro Max"] },
];

const ROUTES = [
  "#chat", "#sessions", "#workspace", "#editor", "#terminal", "#memory",
  "#context", "#profiles", "#capabilities", "#skills", "#vault", "#account",
  "#proof", "#connection",
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const measurements = [];

  for (const profile of VIEWPORTS) {
    const context = await browser.newContext({ ...profile, name: undefined });
    const page = await context.newPage();
    for (const route of ROUTES) {
      try {
        await page.goto(`${baseUrl}/${route}`, { waitUntil: "networkidle", timeout: 30_000 });
      } catch {
        await page.goto(`${baseUrl}/${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      await page.waitForTimeout(1200);
      const slug = route.replace(/[^a-z0-9]/gi, "");
      await page.screenshot({ path: join(outDir, `${profile.name}-${slug}.png`), fullPage: false });
      measurements.push({
        viewport: profile.name,
        route: slug,
        heading: await page.evaluate(() => {
          const h1 = document.querySelector("main h1, .work-view h1, h1");
          if (!(h1 instanceof HTMLElement)) return null;
          const box = h1.getBoundingClientRect();
          const style = getComputedStyle(h1);
          return {
            text: (h1.textContent ?? "").trim().slice(0, 40),
            x: Math.round(box.x * 10) / 10,
            y: Math.round(box.y * 10) / 10,
            fontSize: style.fontSize,
            fontFamily: style.fontFamily.split(",")[0],
            className: h1.className,
          };
        }),
      });
    }
    await context.close();
  }

  await browser.close();
  await writeFile(join(outDir, "measurements.json"), JSON.stringify(measurements, null, 2), "utf8");
  console.log(JSON.stringify(measurements, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
