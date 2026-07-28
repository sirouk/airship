import { mkdir } from "node:fs/promises";
import { chromium, devices } from "playwright";

const phase = process.argv[2] ?? "after";
const out = `.aesthetic/wp-workbench/${phase}`;
await mkdir(out, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: "ipad", ...devices["iPad Pro 11"] },
  { name: "iphone", ...devices["iPhone 14 Pro Max"] },
];

const browser = await chromium.launch();
const report = [];

for (const spec of VIEWPORTS) {
  const { name, ...options } = spec;
  const context = await browser.newContext({ ...options, colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "default", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
  await page.goto("http://localhost:4173/#workspace", { waitUntil: "networkidle" });
  await page.waitForSelector('[role="tree"][aria-label="Workspace files"]', { timeout: 30_000 });
  await page.waitForTimeout(600);

  const measure = async (label) => {
    const data = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height), width: Math.round(box.width) };
      };
      const shell = rect(".workbench-shell");
      const rows = [...document.querySelectorAll(".tree-row")].filter((node) => {
        const box = node.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= innerHeight && box.height > 0;
      }).length;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        chromeAbove: shell ? shell.top : null,
        shell,
        strip: rect(".editor-strip") ?? rect(".editor-status"),
        toolbar: rect(".editor-toolbar"),
        rail: rect(".workbench-activity"),
        code: rect(".code-editor"),
        tree: rect(".workspace-tree"),
        routeHeader: rect(".route-header") ?? rect(".workspace-heading"),
        visibleFileRows: rows,
        documentOverflow: Math.round(document.querySelector("main")?.scrollHeight ?? 0) - Math.round(document.querySelector("main")?.clientHeight ?? 0),
      };
    });
    report.push({ device: name, label, ...data });
    await page.screenshot({ path: `${out}/${name}-${label}.png` });
  };

  await measure("tree");

  // Open a file so the editor pane, its tabs and the file strip are on screen.
  const file = page.getByRole("treeitem", { name: /architecture\.md/u }).first();
  if (await file.count()) {
    await file.click();
    await page.waitForTimeout(700);
    await measure("file");
  }
  await context.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
