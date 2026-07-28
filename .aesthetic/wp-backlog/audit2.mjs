#!/usr/bin/env node
import { chromium, devices } from "@playwright/test";
const base = "http://127.0.0.1:4173";
const say = (l) => console.log(l);

const browser = await chromium.launch();

for (const profile of [
  { name: "desktop", options: { viewport: { width: 1440, height: 900 } } },
  { name: "phone", options: devices["iPhone 14 Pro Max"] },
]) {
  const ctx = await browser.newContext({ ...profile.options });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => say(`[${profile.name}] PAGEERROR ${String(e).slice(0, 200)}`));

  // seed one conversation so memory has content
  await page.goto(`${base}/#chat`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30000 });
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Refactor the retrieval index");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(600);

  // ---- graph inspector state slot
  await page.goto(`${base}/#memory`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const rel = page.locator("#memory-relationships");
  const relOpen = await page.evaluate(() => {
    const d = document.querySelector("#memory-relationships")?.closest("details") ?? document.querySelector("details.memory-disclosure");
    return d ? d.open : null;
  });
  say(`[${profile.name}] relationships details open at rest = ${relOpen}`);
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) {
      if (d.textContent.includes("Relationship")) d.open = true;
    }
  });
  await page.waitForTimeout(900);
  const inspector = await page.evaluate(() => {
    const el = document.querySelector(".memory-detail .panel-heading");
    return el ? el.innerText.replace(/\n/g, " | ") : null;
  });
  say(`[${profile.name}] inspector heading = ${JSON.stringify(inspector)}`);
  await page.screenshot({ path: `.aesthetic/wp-backlog/audit/${profile.name}-graph-open.png` });

  // ---- context empty-state action actually focuses a field
  await page.goto(`${base}/#context`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const emptyButtons = await page.locator(".context-empty__action").allInnerTexts();
  say(`[${profile.name}] context empty actions = ${JSON.stringify(emptyButtons)}`);
  const btn = page.locator(".context-empty__action", { hasText: "Search memory" }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(400);
    say(`[${profile.name}] after 'Search memory' click, activeElement = ${await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)}`);
  } else {
    say(`[${profile.name}] no 'Search memory' button found`);
  }
  // search then check "No local matches" path
  const q = page.getByRole("searchbox", { name: "Search every memory surface" });
  await q.fill("zzqqxxnope");
  await page.waitForTimeout(2200);
  const emptyButtons2 = await page.locator(".context-empty__action").allInnerTexts();
  say(`[${profile.name}] after zero query, context empty actions = ${JSON.stringify(emptyButtons2)}`);
  const noLocal = await page.locator(".context-empty").allInnerTexts();
  say(`[${profile.name}] context empty text = ${JSON.stringify(noLocal.map((t) => t.replace(/\n/g, " | ").slice(0, 220)))}`);

  // ---- phone: open the filters disclosure
  await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  const toggle = page.locator(".session-library-filter-toggle");
  if (profile.name === "phone") {
    await toggle.click();
    await page.waitForTimeout(400);
    say(`[${profile.name}] filters open geometry = ${JSON.stringify(await page.evaluate(() => {
      const bar = document.querySelector(".session-library-toolbar");
      const menus = [...document.querySelectorAll(".session-filter-menu button, .session-filter-menu .menu-select-trigger")];
      return {
        toolbarH: Math.round(bar.getBoundingClientRect().height),
        docScrollWidth: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        menus: menus.map((m) => ({ h: Math.round(m.getBoundingClientRect().height), w: Math.round(m.getBoundingClientRect().width), t: m.textContent.trim().slice(0, 18) })),
      };
    }))}`);
    await page.screenshot({ path: `.aesthetic/wp-backlog/audit/${profile.name}-sessions-filters-open.png` });
    // open one listbox
    const first = page.locator(".session-filter-menu button").first();
    await first.click();
    await page.waitForTimeout(400);
    say(`[${profile.name}] listbox in viewport = ${JSON.stringify(await page.evaluate(() => {
      const lb = document.querySelector("[role=listbox]");
      if (!lb) return null;
      const r = lb.getBoundingClientRect();
      const opts = [...lb.querySelectorAll("[role=option]")].map((o) => Math.round(o.getBoundingClientRect().height));
      return { x: Math.round(r.x), right: Math.round(r.right), vw: window.innerWidth, optionHeights: opts.slice(0, 6) };
    }))}`);
    await page.keyboard.press("Escape");
  }

  // ---- sessions: does the filter count report hidden filters?
  await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  say(`[${profile.name}] toggle label at rest = ${JSON.stringify(await toggle.innerText().catch(() => null))}`);

  // ---- Vault regression check (out of package scope, requested)
  await page.goto(`${base}/#vault`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const vaultText = await page.evaluate(() => document.body.innerText);
  say(`[${profile.name}] vault: adopted=${/adopt/i.test(vaultText)} verified=${/verified/i.test(vaultText)} contract=${/contract/i.test(vaultText)}`);
  say(`[${profile.name}] vault snippet = ${JSON.stringify(vaultText.replace(/\n+/g, " | ").slice(0, 700))}`);
  await page.screenshot({ path: `.aesthetic/wp-backlog/audit/${profile.name}-vault.png` });

  await ctx.close();
}
await browser.close();
