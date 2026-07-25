import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("production service worker", () => {
  it("precaches the complete hashed application asset set on its first install", async () => {
    const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map();
    const cached = [];
    const context = {
      URL,
      Set,
      Error,
      Promise,
      self: {
        location: { origin: "https://airship.example", href: "https://airship.example/airship/sw.js" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
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
        async open() { return { async addAll(urls) { cached.push(...urls); } }; },
        async keys() { return []; },
        async delete() { return true; },
        async match() { return undefined; },
      },
    };
    vm.runInNewContext(source, context);
    let installation;
    listeners.get("install")({ waitUntil(promise) { installation = promise; } });
    await installation;

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
});
