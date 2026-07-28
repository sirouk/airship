#!/usr/bin/env node
/**
 * Vault / Profiles / Account capture harness.
 * Usage: node .aesthetic/wp-vault-account/capture.mjs <outDir> [baseUrl]
 *
 * Drives the real lab (MinIO on 127.0.0.1:9900) and, when
 * AIRSHIP_CHUTES_KEY is exported, a real Chutes account read. The key is
 * read from the environment and never written to disk by this script.
 */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".aesthetic/wp-vault-account/before";
const baseUrl = (process.argv[3] ?? "http://127.0.0.1:4173").replace(/\/$/, "");
const CHUTES_KEY = process.env.AIRSHIP_CHUTES_KEY ?? "";

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", ...devices["iPhone 14 Pro Max"] },
];

const PREFERENCES = (backend) => JSON.stringify({
  mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle",
  bodyFont: "system-sans", vaultBackend: backend, approvalMode: "ask-first",
});

/**
 * Chrome band = everything above the first piece of route content, measured
 * against the visible viewport rather than the scroll height.
 */
const measure = () => {
  const round = (v) => Math.round(v * 10) / 10;
  const main = document.querySelector("main.main") ?? document.querySelector("main");
  const mainBox = main?.getBoundingClientRect();
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { top: round(box.top), height: round(box.height), width: round(box.width) };
  };
  const header = main?.querySelector(".route-header, .vault-view__bar, .page-heading, .billing-heading");
  const headerBox = header?.getBoundingClientRect();
  const chrome = headerBox && mainBox ? round(headerBox.bottom - mainBox.top) : null;
  const firstControl = [...(main?.querySelectorAll("button, input, select, summary, [role=radio], a[href]") ?? [])]
    .map((node) => ({ node, box: node.getBoundingClientRect() }))
    .filter((item) => item.box.height > 0 && item.box.width > 0)[0];
  const small = [...(main?.querySelectorAll("button, input, summary, [role=tab], [role=radio], a[href], label") ?? [])]
    .filter((n) => !n.querySelector("button, input, a[href]"))
    .map((node) => ({
      label: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 44),
      h: Math.round(node.getBoundingClientRect().height),
    }))
    .filter((item) => item.h > 0 && item.h < 44);
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    chromeBandPx: chrome,
    chromeBandPct: chrome === null ? null : round((chrome / window.innerHeight) * 100),
    mainClientHeight: main?.clientHeight ?? 0,
    mainScrollHeight: main?.scrollHeight ?? 0,
    screens: main ? round((main.scrollHeight ?? 0) / (main.clientHeight || 1)) : null,
    firstControl: firstControl
      ? {
        label: (firstControl.node.getAttribute("aria-label") ?? firstControl.node.textContent ?? "").trim().slice(0, 48),
        y: round(firstControl.box.top - (mainBox?.top ?? 0) + (main?.scrollTop ?? 0)),
      }
      : null,
    boxes: {
      routeHeader: rect(".route-header"),
      vaultBar: rect(".vault-view__bar"),
      vaultState: rect(".vault-view__state"),
      chooser: rect(".vault-provider-selector"),
      configuration: rect(".vault-view__configuration"),
      evidence: rect(".vault-view__evidence"),
      ceremony: rect(".local-device-vault__ceremony"),
      localLab: rect(".local-lab"),
      drive: rect(".google-drive-setup"),
      gate: rect(".billing-gate"),
      metrics: rect(".billing-metric-strip"),
      profileCatalog: rect(".profile-catalog"),
      governs: rect(".profile-governs"),
    },
    phase: document.querySelector(".vault-view__phase")?.textContent ?? null,
    stateHeadline: document.querySelector(".vault-view__state strong")?.textContent ?? null,
    smallTargets: small,
    overflow: {
      document: document.documentElement.scrollWidth - window.innerWidth,
      main: (main?.scrollWidth ?? 0) - (main?.clientWidth ?? 0),
    },
  };
};

