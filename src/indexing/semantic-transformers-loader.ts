import type {
  SemanticBackend,
  SemanticLoadedModel,
  SemanticModelLoader,
  SemanticPowerPreference,
} from "./semantic-worker-provider";
import artifactManifest from "./semantic-artifact-manifest.json";

export function semanticPackRoot(base = import.meta.env.BASE_URL): string {
  return `${base.endsWith("/") ? base : `${base}/`}semantic-pack/v1/`;
}

const PACK_ROOT = semanticPackRoot();
const MODEL_ROOT = `${PACK_ROOT}models/`;
const RUNTIME_ROOT = `${PACK_ROOT}runtime/`;

type Progress = Readonly<{ status?: string; loaded?: number; total?: number }>;
type TransformersModule = typeof import("@huggingface/transformers");

/** The nested records ONNX Runtime itself reads for its WASM and WebGPU flags. */
export type OrtBackendEnv = {
  wasm?: Record<string, unknown>;
  webgpu?: Record<string, unknown>;
};

export const transformersSemanticLoader: SemanticModelLoader = Object.freeze({
  async load({ manifest, backend, powerPreference, wasmThreads, signal, onProgress }: Parameters<SemanticModelLoader["load"]>[0]): Promise<SemanticLoadedModel> {
    if (signal.aborted) throw signal.reason;
    const adapterPower = ortPowerPreference(powerPreference);
    if (backend === "webgpu") {
      const gpu = (navigator as Navigator & {
        gpu?: { requestAdapter(options?: Readonly<{ powerPreference?: string }>): Promise<unknown | null> };
      }).gpu;
      // The policy's power preference reaches the real adapter request, not
      // only the capability probe's throwaway adapter.
      if (!gpu || !await gpu.requestAdapter(adapterPower ? { powerPreference: adapterPower } : {})) {
        throw new Error("WebGPU has no usable adapter; continuing with the WASM semantic backend.");
      }
    }
    if (artifactManifest.modelRevision !== manifest.revision) throw new Error("Semantic artifact revision is not the pinned model revision.");
    // Refused before the multi-megabyte verification fetch, not after: the
    // pinned ORT bundle cannot start without these artifacts, and an unpinned
    // artifact can be neither byte- nor hash-checked. The manifest does pin
    // them today, so this only fires if a later manifest edit drops one — the
    // failure mode is a same-origin 404 deep inside ORT, which is far harder to
    // read than this sentence.
    const unpinned = unpinnedOrtRuntimeBinaries();
    if (unpinned.length) {
      throw new Error(`The reviewed semantic artifact manifest does not pin ${unpinned.join(" and ")}, which the pinned ONNX Runtime bundle loads before any model runs.`);
    }
    await verifySemanticAssets(backend, signal, onProgress);
    // The reviewed library is part of the separately deployed same-origin
    // semantic pack, not the application or worker bundle.
    const runtimeUrl = `${RUNTIME_ROOT}transformers.web.js`;
    const transformers = await import(/* @vite-ignore */ runtimeUrl) as TransformersModule;
    if (transformers.env.version !== manifest.transformersVersion) {
      throw new Error(`Transformers.js ${transformers.env.version} does not match pinned ${manifest.transformersVersion}.`);
    }
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = MODEL_ROOT;
    transformers.env.useBrowserCache = true;
    transformers.env.cacheKey = `airship-semantic-${manifest.revision}`;
    const onnx = transformers.env.backends.onnx as OrtBackendEnv;
    applyOrtAcceleration(onnx, { backend, powerPreference, wasmThreads });
    pinOrtRuntimePaths(onnx);
    // Must precede the pipeline call: ORT constructs its pthread workers while
    // instantiating the WebAssembly module, and this page's CSP rejects an
    // untrusted script URL there.
    if (ortSpawnsThreadWorkers({ crossOriginIsolated: globalThis.crossOriginIsolated === true, wasmThreads })) {
      installOrtThreadWorkerPolicy();
    }

    const progress = (event: Progress) => {
      if (signal.aborted) throw signal.reason;
      if (event.status === "progress_total" || event.status === "progress") {
        onProgress({ loadedBytes: event.loaded, totalBytes: event.total, message: "Loading the pinned same-origin model pack." });
      }
    };
    const extractor = await transformers.pipeline("feature-extraction", manifest.modelId, {
      revision: manifest.revision,
      local_files_only: true,
      device: backend,
      dtype: dtypeFor(backend, manifest),
      progress_callback: progress,
    });
    if (signal.aborted) { await extractor.dispose(); throw signal.reason; }

    return Object.freeze({
      async embed(texts: readonly string[], operationSignal: AbortSignal): Promise<readonly Float32Array[]> {
        if (operationSignal.aborted) throw operationSignal.reason;
        const output = await extractor([...texts], { pooling: manifest.pooling, normalize: manifest.normalize });
        try {
          if (operationSignal.aborted) throw operationSignal.reason;
          const dims = output.dims;
          if (dims.length !== 2 || dims[0] !== texts.length || dims[1] !== manifest.dimensions) {
            throw new Error(`Semantic tensor shape ${dims.join("x")} does not match ${texts.length}x${manifest.dimensions}.`);
          }
          const data = output.data;
          if (!(data instanceof Float32Array)) throw new Error("Semantic model returned a non-float32 tensor.");
          return Array.from({ length: texts.length }, (_, index) =>
            new Float32Array(data.slice(index * manifest.dimensions, (index + 1) * manifest.dimensions)),
          );
        } finally {
          output.dispose();
        }
      },
      dispose: () => extractor.dispose(),
    });
  },
});

