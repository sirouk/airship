import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { localChutesOAuthBridge } from "./scripts/local-chutes-oauth-bridge";
import { airshipPyodideAssets } from "./scripts/pyodide-assets";
import { airshipSemanticPackAssets } from "./scripts/semantic-pack-assets";

const DEFERRED_HTML_PRELOAD = /(?:^|\/)(?:deferred-capabilities|execution-runtime-pack|execution-engine|runtime-registry|wasi-preview1-worker|node-webcontainer-pack|wasix-pack|wasix-worker|dist|index|agent|tool-bundle|client-context-runtime|context-selection|repository-admission|editor-view|workspace-binding|content-codec|sources-view|source-selection|workspace-adapter|sessions-route|capabilities-view|browser-runtime|memory-view|kind-visual|proof-view|client|terminal-view|semantic\.worker|client-runtime|telemetry|fabric|openai|provider-connections-view|providers|session-route|inference-bridge-pack|local-device-vault-setup|local-device-keyring|encrypted-envelope|local-lab)-[A-Za-z0-9_-]+\.(?:js|css)$/u;
/**
 * Vite may otherwise promote dependencies of dynamic imports into index.html.
 * Preserve its just-in-time JS-host preloads, but keep optional Airship packs
 * out of the HTML bootstrap so route/runtime activation remains the authority.
 */
export function resolveAirshipModulePreloadDependencies(
  _filename: string,
  dependencies: string[],
  context: Readonly<{ hostId: string; hostType: "html" | "js" }>,
): string[] {
  return context.hostType === "html"
    ? dependencies.filter((dependency) => !DEFERRED_HTML_PRELOAD.test(dependency))
    : dependencies;
}

export function applyLocalDevelopmentPolicy(html: string): string {
  return html
    .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
    .replace(
      "connect-src 'self' ",
      "connect-src 'self' http://localhost:9900 http://127.0.0.1:9900 ",
    );
}

export function resolvePublicBasePath(value: string | undefined): string {
  const candidate = value?.trim() || "/";
  if (!candidate.startsWith("/") || candidate.includes("?") || candidate.includes("#")) {
    throw new TypeError("AIRSHIP_PUBLIC_BASE_PATH must be an absolute URL path.");
  }
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}

export function rewriteLocalExtensionHubRequest(value: string, basePath: string): string {
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex < 0 ? value : value.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : value.slice(queryIndex);
  const hubPath = `${basePath}extension`;
  return pathname === hubPath || pathname === `${hubPath}/`
    ? `${hubPath}/index.html${query}`
    : value;
}

/**
 * Generated acceptance artifacts live below the repository root, but they are
 * not application inputs. Watching them makes Playwright traces and reports
 * trigger Vite page reloads while the browser under test is still running.
 * Keep the list explicit so a new source directory cannot be hidden by a broad
 * repository-wide ignore.
 */
export const DEVELOPMENT_WATCH_IGNORES = Object.freeze([
  "**/.airship-lab/**",
  "**/build/**",
  "**/dist/**",
  "**/playwright-report/**",
  "**/test-results/**",
  "**/.vinext/**",
  "**/.wrangler/**",
]);

const PUBLIC_BASE_PATH = resolvePublicBasePath(process.env.AIRSHIP_PUBLIC_BASE_PATH);

export default defineConfig({
  base: PUBLIC_BASE_PATH,
  resolve: {
    // isomorphic-git's standard fallback drags a Node Buffer-inspection graph
    // into the otherwise browser-native Git pack. Airship keeps the same
    // constructor contract in a reviewed, byte-view-only implementation.
    alias: {
      "sha.js/sha1.js": fileURLToPath(new URL("./src/git/sha1-fallback.ts", import.meta.url)),
    },
  },
  plugins: [
    preact(),
    airshipPyodideAssets(),
    airshipSemanticPackAssets(),
    localChutesOAuthBridge(),
    {
      name: "airship-local-development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        // Vite's development-only CSS HMR client injects <style> elements.
        // The loopback origins are the disposable MinIO lab only. The source
        // and production response remain on the reviewed strict policy.
        return applyLocalDevelopmentPolicy(html);
      },
    },
    {
      name: "airship-local-extension-hub",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url) {
            request.url = rewriteLocalExtensionHubRequest(request.url, PUBLIC_BASE_PATH);
          }
          next();
        });
      },
    },
  ],
  build: {
    target: "es2022",
    modulePreload: {
      resolveDependencies: resolveAirshipModulePreloadDependencies,
    },
    // Source maps are not shipped from the static client. Same-origin source
    // disclosure materially enlarges the blast radius of a release compromise.
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        /*
         * The provider relay and companion client are reached from several
         * independent dynamic routes. Group their small, shared wire clients
         * into one optional pack so adding another consumer cannot duplicate
         * the protocol shell or silently grow the optional-pack count.
         */
        manualChunks(id) {
          return id.includes("/src/inference/bridge/")
            ? "inference-bridge-pack"
            : undefined;
        },
        // The shell interpreter's entry modules are named `pack` and
        // `contract`, which would emit generic chunk names that the release
        // gate cannot attribute to an owner. Name them explicitly so the
        // artifact classifier stays exact rather than matching by accident.
        chunkFileNames(chunk) {
          // A shared shell chunk has no facade module, so ownership is decided
          // by every module it carries rather than by its entry alone.
          const modules = chunk.moduleIds ?? [];
          const ownedByShell = modules.length > 0
            && modules.every((id) => id.includes("/execution/shell/"));
          if (ownedByShell) return "assets/airship-shell-pack-[hash].js";
          /*
           * The extension-bridge client is shared between the provider
           * transports and the Connect surface's presence observation, so
           * Rollup splits it out. Its entry module is named `client`, which
           * three unrelated chunks are also named — an artifact the release
           * gate could then only attribute by accident.
           */
          const ownedByBridge = modules.length > 0
            && modules.every((id) => id.includes("/inference/bridge/"));
          return ownedByBridge
            ? "assets/inference-bridge-pack-[hash].js"
            : "assets/[name]-[hash].js";
        },
      },
    },
  },
  server: {
    // Credential and recovery-key surfaces are loopback-only by default.
    // Deliberate LAN testing must use the explicit package script.
    host: "127.0.0.1",
    watch: {
      ignored: [...DEVELOPMENT_WATCH_IGNORES],
    },
    headers: {
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  worker: {
    format: "es",
  },
});
