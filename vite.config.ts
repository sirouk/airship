import preact from "@preact/preset-vite";
import { build as bundleWithEsbuild } from "esbuild";
import { fileURLToPath } from "node:url";
// The test block below is vitest config, not vite config; vitest extends the
// vite type so both live in this object.
import { defineConfig } from "vitest/config";
import { airshipPyodideAssets } from "./scripts/pyodide-assets";
import { airshipSemanticPackAssets, readVerifiedSemanticPack } from "./scripts/semantic-pack-assets";

const DEFERRED_HTML_PRELOAD = /(?:^|\/)(?:prime|prime-runtime|prime-kernel|prime-harness|prime-subagents|prime-tools|prime-ai|prime-agent|transport-adapter|deferred-capabilities|load-deferred-capabilities|execution-runtime-pack|execution-engine|runtime-registry|execution-tools|wasi-preview1-worker|node-webcontainer-pack|dist|index|agent|multimodal|context-policy|tool-bundle|client-context-runtime|context-selection|repository-admission|editor-view|workspace-binding|content-codec|sources-view|source-selection|workspace-adapter|sessions-route|session-manifest|session-pins|session-fork|fork-context|capabilities-view|browser-runtime|memory-view|skills-manager-view|skill-editor|kind-visual|client|request-state|terminal-view|terminal-dock-state|semantic\.worker|fabric|openai|provider-connections-view|providers|session-route|inference-bridge-pack|extension-bridge|local-device-vault-setup|local-device-keyring|encrypted-envelope|local-lab)-[A-Za-z0-9_-]+\.(?:js|css)$/u;
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

/**
 * This also carried a `style-src 'self';` → `'unsafe-inline'` rewrite for
 * Vite's CSS HMR client. The shipped policy in `index.html` has not had that
 * shape for some time — it already grants `'unsafe-inline'` to `style-src` for
 * the runtime theme tokens — so the literal never occurred and the replacement
 * never fired, while its comment promised a development compensation that
 * anyone tightening the shipped directive would have relied on.
 */
