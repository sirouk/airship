#!/usr/bin/env node
/**
 * Development-only UI capture harness.  It drives the running lab UI across
 * viewport classes and writes screenshots plus a console/error log so a
 * reviewer can inspect real rendered state instead of reasoning from source.
 *
 * Usage: node scripts/ui-capture.mjs [baseUrl] [outDir]
 * It never receives or records credentials.
 */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = process.argv[2] ?? "http://localhost:4173/";
const outDir = process.argv[3] ?? ".ui-capture";

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "tablet", ...devices["iPad Pro 11"] },
  { name: "phone", ...devices["iPhone 14 Pro Max"] },
];

const ROUTES = ["", "#chat", "#workspace", "#terminal", "#memory", "#proof", "#profiles", "#vault", "#account"];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const log = [];

  for (const profile of VIEWPORTS) {
    const context = await browser.newContext({ ...profile, name: undefined });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        log.push(`[${profile.name}] console.${message.type()}: ${message.text().slice(0, 400)}`);
      }
    });
    page.on("pageerror", (error) => log.push(`[${profile.name}] pageerror: ${String(error).slice(0, 400)}`));

    for (const route of ROUTES) {
      const url = `${baseUrl.replace(/\/$/, "")}/${route}`;
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      } catch {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      await page.waitForTimeout(900);
      const slug = route.replace(/[^a-z0-9]/gi, "") || "root";
      await page.screenshot({
        path: join(outDir, `${profile.name}-${slug}.png`),
        fullPage: profile.name === "desktop",
      });
      log.push(`[${profile.name}] captured ${slug} title=${JSON.stringify(await page.title())}`);
    }
    await context.close();
  }

  await browser.close();
  await writeFile(join(outDir, "capture.log"), log.join("\n"), "utf8");
  console.log(log.join("\n"));
  console.log(`\nWrote captures to ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
