#!/usr/bin/env node
/**
 * Vault-route capture harness (WP: vault and storage).
 * Usage: node .aesthetic/vault/capture.mjs <outDir> [baseUrl]
 * Drives the real lab. Never writes a credential to disk.
 */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".aesthetic/vault/before";
const baseUrl = (process.argv[3] ?? "http://127.0.0.1:4173").replace(/\/$/, "");

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "tablet", ...devices["iPad Pro 11"] },
  { name: "phone", ...devices["iPhone 14 Pro Max"] },
];

const measure = () => {
  const round = (value) => Math.round(value * 10) / 10;
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { top: round(box.top), height: round(box.height), width: round(box.width) };
  };
  const main = document.querySelector("main.main") ?? document.querySelector("main");
  const mainBox = main?.getBoundingClientRect();
  const firstControl = [...(main?.querySelectorAll("button, input, select, summary, [role=radio]") ?? [])]
    .map((node) => ({ node, box: node.getBoundingClientRect() }))
    .filter((item) => item.box.height > 0 && item.box.width > 0)[0];
  const text = document.body.innerText;
  const count = (needle) => text.split(needle).length - 1;
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    main: mainBox ? { top: round(mainBox.top), height: round(mainBox.height) } : null,
    mainClientHeight: main?.clientHeight ?? 0,
    mainScrollHeight: main?.scrollHeight ?? 0,
    firstControl: firstControl
      ? {
        label: (firstControl.node.getAttribute("aria-label") ?? firstControl.node.textContent ?? "").trim().slice(0, 48),
        y: round(firstControl.box.top - (mainBox?.top ?? 0) + (main?.scrollTop ?? 0)),
      }
      : null,
    boxes: {
      header: rect(".vault-view__header"),
      bar: rect(".vault-view__bar"),
      chooser: rect(".vault-provider-selector"),
      truth: rect(".vault-view__truth"),
      state: rect(".vault-view__state"),
      empty: rect(".vault-view__empty"),
      configuration: rect(".vault-view__configuration"),
      evidence: rect(".vault-view__evidence"),
      context: rect(".vault-view__context"),
      localDevice: rect(".local-device-vault"),
      localDeviceHeader: rect(".local-device-vault__header"),
      ceremony: rect(".local-device-vault__ceremony"),
      localLab: rect(".local-lab"),
      drive: rect(".google-drive-setup"),
      setupSlot: rect(".vault-setup-slot"),
    },
    notConnectedRestatements: {
      disconnected: count("Disconnected"),
      ephemeral: count("Ephemeral"),
      notOpened: count("Not opened"),
      noAttachment: count("No endpoint, credential authority, or workspace key is attached."),
    },
    smallTargets: [...(main?.querySelectorAll("button, input, summary, [role=tab], [role=radio], label") ?? [])]
      .map((node) => ({
        label: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 40),
        h: Math.round(node.getBoundingClientRect().height),
      }))
      .filter((item) => item.h > 0 && item.h < 44),
    overflow: {
      document: document.documentElement.scrollWidth - window.innerWidth,
      main: (main?.scrollWidth ?? 0) - (main?.clientWidth ?? 0),
    },
  };
};

const PREFERENCES = (backend) => JSON.stringify({
  mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle",
  bodyFont: "system-sans", vaultBackend: backend, approvalMode: "ask-first",
});

async function scrollTo(page, selector) {
  await page.evaluate((target) => {
    const node = document.querySelector(target);
    node?.scrollIntoView({ block: "start" });
  }, selector);
}

async function shoot(page, out, name, report, options = {}) {
  await page.waitForTimeout(options.settle ?? 800);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: Boolean(options.fullPage), animations: "disabled" });
  report[name] = await page.evaluate(measure);
  report[name].url = page.url();
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const report = {};
  const log = [];

  for (const profile of VIEWPORTS) {
    for (const backend of ["local-lab", "local-device", "google-drive", "ephemeral"]) {
      const context = await browser.newContext({ ...profile, name: undefined });
      await context.addInitScript(`localStorage.setItem("airship.display-preferences.v1", ${JSON.stringify(PREFERENCES(backend))})`);
      const page = await context.newPage();
      page.on("pageerror", (error) => log.push(`[${profile.name}/${backend}] pageerror: ${String(error).slice(0, 300)}`));
      try {
        await page.goto(`${baseUrl}/#vault`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(backend === "local-lab" ? 9000 : 3500);
        await shoot(page, outDir, `${profile.name}-${backend}`, report);
        if (backend === "local-lab") {
          await scrollTo(page, ".vault-view__evidence");
          await shoot(page, outDir, `${profile.name}-evidence`, report, { settle: 400 });
          await page.evaluate(() => { const m = document.querySelector("main.main"); if (m) m.scrollTop = 0; });
        }
        if (backend === "google-drive") {
          // The build has no Google client ID, so a seeded preference is
          // coerced back to Local Device. Reach the Drive panel the way a user
          // does, through the provider control.
          const picker = page.getByRole("button", { name: "Vault storage provider" });
          if (await picker.count()) {
            await picker.first().click();
            await page.getByRole("option", { name: /^Google Drive/u }).first().click();
            await page.waitForTimeout(2500);
            await shoot(page, outDir, `${profile.name}-drive-unavailable`, report, { settle: 900 });
            await scrollTo(page, ".google-drive-setup");
            await shoot(page, outDir, `${profile.name}-drive-panel`, report, { settle: 500 });
          }
        }
        if (backend === "local-device") {
          const create = page.getByRole("button", { name: "Create new" });
          if (await create.count()) {
            await create.first().click();
            await shoot(page, outDir, `${profile.name}-ceremony`, report, { settle: 1200 });
            await scrollTo(page, ".local-device-vault__restore");
            await shoot(page, outDir, `${profile.name}-restore`, report, { settle: 400 });
          }
        }
      } catch (error) {
        log.push(`[${profile.name}/${backend}] ${String(error).slice(0, 300)}`);
      } finally {
        await context.close();
      }
    }
  }

  await browser.close();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "log.txt"), log.join("\n"));
  console.log(JSON.stringify(report, null, 2));
}

await main();
