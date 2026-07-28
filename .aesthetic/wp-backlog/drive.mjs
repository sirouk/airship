import { mkdir } from "node:fs/promises";
import { chromium, devices } from "playwright";

const out = process.argv[2] ?? ".aesthetic/wp-backlog/after";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const report = [];

async function open(spec) {
  const { name, ...options } = spec;
  const context = await browser.newContext({ ...options, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.push({ probe: "pageerror", name, message: error.message }));
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "default", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "full-access",
  })));
  await page.goto("http://localhost:4173/#workspace", { waitUntil: "networkidle" });
  await page.waitForSelector('[role="tree"][aria-label="Workspace files"]', { timeout: 30_000 });
  await page.waitForTimeout(500);
  return { name, context, page };
}

const rows = (page) => page.locator(".tree-row");
const treeText = (page) => page.evaluate(() => [...document.querySelectorAll(".tree-row")].map((n) => n.textContent.trim()));

// ── Desktop: folder menu, create folder, rename folder, delete folder ───────
{
  const { page, context } = await open({ name: "desktop", viewport: { width: 1440, height: 900 } });

  await rows(page).filter({ hasText: "notes" }).first().click({ button: "right" });
  await page.waitForTimeout(250);
  report.push({ probe: "folder-menu", items: await page.evaluate(() => [...document.querySelectorAll(".workbench-context button")].map((b) => b.textContent)) });
  await page.screenshot({ path: `${out}/desktop-folder-menu.png` });

  // New folder…
  await page.getByRole("menuitem", { name: "New folder…" }).click();
  await page.waitForTimeout(300);
  report.push({
    probe: "create-folder-dialog",
    heading: await page.locator(".workbench-dialog h2").textContent(),
    accessibleName: await page.locator(".workbench-dialog").getAttribute("aria-labelledby") ? await page.evaluate(() => {
      const d = document.querySelector(".workbench-dialog");
      return document.getElementById(d.getAttribute("aria-labelledby"))?.textContent;
    }) : null,
    body: (await page.locator(".workbench-dialog").innerText()).replace(/\n+/gu, " | "),
    confirm: await page.locator(".workbench-dialog .primary").textContent(),
    confirmDisabled: await page.locator(".workbench-dialog .primary").isDisabled(),
  });
  await page.screenshot({ path: `${out}/desktop-create-folder.png` });

  // invalid name → visible reason
  await page.locator(".workbench-dialog input").fill("a/b");
  await page.waitForTimeout(150);
  report.push({ probe: "name-error", text: await page.locator(".workbench-dialog__error").textContent(), disabled: await page.locator(".workbench-dialog .primary").isDisabled() });
  await page.screenshot({ path: `${out}/desktop-name-error.png` });

  await page.locator(".workbench-dialog input").fill("2026");
  await page.locator(".workbench-dialog .primary").click();
  await page.waitForTimeout(1200);
  report.push({ probe: "after-create-folder", tree: await treeText(page), notice: await page.locator(".workbench-notice p").textContent().catch(() => null) });
  await page.screenshot({ path: `${out}/desktop-after-create-folder.png` });

  // Escape closes the dialog (a11y regression check on the new kinds)
  await rows(page).filter({ hasText: "2026" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: "Rename folder…" }).click();
  await page.waitForTimeout(300);
  report.push({ probe: "rename-folder-dialog", heading: await page.locator(".workbench-dialog h2").textContent(), body: (await page.locator(".workbench-dialog").innerText()).replace(/\n+/gu, " | "), confirm: await page.locator(".workbench-dialog .primary").textContent() });
  await page.screenshot({ path: `${out}/desktop-rename-folder.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  report.push({ probe: "escape-closes-rename-folder", open: await page.locator(".workbench-dialog").count() });

  // Rename the folder for real.
  await rows(page).filter({ hasText: "notes" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: "Rename folder…" }).click();
  await page.waitForTimeout(250);
  await page.locator(".workbench-dialog input").fill("journal");
  await page.locator(".workbench-dialog .primary").click();
  await page.waitForTimeout(1800);
  report.push({ probe: "after-rename-folder", tree: await treeText(page), notice: await page.locator(".workbench-notice p").textContent().catch(() => null) });
  await page.screenshot({ path: `${out}/desktop-after-rename-folder.png` });

  // Delete a folder.
  await rows(page).filter({ hasText: "journal" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: "Delete folder…" }).click();
  await page.waitForTimeout(300);
  report.push({ probe: "delete-folder-dialog", heading: await page.locator(".workbench-dialog h2").textContent(), body: (await page.locator(".workbench-dialog").innerText()).replace(/\n+/gu, " | "), confirm: await page.locator(".workbench-dialog .danger").last().textContent() });
  await page.screenshot({ path: `${out}/desktop-delete-folder.png` });
  await page.locator(".workbench-dialog .danger").last().click();
  await page.waitForTimeout(1800);
  report.push({ probe: "after-delete-folder", tree: await treeText(page), notice: await page.locator(".workbench-notice p").textContent().catch(() => null) });
  await page.screenshot({ path: `${out}/desktop-after-delete-folder.png` });

  // Desktop editor: wrap off by default, gutter present.
  await rows(page).filter({ hasText: "README.md" }).first().click();
  await page.waitForTimeout(900);
  report.push({ probe: "desktop-editor", ...(await page.evaluate(() => {
    const ta = document.querySelector(".code-editor");
    const wrapButton = document.querySelector(".editor-strip__wrap");
    return {
      wrapAttr: ta?.dataset.wrap,
      whiteSpace: ta ? getComputedStyle(ta).whiteSpace : null,
      gutter: Boolean(document.querySelector(".code-gutter")),
      pressed: wrapButton?.getAttribute("aria-pressed"),
      meta: document.querySelector(".editor-strip__meta")?.innerText.replace(/\n/gu, " | "),
      overflowX: ta ? ta.scrollWidth - ta.clientWidth : null,
    };
  })) });
  await page.locator(".editor-strip__wrap").click();
  await page.waitForTimeout(400);
  report.push({ probe: "desktop-editor-wrapped", ...(await page.evaluate(() => {
    const ta = document.querySelector(".code-editor");
    return {
      whiteSpace: getComputedStyle(ta).whiteSpace,
      gutter: Boolean(document.querySelector(".code-gutter")),
      pressed: document.querySelector(".editor-strip__wrap")?.getAttribute("aria-pressed"),
      meta: document.querySelector(".editor-strip__meta")?.innerText.replace(/\n/gu, " | "),
      overflowX: ta.scrollWidth - ta.clientWidth,
    };
  })) });
  await page.screenshot({ path: `${out}/desktop-editor-wrapped.png` });
  await context.close();
}

// ── Phone: wrap defaults on, targets, overflow ─────────────────────────────
{
  const { page, context } = await open({ name: "iphone", ...devices["iPhone 14 Pro Max"] });
  await page.screenshot({ path: `${out}/iphone-tree.png` });
  await rows(page).filter({ hasText: "README.md" }).first().click();
  await page.waitForTimeout(1200);
  report.push({ probe: "iphone-editor", ...(await page.evaluate(() => {
    const ta = document.querySelector(".code-editor");
    return {
      whiteSpace: ta ? getComputedStyle(ta).whiteSpace : null,
      pressed: document.querySelector(".editor-strip__wrap")?.getAttribute("aria-pressed"),
      meta: document.querySelector(".editor-strip__meta")?.innerText.replace(/\n/gu, " | "),
      overflowX: ta ? ta.scrollWidth - ta.clientWidth : null,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })) });
  await page.screenshot({ path: `${out}/iphone-editor.png` });

  const small = await page.evaluate(() => [...document.querySelectorAll("button, a, input, [role=option], [role=menuitem]")]
    .map((n) => ({ t: (n.textContent || n.getAttribute("aria-label") || "").trim().slice(0, 40), h: Math.round(n.getBoundingClientRect().height), c: n.className }))
    .filter((n) => n.h > 0 && n.h < 44));
  report.push({ probe: "iphone-sub44", count: small.length, items: small.slice(0, 12) });
  await context.close();
}

// ── Tablet (coarse pointer, 834px): the new buttons must be 44px ────────────
{
  const { page, context } = await open({ name: "ipad", ...devices["iPad Pro 11"] });
  await page.screenshot({ path: `${out}/ipad-tree.png` });
  report.push({ probe: "ipad-new-buttons", sizes: await page.evaluate(() => [...document.querySelectorAll(".workspace-new")].map((n) => ({ t: n.textContent.trim(), h: Math.round(n.getBoundingClientRect().height) }))) });
  await context.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
