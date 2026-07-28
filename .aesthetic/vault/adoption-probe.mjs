#!/usr/bin/env node
/** Isolate the local-lab adoption failure: fresh namespace vs the shared one. */
import { chromium } from "@playwright/test";

const baseUrl = "http://127.0.0.1:4173";
const namespaces = [
  ["fresh", `airship-live-v2/e2e/probe-${Date.now().toString(36)}`],
  ["shared", ""],
];

const browser = await chromium.launch();
for (const [label, namespace] of namespaces) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(`localStorage.setItem("airship.display-preferences.v1", ${JSON.stringify(JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle",
    bodyFont: "system-sans", vaultBackend: "local-lab", approvalMode: "ask-first",
  }))})`);
  const page = await context.newPage();
  const console_ = [];
  page.on("console", (message) => { if (message.type() === "error") console_.push(message.text().slice(0, 200)); });
  page.on("pageerror", (error) => console_.push(`pageerror ${String(error).slice(0, 200)}`));
  const url = namespace ? `${baseUrl}/?airshipLabNamespace=${encodeURIComponent(namespace)}#vault` : `${baseUrl}/#vault`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  for (const wait of [5000, 5000, 5000]) {
    await page.waitForTimeout(wait);
    const state = await page.evaluate(() => ({
      phase: document.querySelector(".vault-view__phase")?.textContent,
      runtimeStatus: document.querySelector(".runtime-line")?.textContent?.slice(0, 160),
      adopted: document.body.innerText.includes("Encrypted runtime active"),
    }));
    console.log(label, JSON.stringify(state));
  }
  console.log(label, "console errors:", console_.slice(0, 8));
  await context.close();
}
await browser.close();
