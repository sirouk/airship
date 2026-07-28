import { mkdir } from "node:fs/promises";
import { chromium, devices } from "playwright";

const out = ".aesthetic/wp-workbench/probe";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const log = [];

// ── Desktop: filter, notice lifetime, tab overflow, rail splitter ───────────
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await page.goto("http://localhost:4173/#workspace", { waitUntil: "networkidle" });
  await page.waitForSelector('[role="tree"][aria-label="Workspace files"]');
  await page.getByRole("button", { name: /About Workspace/u }).click().catch(() => {});

  // Filter
  await page.getByRole("searchbox", { name: "Filter workspace files by path" }).fill("arch");
  await page.waitForTimeout(300);
  log.push({ check: "filter count", text: await page.locator(".workspace-filter-count").innerText(), rows: await page.locator(".tree-row").count() });
  await page.screenshot({ path: `${out}/desktop-filter.png` });
  await page.getByRole("searchbox", { name: "Filter workspace files by path" }).fill("");
  await page.waitForTimeout(200);

  // Create nine files so the tab strip must overflow, and watch the notice.
  for (let index = 0; index < 9; index += 1) {
    await page.getByRole("button", { name: /New file/u }).first().click();
    const dialog = page.getByRole("dialog", { name: "create workspace file" });
    await dialog.getByRole("textbox").fill(`src/runtime/really-long-component-name-panel-${String(index)}.tsx`);
    await dialog.getByRole("button", { name: "Apply" }).click();
    await page.waitForTimeout(260);
    if (index === 0) log.push({ check: "notice while creating", text: await page.locator(".workbench-notice").innerText().catch(() => "(none)") });
  }
  await page.waitForTimeout(7000);
  log.push({ check: "notice 7s after the last create settled", text: await page.locator(".workbench-notice").innerText().catch(() => "(cleared)") });

  const strip = await page.evaluate(() => {
    const s = document.querySelector(".tabs.editor-tabs .tabs__strip");
    const overflow = document.querySelector(".tabs.editor-tabs .tabs__overflow-trigger");
    const active = document.querySelector('.tabs.editor-tabs .tabs__tab[data-active="true"]');
    return {
      scrollWidth: s?.scrollWidth, clientWidth: s?.clientWidth, edges: s?.dataset.scrollEdges,
      overflowLabel: overflow?.getAttribute("aria-label"),
      activeInView: active && s ? active.getBoundingClientRect().left >= s.getBoundingClientRect().left - 1
        && active.getBoundingClientRect().right <= s.getBoundingClientRect().right + 1 : null,
    };
  });
  log.push({ check: "tab strip", ...strip });
  await page.screenshot({ path: `${out}/desktop-nine-tabs.png` });

  // Rail separator, by keyboard only.
  const before = await page.locator(".workbench-activity").evaluate((n) => n.getBoundingClientRect().width);
  await page.getByRole("separator", { name: "Explorer width" }).focus();
  for (let index = 0; index < 8; index += 1) await page.keyboard.press("ArrowRight");
  const after = await page.locator(".workbench-activity").evaluate((n) => n.getBoundingClientRect().width);
  log.push({ check: "rail resize by keyboard", before, after });
  await page.keyboard.press("Home");
  await page.screenshot({ path: `${out}/desktop-rail-home.png` });
  await page.close();
}

// ── Phone: #editor lands in the editor, and the strip keeps rev + bytes ─────
{
  const context = await browser.newContext({ ...devices["iPhone 14 Pro Max"], colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto("http://localhost:4173/#workspace", { waitUntil: "networkidle" });
  await page.waitForSelector('[role="tree"]');
  await page.getByRole("treeitem", { name: /README\.md/u }).click();
  await page.waitForTimeout(600);
  log.push({
    check: "phone file strip",
    text: (await page.locator(".editor-strip").innerText()).replace(/\n/gu, " | "),
    box: await page.locator(".editor-strip").evaluate((n) => { const b = n.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), viewport: innerHeight }; }),
  });
  await page.screenshot({ path: `${out}/phone-editor.png` });

  // Context menu on a folder, and the dialog's Escape.
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Actions for notes" }).click();
  await page.waitForTimeout(200);
  log.push({ check: "folder menu", items: await page.locator(".workbench-context [role=menuitem]").allInnerTexts(), hint: await page.locator(".workbench-context__hint").innerText() });
  await page.screenshot({ path: `${out}/phone-context.png` });
  await page.close();
  await context.close();
}

await browser.close();
console.log(JSON.stringify(log, null, 2));
