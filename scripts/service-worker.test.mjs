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
        location: { origin: "https://airship.example" },
        addEventListener(type, listener) { listeners.set(type, listener); },
        skipWaiting() {},
      },
      fetch: async (url, options) => {
        expect(url).toBe("/release-manifest.json");
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
      "/",
      "/manifest.webmanifest",
      "/favicon.svg",
      "/assets/index-a1.js",
      "/assets/index-b2.css",
      "/assets/chutes-e2ee-c3.wasm",
    ]);
  });
});
