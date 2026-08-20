const BASE_URL = new URL("./", self.location.href);
const BASE_PATH = BASE_URL.pathname;
const CACHE_PREFIX = "airship-shell-";
const RELEASE_REVISION = safeRevision(new URL(self.location.href).searchParams.get("revision"));
const CACHE_VERSION = `${CACHE_PREFIX}${RELEASE_REVISION}`;
const SHELL = [BASE_PATH, scopedPath("manifest.webmanifest"), scopedPath("favicon.svg")];
const DOCUMENT_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src https://stackblitz.com https://accounts.google.com; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: blob:; connect-src 'self' https: http://localhost:11434 http://127.0.0.1:11434 http://localhost:11435 http://127.0.0.1:11435 http://localhost:11436 http://127.0.0.1:11436 http://localhost:1234 http://127.0.0.1:1234 http://localhost:1235 http://127.0.0.1:1235 http://localhost:1236 http://127.0.0.1:1236; worker-src 'self' blob:; manifest-src 'self'; font-src 'self'; trusted-types default airship-static airship-worker airship-prime-kernel-worker airship-prime-kernel-worker-asset airship-semantic-worker airship-wasi-preview1-worker airship-opfs-worker airship-google-identity; require-trusted-types-for 'script'";
const DOCUMENT_ISOLATION_HEADERS = Object.freeze({
  "Content-Security-Policy": DOCUMENT_CONTENT_SECURITY_POLICY,
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
});
const PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'";
const PRIME_KERNEL_WORKER_RESPONSE_HEADERS = Object.freeze({
  "Content-Security-Policy": PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY,
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
});
const PRIME_KERNEL_WORKER_ARTIFACT = /^assets\/[A-Za-z0-9_-]+\.prime-kernel-worker\.js$/u;
const JAVASCRIPT_MIME_ESSENCES = new Set(["application/javascript", "text/javascript"]);
let primeKernelWorkerPath;
const STATIC_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "device-memory",
  "dnt",
  "downlink",
  "dpr",
  "ect",
  "if-modified-since",
  "if-none-match",
  "origin",
  "pragma",
  "priority",
  "purpose",
  "referer",
  "rtt",
  "save-data",
  "upgrade-insecure-requests",
  "user-agent",
  "viewport-width",
  "width",
]);

function scopedPath(path) {
  return new URL(path, BASE_URL).pathname;
}

function safeRevision(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value)
    ? value
    : "unversioned";
}

function reviewedAssetPath(path) {
  return typeof path === "string"
    && /^assets\/[A-Za-z0-9._/-]+$/u.test(path)
    && path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function primeKernelWorkerArtifactPath(path) {
  return typeof path === "string" && PRIME_KERNEL_WORKER_ARTIFACT.test(path);
}

function primeKernelWorkerCandidate(url) {
  const assetsPrefix = scopedPath("assets/");
  if (url.search || url.hash || !url.pathname.startsWith(assetsPrefix)) return false;
  const relative = `assets/${url.pathname.slice(assetsPrefix.length)}`;
  return primeKernelWorkerArtifactPath(relative);
}

async function resolvePrimeKernelWorkerPath() {
  if (primeKernelWorkerPath) return primeKernelWorkerPath;
  const cache = await caches.open(CACHE_VERSION);
  const requests = await cache.keys();
  const candidates = requests
    .map((request) => new URL(request.url))
    .filter((url) => url.origin === self.location.origin && primeKernelWorkerCandidate(url))
    .map((url) => url.pathname);
  if (candidates.length !== 1) {
    throw new Error("The active Airship cache does not contain exactly one Prime kernel worker artifact.");
  }
  [primeKernelWorkerPath] = candidates;
  return primeKernelWorkerPath;
}

function hasNonStaticRequestHeader(headers) {
  for (const name of headers.keys()) {
    const normalizedName = name.toLowerCase();
    // `Sec-` is reserved for browser-controlled request metadata. Everything
    // else must be one of the ordinary headers a static navigation or asset
    // fetch can carry. Provider-specific headers must stay on the network path.
    if (normalizedName.startsWith("sec-") || STATIC_REQUEST_HEADERS.has(normalizedName)) continue;
    return true;
  }
  return false;
}

function exactPrimeKernelWorkerUrl(path) {
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin || url.search || url.hash) {
    throw new Error("The Prime kernel worker cache key must be one exact same-origin URL.");
  }
  return url.href;
}

function validatePrimeKernelWorkerProvenance(response, exactUrl) {
  const contentType = response.headers.get("content-type");
  const mimeEssence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !response.ok
    || response.status !== 200
    || response.redirected
    || response.type !== "basic"
    || response.url !== exactUrl
    || !mimeEssence
    || !JAVASCRIPT_MIME_ESSENCES.has(mimeEssence)
  ) {
    throw new Error("The Prime kernel worker response changed URL, type, status, or JavaScript provenance.");
  }
  return response;
}

async function fetchExactPrimeKernelWorker(exactUrl) {
  const response = await fetch(exactUrl, {
    cache: "no-store",
    credentials: "omit",
    redirect: "manual",
  });
  return validatePrimeKernelWorkerProvenance(response, exactUrl);
}

