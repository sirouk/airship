const CACHE_VERSION = "airship-shell-v5";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch("/release-manifest.json", { cache: "no-store", credentials: "omit" })
      .then((response) => {
        if (!response.ok) throw new Error("Airship release manifest was unavailable during service-worker install.");
        return response.json();
      })
      .then((manifest) => {
        if (manifest?.schema !== "airship.release-manifest.v1" || !Array.isArray(manifest.artifacts)) {
          throw new Error("Airship release manifest was invalid during service-worker install.");
        }
        const assets = manifest.artifacts
          .map((artifact) => artifact?.path)
          .filter((path) => typeof path === "string" && /^assets\/[A-Za-z0-9._/-]+$/u.test(path))
          .map((path) => `/${path}`);
        if (assets.length === 0) throw new Error("Airship release manifest did not contain its application assets.");
        return caches.open(CACHE_VERSION).then((cache) => cache.addAll([...SHELL, ...new Set(assets)]));
      }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;
  if (event.request.headers.has("authorization") || event.request.headers.has("range")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put("/", response.clone())));
          }
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    return;
  }

  const isStaticAsset =
    requestUrl.pathname.startsWith("/assets/") ||
    requestUrl.pathname.startsWith("/execution-packs/pyodide/") ||
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
