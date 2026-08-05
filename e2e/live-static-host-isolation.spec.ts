import { expect, test, type Page, type Response } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:4193";
const PUBLIC_BASE_PATH = "/airship/";
const LOAD_COUNTER = "airship.static-host-document-loads.v1";

type DocumentEvidence = Readonly<{
  fromServiceWorker: boolean;
  url: string;
  headers: Record<string, string>;
}>;

function expectVersionedServiceWorker(rawUrl: string | undefined): void {
  expect(rawUrl).toBeDefined();
  const workerUrl = new URL(rawUrl as string);
  expect(workerUrl.origin).toBe(ORIGIN);
  expect(workerUrl.pathname).toBe(`${PUBLIC_BASE_PATH}sw.js`);
  expect([...workerUrl.searchParams.keys()]).toEqual(["revision"]);
  expect(workerUrl.searchParams.get("revision")).toMatch(/^index-[A-Za-z0-9_-]+\.js$/u);
}

test("a headerless static host becomes isolated once, then boots the browser terminal", async ({ page }) => {
  test.setTimeout(120_000);
  const documents: Promise<DocumentEvidence>[] = [];
  page.on("response", (response) => {
    if (isAirshipDocument(response)) {
      documents.push(response.allHeaders().then((headers) => Object.freeze({
        fromServiceWorker: response.fromServiceWorker(),
        url: response.url(),
        headers,
      })));
    }
  });
  await page.addInitScript(({ origin, counter }) => {
    if (location.origin !== origin) return;
    const prior = Number.parseInt(sessionStorage.getItem(counter) ?? "0", 10);
    sessionStorage.setItem(counter, String(Number.isFinite(prior) ? prior + 1 : 1));
  }, { origin: ORIGIN, counter: LOAD_COUNTER });

  const first = await page.goto(`${PUBLIC_BASE_PATH}#terminal`, { waitUntil: "domcontentloaded" });
  expect(first).not.toBeNull();
  expect(await first?.headerValue("cross-origin-opener-policy")).toBeNull();
  expect(await first?.headerValue("cross-origin-embedder-policy")).toBeNull();

  await page.waitForFunction(() => (
    globalThis.crossOriginIsolated === true
    && typeof SharedArrayBuffer === "function"
    && Boolean(navigator.serviceWorker.controller)
  ), undefined, { timeout: 30_000 });

  const runtime = await page.evaluate(async ({ counter }) => {
    const registration = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    let sharedArrayBufferTransfer = false;
    try {
      channel.port1.postMessage(new SharedArrayBuffer(1));
      sharedArrayBufferTransfer = true;
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      sharedArrayBufferTransfer,
      controller: navigator.serviceWorker.controller?.scriptURL,
      activeWorker: registration.active?.scriptURL,
      documentLoads: Number.parseInt(sessionStorage.getItem(counter) ?? "0", 10),
      navigationType: performance.getEntriesByType("navigation")
        .map((entry) => entry as PerformanceNavigationTiming)
        .at(-1)?.type,
    };
  }, { counter: LOAD_COUNTER });
  expect(runtime).toMatchObject({
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    sharedArrayBufferTransfer: true,
    documentLoads: 2,
    navigationType: "reload",
  });
  expect(runtime.activeWorker).toBe(runtime.controller);
  expectVersionedServiceWorker(runtime.controller);

  await expect.poll(() => documents.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const navigationEvidence = await Promise.all(documents);
  expect(navigationEvidence[0]).toMatchObject({ fromServiceWorker: false });
  expect(navigationEvidence[0]?.headers["cross-origin-opener-policy"]).toBeUndefined();
  expect(navigationEvidence[0]?.headers["cross-origin-embedder-policy"]).toBeUndefined();
  expect(navigationEvidence.some(({ fromServiceWorker, headers }) => (
    fromServiceWorker
    && headers["cross-origin-opener-policy"] === "same-origin"
    && headers["cross-origin-embedder-policy"] === "credentialless"
    && headers["cross-origin-resource-policy"] === "same-origin"
  ))).toBe(true);

  // One controller takeover is intentional. More document loads after the
  // isolated page settles would reveal a controllerchange reload loop.
  const settledLoads = runtime.documentLoads;
  await page.waitForTimeout(1_000);
  await expect.poll(() => page.evaluate(
    (counter) => Number.parseInt(sessionStorage.getItem(counter) ?? "0", 10),
    LOAD_COUNTER,
  )).toBe(settledLoads);

  await expect(page.getByLabel(/browser terminal/iu)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".terminal-panel__bar strong", { hasText: "Running" }))
    .toBeVisible({ timeout: 60_000 });
  const emulator = page.locator(".terminal-emulator");
  const input = emulator.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type("node -e \"console.log('AIRSHIP_STATIC_HOST_42')\"");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Input history · 1", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(emulator.locator(".xterm-accessibility-tree"))
    .toContainText("AIRSHIP_STATIC_HOST_42", { timeout: 30_000 });

  await page.goto(`${PUBLIC_BASE_PATH}#memory`);
  const index = page.locator("#memory-index");
  if ((await index.getAttribute("open")) === null) await index.locator("summary").click();
  await expect(page.getByRole("button", { name: "Local semantic" })).toBeDisabled();
  await expect(page.locator(".embedding-engine-state"))
    .toContainText("local semantic not included in this build");
});