async function fetchAndCachePrimeKernelWorker(cache, path) {
  const exactUrl = exactPrimeKernelWorkerUrl(path);
  const response = await fetchExactPrimeKernelWorker(exactUrl);
  // Cache the validated network Response itself. Rebuilding headers first
  // would erase its response URL list and make later provenance checks a lie.
  await cache.put(exactUrl, response.clone());
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch(scopedPath("release-manifest.json"), { cache: "no-store", credentials: "omit" })
      .then((response) => {
        if (!response.ok) throw new Error("Airship release manifest was unavailable during service-worker install.");
        return response.json();
      })
      .then((manifest) => {
        if (manifest?.schema !== "airship.release-manifest.v1" || !Array.isArray(manifest.artifacts)) {
          throw new Error("Airship release manifest was invalid during service-worker install.");
        }
        const artifactPaths = manifest.artifacts.map((artifact) => artifact?.path);
        const kernelWorkerArtifacts = artifactPaths.filter(primeKernelWorkerArtifactPath);
        if (kernelWorkerArtifacts.length !== 1) {
          throw new Error("Airship release manifest must contain exactly one Prime kernel worker artifact.");
        }
        const primeKernelWorkerArtifact = kernelWorkerArtifacts[0];
        primeKernelWorkerPath = scopedPath(primeKernelWorkerArtifact);
        const assets = artifactPaths
          .filter((path) => reviewedAssetPath(path) && path !== primeKernelWorkerArtifact)
          .map(scopedPath);
        if (assets.length === 0) throw new Error("Airship release manifest did not contain its application assets.");
        return caches.open(CACHE_VERSION).then((cache) => Promise.all([
          cache.addAll([...SHELL, ...new Set(assets)]),
          fetchAndCachePrimeKernelWorker(cache, primeKernelWorkerPath),
        ]));
      })
      // Security-policy updates must not remain waiting behind a frameable old
      // document. Top-level work is preserved below; nested clients are forced
      // across the protected navigation boundary during activation.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) => Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        )),
      // Claim the first document immediately. Airship's existing
      // controllerchange listener reloads it once, after which this worker can
      // provide the navigation response carrying the isolation policy even on
      // static hosts (such as GitHub Pages) that ignore `_headers`.
      self.clients.claim(),
      secureNestedWindowClients(),
    ]),
  );
});

async function secureNestedWindowClients() {
  if (typeof self.clients.matchAll !== "function") return;
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  await Promise.all(clients
    .filter((client) => client.frameType === "nested" && typeof client.navigate === "function")
    .map((client) => client.navigate(client.url).catch(() => undefined)));
}

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

  // Every controlled same-origin navigation gets the reviewed document policy.
  // Request.cache is only a cache decision; letting `no-store` bypass this
  // branch would turn a reload into headerless interactive HTML again.
  if (event.request.mode === "navigate") {
    const sensitiveNavigation = event.request.cache === "no-store"
      || event.request.headers.has("authorization")
      || event.request.headers.has("range")
      || hasNonStaticRequestHeader(event.request.headers);
    if (sensitiveNavigation) {
      event.respondWith(
        fetch(event.request)
          .then(isolatedNavigationResponse)
          .catch(() => Response.error()),
      );
      return;
    }
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok && response.type === "basic" && !response.headers.has("set-cookie")) {
            event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(BASE_PATH, response.clone())));
          }
          return isolatedNavigationResponse(response);
        })
        .catch(() => caches.match(BASE_PATH).then((cached) =>
          cached ? isolatedNavigationResponse(cached) : Response.error()
        )),
    );
    return;
  }

  // Cache Storage does not honor Request.cache. Leave no-store asset requests
  // on the browser's network path before this worker can look up or write one.
  if (event.request.cache === "no-store") return;
  if (event.request.headers.has("authorization") || event.request.headers.has("range")) return;
  if (hasNonStaticRequestHeader(event.request.headers)) return;

  if (primeKernelWorkerCandidate(requestUrl)) {
    event.respondWith(
      servePrimeKernelWorker(event.request, requestUrl)
        .catch(() => Response.error()),
    );
    return;
  }

  const isStaticAsset =
    requestUrl.pathname.startsWith(scopedPath("assets/")) ||
    requestUrl.pathname.startsWith(scopedPath("execution-packs/pyodide/")) ||
    // The reviewed semantic artifact manifest pins every byte below this
    // versioned same-origin prefix. Cache on first use; do not inflate the
    // install transaction with optional model weights.
    requestUrl.pathname.startsWith(scopedPath("semantic-pack/v1/")) ||
    SHELL.includes(requestUrl.pathname);
  if (!isStaticAsset) return;
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached ?? fetch(event.request).then((response) => {
        if (response.ok && response.type === "basic" && !response.headers.has("set-cookie")) {
          event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, response.clone())));
        }
        return response;
      }),
    ),
  );
});

async function servePrimeKernelWorker(request, requestUrl) {
  const exactPath = await resolvePrimeKernelWorkerPath();
  if (requestUrl.pathname !== exactPath) return Response.error();
  const exactUrl = exactPrimeKernelWorkerUrl(exactPath);
  if (requestUrl.href !== exactUrl || request.url !== exactUrl) return Response.error();

  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(exactUrl);
  if (cached) {
    validatePrimeKernelWorkerProvenance(cached, exactUrl);
    return primeKernelWorkerResponse(cached);
  }

  const network = await fetchExactPrimeKernelWorker(exactUrl);
  await cache.put(exactUrl, network.clone());
  return primeKernelWorkerResponse(network);
}

/** Rebuild, rather than append, so a duplicate origin CSP cannot intersect. */
function primeKernelWorkerResponse(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PRIME_KERNEL_WORKER_RESPONSE_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * A navigation response is the authority for cross-origin isolation. Preserve
 * every byte and origin-provided header, adding only the four reviewed
 * document-policy headers that a header-capable host already serves.
 */
function isolatedNavigationResponse(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(DOCUMENT_ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