type SemanticPackAssetPath = keyof typeof artifactManifest.assets;

/**
 * Assets both rungs need.
 *
 * The ORT WebAssembly factory and binary are shared, not backend-specific: the
 * pinned bundle is a single asyncify build that carries the WebGPU execution
 * provider *and* the plain WASM one, and it names the same two files either
 * way (see REQUIRED_ORT_RUNTIME_BINARIES). Only the model dtype differs.
 */
const SHARED_PACK_ASSETS = [
  "runtime/transformers.web.js",
  "runtime/ort.webgpu.bundle.min.mjs",
  "runtime/onnxruntime-common.mjs",
  "runtime/ort-wasm-simd-threaded.asyncify.mjs",
  "runtime/ort-wasm-simd-threaded.asyncify.wasm",
  "models/mixedbread-ai/mxbai-embed-xsmall-v1/config.json",
  "models/mixedbread-ai/mxbai-embed-xsmall-v1/tokenizer.json",
  "models/mixedbread-ai/mxbai-embed-xsmall-v1/tokenizer_config.json",
  "models/mixedbread-ai/mxbai-embed-xsmall-v1/special_tokens_map.json",
] as const;

const BACKEND_PACK_ASSETS = Object.freeze({
  webgpu: ["models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_q4f16.onnx"] as const,
  wasm: ["models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_quantized.onnx"] as const,
});

/** Every pinned asset a backend must verify before the pack may load. */
export function semanticPackAssetPaths(backend: SemanticBackend): readonly SemanticPackAssetPath[] {
  return Object.freeze([...SHARED_PACK_ASSETS, ...BACKEND_PACK_ASSETS[backend]]);
}

/**
 * Byte total of the pinned pack for a backend, read from the reviewed artifact
 * manifest so a download-cost surface can name the number without duplicating
 * (or drifting from) the asset list.
 */
export function semanticPackBytes(backend: SemanticBackend): number {
  return semanticPackAssetPaths(backend).reduce((sum, path) => sum + artifactManifest.assets[path].bytes, 0);
}

/** ORT accepts only these two values; it throws on "default". */
export function ortPowerPreference(value?: SemanticPowerPreference): "low-power" | "high-performance" | undefined {
  return value === "low-power" || value === "high-performance" ? value : undefined;
}

/**
 * Applies the adaptive policy to the runtime that actually executes the model.
 *
 * Transformers.js exposes a shallow copy of the ONNX Runtime env
 * (`env.backends.onnx = { ...ONNX_ENV }`), so only a mutation of the nested
 * wasm/webgpu records reaches the runtime; replacing a nested record writes to
 * the copy alone. Transformers.js also pins `webgpu.powerPreference` to
 * "high-performance" for every host, so a policy that observed low battery or
 * data-saving must override it here or it is merely displayed.
 */