test("service-worker takeover never interrupts work started during first install", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.addInitScript(({ origin, counter }) => {
    if (location.origin !== origin) return;
    const prior = Number.parseInt(sessionStorage.getItem(counter) ?? "0", 10);
    sessionStorage.setItem(counter, String(Number.isFinite(prior) ? prior + 1 : 1));
  }, { origin: ORIGIN, counter: LOAD_COUNTER });

  const first = await page.goto(`${PUBLIC_BASE_PATH}#chat`, { waitUntil: "domcontentloaded" });
  expect(await first?.headerValue("cross-origin-opener-policy")).toBeNull();
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.click();
  await composer.fill("Preserve this unsent draft during runtime takeover.");

  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 30_000 });
  await expect(page.getByText("Runtime update ready")).toBeVisible();
  await expect(composer).toHaveValue("Preserve this unsent draft during runtime takeover.");
  await expect.poll(() => page.evaluate(
    (counter) => Number.parseInt(sessionStorage.getItem(counter) ?? "0", 10),
    LOAD_COUNTER,
  )).toBe(1);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(false);

  await page.waitForTimeout(300);
  await reloadFromBanner(page);
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true);
  await expect(page.getByRole("combobox", { name: "Message Airship" }))
    .toHaveValue("Preserve this unsent draft during runtime takeover.");
  await expect.poll(() => documentLoads(page)).toBe(2);

  // A changed worker installs beside the active one. One click must both
  // promote it and reload; the user-activation guard must not swallow the
  // controllerchange event after this explicit request.
  await page.request.get(`${ORIGIN}${PUBLIC_BASE_PATH}__airship_test__/bump-sw`);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await expect(page.getByText("Runtime update ready")).toBeVisible({ timeout: 30_000 });
  await reloadFromBanner(page);
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true);
  await expect.poll(() => documentLoads(page)).toBe(3);
  await expect(page.getByRole("combobox", { name: "Message Airship" }))
    .toHaveValue("Preserve this unsent draft during runtime takeover.");
});

async function reloadFromBanner(page: Page): Promise<void> {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "Reload Airship" }).click(),
  ]);
}

async function documentLoads(page: Page): Promise<number> {
  return page.evaluate(
    (counter) => Number.parseInt(sessionStorage.getItem(counter) ?? "0", 10),
    LOAD_COUNTER,
  );
}

function isAirshipDocument(response: Response): boolean {
  const url = new URL(response.url());
  return response.request().resourceType() === "document"
    && url.origin === ORIGIN
    && url.pathname === PUBLIC_BASE_PATH;
}
