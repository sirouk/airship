import { expect, test, type Response } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:4193";
const PUBLIC_BASE_PATH = "/airship/";
const LOAD_COUNTER = "airship.static-host-document-loads.v1";
const EXACT_DOCUMENT_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src https://stackblitz.com https://accounts.google.com; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: blob:; connect-src 'self' https: http://localhost:11434 http://127.0.0.1:11434 http://localhost:11435 http://127.0.0.1:11435 http://localhost:11436 http://127.0.0.1:11436 http://localhost:1234 http://127.0.0.1:1234 http://localhost:1235 http://127.0.0.1:1235 http://localhost:1236 http://127.0.0.1:1236; worker-src 'self' blob:; manifest-src 'self'; font-src 'self'; trusted-types default airship-static airship-worker airship-prime-kernel-worker airship-prime-kernel-worker-asset airship-semantic-worker airship-wasi-preview1-worker airship-opfs-worker airship-google-identity; require-trusted-types-for 'script'";

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
    && headers["content-security-policy"] === EXACT_DOCUMENT_CONTENT_SECURITY_POLICY
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

test("worker install rejects same-origin and cross-origin CORS redirect bodies", async ({ page }) => {
  test.setTimeout(120_000);
  await page.request.get(`${ORIGIN}${PUBLIC_BASE_PATH}__airship_test__/worker-redirect?mode=none`);
  await page.goto(`${PUBLIC_BASE_PATH}#chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (
    Boolean(navigator.serviceWorker.controller) && globalThis.crossOriginIsolated === true
  ), undefined, { timeout: 30_000 });

  const workerCacheEvidence = await page.evaluate(async (publicBasePath) => {
    const manifest = await fetch(`${publicBasePath}release-manifest.json`, { cache: "no-store" }).then((response) => response.json());
    const path = manifest.artifacts
      .map((artifact: { path?: string }) => artifact.path)
      .find((candidate: string | undefined) => candidate?.endsWith(".prime-kernel-worker.js"));
    if (!path) throw new Error("Release manifest did not expose the Prime kernel worker.");
    const exactUrl = new URL(path, location.href).href;
    const response = await fetch(exactUrl, { credentials: "omit", redirect: "manual" });
    await response.body?.cancel();
    return {
      exactUrl,
      headers: Object.fromEntries(response.headers.entries()),
      redirected: response.redirected,
      status: response.status,
      type: response.type,
      url: response.url,
    };
  }, PUBLIC_BASE_PATH);
  expect(workerCacheEvidence).toMatchObject({
    redirected: false,
    status: 200,
    type: "basic",
  });
  expect(workerCacheEvidence.url).toBe(workerCacheEvidence.exactUrl);
  expect(workerCacheEvidence.headers["content-security-policy"]).toBe(
    "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
  );
  expect(workerCacheEvidence.headers["cross-origin-embedder-policy"]).toBe("credentialless");
  expect(workerCacheEvidence.headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(workerCacheEvidence.headers["x-content-type-options"]).toBe("nosniff");

  // The application page intentionally has connect-src 'self'. Use a second
  // real Chromium page on the auxiliary origin to prove the redirect target is
  // a fetchable cross-origin CORS JavaScript response, not a synthetic label.
  const corsPage = await page.context().newPage();
  await corsPage.goto(`http://127.0.0.1:4194${PUBLIC_BASE_PATH}__airship_test__/cors-worker.js`);
  const corsProbe = await corsPage.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "omit", mode: "cors" });
    return { body: await response.text(), type: response.type, url: response.url };
  }, `${ORIGIN}${PUBLIC_BASE_PATH}__airship_test__/cors-worker.js`);
  await corsPage.close();
  expect(corsProbe.type).toBe("cors");
  expect(corsProbe.url).toBe(`${ORIGIN}${PUBLIC_BASE_PATH}__airship_test__/cors-worker.js`);
  expect(corsProbe.body).toContain("__crossOriginCorsPrimeKernelWorker");

  for (const mode of ["same-origin", "cross-origin-cors"] as const) {
    const evidence = await page.evaluate(async ({ mode, publicBasePath }) => {
      const registration = await navigator.serviceWorker.ready;
      const activeBefore = registration.active?.scriptURL ?? null;
      await fetch(`${publicBasePath}__airship_test__/worker-redirect?mode=${mode}`, { cache: "no-store" });
      await fetch(`${publicBasePath}__airship_test__/bump-sw`, { cache: "no-store" });

      let installing: ServiceWorker | null = null;
      const updateFound = new Promise<ServiceWorker>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No service-worker update was discovered.")), 15_000);
        registration.addEventListener("updatefound", () => {
          if (!registration.installing) return;
          clearTimeout(timer);
          installing = registration.installing;
          resolve(registration.installing);
        }, { once: true });
      });
      const update = registration.update().catch((error: unknown) => error);
      const candidate = await updateFound;
      const states = [candidate.state];
      if (candidate.state !== "redundant") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Redirected worker stayed ${candidate.state}.`)), 20_000);
          candidate.addEventListener("statechange", () => {
            states.push(candidate.state);
            if (candidate.state === "redundant") {
              clearTimeout(timer);
              resolve();
            }
          });
        });
      }
      await update;
      await fetch(`${publicBasePath}__airship_test__/worker-redirect?mode=none`, { cache: "no-store" });
      return {
        activeAfter: registration.active?.scriptURL ?? null,
        activeBefore,
        candidateIsInstalling: candidate === installing,
        candidateState: candidate.state,
        states,
        waiting: registration.waiting?.scriptURL ?? null,
      };
    }, { mode, publicBasePath: PUBLIC_BASE_PATH });

    expect(evidence.candidateIsInstalling).toBe(true);
    expect(evidence.candidateState).toBe("redundant");
    expect(evidence.states).toContain("redundant");
    expect(evidence.activeAfter).toBe(evidence.activeBefore);
    expect(evidence.waiting).toBeNull();
  }
});

test("a fresh cross-origin frame stays inert and controlled navigation carries frame-ancestors", async ({ page }) => {
  test.setTimeout(120_000);
  const interactiveBoots: string[] = [];
  const documents: Promise<DocumentEvidence>[] = [];
  page.on("console", (message) => {
    if (message.text() === "AIRSHIP_INTERACTIVE_UI_OBSERVED") interactiveBoots.push(message.text());
  });
  page.on("response", (response) => {
    if (isAirshipDocument(response)) {
      documents.push(response.allHeaders().then((headers) => Object.freeze({
        fromServiceWorker: response.fromServiceWorker(),
        url: response.url(),
        headers,
      })));
    }
  });
  await page.addInitScript((origin) => {
    if (location.origin !== origin) return;
    let reported = false;
    const reportInteractiveUi = () => {
      if (reported || !document.querySelector("button, input, textarea, select, [contenteditable='true']")) return;
      reported = true;
      console.log("AIRSHIP_INTERACTIVE_UI_OBSERVED");
    };
    new MutationObserver(reportInteractiveUi).observe(document, { childList: true, subtree: true });
    addEventListener("DOMContentLoaded", reportInteractiveUi, { once: true });
  }, ORIGIN);

  await page.setContent(`<iframe title="untrusted embed" src="${ORIGIN}${PUBLIC_BASE_PATH}#access"></iframe>`);
  await expect.poll(() => documents.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const framedNavigations = await Promise.all(documents);
  expect(framedNavigations[0]).toMatchObject({ fromServiceWorker: false });
  expect(framedNavigations[0]?.headers["content-security-policy"]).toBeUndefined();

  // Chromium disables Service Workers in this fresh third-party frame. That is
  // still fail-closed: the uncontrolled response contains only the inert boot
  // boundary and never reaches application controls.
  await expect(page.locator("iframe").contentFrame().getByText(
    "This browser cannot establish Airship's protected navigation boundary.",
  )).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(interactiveBoots).toEqual([]);
  await expect(page.locator("iframe").contentFrame().locator("button, input, textarea, select, [contenteditable='true']"))
    .toHaveCount(0);

  // The same installed worker still supports normal static-PWA use. A direct
  // controlled navigation is interactive and exposes the exact reviewed CSP.
  const beforeDirect = documents.length;
  const direct = await page.goto(`${ORIGIN}${PUBLIC_BASE_PATH}#access`, { waitUntil: "domcontentloaded" });
  expect(direct).not.toBeNull();
  expect(await direct?.headerValue("content-security-policy")).toBeNull();
  await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
  await expect.poll(() => documents.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(beforeDirect + 2);
  const directNavigations = await Promise.all(documents.slice(beforeDirect));
  expect(directNavigations.some(({ fromServiceWorker, headers }) => (
    fromServiceWorker
    && headers["content-security-policy"] === EXACT_DOCUMENT_CONTENT_SECURITY_POLICY
  ))).toBe(true);
});

function isAirshipDocument(response: Response): boolean {
  const url = new URL(response.url());
  return response.request().resourceType() === "document"
    && url.origin === ORIGIN
    && url.pathname === PUBLIC_BASE_PATH;
}
