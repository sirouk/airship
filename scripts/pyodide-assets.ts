import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const PYODIDE_VERSION = "314.0.2";
export const PYODIDE_PUBLIC_BASE = "/execution-packs/pyodide/";
export const PYODIDE_ASSET_NAMES = Object.freeze([
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "pyodide-lock.json",
  "python_stdlib.zip",
]);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/pyodide");

/**
 * Serve and emit only the minimal locked Pyodide core. Runtime bytes stay out
 * of the application graph, retain their upstream filenames for Pyodide's
 * loader, and are hashed with every other file by the release manifest.
 */
export function airshipPyodideAssets(): Plugin {
  return {
    name: "airship-pyodide-assets",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://airship.invalid").pathname;
        if (!pathname.startsWith(PYODIDE_PUBLIC_BASE)) return next();
        const name = decodeURIComponent(pathname.slice(PYODIDE_PUBLIC_BASE.length));
        if (!PYODIDE_ASSET_NAMES.includes(name)) {
          response.statusCode = 404;
          response.end("Unknown Pyodide asset.");
          return;
        }
        try {
          await assertLockedPackage();
          response.statusCode = 200;
          response.setHeader("Content-Type", contentType(name));
          response.setHeader("Cache-Control", "no-cache");
          response.end(await readPackAsset(name));
        } catch (error) {
          next(error instanceof Error ? error : new Error("Failed to serve the Pyodide pack."));
        }
      });
    },
    async generateBundle() {
      await assertLockedPackage();
      for (const name of PYODIDE_ASSET_NAMES) {
        this.emitFile({
          type: "asset",
          fileName: `${PYODIDE_PUBLIC_BASE.slice(1)}${name}`,
          source: await readPackAsset(name),
        });
      }
    },
  };
}

async function assertLockedPackage(): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (manifest.version !== PYODIDE_VERSION) {
    throw new Error(`Airship requires locked pyodide@${PYODIDE_VERSION}; found ${String(manifest.version)}.`);
  }
}

async function readPackAsset(name: string): Promise<Buffer> {
  const payload = await readFile(resolve(packageRoot, name));
  if (!name.endsWith(".mjs")) return payload;
  // Upstream points at maps that Airship intentionally does not ship. Remove
  // only that non-executable trailer; the exact served bytes are still hashed
  // into the Airship release manifest.
  return Buffer.from(payload.toString("utf8").replace(/\/\/[#@]\s*sourceMappingURL=.*?(?:\r?\n|$)/gu, ""), "utf8");
}

function contentType(name: string): string {
  switch (extname(name)) {
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".wasm": return "application/wasm";
    case ".json": return "application/json; charset=utf-8";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}
