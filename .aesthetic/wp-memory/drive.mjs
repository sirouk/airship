#!/usr/bin/env node
/**
 * Memory + Sessions design capture. Development-only; never records secrets.
 * Usage: node .aesthetic/wp-memory/drive.mjs <outDir> [seedCount]
 */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".aesthetic/wp-memory/tmp";
const seedCount = Number(process.argv[3] ?? 12);
const base = "http://127.0.0.1:4173";

const PROMPTS = [
  "Refactor the retrieval index so lookups are O(1)",
  "Why does the vault probe fail on Safari?",
  "Summarise the trust-language test suite",
  "Create a file notes.md with three bullet points",
  "Explain the WebContainer approval boundary",
  "What does verified-without-authority mean?",
  "List the workspace files and their sizes",
  "Draft a changelog for the proof route",
  "How is the journal head digest computed?",
  "Compare bootstrap and semantic embeddings",
  "Where does the composer aria-label live?",
  "Write a test for relativeSessionTime",
  "Audit the session library for stale panes",
  "Trace a fork through the manifest lineage",
  "Which routes overflow at 430px?",
  "Show me the release gate budget lines",
  "Explain the disclosure ladder rungs",
  "What survives an ephemeral reload?",
  "Describe the kind-visual colour table",
  "Plan the memory bar sticky behaviour",
];

async function seed(page, count) {
  await page.goto(`${base}/#chat`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
      await page.waitForTimeout(120);
    }
    const composer = page.getByRole("combobox", { name: "Message Airship" });
    await composer.fill(PROMPTS[index % PROMPTS.length]);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForTimeout(320);
  }
}

async function band(page, selector) {
  return page.evaluate((sel) => {
    const main = document.querySelector("main.app-main") ?? document.querySelector("main") ?? document.body;
    const mainRect = main.getBoundingClientRect();
    const node = document.querySelector(sel);
    const rect = node?.getBoundingClientRect();
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      mainTop: Math.round(mainRect.top),
      firstContentTop: rect ? Math.round(rect.top) : null,
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, selector);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const log = [];
  const profiles = [
    { name: "desktop", options: { viewport: { width: 1440, height: 900 } } },
    { name: "phone", options: devices["iPhone 14 Pro Max"] },
  ];

  for (const profile of profiles) {
    const context = await browser.newContext({ ...profile.options });
    const page = await context.newPage();
    page.on("pageerror", (error) => log.push(`[${profile.name}] pageerror ${String(error).slice(0, 300)}`));
    await seed(page, seedCount);

    // --- Memory, resting
    await page.goto(`${base}/#memory`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-rest.png`), fullPage: false });
    log.push(`[${profile.name}] memory rest ${JSON.stringify(await band(page, "#memory-results"))}`);

    // --- Memory, query with hits
    const q = page.getByRole("searchbox", { name: "Search every memory surface" });
    await q.fill("retrieval");
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-hits.png`), fullPage: false });
    log.push(`[${profile.name}] memory hits ${JSON.stringify(await band(page, ".memory-hit"))}`);

    // --- Memory, zero result
    await q.fill("zzzqqqxyz");
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-zero.png`), fullPage: false });

    // --- Graph
    await q.fill("");
    await page.waitForTimeout(600);
    await page.locator("#memory-relationships").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-graph.png`), fullPage: false });

    // --- Index
    await page.goto(`${base}/#context`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-index.png`), fullPage: false });
    await page.evaluate(() => document.querySelector("#memory-index")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-index-2.png`), fullPage: false });

    // --- Sessions
    await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(outDir, `${profile.name}-sessions.png`), fullPage: false });
    log.push(`[${profile.name}] sessions ${JSON.stringify(await band(page, ".session-library-card"))}`);
    log.push(`[${profile.name}] sessions rows ${await page.locator(".session-library-card").count()} cardH ${JSON.stringify((await page.locator(".session-library-card").first().boundingBox()) ?? null)}`);

    // --- Sessions, filtered to zero
    const search = page.locator(".session-library-search input");
    await search.fill("plan.md");
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, `${profile.name}-sessions-zero.png`), fullPage: false });
    log.push(`[${profile.name}] zero-state text ${JSON.stringify((await page.locator(".session-library-empty").first().innerText().catch(() => "")).slice(0, 300))}`);
    log.push(`[${profile.name}] detail still rendered: ${await page.locator(".session-library-inspector").count()} forkEnabled=${await page.locator(".session-library-actions button", { hasText: /Fork/ }).first().isEnabled().catch(() => "n/a")}`);
    log.push(`[${profile.name}] out-of-results strip: ${await page.locator(".session-library-out-of-results").count()}`);
    log.push(`[${profile.name}] toolbar overflow ${JSON.stringify(await page.evaluate(() => {
      const bar = document.querySelector(".session-library-toolbar");
      if (!bar) return null;
      const last = bar.lastElementChild;
      return {
        scrollWidth: bar.scrollWidth,
        clientWidth: bar.clientWidth,
        lastRight: Math.round(last.getBoundingClientRect().right),
        barRight: Math.round(bar.getBoundingClientRect().right),
        height: Math.round(bar.getBoundingClientRect().height),
      };
    }))}`);
    await search.fill("vault");
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, `${profile.name}-sessions-search.png`), fullPage: false });

    await context.close();
  }

  await browser.close();
  await writeFile(join(outDir, "capture.log"), log.join("\n"), "utf8");
  console.log(log.join("\n"));
}

await main();