export function applyOrtAcceleration(
  onnx: OrtBackendEnv,
  options: Readonly<{ backend: SemanticBackend; powerPreference?: SemanticPowerPreference; wasmThreads?: number }>,
): void {
  if (onnx.wasm && namesOrtThreadCount(options.wasmThreads)) {
    // ORT spawns (numThreads - 1) workers and clamps to 1 itself when the page
    // is not cross-origin isolated, so an over-request degrades, never fails.
    onnx.wasm.numThreads = boundedOrtThreadCount(options.wasmThreads);
  }
  if (onnx.webgpu && options.backend === "webgpu") {
    // Only positive evidence moves this. The policy's "default" means the
    // battery and save-data signals said nothing and the core/memory counts
    // were merely mid-range — none of which is evidence about which GPU should
    // run the model. Deleting the reviewed pack's own high-performance pin on
    // that non-evidence would silently hand a multi-GPU laptop to its
    // integrated adapter, an unmeasured downgrade, so the pack keeps its value.
    const accepted = ortPowerPreference(options.powerPreference);
    if (accepted) onnx.webgpu.powerPreference = accepted;
  }
}

/** ORT reads `numThreads` only when it is a finite number; anything else is its own default. */
function namesOrtThreadCount(wasmThreads?: number): wasmThreads is number {
  return wasmThreads !== undefined && Number.isFinite(wasmThreads);
}

/**
 * The ceiling this loader will ever hand ORT.
 *
 * `semanticWasmThreadCount` in browser-runtime.ts applies the same 8 on the
 * producing side; neither reads the other, so both are stated deliberately and
 * the loader clamps again rather than trusting its caller.
 */
export const MAX_ORT_THREADS = 8;

/** ORT rejects a non-positive or non-integer count, so clamp before writing. */
export function boundedOrtThreadCount(wasmThreads: number): number {
  return Math.max(1, Math.min(MAX_ORT_THREADS, Math.trunc(wasmThreads)));
}

/**
 * Whether ONNX Runtime will construct pthread Workers for this load.
 *
 * Two ORT behaviours decide it, both read off the pinned bundle: it forces
 * `numThreads` to 1 whenever the page is not cross-origin isolated (threads
 * need SharedArrayBuffer), and when the caller names no count it picks
 * `min(4, ceil(hardwareConcurrency / 2))` for itself — which is above 1 on
 * essentially every isolated multi-core page. So "the caller said 1" is the
 * only isolated case that stays worker-free.
 *
 * This has to be predicted rather than observed because the Trusted Types
 * policy below must exist before ORT reaches the Worker constructor.
 */
export function ortSpawnsThreadWorkers(
  options: Readonly<{ crossOriginIsolated: boolean; wasmThreads?: number }>,
): boolean {
  if (!options.crossOriginIsolated) return false;
  if (!namesOrtThreadCount(options.wasmThreads)) return true;
  return boundedOrtThreadCount(options.wasmThreads) > 1;
}

/** Minimal shape of the Trusted Types factory this worker needs. */
export type ScriptUrlPolicyHost = Readonly<{
  trustedTypes?: Readonly<{
    createPolicy(name: string, rules: Readonly<{ createScriptURL(value: string): string }>): unknown;
  }>;
  location: Readonly<{ href: string }>;
}>;

/**
 * The only script URL ORT's thread workers may be constructed from.
 *
 * A Trusted Types `createScriptURL` callback can refuse only by throwing, so
 * this throws. Everything outside the pinned pack's runtime directory —
 * another origin, another path on this origin, a `..` escape, a blob: URL —
 * is refused, which is what keeps the default policy below from becoming a
 * general-purpose script-URL opener for the rest of this worker.
 */
export function semanticRuntimeScriptUrl(value: string, baseHref: string, runtimeRoot: string = RUNTIME_ROOT): string {
  const base = new URL(baseHref);
  const url = new URL(value, base);
  if (url.origin !== base.origin || url.protocol !== base.protocol || !url.pathname.startsWith(runtimeRoot)) {
    throw new TypeError(`Script URL outside the pinned semantic pack runtime: ${value}`);
  }
  return url.href;
}

