// End-to-end walk of the loopback S3 lab form: bad endpoint (the reproduced
// "validation destroys work" case), then the real MinIO handoff and probe.
import { chromium } from "@playwright/test";
const base = "http://127.0.0.1:4173";
const out = ".aesthetic/vault/walkthrough";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
  mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans", vaultBackend: "ephemeral", approvalMode: "ask-first",
})));
const page = await ctx.newPage();
await page.goto(`${base}/#vault`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

await page.getByRole("button", { name: "Vault storage provider" }).click();
await page.getByRole("option", { name: /^S3-compatible/u }).click();
await page.waitForTimeout(3000);
await page.locator(".local-lab").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/01-lab-form.png` });

// Generate the one-time key and tick both acknowledgements first, exactly as
// the reproduced defect did.
await page.getByRole("button", { name: "Generate one-time recovery key" }).click();
await page.waitForTimeout(800);
const keyBefore = (await page.locator(".local-lab__recovery output").textContent()) ?? "";
await page.getByRole("checkbox", { name: /I own this loopback service/u }).check();
await page.getByRole("checkbox", { name: /I saved the generated recovery key/u }).check();
await page.locator("input[name='airship-local-endpoint']").fill("https://s3.amazonaws.com");
await page.getByRole("button", { name: "Hand off to memory-only vault" }).click();
await page.waitForTimeout(1200);
const after = await page.evaluate(() => ({
  endpoint: document.querySelector("input[name='airship-local-endpoint']")?.value,
  bucket: document.querySelector("input[name='airship-local-bucket']")?.value,
  region: document.querySelector("input[name='airship-local-region']")?.value,
  namespace: document.querySelector("input[name='airship-local-namespace']")?.value,
  key: document.querySelector(".local-lab__recovery output")?.textContent ?? "",
  ariaInvalid: document.querySelector("input[name='airship-local-endpoint']")?.getAttribute("aria-invalid"),
  fieldError: document.querySelector(".local-lab__field-error")?.textContent,
  focused: document.activeElement?.getAttribute("name"),
  acknowledgements: [...document.querySelectorAll(".local-lab__acknowledgements input")].map((i) => i.checked),
}));
console.log("after a refused endpoint:", JSON.stringify({ ...after, keyPreserved: after.key === keyBefore && keyBefore.length > 0 }, null, 2));
await page.locator("input[name='airship-local-endpoint']").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/02-field-error.png` });

await page.locator("input[name='airship-local-endpoint']").fill("http://127.0.0.1:9900");
await page.getByRole("button", { name: "Hand off to memory-only vault" }).click();
await page.waitForTimeout(2000);
await page.evaluate(() => { document.querySelector("main.main").scrollTop = 0; });
await page.screenshot({ path: `${out}/03-configured.png` });
const probe = page.getByRole("button", { name: "Run live probe" });
if (await probe.count()) {
  await probe.click();
  const allow = page.getByRole("button", { name: /Allow|Approve/u });
  await page.waitForTimeout(1500);
  if (await allow.count()) await allow.first().click();
  await page.waitForTimeout(12000);
}
await page.evaluate(() => { document.querySelector("main.main").scrollTop = 0; });
await page.screenshot({ path: `${out}/04-after-probe.png` });
console.log("final:", await page.evaluate(() => ({
  phase: document.querySelector(".vault-view__phase")?.textContent,
  state: document.querySelector(".vault-view__state strong")?.textContent,
  outcomes: [...document.querySelectorAll(".vault-view__outcomes li > strong")].map((n) => n.textContent),
  setupStillOpen: Boolean(document.querySelector(".local-lab")),
  scroll: document.querySelector("main.main")?.scrollHeight,
})));
await browser.close();
