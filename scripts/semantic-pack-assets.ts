import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import artifactManifest from "../src/indexing/semantic-artifact-manifest.json";

export const SEMANTIC_PACK_OUTPUT_PREFIX = "semantic-pack/v1/";
export const SEMANTIC_PACK_STATE_FILE = "semantic-pack-state.json";

type SemanticPackAssets = Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>;
export type VerifiedSemanticPackAsset = Readonly<{
  relativePath: string;
  source: Buffer;
}>;

/**
 * Reads one immutable pack snapshot only when every manifest-pinned byte matches.
 * The returned buffers are the exact bytes both the dev server and build emit,
 * so availability cannot race a later file change.
 */
export function readVerifiedSemanticPack(
  root = resolve(process.cwd(), ".airship-lab/semantic-pack"),
  assets: SemanticPackAssets = artifactManifest.assets,
): readonly VerifiedSemanticPackAsset[] | null {
  try {
    const entries = Object.entries(assets);
    if (entries.length === 0) return null;
    const packRoot = resolve(root);
    const verified = entries.map(([relativePath, expected]) => {
      const file = resolve(packRoot, relativePath);
      if (!file.startsWith(`${packRoot}${sep}`)) throw new Error("Semantic pack path escaped its root.");
      const source = readFileSync(file);
      const digest = createHash("sha256").update(source).digest("hex");
      if (source.byteLength !== expected.bytes || digest !== expected.sha256) {
        throw new Error("Semantic pack asset failed its manifest pin.");
      }
      return Object.freeze({ relativePath, source });
    });
    return Object.freeze(verified);
  } catch {
    // The pack is optional. An unreadable or concurrently changing directory is
    // unavailable, not permission to start requests against a partial pack.
    return null;
  }
}

/** True only when every manifest-pinned pack asset is present and hash-exact. */
export function isSemanticPackPrepared(
  root = resolve(process.cwd(), ".airship-lab/semantic-pack"),
  assets: SemanticPackAssets = artifactManifest.assets,
): boolean {
  return readVerifiedSemanticPack(root, assets) !== null;
}

/** Public request prefix for a root or subpath Vite deployment. */
export function semanticPackPublicPrefix(base: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}${SEMANTIC_PACK_OUTPUT_PREFIX}`;
}

export function semanticPackBuildAssets(verifiedAssets: readonly VerifiedSemanticPackAsset[]) {
  return [
    Object.freeze({
      fileName: SEMANTIC_PACK_STATE_FILE,
      source: Buffer.from(`${JSON.stringify({
        schema: "airship.semantic-pack-state.v1",
        available: verifiedAssets.length > 0,
        modelRevision: artifactManifest.modelRevision,
      }, null, 2)}\n`),
    }),
    ...verifiedAssets.map((asset) => Object.freeze({
      fileName: `${SEMANTIC_PACK_OUTPUT_PREFIX}${asset.relativePath}`,
      source: asset.source,
    })),
  ];
}

/** Serves and emits only the hash-verified, explicitly prepared public pack. */
export function airshipSemanticPackAssets(
  verifiedAssets: readonly VerifiedSemanticPackAsset[] | null = readVerifiedSemanticPack(),
): Plugin {
  const assetsByPath = new Map(verifiedAssets?.map((asset) => [asset.relativePath, asset.source]) ?? []);
  let prefix = semanticPackPublicPrefix("/");
  const install = (middlewares: { use(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => void): void }) => {
    middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? "/", "http://airship.local").pathname;
      if (!pathname.startsWith(prefix)) { next(); return; }
      let relative: string;
      try {
        relative = decodeURIComponent(pathname.slice(prefix.length));
      } catch {
        response.statusCode = 404;
        response.end("Unknown semantic pack asset.");
        return;
      }
      const source = assetsByPath.get(relative);
      if (!source) {
        response.statusCode = 404;
        response.end("Optional semantic pack is not prepared. Run npm run semantic:prepare and restart Airship.");
        return;
      }
      /*
       * ORT's threaded WASM runtime starts same-origin module workers from this
       * pack. Those worker responses must opt into the same embedder policy as
       * the parent semantic worker or Chromium blocks them before execution.
       * A concrete byte length also lets the browser finish the verified model
       * cache entry before Transformers.js opens the same pinned artifact.
       */
      for (const [name, value] of Object.entries(semanticPackResponseHeaders(relative, source.byteLength))) {
        response.setHeader(name, value);
      }
      response.end(source);
    });
  };
  return {
    name: "airship-semantic-pack-assets",
    configResolved(config) {
      prefix = semanticPackPublicPrefix(config.base);
    },
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      // A preview of an already-built directory can serve its emitted pack even
      // if the source-side preparation directory has since been removed.
      if (verifiedAssets) install(server.middlewares);
    },
    generateBundle() {
      for (const asset of semanticPackBuildAssets(verifiedAssets ?? [])) {
        this.emitFile({
          type: "asset",
          fileName: asset.fileName,
          source: asset.source,
        });
      }
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