/**
 * One default Trusted Types policy per Trusted Types factory. The factory is a
 * per-global singleton, so this is "once per worker" without a module-level
 * flag that would leak between tests.
 */
const scriptUrlPolicyInstalled = new WeakSet<object>();

/**
 * Lets ONNX Runtime construct its pthread workers under this application's CSP.
 *
 * Airship serves `require-trusted-types-for 'script'`, and ORT's Emscripten
 * factory spawns (numThreads - 1) workers with
 * `new Worker(new URL(import.meta.url), { type: "module" })` — a raw string at
 * a TrustedScriptURL sink. Verified in Chromium against the pinned
 * `ort-wasm-simd-threaded.asyncify.mjs`: with `numThreads: 1` the module
 * instantiates, and with `numThreads: 4` it throws
 * `TypeError: Failed to construct 'Worker': This document requires
 * 'TrustedScriptURL' assignment.` ORT exposes no hook to wrap that
 * constructor, so a default policy in this worker's global is the only way to
 * keep threads — and it is scoped to the pack runtime, so it grants nothing
 * else. With this policy installed, the same measurement runs the prepared
 * pack end to end in a module worker under this CSP: four ORT threads, only
 * same-origin pack requests, normalized 384-dimension float32 output.
 *
 * Fails loudly. If the CSP does not allow the `default` policy name, the pack
 * would otherwise die later inside ORT with the message above and no
 * indication of which directive to change.
 *
 * Accepted cost, recorded rather than left implicit: allowing `default` in the
 * `trusted-types` directive is an origin-wide grant, not a pack-scoped one. Any
 * realm on this origin may register the default policy, and whoever registers
 * it first wins — a second `createPolicy("default")` throws. This function
 * therefore claims the name eagerly, before ORT can reach a sink, and binds it
 * to `semanticRuntimeScriptUrl`, which admits only the same-origin pack root.
 * A realm that registered a pass-through default first would still defeat the
 * directive; the exposure is bounded by Airship shipping no such realm and by
 * `script-src 'self'` continuing to govern where scripts may come from.
 */
