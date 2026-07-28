import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ns = `airship-live-v2/e2e/pill-${Date.now().toString(36)}`;
for (const [label, backend, url] of [["adopted S3", "local-lab", `?airshipLabNamespace=${ns}`], ["poisoned S3", "local-lab", ""], ["local device empty", "local-device", ""], ["ephemeral", "ephemeral", ""]]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(`localStorage.setItem("airship.display-preferences.v1", ${JSON.stringify(JSON.stringify({mode:"dark",typeScale:"default",density:"comfortable",corners:"subtle",bodyFont:"system-sans",vaultBackend:backend,approvalMode:"ask-first"}))})`);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:4173/${url}#vault`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(backend === "local-lab" ? 11000 : 3500);
  console.log(label, await page.evaluate(() => {
    const p = document.querySelector(".vault-view__phase");
    return { text: p?.textContent, colour: p ? getComputedStyle(p).color : null, adopted: p?.getAttribute("data-adopted") };
  }));
  await ctx.close();
}
await browser.close();
