import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const EXACT_DOCUMENT_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src https://stackblitz.com https://accounts.google.com; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: blob:; connect-src 'self' https: http://localhost:11434 http://127.0.0.1:11434 http://localhost:11435 http://127.0.0.1:11435 http://localhost:11436 http://127.0.0.1:11436 http://localhost:1234 http://127.0.0.1:1234 http://localhost:1235 http://127.0.0.1:1235 http://localhost:1236 http://127.0.0.1:1236; worker-src 'self' blob:; manifest-src 'self'; font-src 'self'; trusted-types default airship-static airship-worker airship-prime-kernel-worker airship-prime-kernel-worker-asset airship-semantic-worker airship-wasi-preview1-worker airship-opfs-worker airship-google-identity; require-trusted-types-for 'script'";

function responseWithProvenance(body, url, init = {}) {
  const { redirected = false, type = "basic", ...responseInit } = init;
  const decorate = (response) => {
    const nativeClone = response.clone.bind(response);
    Object.defineProperties(response, {
      clone: { value: () => decorate(nativeClone()), configurable: true },
      redirected: { value: redirected, configurable: true },
      type: { value: type, configurable: true },
      url: { value: url, configurable: true },
    });
    return response;
  };
  return decorate(new Response(body, responseInit));
}

describe("production service worker", () => {
  it("precaches the complete hashed application asset set on its first install", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const cached = [];
    const workerWrites = [];
    const opened = [];
    const context = {
      URL,
      Set,
      Error,
      Promise,
      Object,
      Headers,
      Response,
      self: {
        location: {
          origin: "https://airship.example",
          href: "https://airship.example/airship/sw.js?revision=index-a1.js",
        },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: { async claim() {} },
      },
      fetch: async (url, options) => {
        if (url === "/airship/release-manifest.json") {
          expect(options).toEqual({ cache: "no-store", credentials: "omit" });
          return {
            ok: true,
            async json() {
              return {
                schema: "airship.release-manifest.v1",
                artifacts: [
                  { path: "assets/index-a1.js" },
                  { path: "assets/index-b2.css" },
                  { path: "assets/KerN3l_42.prime-kernel-worker.js" },
                  { path: "assets/provider-connections-view-c3.js" },
                  { path: "execution-packs/pyodide/python_stdlib.zip" },
                  { path: "../escape.js" },
                  { path: "assets/../scope-escape.js" },
                ],
              };
            },
          };
        }
        expect(url).toBe("https://airship.example/airship/assets/KerN3l_42.prime-kernel-worker.js");
        expect(options).toEqual({ cache: "no-store", credentials: "omit", redirect: "manual" });
        return responseWithProvenance("exact worker", url, {
          status: 200,
          headers: { "Content-Type": "text/javascript" },
        });
      },
      caches: {
        async open(name) {
          opened.push(name);
          return {
            async addAll(urls) { cached.push(...urls); },
            async put(request, response) { workerWrites.push([request, response]); },
          };
        },
        async keys() { return []; },
        async delete() { return true; },
        async match() { return undefined; },
      },
    };
    vm.runInNewContext(source, context);
    let installation;
    listeners.get("install")({ waitUntil(promise) { installation = promise; } });
    await installation;

    expect(opened).toEqual(["airship-shell-index-a1.js"]);
    expect(cached).toEqual([
      "/airship/",
      "/airship/manifest.webmanifest",
      "/airship/favicon.svg",
      "/airship/assets/index-a1.js",
      "/airship/assets/index-b2.css",
      "/airship/assets/provider-connections-view-c3.js",
    ]);
    expect(workerWrites).toHaveLength(1);
    expect(workerWrites[0][0]).toBe("https://airship.example/airship/assets/KerN3l_42.prime-kernel-worker.js");
    expect(workerWrites[0][1].url).toBe("https://airship.example/airship/assets/KerN3l_42.prime-kernel-worker.js");
  });

  it.each([
    {
      name: "same-origin manual redirect",
      response: () => responseWithProvenance("redirect", "https://airship.example/airship/assets/KerN3l_42.prime-kernel-worker.js", {
        status: 302,
        type: "opaqueredirect",
        headers: { Location: "/airship/assets/redirected-worker.js", "Content-Type": "text/javascript" },
      }),
    },
    {
      name: "cross-origin CORS redirect result",
      response: () => responseWithProvenance("cors worker", "https://cdn.attacker.example/worker.js", {
        status: 200,
        type: "cors",
        redirected: true,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/javascript",
        },
      }),
    },
  ])("refuses $name while separately precaching the exact worker", async ({ response: workerResponse }) => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const workerPuts = [];
    const context = {
      URL,
      Set,
      Error,
      Promise,
      Object,
      Headers,
      Response,
      self: {
        location: { origin: "https://airship.example", href: "https://airship.example/airship/sw.js?revision=redirect-test" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: { async claim() {} },
      },
      async fetch(url, options) {
        if (url === "/airship/release-manifest.json") {
          return {
            ok: true,
            async json() {
              return {
                schema: "airship.release-manifest.v1",
                artifacts: [
                  { path: "assets/index-a1.js" },
                  { path: "assets/KerN3l_42.prime-kernel-worker.js" },
                ],
              };
            },
          };
        }
        expect(url).toBe("https://airship.example/airship/assets/KerN3l_42.prime-kernel-worker.js");
        expect(options).toEqual({ cache: "no-store", credentials: "omit", redirect: "manual" });
        return workerResponse();
      },
      caches: {
        async open() {
          return {
            async addAll() {},
            async put(request, response) { workerPuts.push([request, response]); },
          };
        },
        async keys() { return []; },
        async delete() { return true; },
        async match() { return undefined; },
      },
    };
    vm.runInNewContext(source, context);
    let installation;
    listeners.get("install")({ waitUntil(promise) { installation = promise; } });
    await expect(installation).rejects.toThrow(/changed URL, type, status, or JavaScript provenance/u);
    expect(workerPuts).toEqual([]);
  });

  it.each(["cache", "network"])("rejects %s worker provenance drift before rebuilding privileged headers", async (lane) => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const exactUrl = "https://airship.example/airship/assets/KerN3l_42.prime-kernel-worker.js";
    const poisoned = responseWithProvenance("redirect-derived worker", "https://cdn.attacker.example/worker.js", {
      status: 200,
      type: "cors",
      redirected: true,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/javascript" },
    });
    let networkRequests = 0;
    const puts = [];
    const cache = {
      async keys() { return [new Request(exactUrl)]; },
      async match() { return lane === "cache" ? poisoned.clone() : undefined; },
      async put(request, response) { puts.push([request, response]); },
      async addAll() {},
    };
    const context = {
      URL,
      Set,
      Error,
      Promise,
      Object,
      Headers,
      Request,
      Response,
      self: {
        location: { origin: "https://airship.example", href: "https://airship.example/airship/sw.js?revision=drift-test" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: { async claim() {} },
      },
      async fetch(url, options) {
        networkRequests += 1;
        expect(url).toBe(exactUrl);
        expect(options).toEqual({ cache: "no-store", credentials: "omit", redirect: "manual" });
        return poisoned.clone();
      },
      caches: {
        async open() { return cache; },
        async keys() { return []; },
        async delete() { return true; },
        async match() { return undefined; },
      },
    };
    vm.runInNewContext(source, context);
    let response;
    listeners.get("fetch")({
      request: new Request(exactUrl, { headers: { accept: "text/javascript" } }),
      respondWith(promise) { response = promise; },
      waitUntil() {},
    });
    const refused = await response;
    expect(refused.type).toBe("error");
    expect(networkRequests).toBe(lane === "network" ? 1 : 0);
    expect(puts).toEqual([]);
  });

  it("cache-first serves the reviewed optional semantic pack without precaching it", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const cachedResponse = { source: "semantic-cache" };
    let networkRequests = 0;
    const context = {
      URL,
      Set,
      Error,
      Promise,
      self: {
        location: { origin: "https://airship.example", href: "https://airship.example/airship/sw.js" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: { async claim() {} },
      },
      async fetch() {
        networkRequests += 1;
        throw new Error("The cached semantic artifact should not reach the network.");
      },
      caches: {
        async open() { return { async put() {}, async addAll() {} }; },
        async keys() { return []; },
        async delete() { return true; },
        async match(request) {
          return request.url.includes("/semantic-pack/v1/") ? cachedResponse : undefined;
        },
      },
    };
    vm.runInNewContext(source, context);
    let response;
    listeners.get("fetch")({
      request: {
        url: "https://airship.example/airship/semantic-pack/v1/models/example/model.onnx",
        method: "GET",
        mode: "cors",
        cache: "default",
        headers: new Headers({
          accept: "application/octet-stream",
          referer: "https://airship.example/airship/",
        }),
      },
      respondWith(promise) { response = promise; },
      waitUntil() {},
    });

    expect(await response).toBe(cachedResponse);
    expect(networkRequests).toBe(0);
  });

  it("does not intercept credential-bearing, no-store, or range requests under cacheable paths", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const cacheNames = new Set();
    const cacheStorageKeys = new Set();
    const interceptedResponses = [];
    const cacheWrites = [];
    let cacheMatches = 0;
    let workerNetworkRequests = 0;
    const context = {
      URL,
      Set,
      Error,
      Promise,
      self: {
        location: { origin: "https://airship.example", href: "https://airship.example/airship/sw.js" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: { async claim() {} },
      },
      async fetch() {
        workerNetworkRequests += 1;
        return {
          ok: true,
          type: "basic",
          headers: new Headers(),
          clone() { return this; },
        };
      },
      caches: {
        async open(name) {
          cacheNames.add(name);
          return {
            async put(request) { cacheStorageKeys.add(request.url ?? request); },
            async addAll() {},
          };
        },
        async keys() { return [...cacheNames]; },
        async delete(key) { return cacheNames.delete(key); },
        async match(request) {
          cacheMatches += 1;
          return request.url.includes("/semantic-pack/v1/")
            ? { source: "credential-blind-cache" }
            : undefined;
        },
      },
    };
    vm.runInNewContext(source, context);

    const requests = [
      new Request("https://airship.example/airship/semantic-pack/v1/provider/catalog.json", {
        cache: "no-store",
        headers: { "x-api-key": "test-only-key" },
      }),
      new Request("https://airship.example/airship/assets/custom-provider.json", {
        headers: { "x-provider-token": "test-only-token" },
      }),
      new Request("https://airship.example/airship/assets/authorized-provider.json", {
        headers: { authorization: "Bearer test-only-token" },
      }),
      new Request("https://airship.example/airship/assets/model.bin", {
        headers: { range: "bytes=0-7" },
      }),
    ];
    for (const request of requests) {
      listeners.get("fetch")({
        request,
        respondWith(promise) { interceptedResponses.push(promise); },
        waitUntil(promise) { cacheWrites.push(promise); },
      });
    }
    await Promise.all(interceptedResponses);
    await Promise.all(cacheWrites);

    expect(interceptedResponses).toEqual([]);
    expect(cacheMatches).toBe(0);
    expect(cacheStorageKeys).toEqual(new Set());
    expect(await context.caches.keys()).toEqual([]);
    expect(workerNetworkRequests).toBe(0);
  });

  it("recognizes only the manifest-pinned worker and rebuilds cached, network, and offline responses", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const exactPath = "/airship/assets/KerN3l_42.prime-kernel-worker.js";
    const exactUrl = `https://airship.example${exactPath}`;
    let installComplete = false;
    let cachedWorker;
    let networkWorker;
    let networkRequests = 0;
    const writes = [];
    const cache = {
      async addAll() {},
      async keys() { return [new Request(`https://airship.example${exactPath}`)]; },
      async match(request) {
        return new URL(request.url ?? request, "https://airship.example").pathname === exactPath
          ? cachedWorker?.clone()
          : undefined;
      },
      async put(request, response) { writes.push([request, response]); },
    };
    const context = {
      URL,
      Set,
      Error,
      Promise,
      Object,
      Headers,
      Request,
      Response,
      self: {
        location: { origin: "https://airship.example", href: "https://airship.example/airship/sw.js?revision=current" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: { async claim() {} },
      },
      async fetch(request, options) {
        if (request === "/airship/release-manifest.json") {
          return new Response(JSON.stringify({
            schema: "airship.release-manifest.v1",
            artifacts: [
              { path: "assets/index-a1.js" },
              { path: "assets/KerN3l_42.prime-kernel-worker.js" },
            ],
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (typeof request === "string" && request === exactUrl) {
          expect(options).toEqual({ cache: "no-store", credentials: "omit", redirect: "manual" });
          if (!installComplete) {
            return responseWithProvenance("install worker", exactUrl, {
              status: 200,
              headers: { "Content-Type": "text/javascript" },
            });
          }
          networkRequests += 1;
          if (!networkWorker) throw new Error("offline");
          return networkWorker.clone();
        }
        networkRequests += 1;
        if (!networkWorker) throw new Error("offline");
        return networkWorker.clone();
      },
      caches: {
        async open() { return cache; },
        async keys() { return []; },
        async delete() { return true; },
        async match() { return undefined; },
      },
    };
    vm.runInNewContext(source, context);
    let installation;
    listeners.get("install")({ waitUntil(promise) { installation = promise; } });
    await installation;
    installComplete = true;

    async function dispatch(path) {
      const request = new Request(`https://airship.example${path}`, {
        headers: { accept: "text/javascript", referer: "https://airship.example/airship/" },
      });
      let response;
      listeners.get("fetch")({
        request,
        respondWith(promise) { response = promise; },
        waitUntil() {},
      });
      return response ? response : undefined;
    }
    function expectWorkerHeaders(response) {
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
      );
      expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }

    cachedWorker = responseWithProvenance("cached worker", exactUrl, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript",
        "Content-Security-Policy": "default-src 'self', connect-src *",
      },
    });
    const cached = await dispatch(exactPath);
    expect(await cached.text()).toBe("cached worker");
    expectWorkerHeaders(cached);
    expect(networkRequests).toBe(0);

    cachedWorker = undefined;
    networkWorker = responseWithProvenance("network worker", exactUrl, {
      status: 200,
      headers: { "Content-Type": "text/javascript" },
    });
    const network = await dispatch(exactPath);
    expect(await network.text()).toBe("network worker");
    expectWorkerHeaders(network);
    expect(networkRequests).toBe(1);

    const lookalike = await dispatch("/airship/assets/OtherHash.prime-kernel-worker.js");
    expect(lookalike.type).toBe("error");
    expect(networkRequests).toBe(1);

    const ordinary = await dispatch("/airship/assets/ordinary.js");
    expect(await ordinary.text()).toBe("network worker");
    expect(ordinary.headers.get("Content-Security-Policy")).toBeNull();
    expect(networkRequests).toBe(2);

    cachedWorker = responseWithProvenance("offline worker", exactUrl, {
      status: 200,
      headers: { "Content-Type": "text/javascript" },
    });
    networkWorker = undefined;
    const offline = await dispatch(exactPath);
    expect(await offline.text()).toBe("offline worker");
    expectWorkerHeaders(offline);
    expect(networkRequests).toBe(2);
    const workerWrites = writes.filter(([key]) => key === exactUrl);
    expect(workerWrites).toHaveLength(2);
    for (const [key, response] of workerWrites) {
      expect(key).toBe(exactUrl);
      expect(response.url).toBe(exactUrl);
      expect(response.type).toBe("basic");
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
    }
  });

  it("recovers the unique worker route from the release cache after the service-worker global restarts", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const exactUrl = "https://airship.example/airship/assets/KerN3l_42.prime-kernel-worker.js";
    const cache = {
      async keys() { return [new Request(exactUrl)]; },
      async match() {
        return responseWithProvenance("offline restart", exactUrl, {
          status: 200,
          headers: { "Content-Type": "text/javascript" },
        });
      },
      async put() {},
      async addAll() {},
    };
    const context = {
      URL,
      Set,
      Error,
      Promise,
      Object,
      Headers,
      Request,
      Response,
      self: {
        location: { origin: "https://airship.example", href: "https://airship.example/airship/sw.js?revision=current" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: { async claim() {} },
      },
      async fetch() { throw new Error("offline"); },
      caches: {
        async open() { return cache; },
        async keys() { return []; },
        async delete() { return true; },
        async match() { return undefined; },
      },
    };
    vm.runInNewContext(source, context);
    let response;
    listeners.get("fetch")({
      request: new Request(exactUrl, { headers: { accept: "text/javascript" } }),
      respondWith(promise) { response = promise; },
      waitUntil() {},
    });
    const rebuilt = await response;
    expect(await rebuilt.text()).toBe("offline restart");
    expect(rebuilt.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
    );
  });

  it("claims the first page and adds cross-origin isolation to network and offline navigations", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    let claimed = 0;
    let onlineAvailable = true;
    let offlineNavigationCached = false;
    const deleted = [];
    const nestedNavigations = [];
    const online = new Response("<!doctype html><title>Airship</title>", {
      status: 200,
      headers: { "Content-Type": "text/html", "X-Origin-Marker": "preserved" },
    });
    const context = {
      URL,
      Set,
      Error,
      Promise,
      Object,
      Headers,
      Response,
      self: {
        location: {
          origin: "https://airship.example",
          href: "https://airship.example/airship/sw.js?revision=index-current.js",
        },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
        clients: {
          async claim() { claimed += 1; },
          async matchAll(options) {
            expect(options).toEqual({ includeUncontrolled: true, type: "window" });
            return [
              { frameType: "top-level", url: "https://airship.example/airship/", async navigate() { throw new Error("top-level work must not be forced"); } },
              { frameType: "nested", url: "https://airship.example/airship/#chat", async navigate(url) { nestedNavigations.push(url); } },
            ];
          },
        },
      },
      async fetch() {
        if (!onlineAvailable) throw new Error("offline");
        return online.clone();
      },
      caches: {
        async open() { return { async put() {}, async addAll() {} }; },
        async keys() {
          return [
            "airship-shell-index-old.js",
            "airship-shell-index-current.js",
            "unrelated-application-cache",
          ];
        },
        async delete(key) { deleted.push(key); return true; },
        async match(request) {
          return request === "/airship/" && offlineNavigationCached
            ? new Response("<!doctype html><title>Airship</title>", {
                status: 200,
                headers: { "Content-Type": "text/html", "X-Origin-Marker": "preserved" },
              })
            : undefined;
        },
      },
    };
    vm.runInNewContext(source, context);

    let activation;
    listeners.get("activate")({ waitUntil(promise) { activation = promise; } });
    await activation;
    expect(claimed).toBe(1);
    expect(nestedNavigations).toEqual(["https://airship.example/airship/#chat"]);
    expect(deleted).toEqual(["airship-shell-index-old.js"]);

    const navigationRequest = {
      url: "https://airship.example/airship/",
      method: "GET",
      mode: "navigate",
      cache: "default",
      headers: new Headers({ accept: "text/html", "upgrade-insecure-requests": "1" }),
    };
    let response;
    let cacheWrite;
    listeners.get("fetch")({
      request: navigationRequest,
      respondWith(promise) { response = promise; },
      waitUntil(promise) { cacheWrite = promise; },
    });
    const isolated = await response;
    await cacheWrite;
    expect(await isolated.text()).toContain("<title>Airship</title>");
    expect(isolated.headers.get("X-Origin-Marker")).toBe("preserved");
    expect(isolated.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(isolated.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(isolated.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(isolated.headers.get("Content-Security-Policy")).toBe(EXACT_DOCUMENT_CONTENT_SECURITY_POLICY);

    let noStoreResponse;
    let noStoreCacheWrite = false;
    listeners.get("fetch")({
      request: { ...navigationRequest, cache: "no-store" },
      respondWith(promise) { noStoreResponse = promise; },
      waitUntil() { noStoreCacheWrite = true; },
    });
    const noStore = await noStoreResponse;
    expect(noStore.headers.get("Content-Security-Policy")).toBe(EXACT_DOCUMENT_CONTENT_SECURITY_POLICY);
    expect(noStoreCacheWrite).toBe(false);

    let authorizedResponse;
    let authorizedCacheWrite = false;
    listeners.get("fetch")({
      request: {
        ...navigationRequest,
        headers: new Headers({ accept: "text/html", authorization: "Basic private" }),
      },
      respondWith(promise) { authorizedResponse = promise; },
      waitUntil() { authorizedCacheWrite = true; },
    });
    const authorized = await authorizedResponse;
    expect(authorized.headers.get("Content-Security-Policy")).toBe(EXACT_DOCUMENT_CONTENT_SECURITY_POLICY);
    expect(authorizedCacheWrite).toBe(false);

    onlineAvailable = false;
    offlineNavigationCached = true;
    let offlineResponse;
    listeners.get("fetch")({
      request: navigationRequest,
      respondWith(promise) { offlineResponse = promise; },
      waitUntil() {},
    });
    const offline = await offlineResponse;
    expect(await offline.text()).toContain("<title>Airship</title>");
    expect(offline.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(offline.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(offline.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(offline.headers.get("Content-Security-Policy")).toBe(EXACT_DOCUMENT_CONTENT_SECURITY_POLICY);
  });
});