async function shoot(page, name, report, options = {}) {
  await page.waitForTimeout(options.settle ?? 700);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false, animations: "disabled" });
  if (options.full) {
    await page.screenshot({ path: join(outDir, `${name}-full.png`), fullPage: true, animations: "disabled" });
  }
  report[name] = await page.evaluate(measure);
}

async function connectChutes(page) {
  if (!CHUTES_KEY) return false;
  await page.goto(`${baseUrl}/#connection`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const lane = page.locator('.connect-lane[data-lane="chutes"]');
  if (await lane.count()) {
    const open = await lane.getAttribute("data-open");
    if (open !== "true") await lane.locator("summary, .connect-lane__header button").first().click().catch(() => {});
  }
  await page.waitForTimeout(500);
  const tab = page.getByRole("tab", { name: /^API key/u });
  if (await tab.count()) await tab.first().click();
  await page.waitForTimeout(400);
  const field = page.locator('input[name="chutes-api-key"]');
  if (!(await field.count())) return false;
  await field.fill(CHUTES_KEY);
  const submit = page.getByRole("button", { name: "Discover models with key" });
  if (await submit.count()) await submit.first().click();
  await page.waitForTimeout(14_000);
  const finish = page.getByRole("button", { name: /^Finish: verify & connect/u });
  if (!(await finish.count())) return false;
  await finish.first().click();
  await page.waitForTimeout(16_000);
  return true;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const report = {};
  const log = [];

  for (const profile of VIEWPORTS) {
    const newContext = async (backend) => {
      const context = await browser.newContext({ ...profile, name: undefined });
      await context.addInitScript(
        `localStorage.setItem("airship.display-preferences.v1", ${JSON.stringify(PREFERENCES(backend))})`,
      );
      return context;
    };

    // ---- Vault: ephemeral ----
    try {
      const context = await newContext("ephemeral");
      const page = await context.newPage();
      page.on("pageerror", (e) => log.push(`[${profile.name}/ephemeral] ${String(e).slice(0, 200)}`));
      await page.goto(`${baseUrl}/#vault`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await shoot(page, `${profile.name}-vault-ephemeral`, report, { full: true });
      await context.close();
    } catch (error) { log.push(`[${profile.name}] ephemeral ${String(error).slice(0, 300)}`); }

    // ---- Vault: local device + ceremony ----
    try {
      const context = await newContext("local-device");
      const page = await context.newPage();
      page.on("pageerror", (e) => log.push(`[${profile.name}/local-device] ${String(e).slice(0, 200)}`));
      await page.goto(`${baseUrl}/#vault`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await shoot(page, `${profile.name}-vault-local-device`, report, { full: true });
      const create = page.getByRole("button", { name: "Create new" });
      if (await create.count()) {
        await create.first().click();
        await shoot(page, `${profile.name}-vault-ceremony`, report, { settle: 1400, full: true });
      }
      await context.close();
    } catch (error) { log.push(`[${profile.name}] local-device ${String(error).slice(0, 300)}`); }

    // ---- Vault: Google Drive with no client id ----
    try {
      const context = await newContext("local-device");
      const page = await context.newPage();
      await page.goto(`${baseUrl}/#vault`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      const picker = page.getByRole("button", { name: "Vault storage provider" });
      if (await picker.count()) {
        await picker.first().click();
        await page.getByRole("option", { name: /^Google Drive/u }).first().click();
        await page.waitForTimeout(2500);
        await shoot(page, `${profile.name}-vault-drive-unavailable`, report, { settle: 900, full: true });
        await page.evaluate(() => document.querySelector(".google-drive-setup")?.scrollIntoView({ block: "start" }));
        await shoot(page, `${profile.name}-vault-drive-panel`, report, { settle: 500 });
      }
      await context.close();
    } catch (error) { log.push(`[${profile.name}] drive ${String(error).slice(0, 300)}`); }

    // ---- Vault: MinIO end to end ----
    try {
      const context = await newContext("ephemeral");
      const page = await context.newPage();
      page.on("pageerror", (e) => log.push(`[${profile.name}/local-lab] ${String(e).slice(0, 200)}`));
      await page.goto(`${baseUrl}/#vault`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.getByRole("button", { name: "Vault storage provider" }).click();
      await page.getByRole("option", { name: /^S3-compatible/u }).click();
      await page.waitForTimeout(3000);
      await page.evaluate(() => document.querySelector(".local-lab")?.scrollIntoView({ block: "start" }));
      await shoot(page, `${profile.name}-vault-lab-form`, report, { settle: 700, full: true });
      await page.getByRole("button", { name: "Generate one-time recovery key" }).click();
      await page.waitForTimeout(900);
      await page.getByRole("checkbox", { name: /I own this loopback service/u }).check();
      await page.getByRole("checkbox", { name: /I saved the generated recovery key/u }).check();
      await page.getByRole("button", { name: "Hand off to memory-only vault" }).click();
      await page.waitForTimeout(2500);
      await page.evaluate(() => { const m = document.querySelector("main.main"); if (m) m.scrollTop = 0; });
      await shoot(page, `${profile.name}-vault-lab-configured`, report, { settle: 700, full: true });
      const probe = page.getByRole("button", { name: "Run live probe" });
      if (await probe.count()) {
        await probe.first().click();
        await page.waitForTimeout(1500);
        const allow = page.getByRole("button", { name: /Allow|Approve/u });
        if (await allow.count()) await allow.first().click();
        await page.waitForTimeout(14_000);
      }
      await page.evaluate(() => { const m = document.querySelector("main.main"); if (m) m.scrollTop = 0; });
      await shoot(page, `${profile.name}-vault-lab-connected`, report, { settle: 900, full: true });
      await context.close();
    } catch (error) { log.push(`[${profile.name}] local-lab ${String(error).slice(0, 300)}`); }

    // ---- Profiles ----
    try {
      const context = await newContext("ephemeral");
      const page = await context.newPage();
      page.on("pageerror", (e) => log.push(`[${profile.name}/profiles] ${String(e).slice(0, 200)}`));
      await page.goto(`${baseUrl}/#profiles`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await shoot(page, `${profile.name}-profiles`, report, { full: true });
      await context.close();
    } catch (error) { log.push(`[${profile.name}] profiles ${String(error).slice(0, 300)}`); }

    // ---- Account: disconnected ----
    try {
      const context = await newContext("ephemeral");
      const page = await context.newPage();
      page.on("pageerror", (e) => log.push(`[${profile.name}/account] ${String(e).slice(0, 200)}`));
      await page.goto(`${baseUrl}/#account`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
      await shoot(page, `${profile.name}-account-disconnected`, report, { full: true });
      await context.close();
    } catch (error) { log.push(`[${profile.name}] account ${String(error).slice(0, 300)}`); }

    // ---- Account: connected with a live key ----
    if (CHUTES_KEY) {
      try {
        const context = await newContext("ephemeral");
        const page = await context.newPage();
        page.on("pageerror", (e) => log.push(`[${profile.name}/account-live] ${String(e).slice(0, 200)}`));
        const connected = await connectChutes(page);
        if (connected) {
          await page.goto(`${baseUrl}/#account`, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(8000);
          await shoot(page, `${profile.name}-account-connected`, report, { settle: 1500, full: true });
        } else {
          log.push(`[${profile.name}] account-live: could not reach the API key field`);
        }
        await context.close();
      } catch (error) { log.push(`[${profile.name}] account-live ${String(error).slice(0, 300)}`); }
    }
  }

  await browser.close();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "log.txt"), log.join("\n"));
  console.log(log.join("\n") || "(no log entries)");
  for (const [name, value] of Object.entries(report)) {
    console.log(`${name}: chrome ${value.chromeBandPx}px (${value.chromeBandPct}%) · screens ${value.screens} · overflow ${value.overflow.document}/${value.overflow.main} · small ${value.smallTargets.length} · phase ${value.phase ?? "-"}`);
  }
}

await main();
