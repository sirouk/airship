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
  "accept", "accept-encoding", "accept-language", "cache-control", "device-memory",
  "dnt", "downlink", "dpr", "ect", "if-modified-since", "if-none-match", "origin",
  "pragma", "priority", "purpose", "referer", "rtt", "save-data",
  "upgrade-insecure-requests", "user-agent", "viewport-width", "width",
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
  const candidates = (await cache.keys())
    .map((request) => new URL(request.url))
    .filter((url) => url.origin === self.location.origin && primeKernelWorkerCandidate(url))
    .map((url) => url.pathname);
  if (candidates.length !== 1) {
    throw new Error("Expected one cached Prime kernel worker artifact.");
  }
  [primeKernelWorkerPath] = candidates;
  return primeKernelWorkerPath;
}

function hasNonStaticRequestHeader(headers) {
  // Only browser-controlled Sec-* and reviewed static headers may touch caches.
  for (const name of headers.keys()) {
    const normalized = name.toLowerCase();
    if (!normalized.startsWith("sec-") && !STATIC_REQUEST_HEADERS.has(normalized)) return true;
  }
  return false;
}

function exactPrimeKernelWorkerUrl(path) {
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin || url.search || url.hash) {
    throw new Error("The Prime kernel worker URL must be exact and same-origin.");
  }
  return url.href;
}

function validatePrimeKernelWorkerProvenance(response, exactUrl) {
  const contentType = response.headers.get("content-type");
  const mimeEssence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    response.status !== 200
    || response.redirected
    || response.type !== "basic"
    || response.url !== exactUrl
    || !JAVASCRIPT_MIME_ESSENCES.has(mimeEssence)
  ) {
    throw new Error("The Prime worker changed URL, type, status, or JavaScript provenance.");
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
  // Preserve the native URL list for later provenance checks.
  await cache.put(exactUrl, response.clone());
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch(scopedPath("release-manifest.json"), { cache: "no-store", credentials: "omit" })
      .then((response) => {
        if (!response.ok) throw new Error("The release manifest was unavailable.");
        return response.json();
      })
      .then((manifest) => {
        if (manifest?.schema !== "airship.release-manifest.v1" || !Array.isArray(manifest.artifacts)) {
          throw new Error("The release manifest was invalid.");
        }
        const artifactPaths = manifest.artifacts.map((artifact) => artifact?.path);
        const kernelWorkerArtifacts = artifactPaths.filter(primeKernelWorkerArtifactPath);
        if (kernelWorkerArtifacts.length !== 1) {
          throw new Error("The release manifest must contain one Prime kernel worker artifact.");
        }
        const primeKernelWorkerArtifact = kernelWorkerArtifacts[0];
        primeKernelWorkerPath = scopedPath(primeKernelWorkerArtifact);
        const assets = artifactPaths
          .filter((path) => reviewedAssetPath(path) && path !== primeKernelWorkerArtifact)
          .map(scopedPath);
        if (assets.length === 0) throw new Error("The release manifest contains no application assets.");
        return caches.open(CACHE_VERSION).then((cache) => Promise.all([
          cache.addAll([...SHELL, ...new Set(assets)]),
          fetchAndCachePrimeKernelWorker(cache, primeKernelWorkerPath),
        ]));
      })
      // Activate policy updates now; activation reloads nested clients.
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
      // Claim so controllerchange reloads the first headerless document under this policy.
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
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;
  const bypassCache = request.cache === "no-store"
    || request.headers.has("authorization")
    || request.headers.has("range")
    || hasNonStaticRequestHeader(request.headers);

  // Wrap every controlled same-origin navigation, including no-store reloads.
  if (request.mode === "navigate") {
    if (bypassCache) {
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
          // Only the app root may become the offline app root: every in-scope
          // navigation was cached under that one key, so opening the install
          // hub once made it the document served offline at the base path.
          if (
            requestUrl.pathname === BASE_PATH
            && response.ok
            && response.type === "basic"
            && !response.headers.has("set-cookie")
          ) {
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

  // Cache Storage ignores Request.cache; bypass sensitive asset requests.
  if (bypassCache) return;

  if (primeKernelWorkerCandidate(requestUrl)) {
    event.respondWith(
      servePrimeKernelWorker(request, requestUrl)
        .catch(() => Response.error()),
    );
    return;
  }

  const isStaticAsset =
    requestUrl.pathname.startsWith(scopedPath("assets/")) ||
    requestUrl.pathname.startsWith(scopedPath("execution-packs/pyodide/")) ||
    // Cache manifest-pinned optional weights on first use.
    requestUrl.pathname.startsWith(scopedPath("semantic-pack/v1/")) ||
    SHELL.includes(requestUrl.pathname);
  if (!isStaticAsset) return;
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ?? fetch(request).then((response) => {
        if (response.ok && response.type === "basic" && !response.headers.has("set-cookie")) {
          event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone())));
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
  if (request.url !== exactUrl) return Response.error();

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

// Rebuild headers so an origin CSP cannot intersect the reviewed worker policy.
function responseWithHeaders(response, additions) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(additions)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function primeKernelWorkerResponse(response) {
  return responseWithHeaders(response, PRIME_KERNEL_WORKER_RESPONSE_HEADERS);
}

// Preserve body, status, and origin headers; add the reviewed navigation policy.
function isolatedNavigationResponse(response) {
  return responseWithHeaders(response, DOCUMENT_ISOLATION_HEADERS);
}
