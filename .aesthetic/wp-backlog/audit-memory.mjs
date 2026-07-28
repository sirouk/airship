#!/usr/bin/env node
/** Independent audit capture for the Memory/Context/Sessions package. Dev-only. */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".aesthetic/wp-backlog/audit";
const base = "http://127.0.0.1:4173";
const PROMPTS = [
  "Refactor the retrieval index so lookups are O(1)",
  "Why does the vault probe fail on Safari?",
  "Summarise the trust-language test suite",
  "Create a file notes.md with three bullet points",
  "Explain the WebContainer approval boundary",
  "Vault probe rerun for the retrieval index",
];

const log = [];
const say = (line) => { log.push(line); console.log(line); };

async function seed(page, count) {
  await page.goto(`${base}/#chat`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      await page.getByRole("region", { name: "Agent session" }).getByRole("button", { name: "New conversation" }).click();
      await page.waitForTimeout(140);
    }
    const composer = page.getByRole("combobox", { name: "Message Airship" });
    await composer.fill(PROMPTS[i % PROMPTS.length]);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForTimeout(340);
  }
}

async function geometry(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    const rect = node?.getBoundingClientRect();
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      firstContentTop: rect ? Math.round(rect.top) : null,
      chromePct: rect ? Math.round((rect.top / window.innerHeight) * 1000) / 10 : null,
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, selector);
}

