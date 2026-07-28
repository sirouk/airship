import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { resolve } from "node:path";

const extensionPath = resolve("extension/build/development/chromium");
const browserChannel = process.env.AIRSHIP_COMPANION_BROWSER_CHANNEL ?? "chromium";

test("the real Chromium companion reports, computes, and stores only after opt-in", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One real extension-host acceptance journey is sufficient.");
  test.setTimeout(60_000);

  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("companion-profile"), {
      channel: browserChannel,
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("http://127.0.0.1:4173/#connection");

    const hello = await companionRequest(page, { kind: "hello" });
    expect(hello).toMatchObject({
      kind: "hello",
      version: "1.1.1",
      capabilities: {
        storage: {
          state: "available",
          enabled: false,
          boundary: "ciphertext-cache-only",
        },
        compute: {
          state: "available",
          execution: "extension-background",
        },
      },
    });

    const worker = context.serviceWorkers()[0]
      ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const workerUrl = new URL(worker.url());
    const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`;
    const popup = await context.newPage();
    await popup.goto(`${extensionOrigin}/popup.html`);
    await expect(popup.locator("[data-build-channel]")).toHaveText("Development channel");
    await expect(popup.locator("[data-caller-rules]")).toContainText("http://localhost:4173/");
    await expect(popup.locator("[data-caller-rules]")).toContainText("http://127.0.0.1:4173/");
    await expect(popup.locator("[data-tab-state]")).toContainText(
      /caller allowlist|address is not available/u,
    );
    await expect(popup.locator("body")).not.toContainText("Provider relay is ready");
    await popup.locator("[data-cache-toggle]").check();
    await expect(popup.locator("[data-status]")).toHaveText("Extension-local encrypted cache is on.");

    const namespace = "n".repeat(43);
    const key = "k".repeat(43);
    const put = await companionRequest(page, {
      kind: "cache",
      operation: "put",
      namespace,
      key,
      data: btoa("ciphertext-fixture"),
      ciphertext: true,
    });
    expect(put).toMatchObject({ kind: "result", result: { stored: true } });
    expect(await companionRequest(page, {
      kind: "cache",
      operation: "list",
      namespace,
    })).toMatchObject({ kind: "result", result: { pages: [{ key, bytes: 18 }] } });
    expect(await companionRequest(page, {
      kind: "cache",
      operation: "get",
      namespace,
      key,
    })).toMatchObject({ kind: "result", result: { found: true, data: btoa("ciphertext-fixture") } });

    const digest = await companionRequest(page, {
      kind: "compute",
      operation: "sha256",
      data: btoa("airship"),
    });
    expect(digest).toMatchObject({
      kind: "result",
      result: { bytes: 7, digest: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/u) },
    });

    await page.reload();
    /*
     * The Companion is now the sixth row of the lane list rather than a 219px
     * card above it, so the selector moves. The invariant is *stronger* than
     * the one it replaces: all three readings are asserted on the COLLAPSED
     * row, which means a truthful positive state is observable without opening
     * anything — the card required no gesture either, but it also spent 66% of
     * a phone viewport saying "Not active" three times when it was false.
     */
    const companion = page.locator('.connect-lane[data-lane="companion"]');
    await expect(companion).toContainText("Extension 1.1.1", { timeout: 15_000 });
    await expect(companion.locator(".connect-lane__facts")).toContainText("1 page");
    await expect(companion.locator(".connect-lane__facts")).toContainText("Hash + vector ranking");
  } finally {
    await context?.close();
  }
});

async function companionRequest(page: Page, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  return page.evaluate(async (requestFields) => {
    const id = crypto.randomUUID();
    return await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        rejectPromise(new Error("companion timeout"));
      }, 5_000);
      const listener = (event: MessageEvent<unknown>) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const value = event.data;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const record = value as Record<string, unknown>;
        if (record.airshipCompanion !== 1 || record.from !== "extension" || record.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolvePromise(record);
      };
      window.addEventListener("message", listener);
      window.postMessage({
        airshipCompanion: 1,
        from: "page",
        id,
        ...requestFields,
      }, location.origin);
    });
  }, fields);
}
