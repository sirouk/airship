import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("production service worker", () => {
  it("precaches the complete hashed application asset set on its first install", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const cached = [];
    const opened = [];
    const context = {
      URL,
      Set,
      Error,
      Promise,
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
        expect(url).toBe("/airship/release-manifest.json");
        expect(options).toEqual({ cache: "no-store", credentials: "omit" });
        return {
          ok: true,
          async json() {
            return {
              schema: "airship.release-manifest.v1",
              artifacts: [
                { path: "assets/index-a1.js" },
                { path: "assets/index-b2.css" },
                { path: "assets/chutes-e2ee-c3.wasm" },
                { path: "execution-packs/pyodide/python_stdlib.zip" },
                { path: "../escape.js" },
                { path: "assets/../scope-escape.js" },
              ],
            };
          },
        };
      },
      caches: {
        async open(name) {
          opened.push(name);
          return { async addAll(urls) { cached.push(...urls); } };
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
      "/airship/assets/chutes-e2ee-c3.wasm",
    ]);
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
        headers: { has() { return false; } },
      },
      respondWith(promise) { response = promise; },
      waitUntil() {},
    });

    expect(await response).toBe(cachedResponse);
    expect(networkRequests).toBe(0);
  });

  it("claims the first page and adds cross-origin isolation to network and offline navigations", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    let claimed = 0;
    const deleted = [];
    const online = new Response("<!doctype html><title>Airship</title>", {
      status: 200,
      headers: { "Content-Type": "text/html", "X-Origin-Proof": "preserved" },
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
        clients: { async claim() { claimed += 1; } },
      },
      async fetch() { return online.clone(); },
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
        async match() { return undefined; },
      },
    };
    vm.runInNewContext(source, context);

    let activation;
    listeners.get("activate")({ waitUntil(promise) { activation = promise; } });
    await activation;
    expect(claimed).toBe(1);
    expect(deleted).toEqual(["airship-shell-index-old.js"]);

    let response;
    let cacheWrite;
    listeners.get("fetch")({
      request: {
        url: "https://airship.example/airship/",
        method: "GET",
        mode: "navigate",
        headers: { has() { return false; } },
      },
      respondWith(promise) { response = promise; },
      waitUntil(promise) { cacheWrite = promise; },
    });
    const isolated = await response;
    await cacheWrite;
    expect(await isolated.text()).toContain("<title>Airship</title>");
    expect(isolated.headers.get("X-Origin-Proof")).toBe("preserved");
    expect(isolated.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(isolated.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(isolated.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });
});
