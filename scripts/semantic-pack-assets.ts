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
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (file.endsWith(".wasm")) response.setHeader("Content-Type", "application/wasm");
      else if (file.endsWith(".mjs") || file.endsWith(".js")) response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      else if (file.endsWith(".json")) response.setHeader("Content-Type", "application/json; charset=utf-8");
      else response.setHeader("Content-Type", "application/octet-stream");
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
