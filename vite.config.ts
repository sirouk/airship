import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
// The test block below is vitest config, not vite config; vitest extends the
// vite type so both live in this object.
import { defineConfig } from "vitest/config";
import { localChutesOAuthBridge } from "./scripts/local-chutes-oauth-bridge";
import { airshipPyodideAssets } from "./scripts/pyodide-assets";
import { airshipSemanticPackAssets, readVerifiedSemanticPack } from "./scripts/semantic-pack-assets";

const DEFERRED_HTML_PRELOAD = /(?:^|\/)(?:prime|prime-runtime|prime-kernel|prime-harness|prime-subagents|prime-tools|prime-ai|prime-agent|transport-adapter|deferred-capabilities|load-deferred-capabilities|execution-runtime-pack|execution-engine|runtime-registry|execution-tools|wasi-preview1-worker|node-webcontainer-pack|wasix-pack|wasix-worker|dist|index|agent|multimodal|context-policy|tool-bundle|client-context-runtime|context-selection|repository-admission|editor-view|workspace-binding|content-codec|sources-view|source-selection|workspace-adapter|sessions-route|session-manifest|session-pins|session-fork|fork-context|capabilities-view|browser-runtime|memory-view|skills-manager-view|skill-editor|kind-visual|proof-view|client|request-state|evidence-acquisition-queue|workspace-evidence-acquisition-persistence|terminal-view|terminal-dock-state|semantic\.worker|client-runtime|telemetry|fabric|openai|provider-connections-view|providers|session-route|inference-bridge-pack|chutes-oauth|chutes-oauth-registration|extension-bridge|local-device-vault-setup|local-device-keyring|encrypted-envelope|local-lab)-[A-Za-z0-9_-]+\.(?:js|css)$/u;
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

/**
 * Vite's dependency scanner otherwise treats every HTML file below the project
 * root as an application entry. This repository also contains a separately
 * packaged extension and reference checkouts, neither of which belongs to the
 * web application's development dependency graph.
 */
export const DEVELOPMENT_OPTIMIZE_ENTRIES = Object.freeze(["index.html"]);

const PUBLIC_BASE_PATH = resolvePublicBasePath(process.env.AIRSHIP_PUBLIC_BASE_PATH);
const VERIFIED_SEMANTIC_PACK = process.env.AIRSHIP_DISABLE_SEMANTIC_PACK === "1"
  ? null
  : readVerifiedSemanticPack();
const SEMANTIC_PACK_AVAILABLE = VERIFIED_SEMANTIC_PACK !== null;

export default defineConfig({
  base: PUBLIC_BASE_PATH,
  test: {
    // Suites outgrew the stock 5 s default on shared worker hosts; full-tree
    // runs of some long-but-alway-passing tests time out under contention in
    // shared machines. 30 s is the point where environments state their own
    // budgets honestly instead of aborting mid-exchange.
    testTimeout: 30_000,
  },
  define: {
    "import.meta.env.VITE_AIRSHIP_SEMANTIC_PACK_AVAILABLE": JSON.stringify(SEMANTIC_PACK_AVAILABLE ? "true" : "false"),
  },
  optimizeDeps: {
    entries: [...DEVELOPMENT_OPTIMIZE_ENTRIES],
  },
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
    airshipSemanticPackAssets(VERIFIED_SEMANTIC_PACK),
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
          /*
           * `transcript-operations` is imported by `platform-shell.tsx`, which
           * is on the boot path, and by `message-parts-view.tsx`, which is
           * deferred. Rollup is free to resolve that shared module either way,
           * and it did: built from two checkouts of the identical tree — same
           * sources, same config, same lockfile — it emitted a 350 B stub in
           * one and a 10.5 KiB chunk in the other, moving the baseline budget
           * by 4 KiB gzip and failing the release gate in a clean clone while
           * passing on the machine it was tuned on.
           *
           * A budget that depends on which directory you built in is not a
           * budget. The chunk is named here for ATTRIBUTION — the same reason
           * `chunkFileNames` below names the shell and bridge packs, so the
           * release gate's classifier is exact rather than matching on whatever
           * Rollup happened to call it. Naming it did NOT remove the
           * cross-checkout split: both forms are still observed, and the gate's
           * ceilings cover both, pending a dedicated deterministic-build
           * repair.
           */
          if (id.includes("/src/ui/chat/transcript-operations")) return "transcript-operations";
          /*
           * The code scanner is now shared by two deferred surfaces — the
           * transcript's code blocks and the Workspace editor's painted layer
           * — and their only common ancestor is the entry. Rollup answered
           * that by hoisting its five grammar tables into the eager bundle,
           * which is 2 KiB of first paint spent on a scanner that cannot run
           * until a route neither of them is has been opened. Named here so it
           * stays one deferred chunk fetched by whichever surface asks first.
           */
          if (id.includes("/src/ui/chat/highlight")) return "code-highlight";
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
          if (ownedByBridge) return "assets/inference-bridge-pack-[hash].js";
          /*
           * `git/client.ts` moved off the startup path so a visitor who never
           * opens the Workspace does not pay for Git. Alone it emits a chunk
           * named `client`, a shape the release gate's Proof-surface classifier
           * already claims. Name it for what it is so the classifier stays
           * exact rather than matching by accident.
           */
          /*
           * Any chunk made purely of Git modules that is not the adapter facade
           * belongs to this pack. Moving the client off first paint split
           * `git/operations.ts` out beside it, and a second generically named
           * chunk is exactly what the classifier must not have to guess about.
           */
          const GIT_CLIENT_MODULES = ["/src/git/client.ts", "/src/git/operations.ts"];
          const ownedByGitClient = modules.length > 0
            && modules.every((id) => id.includes("/src/git/"))
            && modules.some((id) => GIT_CLIENT_MODULES.some((entry) => id.includes(entry)));
          return ownedByGitClient
            ? "assets/browser-git-client-[hash].js"
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
