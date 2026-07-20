import type {
  SemanticBackend,
  SemanticLoadedModel,
  SemanticModelLoader,
} from "./semantic-worker-provider";
import artifactManifest from "./semantic-artifact-manifest.json";

const MODEL_ROOT = "/semantic-pack/models/";
const RUNTIME_ROOT = "/semantic-pack/runtime/";

type Progress = Readonly<{ status?: string; loaded?: number; total?: number }>;
type TransformersModule = typeof import("@huggingface/transformers");

export const transformersSemanticLoader: SemanticModelLoader = Object.freeze({
  async load({ manifest, backend, signal, onProgress }: Parameters<SemanticModelLoader["load"]>[0]): Promise<SemanticLoadedModel> {
    if (signal.aborted) throw signal.reason;
    if (backend === "webgpu") {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
      if (!gpu || !await gpu.requestAdapter()) throw new Error("WebGPU has no usable adapter; continuing with the WASM semantic backend.");
    }
    if (artifactManifest.modelRevision !== manifest.revision) throw new Error("Semantic artifact revision is not the pinned model revision.");
    await verifySemanticAssets(backend, signal, onProgress);
    // The reviewed library is part of the separately deployed same-origin
    // semantic pack, not the application or worker bundle.
    const transformers = await import(/* @vite-ignore */ "/semantic-pack/runtime/transformers.web.js") as TransformersModule;
    if (transformers.env.version !== manifest.transformersVersion) {
      throw new Error(`Transformers.js ${transformers.env.version} does not match pinned ${manifest.transformersVersion}.`);
    }
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = MODEL_ROOT;
    transformers.env.useBrowserCache = true;
    transformers.env.cacheKey = `airship-semantic-${manifest.revision}`;
    const onnx = transformers.env.backends.onnx as { wasm?: Record<string, unknown> };
    onnx.wasm = { ...onnx.wasm, wasmPaths: RUNTIME_ROOT };

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

async function verifySemanticAssets(
  backend: SemanticBackend,
  signal: AbortSignal,
  onProgress: Parameters<SemanticModelLoader["load"]>[0]["onProgress"],
): Promise<void> {
  const suffixes = [
    "runtime/transformers.web.js",
    "models/mixedbread-ai/mxbai-embed-xsmall-v1/config.json",
    "models/mixedbread-ai/mxbai-embed-xsmall-v1/tokenizer.json",
    "models/mixedbread-ai/mxbai-embed-xsmall-v1/tokenizer_config.json",
    "models/mixedbread-ai/mxbai-embed-xsmall-v1/special_tokens_map.json",
    backend === "webgpu"
      ? "models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_q4f16.onnx"
      : "models/mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_quantized.onnx",
    backend === "webgpu" ? "runtime/ort-wasm-simd-threaded.jsep.mjs" : "runtime/ort-wasm-simd-threaded.mjs",
    backend === "webgpu" ? "runtime/ort-wasm-simd-threaded.jsep.wasm" : "runtime/ort-wasm-simd-threaded.wasm",
  ] as const;
  const totalBytes = suffixes.reduce((sum, path) => sum + artifactManifest.assets[path].bytes, 0);
  let loadedBytes = 0;
  for (const path of suffixes) {
    const expected = artifactManifest.assets[path];
    const response = await fetch(`/semantic-pack/${path}`, { signal, credentials: "same-origin", cache: "force-cache" });
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
