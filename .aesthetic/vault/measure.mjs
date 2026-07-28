import { chromium, devices } from "@playwright/test";
const base = "http://127.0.0.1:4173";
const VIEWPORTS = [
  { name: "desktop 1440x900", viewport: { width: 1440, height: 900 } },
  { name: "iPad Pro 11", ...devices["iPad Pro 11"] },
  { name: "iPhone 14 Pro Max", ...devices["iPhone 14 Pro Max"] },
];
const prefs = (b) => JSON.stringify({ mode:"dark",typeScale:"default",density:"comfortable",corners:"subtle",bodyFont:"system-sans",vaultBackend:b,approvalMode:"ask-first" });
const probe = () => {
  const main = document.querySelector("main.main");
  const view = document.querySelector(".vault-view");
  const mainTop = main.getBoundingClientRect().top;
  const controls = [...document.querySelectorAll(".vault-view button, .vault-view summary, .vault-view input, .local-device-vault button, .local-lab button, .google-drive-setup button")]
    .map((n) => ({ label: (n.textContent ?? n.getAttribute("aria-label") ?? "").trim().slice(0, 44), y: Math.round(n.getBoundingClientRect().top - mainTop + main.scrollTop), h: Math.round(n.getBoundingClientRect().height) }))
    .filter((c) => c.h > 0);
  const text = document.body.innerText;
  const n = (s) => text.split(s).length - 1;
  return {
    innerHeight: window.innerHeight,
    mainTop: Math.round(mainTop),
    chromeAboveRoute: Math.round(mainTop),
    routeBar: Math.round(document.querySelector(".vault-view__bar")?.getBoundingClientRect().height ?? 0),
    scroll: main.scrollHeight, client: main.clientHeight,
    firstControl: controls[0],
    subFortyFour: controls.filter((c) => c.h < 44).map((c) => `${c.label}:${c.h}`),
    restated: { disconnected: n("Disconnected"), notOpened: n("Not opened"), notConnectedish: n("No vault claim") + n("Ephemeral") },
  };
};
const browser = await chromium.launch();
for (const profile of VIEWPORTS) {
  for (const backend of ["local-lab", "local-device", "ephemeral"]) {
    const ctx = await browser.newContext({ ...profile, name: undefined });
    await ctx.addInitScript(`localStorage.setItem("airship.display-preferences.v1", ${JSON.stringify(prefs(backend))})`);
    const page = await ctx.newPage();
    await page.goto(`${base}/#vault`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(backend === "local-lab" ? 9000 : 3500);
    const r = await page.evaluate(probe);
    console.log(`${profile.name} / ${backend}`);
    console.log(`   chrome above route ${r.chromeAboveRoute}px = ${(100*r.chromeAboveRoute/r.innerHeight).toFixed(1)}% of ${r.innerHeight}px; route bar ${r.routeBar}px`);
    console.log(`   content ${r.scroll}px in ${r.client}px (${(r.scroll/r.client).toFixed(2)} viewports); first vault control: ${JSON.stringify(r.firstControl)}`);
    console.log(`   sub-44px: ${r.subFortyFour.length ? r.subFortyFour.join(", ") : "none"}; restated: ${JSON.stringify(r.restated)}`);
    await ctx.close();
  }
}
await browser.close();