export function installOrtThreadWorkerPolicy(
  host: ScriptUrlPolicyHost = globalThis as unknown as ScriptUrlPolicyHost,
  runtimeRoot: string = RUNTIME_ROOT,
): void {
  const factory = host.trustedTypes;
  // Firefox and Safari expose no Trusted Types, so nothing enforces the sink
  // and no policy can (or need) be created.
  if (!factory || scriptUrlPolicyInstalled.has(factory)) return;
  try {
    factory.createPolicy("default", {
      createScriptURL: (value: string) => semanticRuntimeScriptUrl(value, host.location.href, runtimeRoot),
    });
  } catch (error) {
    throw new Error(
      `ONNX Runtime thread workers need the "default" policy this CSP trusted-types directive did not allow: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  scriptUrlPolicyInstalled.add(factory);
}

/**
 * Every ORT WebAssembly artifact a bundle source names for itself.
 *
 * ORT resolves these filenames against `env.wasm.wasmPaths`, so the pack must
 * publish exactly this set or the same-origin pin below points at a 404. The
 * derivation is a function of the bundle text rather than a hand-kept list
 * because the ONNX Runtime build has already renamed this pair once
 * (`ort-wasm-simd-threaded.jsep.*` became `…asyncify.*`), and the previous
 * hand-kept list silently survived that rename.
 *
 * The `.mjs`/`.wasm` suffix filter is load-bearing: the same bundle also
 * contains the string `ort-wasm-proxy-worker`, which is a Worker *name*, not a
 * fetched artifact.
 */
export function ortRuntimeBinariesNamedBy(bundleSource: string): readonly string[] {
  const named = [...bundleSource.matchAll(/ort-wasm[a-z0-9.-]*\.(?:mjs|wasm)/gu)].map((match) => `runtime/${match[0]}`);
  return Object.freeze([...new Set(named)].sort());
}

/**
 * ORT binaries the pinned WebGPU bundle actually loads.
 *
 * Read off `runtime/ort.webgpu.bundle.min.mjs` itself: the bundle's Emscripten
 * factory resolves `ort-wasm-simd-threaded.asyncify.wasm` through `locateFile`,
 * and its loader dynamically imports `ort-wasm-simd-threaded.asyncify.mjs` from
 * the `wasmPaths` prefix whenever one is set — which the pin below always sets.
 * It requests neither the `.jsep.*` nor the plain `ort-wasm-simd-threaded.*`
 * files, so the pack no longer ships them.
 *
 * `semantic-transformers-loader.test.ts` re-derives this list from the byte- and
 * hash-verified bundle in `node_modules`, so the constant cannot drift from the
 * artifact without a red test.
 */
export const REQUIRED_ORT_RUNTIME_BINARIES = Object.freeze([
  "runtime/ort-wasm-simd-threaded.asyncify.mjs",
  "runtime/ort-wasm-simd-threaded.asyncify.wasm",
] as const);

/**
 * Required-but-unpinned ORT binaries, in required order.
 *
 * This is the fail-closed half of the wasmPaths pin below: without these two
 * artifacts no `wasmPaths` value can produce a working backend, so the pack
 * must refuse to start rather than fetch tens of MiB and then die inside ORT.
 * The manifest satisfies it today; it exists to keep a later manifest edit from
 * quietly reintroducing that failure.
 */
export function unpinnedOrtRuntimeBinaries(): readonly string[] {
  const pinned: Readonly<Record<string, unknown>> = artifactManifest.assets;
  return Object.freeze(REQUIRED_ORT_RUNTIME_BINARIES.filter((path) => pinned[path] === undefined));
}

/**
 * Points ONNX Runtime at the same-origin pack.
 *
 * Transformers.js installs a `cdn.jsdelivr.net` `wasmPaths` **object** on the
 * real ORT env at import time, and the application CSP allows no such origin,
 * so leaving it in place means the semantic backend is blocked before it
 * starts. Overwriting it with a same-origin *string* prefix is what ORT treats
 * as "resolve my own filenames here": it then imports
 * `<prefix>ort-wasm-simd-threaded.asyncify.mjs` and sets `locateFile` to
 * `<prefix>` + the binary name. A string also keeps Transformers.js's
 * `useWasmCache` pre-fetch out of the path, which only engages for the object
 * form.
 *
 * The pin has to mutate the nested `wasm` record in place: `env.backends.onnx`
 * is a shallow copy, so replacing that record only rewrites the copy ORT never
 * reads.
 */
export function pinOrtRuntimePaths(onnx: OrtBackendEnv, runtimeRoot: string = RUNTIME_ROOT): void {
  if (onnx.wasm) onnx.wasm.wasmPaths = runtimeRoot;
}

async function verifySemanticAssets(
  backend: SemanticBackend,
  signal: AbortSignal,
  onProgress: Parameters<SemanticModelLoader["load"]>[0]["onProgress"],
): Promise<void> {
  const suffixes = semanticPackAssetPaths(backend);
  const totalBytes = semanticPackBytes(backend);
  let loadedBytes = 0;
  for (const path of suffixes) {
    const expected = artifactManifest.assets[path];
    const response = await fetch(`${PACK_ROOT}${path}`, { signal, credentials: "same-origin", cache: "force-cache" });
    if (!response.ok || response.type === "opaque") throw new Error(`Semantic pack asset ${path} is unavailable (${response.status}).`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== expected.bytes) throw new Error(`Semantic pack asset ${path} has an unexpected byte length.`);
    const actual = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (actual !== expected.sha256) throw new Error(`Semantic pack asset ${path} failed its SHA-256 check.`);
    loadedBytes += bytes.byteLength;
    onProgress({ loadedBytes, totalBytes, message: `Verified ${path.split("/").pop()}.` });
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function dtypeFor(backend: SemanticBackend, manifest: Parameters<SemanticModelLoader["load"]>[0]["manifest"]) {
  return backend === "webgpu" ? manifest.webgpuDtype : manifest.wasmDtype;
}
