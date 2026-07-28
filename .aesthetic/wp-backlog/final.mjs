import { mkdir } from "node:fs/promises";
import { chromium, devices } from "playwright";
const out = ".aesthetic/wp-backlog/final";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const report = [];
async function open(spec) {
  const { name, ...options } = spec;
  const context = await browser.newContext({ ...options, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.push({ probe: "pageerror", name, message: e.message }));
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "default", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access" })));
  await page.goto("http://localhost:4173/#workspace", { waitUntil: "networkidle" });
  await page.waitForSelector('[role="tree"][aria-label="Workspace files"]', { timeout: 30_000 });
  await page.waitForTimeout(500);
  return { name, context, page };
}
for (const spec of [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "ipad", ...devices["iPad Pro 11"] },
  { name: "iphone", ...devices["iPhone 14 Pro Max"] },
]) {
  const { name, page, context } = await open(spec);
  // Keyboard-only: reach the folder menu and open New folder, check focus ring + trap.
  const notes = page.locator(".tree-row").filter({ hasText: "notes" }).first();
  await notes.focus();
  await page.keyboard.press("Shift+F10");
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: "New folder…" }).click();
  await page.waitForTimeout(350);
  const focus = await page.evaluate(() => {
    const a = document.activeElement;
    const dialog = document.querySelector(".workbench-dialog");
    return { tag: a?.tagName, insideDialog: Boolean(dialog?.contains(a)), ring: a ? getComputedStyle(a).outlineStyle + " " + getComputedStyle(a).boxShadow.slice(0, 24) : null };
  });
  // Tab all the way round: focus must never leave the dialog.
  let escaped = false;
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => document.querySelector(".workbench-dialog")?.contains(document.activeElement)))) { escaped = true; break; }
  }
  await page.screenshot({ path: `${out}/${name}-create-folder.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const returned = await page.evaluate(() => ({ dialog: document.querySelectorAll(".workbench-dialog").length, focus: document.activeElement?.className }));
  report.push({ probe: "keyboard", device: name, focusOnOpen: focus, focusEscapedTrap: escaped, afterEscape: returned });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  report.push({ probe: "overflow-x", device: name, overflowX });
  await page.screenshot({ path: `${out}/${name}-tree.png` });
  await context.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
