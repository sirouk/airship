import type { Plugin } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const PREFIX = "/semantic-pack/v1/";

/** Serves only the explicitly prepared, public semantic pack on the app origin. */
export function airshipSemanticPackAssets(): Plugin {
  const root = resolve(process.cwd(), ".airship-lab/semantic-pack");
  const install = (middlewares: { use(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => void): void }) => {
    middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? "/", "http://airship.local").pathname;
      if (!pathname.startsWith(PREFIX)) { next(); return; }
      const relative = decodeURIComponent(pathname.slice(PREFIX.length));
      const file = resolve(root, relative);
      if ((!file.startsWith(`${root}${sep}`) && file !== root) || !existsSync(file) || !statSync(file).isFile()) {
        response.statusCode = 404;
        response.end("Optional semantic pack is not prepared. Run npm run semantic:prepare.");
        return;
      }
      const fileStats = statSync(file);
      /*
       * ORT's threaded WASM runtime starts same-origin module workers from this
       * pack. Those worker responses must opt into the same embedder policy as
       * the parent semantic worker or Chromium blocks them before execution.
       * A concrete byte length also lets the browser finish the verified model
       * cache entry before Transformers.js opens the same pinned artifact.
       */
      for (const [name, value] of Object.entries(semanticPackResponseHeaders(file, fileStats.size))) {
        response.setHeader(name, value);
      }
      createReadStream(file).pipe(response);
    });
  };
  return {
    name: "airship-semantic-pack-assets",
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export function semanticPackResponseHeaders(
  file: string,
  byteLength: number,
): Readonly<Record<string, string>> {
  const contentType = file.endsWith(".wasm")
    ? "application/wasm"
    : file.endsWith(".mjs") || file.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : file.endsWith(".json")
        ? "application/json; charset=utf-8"
        : "application/octet-stream";
  return Object.freeze({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(byteLength),
    "Content-Type": contentType,
    "Cross-Origin-Embedder-Policy": "credentialless",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}