async function smallTargets(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("button, a[href], input, select, [role=button], summary")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest("[hidden]")) continue;
      if (r.height < 43.5) out.push({ h: Math.round(r.height), w: Math.round(r.width), cls: el.className?.toString().slice(0, 60), text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40) });
    }
    return out;
  });
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  for (const profile of [
    { name: "desktop", options: { viewport: { width: 1440, height: 900 } } },
    { name: "phone", options: devices["iPhone 14 Pro Max"] },
  ]) {
    const context = await browser.newContext({ ...profile.options });
    const page = await context.newPage();
    page.on("pageerror", (e) => say(`[${profile.name}] PAGEERROR ${String(e).slice(0, 200)}`));
    page.on("console", (m) => { if (m.type() === "error") say(`[${profile.name}] console.error ${m.text().slice(0, 160)}`); });
    await seed(page, 6);

    // ---- Memory resting (unsearched)
    await page.goto(`${base}/#memory`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-rest.png`) });
    say(`[${profile.name}] memory rest ${JSON.stringify(await geometry(page, "#memory-results"))}`);
    const starters = await page.locator(".memory-starters button").all();
    const starterInfo = [];
    for (const s of starters) {
      const box = await s.boundingBox();
      starterInfo.push({ label: await s.getAttribute("aria-label"), h: Math.round(box?.height ?? 0) });
    }
    say(`[${profile.name}] starters ${JSON.stringify(starterInfo)}`);
    say(`[${profile.name}] has 'no search history is kept': ${(await bodyText(page)).includes("no search history is kept")}`);

    // ---- Memory searched
    const q = page.getByRole("searchbox", { name: "Search every memory surface" });
    await q.fill("retrieval");
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-hits.png`) });
    const hitsText = await bodyText(page);
    say(`[${profile.name}] hit destinations rendered: openEditor=${hitsText.includes("Open in editor")} openProfile=${hitsText.includes("Open profile memory")}`);
    say(`[${profile.name}] memory hits ${JSON.stringify(await geometry(page, ".memory-hit"))}`);
    say(`[${profile.name}] small targets on memory: ${JSON.stringify((await smallTargets(page)).slice(0, 12))}`);

    // ---- Memory zero
    await q.fill("zzzqqqxyz");
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-zero.png`) });

    // ---- Graph inspector state slot
    await q.fill("");
    await page.waitForTimeout(700);
    await page.locator("#memory-relationships").scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `${profile.name}-memory-graph.png`) });
    const graphText = await bodyText(page);
    say(`[${profile.name}] inspector slot: nothingSelected=${graphText.includes("nothing selected")} selectANode=${graphText.includes("select a node")} footerHelp=${graphText.includes("Pan, zoom, search, or select a node")}`);

    // ---- Index (#context)
    await page.goto(`${base}/#context`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(outDir, `${profile.name}-index.png`) });
    await page.evaluate(() => document.querySelector("#memory-index")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `${profile.name}-index-2.png`) });
    const idxText = await bodyText(page);
    say(`[${profile.name}] index strings: sharedMemoryQueryLabel=${idxText.includes("Shared Memory query")} nothingSearched=${idxText.includes("Nothing searched yet")} searchActiveGen=${idxText.includes("Search the active generation")} bootstrapCaveat=${idxText.includes("not semantic understanding")}`);
    say(`[${profile.name}] index clipping ${JSON.stringify(await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".context-candidate-row, .context-source-row, .context-candidate")];
      const clipped = (el) => el.scrollWidth > el.clientWidth + 1;
      return rows.slice(0, 6).map((r) => ({ h: Math.round(r.getBoundingClientRect().height), clippedKids: [...r.querySelectorAll("*")].filter(clipped).map((k) => k.textContent.slice(0, 30)) }));
    }))}`);
    const clippedLeaves = await page.evaluate(() => [...document.querySelectorAll("main *")].filter((el) => el.children.length === 0 && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.trim().slice(0, 40)).slice(0, 15));
    say(`[${profile.name}] any clipped text nodes on #context: ${JSON.stringify(clippedLeaves)}`);
    say(`[${profile.name}] #context ${JSON.stringify(await geometry(page, "#memory-index"))}`);

    // ---- Sessions
    await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(outDir, `${profile.name}-sessions.png`) });
    say(`[${profile.name}] sessions ${JSON.stringify(await geometry(page, ".session-library-card"))}`);
    say(`[${profile.name}] sessions small targets: ${JSON.stringify((await smallTargets(page)).slice(0, 12))}`);
    say(`[${profile.name}] toolbar ${JSON.stringify(await page.evaluate(() => {
      const bar = document.querySelector(".session-library-toolbar");
      const filters = document.querySelector(".session-library-filters");
      const toggle = document.querySelector(".session-library-filter-toggle");
      return bar ? {
        scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
        height: Math.round(bar.getBoundingClientRect().height),
        toggleVisible: toggle ? getComputedStyle(toggle).display !== "none" : null,
        toggleBox: toggle ? { w: Math.round(toggle.getBoundingClientRect().width), h: Math.round(toggle.getBoundingClientRect().height) } : null,
        filtersDisplay: filters ? getComputedStyle(filters).display : null,
        filterMenus: document.querySelectorAll(".session-filter-menu").length,
        visibleMenus: [...document.querySelectorAll(".session-filter-menu")].filter((m) => m.getBoundingClientRect().width > 0).length,
      } : null;
    }))}`);

    // ---- Sessions filtered to zero, with a selection
    const search = page.locator(".session-library-search input");
    await search.fill("zzqqxx");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(outDir, `${profile.name}-sessions-zero.png`) });
    say(`[${profile.name}] zero-state ${JSON.stringify((await page.locator(".session-library-empty").first().innerText().catch(() => "")).slice(0, 400))}`);
    say(`[${profile.name}] out-of-results strip count=${await page.locator(".session-library-out-of-results").count()}`);
    say(`[${profile.name}] verbs ${JSON.stringify(await page.evaluate(() => {
      const buttons = [...document.querySelectorAll(".session-library-actions button")];
      return buttons.map((b) => ({ text: b.textContent.trim().slice(0, 24), disabled: b.disabled, cls: b.className }));
    }))}`);
    say(`[${profile.name}] detail still shows facts: ${JSON.stringify(await page.evaluate(() => ({
      inspector: !!document.querySelector(".session-library-detail"),
      integrity: !!document.querySelector(".session-integrity"),
      transcript: !!document.querySelector(".session-library-technical"),
    })))}`);

    // ---- Sessions searched with matches (mark)
    await search.fill("vault");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(outDir, `${profile.name}-sessions-search.png`) });
    say(`[${profile.name}] marks=${await page.locator(".session-library-card-top mark").count()} titles=${JSON.stringify((await page.locator(".session-library-card-top strong").allInnerTexts()).slice(0, 5))}`);

    // ---- Keyboard focus visibility on sessions
    await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const focusReport = [];
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName, text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 28),
          outline: cs.outlineStyle === "none" ? null : `${cs.outlineWidth} ${cs.outlineColor}`,
          shadow: cs.boxShadow === "none" ? null : cs.boxShadow.slice(0, 40),
          h: Math.round(r.height),
        };
      });
      if (info) focusReport.push(info);
    }
    say(`[${profile.name}] tab focus ${JSON.stringify(focusReport)}`);
    await context.close();
  }
  await browser.close();
  await writeFile(join(outDir, "audit.log"), log.join("\n"), "utf8");
}
await main();
