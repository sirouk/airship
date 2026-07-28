import { mkdir } from "node:fs/promises";
import { chromium, devices } from "playwright";

const out = process.argv[2] ?? ".aesthetic/wp-backlog/before";
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const report = [];

async function open(spec) {
  const { name, ...options } = spec;
  const context = await browser.newContext({ ...options, colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "default", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
  await page.goto("http://localhost:4173/#workspace", { waitUntil: "networkidle" });
  await page.waitForSelector('[role="tree"][aria-label="Workspace files"]', { timeout: 30_000 });
  await page.waitForTimeout(500);
  return { name, context, page };
}

// 1. Desktop: folder context menu contents.
{
  const { page, context } = await open({ name: "desktop", viewport: { width: 1440, height: 900 } });
  const folder = page.locator(".tree-row", { hasText: "notes" }).first();
  await folder.click({ button: "right" });
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => {
    const node = document.querySelector(".workbench-context");
    if (!node) return null;
    return {
      items: [...node.querySelectorAll("button")].map((b) => b.textContent),
      hint: node.querySelector("p")?.textContent,
    };
  });
  report.push({ probe: "folder-context-menu", menu });
  await page.screenshot({ path: `${out}/desktop-folder-context.png` });
  await page.keyboard.press("Escape");

  const file = page.locator(".tree-row", { hasText: "README.md" }).first();
  await file.click({ button: "right" });
  await page.waitForTimeout(300);
  const fileMenu = await page.evaluate(() => [...document.querySelectorAll(".workbench-context button")].map((b) => b.textContent));
  report.push({ probe: "file-context-menu", items: fileMenu });
  await page.screenshot({ path: `${out}/desktop-file-context.png` });
  await page.keyboard.press("Escape");

  // sub-44 targets across the workbench
  const small = await page.evaluate(() => [...document.querySelectorAll("button, a, input, [role=option], [role=menuitem]")]
    .map((n) => ({ t: (n.textContent || n.getAttribute("aria-label") || "").trim().slice(0, 40), h: Math.round(n.getBoundingClientRect().height), w: Math.round(n.getBoundingClientRect().width), c: n.className }))
    .filter((n) => n.h > 0 && n.h < 44));
  report.push({ probe: "desktop-sub44", count: small.length });
  await context.close();
}

// 2. Sources tab — duplication scan.
{
  const { page, context } = await open({ name: "sources", viewport: { width: 1440, height: 900 } });
  await page.getByRole("tab", { name: /Sources/u }).click();
  await page.waitForTimeout(1500);
  const dup = await page.evaluate(() => {
    const text = document.querySelector("main")?.innerText ?? "";
    const count = (needle) => text.split(needle).length - 1;
    return {
      ephemeralThisPageOnly: count("Ephemeral · this page only"),
      cspSentence: count("isomorphic-git speaks Smart HTTP"),
      words: text.split(/\s+/u).filter(Boolean).length,
      height: Math.round(document.querySelector("main")?.scrollHeight ?? 0),
      client: Math.round(document.querySelector("main")?.clientHeight ?? 0),
    };
  });
  report.push({ probe: "sources-duplication", dup });
  await page.screenshot({ path: `${out}/desktop-sources.png`, fullPage: true });
  await context.close();
}

// 3. Nine tabs in the editor strip.
{
  const { page, context } = await open({ name: "tabs", viewport: { width: 1440, height: 900 } });
  const rows = await page.locator(".tree-row").all();
  for (const row of rows) {
    const label = await row.getAttribute("aria-level");
    if (label === null) continue;
    const text = (await row.textContent()) ?? "";
    if (/\.md|\.ts|\.json/u.test(text)) await row.click();
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
  const strip = await page.evaluate(() => {
    const s = document.querySelector(".editor-tabs .tabs__strip");
    if (!s) return null;
    return { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth, edges: s.dataset.scrollEdges, overflow: document.querySelector(".tabs__overflow-trigger")?.textContent };
  });
  report.push({ probe: "editor-tabs", strip });
  await page.screenshot({ path: `${out}/desktop-tabs.png` });
  await context.close();
}

// 4. Phone.
{
  const { page, context } = await open({ name: "iphone", ...devices["iPhone 14 Pro Max"] });
  await page.screenshot({ path: `${out}/iphone-tree.png` });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  report.push({ probe: "iphone-overflow-x", overflowX });
  await context.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