export function applyLocalDevelopmentPolicy(html: string): string {
  return html.replace(
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

/**
 * The JavaScript REPL is the only Airship runtime that needs string-to-code
 * evaluation. This policy is sent on its dedicated worker response only. The
 * page policy deliberately remains free of `unsafe-eval`.
 */
export const PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'";
export const PRIME_KERNEL_WORKER_ASSET_SUFFIX = ".prime-kernel-worker.js";
export const PRIME_KERNEL_WORKER_RESPONSE_HEADERS = Object.freeze({
  "Content-Security-Policy": PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY,
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
});

/**
 * Keep a stable suffix after Vite's content hash. `_headers` gets one greedy
 * splat, so a suffix (rather than a name before the hash) can match both root
 * and arbitrary-base deployments without widening the rule to other assets.
 */
export function resolveAirshipWorkerEntryFileName(chunk: Readonly<{ name: string }>): string {
  return chunk.name === "prime-kernel-worker"
    ? `assets/[hash]${PRIME_KERNEL_WORKER_ASSET_SUFFIX}`
    : "assets/[name]-[hash].js";
}

export function isPrimeKernelWorkerRequest(value: string | undefined, basePath: string): boolean {
  if (!value) return false;
  const sentinel = "http://airship.invalid";
  const request = new URL(value, sentinel);
  if (request.origin !== sentinel || request.hash) return false;
  const base = resolvePublicBasePath(basePath);
  const builtPrefix = `${base}assets/`;
  if (request.pathname.startsWith(builtPrefix) && request.search === "") {
    const filename = request.pathname.slice(builtPrefix.length);
    return /^[A-Za-z0-9_-]+\.prime-kernel-worker\.js$/u.test(filename);
  }
  const sourcePath = `${base}src/prime/kernel/prime-kernel-worker.ts`;
  const sourceParameters = [...request.searchParams.entries()];
  return request.pathname === sourcePath
    && sourceParameters.length === 2
    && sourceParameters[0]?.[0] === "worker_file"
    && sourceParameters[0]?.[1] === ""
    && sourceParameters[1]?.[0] === "type"
    && sourceParameters[1]?.[1] === "module";
}

type MiddlewareServer = Readonly<{
  middlewares: {
    use(handler: (
      request: Readonly<{ url?: string }>,
      response: {
        statusCode: number;
        setHeader(name: string, value: string): void;
        end(body?: string): void;
      },
      next: (error?: unknown) => void,
    ) => void): void;
  };
  watcher?: { on(type: "change", listener: (path: string) => void): void };
}>;

const PRIME_KERNEL_WORKER_SOURCE_PATH = fileURLToPath(
  new URL("./src/prime/kernel/prime-kernel-worker.ts", import.meta.url),
);
let developmentPrimeKernelWorkerBundle: Promise<string> | undefined;

function isDevelopmentPrimeKernelWorkerRequest(value: string | undefined, basePath: string): boolean {
  if (!isPrimeKernelWorkerRequest(value, basePath) || !value) return false;
  const request = new URL(value, "http://airship.invalid");
  return request.pathname === `${resolvePublicBasePath(basePath)}src/prime/kernel/prime-kernel-worker.ts`;
}

async function bundleDevelopmentPrimeKernelWorker(): Promise<string> {
  const result = await bundleWithEsbuild({
    absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
    bundle: true,
    entryPoints: [PRIME_KERNEL_WORKER_SOURCE_PATH],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    platform: "browser",
    sourcemap: false,
    target: "es2022",
    treeShaking: true,
    write: false,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error("The Prime kernel development worker did not bundle to one external module.");
  }
  return result.outputFiles[0]!.text;
}

function installPrimeKernelWorkerResponseHeaders(
  server: MiddlewareServer,
  basePath: string,
  bundleDevelopmentEntry: boolean,
): void {
  if (bundleDevelopmentEntry) {
    server.watcher?.on("change", (path) => {
      if (path.includes("/src/prime/kernel/")) developmentPrimeKernelWorkerBundle = undefined;
    });
  }
  server.middlewares.use((request, response, next) => {
    if (!isPrimeKernelWorkerRequest(request.url, basePath)) {
      next();
      return;
    }
    for (const [name, value] of Object.entries(PRIME_KERNEL_WORKER_RESPONSE_HEADERS)) {
      response.setHeader(name, value);
    }
    if (!bundleDevelopmentEntry || !isDevelopmentPrimeKernelWorkerRequest(request.url, basePath)) {
      next();
      return;
    }

    // Vite's development worker endpoint normally keeps static imports. The
    // reviewed worker CSP deliberately has no `self`, so serve the same entry
    // as one external module in development as Vite does in a production build.
    developmentPrimeKernelWorkerBundle ??= bundleDevelopmentPrimeKernelWorker();
    void developmentPrimeKernelWorkerBundle.then(
      (source) => {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(source);
      },
      (error: unknown) => next(error),
    );
  });
}

const PUBLIC_BASE_PATH = resolvePublicBasePath(process.env.AIRSHIP_PUBLIC_BASE_PATH);
const VERIFIED_SEMANTIC_PACK = process.env.AIRSHIP_DISABLE_SEMANTIC_PACK === "1"
  ? null
  : readVerifiedSemanticPack();
const SEMANTIC_PACK_AVAILABLE = VERIFIED_SEMANTIC_PACK !== null;
/*
 * The loopback storage lab is host composition, not a product feature, so it is
 * replaced with a literal rather than read at runtime: `"0" === "1"` folds, and
 * a folded `false` takes the lab's modules, dynamic imports, copy and stylesheet
 * out of the graph instead of shipping them behind a refusal. `.env.sample` and
 * `scripts/local-lab.mjs` already speak the exact `1`; anything else is off.
 */
const LOCAL_LAB_ENABLED = process.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB === "1";

/**
 * The modules only a lab build may contain.
 *
 * Folding `LOCAL_LAB_BUILD` deletes every branch that *calls* these dynamic
 * imports, but the bundler still walks a dynamic import it has parsed and emits
 * a chunk for its target — four orphan files, 21 KiB of them, referenced by
 * nothing and shipped anyway. Marking the specifiers external in a stock build
 * removes the targets from the graph, so no chunk is created and the release
 * gate's own inventory has nothing to classify.
 *
 * If a lab-only import ever escapes its branch, the artifact carries the literal
 * below and `assertStockReleaseExcludesLocalLab` fails the release rather than
 * shipping an import that resolves to nothing.
 */
export const LOCAL_LAB_ONLY_MODULES: readonly string[] = Object.freeze([
  "/src/storage/s3-object-store.ts",
  "/src/ui/local-lab-setup.tsx",
  "/src/ui/local-lab-vault.ts",
  "/src/vault/local-lab.ts",
]);
export const LOCAL_LAB_ABSENT_MODULE = "airship:local-lab-is-not-in-this-build";

export function isLocalLabOnlyModule(resolvedId: string): boolean {
  const path = resolvedId.split("?")[0].split("\\").join("/");
  return LOCAL_LAB_ONLY_MODULES.some((suffix) => path.endsWith(suffix));
}

function airshipLocalLabComposition(enabled: boolean) {
  return {
    name: "airship-local-lab-composition",
    apply: "build" as const,
    // Ahead of `vite:resolve`, which would otherwise answer for these relative
    // specifiers before this plugin is consulted at all.
    enforce: "pre" as const,
    async resolveId(source: string, importer: string | undefined, options: Record<string, unknown>) {
      if (enabled || !importer || source.startsWith("\0")) return null;
      const resolved = await (this as unknown as {
        resolve: (
          source: string,
          importer: string,
          options: Record<string, unknown>,
        ) => Promise<{ id: string } | null>;
      }).resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !isLocalLabOnlyModule(resolved.id)) return null;
      return { id: LOCAL_LAB_ABSENT_MODULE, external: true };
    },
  };
}

export default defineConfig({
  base: PUBLIC_BASE_PATH,
  define: {
    "import.meta.env.VITE_AIRSHIP_SEMANTIC_PACK_AVAILABLE": JSON.stringify(SEMANTIC_PACK_AVAILABLE ? "true" : "false"),
    "import.meta.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB": JSON.stringify(LOCAL_LAB_ENABLED ? "1" : "0"),
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
    airshipLocalLabComposition(LOCAL_LAB_ENABLED),
    {
      name: "airship-local-development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        // The loopback origins are the disposable MinIO lab only. The source
        // and production response remain on the reviewed strict policy.
        return applyLocalDevelopmentPolicy(html);
      },
    },
    {
      name: "airship-prime-kernel-worker-csp",
      configureServer(server) {
        installPrimeKernelWorkerResponseHeaders(server, PUBLIC_BASE_PATH, true);
      },
      configurePreviewServer(server) {
        installPrimeKernelWorkerResponseHeaders(server, PUBLIC_BASE_PATH, false);
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
           * Simplifying the old provider/trust surfaces removed the secondary
           * importers that had made these startup modules shared chunks.
           * Rolldown then folded them into the entry, even though total startup
           * JavaScript fell. Keep the profile-storage boundary explicit so the
           * entry stays a bounded coordinator and these stable persistence
           * primitives retain their own cache unit. This chunk is still an
           * eager dependency; it is not excluded from HTML module preloads.
           *
           * `src/vault/config.ts` used to be named here too, and naming it was
           * what kept it in a stock artifact: the S3 configuration grammar is
           * reachable from one destination only — the host-composed loopback lab
           * — so once `configure()` refuses in a stock build nothing references
           * it, and only this list was still pinning 4,969 raw bytes of it into
           * an eager chunk. A lab build places it with the code that uses it.
           */
          if (
            id.includes("/src/profiles/catalog.ts")
            || id.includes("/src/profiles/persistence.ts")
            || id.includes("/src/storage/encrypted-envelope.ts")
          ) return "profile-storage-foundations";
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
          /*
           * Named first, and load-bearing: the content codec's only remaining
           * importer is the content search, so folding the search into the
           * pack below took the codec in with it and the gate lost the
           * `content-codec` artifact it requires exactly one of. Naming the
           * codec keeps it the separate chunk its own budget is written
           * against.
           */
          if (id.includes("/src/workspace/content-codec")) return "content-codec";
          /*
           * Wiring prime's tool vocabulary gave the tool registry, its schema
           * compiler and the workspace content search a second importer: the
           * lazy prime runtime chunk, alongside the eager path they already
           * served. Rollup answered by hoisting each into its own chunk named
           * `registry`, `schema` and `content-search` — three generic names,
           * reachable only from a lazy pack, that the release gate's classifier
           * could attribute to no owner at all and therefore refused. Naming
           * them as one pack restores what they were before prime split them:
           * a single chunk the entry preloads, owned by
           * `core-entry-and-preloads` like every other shared eager module.
           */
          if (
            id.includes("/src/tools/registry")
            || id.includes("/src/tools/schema")
            // Joined by the modules the tool surface shares with the eager
            // path once its definitions began pinning new manifests: workspace
            // addressing, the core contracts and the schema validator. All
            // three were already on first paint; naming them keeps them one
            // attributable chunk instead of three the classifier cannot own.
            || id.includes("/src/workspace/addressing")
            || id.includes("/src/core/contracts")
            || id.includes("/src/tools/validation")
          ) return "tool-registry-pack";
          /*
           * Named, but on its own: the registry and its schema compiler are
           * already on the eager path, so folding them into one preloaded pack
           * costs first paint nothing. The content search is not — it serves
           * the workspace surfaces and now prime's `search_text`, both lazy —
           * and pulling it into that pack put 4.45 KiB gzip onto first paint
           * and broke the baseline budget. It keeps its own deferred chunk and
           * only needs a name the classifier can attribute.
           */
          if (id.includes("/src/workspace/content-search")) return "content-search";
          /*
           * Prime's own non-crypto digest helper, shared by the runtime chunk
           * and the subagent factory's manifest minting once children became
           * real. Left unnamed it emits a bare `hash` chunk — a name the gate
           * can attribute to nobody, and one that would be indistinguishable
           * from `core/hash`. Named into the prime family it belongs to.
           */
          /*
           * Core's legacy execution tools now reuse the hardened Prime worker
           * host. That second importer makes Rollup split the host from the
           * lazy Prime runtime; keep the shared chunk in its exact Prime-kernel
           * release family instead of emitting an unowned `kernel-host` stem.
           */
          if (id.includes("/src/prime/kernel/kernel-host")) return "prime-kernel-host";
          if (id.includes("/src/prime/ai/hash")) return "prime-ai-hash";
          /*
           * The tool surface has two importers now — the prime runtime chunk,
           * and the session-creation path that pins its definitions into a new
           * manifest — so Rollup splits it out under a bare `tool-surface`
           * name the classifier can attribute to nobody. It is prime's, and it
           * is named into prime's family.
           */
          if (id.includes("/src/prime/runtime/tool-surface")) return "prime-tool-surface";
          /*
           * Git's path validation shares the content search with prime's
           * `search_text`, so moving that search into its own deferred chunk
           * left this one hoisted under a bare `validation` name — a name the
           * inference providers also emit. It is on the eager path, so it is
           * named into the same preloaded pack the registry and contracts use
           * rather than becoming a chunk of its own.
           */
          if (id.includes("/src/git/validation")) return "tool-registry-pack";
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
           * named `client`, a name several unrelated chunks also emit. Name it
           * for what it is so the release gate's classifier stays exact rather
           * than matching by accident.
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
    rollupOptions: {
      output: {
        entryFileNames: resolveAirshipWorkerEntryFileName,
      },
    },
  },
});
