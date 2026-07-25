import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { localChutesOAuthBridge } from "./scripts/local-chutes-oauth-bridge";
import { airshipPyodideAssets } from "./scripts/pyodide-assets";
import { airshipSemanticPackAssets } from "./scripts/semantic-pack-assets";

const DEFERRED_HTML_PRELOAD = /(?:^|\/)(?:deferred-capabilities|execution-runtime-pack|execution-engine|runtime-registry|wasi-preview1-worker|node-webcontainer-pack|wasix-pack|wasix-worker|dist|index|agent|tool-bundle|client-context-runtime|context-selection|repository-admission|editor-view|workspace-binding|content-codec|sources-view|source-selection|workspace-adapter|sessions-route|capabilities-view|browser-runtime|memory-view|kind-visual|proof-view|client|terminal-view|semantic\.worker|client-runtime|telemetry|fabric|openai|provider-connections-view|providers|session-route|local-device-vault-setup|local-device-keyring|encrypted-envelope|local-lab)-[A-Za-z0-9_-]+\.(?:js|css)$/u;

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

export default defineConfig({
  base: resolvePublicBasePath(process.env.AIRSHIP_PUBLIC_BASE_PATH),
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
