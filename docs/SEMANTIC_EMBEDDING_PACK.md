# Optional semantic embedding pack

Airship ships a real, opt-in client-side semantic embedding engine. The
startup and offline baseline remains `HashEmbeddingProvider`; selecting
**Local semantic** atomically rebuilds the active memory-only index with the
pinned transformer. There is no remote embedding endpoint and no silent
fallback that can mislabel hash vectors as semantic vectors.

## Runtime contract

| Component | Pin |
| --- | --- |
| Transformers.js | `@huggingface/transformers@4.0.0` |
| ONNX Runtime | `onnxruntime-web@1.25.0-dev.20260327-722743c0e2`, `ort.webgpu.bundle.min.mjs` |
| ONNX Runtime WebAssembly | `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` — the only pair that bundle names |
| Model | `mixedbread-ai/mxbai-embed-xsmall-v1` |
| Model revision | `b0561d9a97e6b298da39f0ef3e7d3cf153b1b29a` |
| Output | 384 dimensions, mean pooling, normalized float32 |
| WebGPU | `q4f16`, attempted first only when a usable adapter is acquired |
| WASM | `q8`, attempted after a failed WebGPU rung — see below |

### What the WASM rung actually is

It is a second full attempt, not a graceful degradation inside one load. The
worker builds an attempt list of `["webgpu", "wasm"]` when the adaptive policy
prefers WebGPU and `["wasm"]` otherwise, then runs the whole loader once per
entry: adapter check, asset verification, Transformers.js pipeline
construction. The WASM rung therefore runs whenever the WebGPU rung throws for
*any* reason — no adapter, a CSP or 404 on an artifact, a manifest mismatch —
not only for a missing GPU.

Both rungs load the **same** ONNX Runtime WebAssembly binary; the asyncify
build carries the WebGPU execution provider and the plain one. Only the model
dtype differs between them, so the second attempt re-fetches nothing but the
q8 model file.

If every attempt throws, the worker emits `SEMANTIC_BACKENDS_UNAVAILABLE`
carrying the last error, which the index screen surfaces verbatim. There is no
third rung: a failed semantic load never silently becomes hash vectors
labelled as semantic.

`semantic.worker.ts` owns Transformers.js, ONNX Runtime, tokenization, and all
workspace-text embedding. The application entry bundle contains only the small
worker facade; Vite emits that worker as an optional chunk requested on first
semantic indexing, and Transformers.js is not a Vite chunk at all — it is
`runtime/transformers.web.js` inside the verified pack, imported at runtime
from the same origin. The worker protocol supports
progress, cooperative cancellation, bounded batches, finite-vector and
dimension checks, and disposal. Cancellation aborts downloads and suppresses
stale results immediately; an ONNX inference already executing may finish its
current native/WASM call before the worker can reclaim that compute.

## Artifact and network posture

The model and ONNX runtime are served below the application origin at
`/semantic-pack/v1/`. `env.allowRemoteModels` is false,
`env.allowLocalModels` is true, and the pipeline uses `local_files_only`.
Before model construction, the worker fetches every backend-specific asset and
refuses byte-length or SHA-256 drift against
`semantic-artifact-manifest.json`. The URL is immutable and versioned; a future
artifact set must use a new pack version. The revision, dtype, dimensions,
pooling, and normalization are also pinned in source.

Transformers.js does not leave ONNX Runtime pointed at the same origin on its
own: at import time it writes a `cdn.jsdelivr.net` object into
`ONNX_ENV.wasm.wasmPaths`, and no Airship CSP allows that host, so an unpinned
pack would be blocked before its first byte. The loader overwrites that value
with the same-origin string prefix `/semantic-pack/v1/runtime/`, which is what
ORT reads as "resolve my own filenames here". The write has to mutate the
nested `wasm` record in place, because `transformers.env.backends.onnx` is a
shallow copy of the runtime env and replacing a nested record would only
rewrite the copy.

Which filenames ORT then resolves is not a matter of taste: the pinned bundle
names `ort-wasm-simd-threaded.asyncify.mjs` and
`ort-wasm-simd-threaded.asyncify.wasm` and nothing else. `semantic:prepare`
re-derives that set from the verified bundle text and fails if the manifest
does not pin it, and the loader refuses to start when the manifest is missing
either one rather than fetching tens of megabytes and dying inside ORT. Older
pack versions pinned `ort-wasm-simd-threaded.jsep.*` and the plain
`ort-wasm-simd-threaded.*`; this ONNX Runtime build loads neither, so they are
no longer published.

### Trusted Types and ONNX Runtime's thread workers

Airship serves `require-trusted-types-for 'script'`, under which the `Worker`
constructor accepts only a `TrustedScriptURL`. ONNX Runtime's Emscripten
factory spawns `numThreads - 1` pthread workers with
`new Worker(new URL(import.meta.url), { type: "module" })` and exposes no hook
to wrap that call. Measured in Chromium against the pinned
`ort-wasm-simd-threaded.asyncify.mjs` under this exact policy: `numThreads: 1`
instantiates the module, and `numThreads: 4` throws

```
TypeError: Failed to construct 'Worker': This document requires 'TrustedScriptURL' assignment.
```

ORT reaches that path on its own even when Airship names no thread count —
absent one it picks `min(4, ceil(hardwareConcurrency / 2))` on any
cross-origin-isolated page, and Airship is cross-origin isolated wherever its
COOP/COEP headers are actually served. `public/_headers` and the Vite dev and
preview servers send them; GitHub Pages ignores `public/_headers`, so the
deployed Pages build is *not* cross-origin isolated and ORT stays single
threaded there. The runtime reads `globalThis.crossOriginIsolated` rather than
assuming either case.

So the CSP allows the policy name `default`, and the semantic worker installs
one — but only when it can predict that ORT will actually spawn workers, and
only inside the worker's own global, never the document's. The policy is not a
pass-through: it returns a URL only for same-origin paths under
`/semantic-pack/v1/runtime/` and throws for anything else, so it cannot become
a general script-URL opener. If the CSP does not allow the name, the loader
fails with a message naming the directive instead of dying inside ORT.

Run `npm run semantic:prepare` to materialize the reviewed public artifacts in
`.airship-lab/semantic-pack`. The Vite development and production-preview
plugin exposes only that directory on the same origin. Production hosting must publish the same
verified directory at the same URL; the model pack is intentionally not
folded into the startup bundle.

Transformers.js may use the browser Cache API for these public, immutable
model/runtime files. Airship does not give it workspace files, credentials,
messages, vectors, or index snapshots to persist. Workspace text crosses only
the page-to-same-origin-module-worker boundary. Vectors and the flat index are
discarded with the page runtime and rebuilt from the active workspace.

That statement describes the currently selected local semantic materialization.
The separate context-fabric publisher can seal compatible chunk generations as
independently authenticated encrypted Vault shards, and
`VaultTurnContextProvider` retrieves selected blocks through exact ranges. The
active application adopts an already-published, generation-matched Vault mirror
behind the provider-neutral turn seam and otherwise keeps the local generation
with an inspectable fallback reason. Adoption is deliberately read-only:
publishing or replacing encrypted shards requires a separate explicit policy
decision through the Vault's publish/update action, and a mismatched embedding
model never masquerades as successful cross-page adoption. A published provider
is also fenced against the live workspace generation on every turn: recent
edits use the fresh local index until another explicit encrypted publication.

## Activation and truth in the UI

The Memory & Context index screen exposes **Bootstrap** and **Local semantic**
as explicit modes. It reports cold/loading/download/initializing/ready/error
state, verified bytes, and the actual WebGPU or WASM backend. Switching waits
for the prior generation boundary, drops its rebuildable materialization, and
re-embeds the exact workspace revision set. The selected mode is a local
preference; semantic model state and workspace data are not persisted there.

## Verification

Unit tests cover lazy construction, fallback, cancellation, dimension checks,
and bootstrap selection. The opt-in Chromium test runs the actual worker and
pinned q8 model, verifies normalized 384-dimensional vectors, builds an exact
workspace generation, retrieves the semantically relevant document, and
asserts that no model request leaves the application origin:

```sh
npm run semantic:prepare
AIRSHIP_LIVE_SEMANTIC=1 AIRSHIP_LIVE_SEMANTIC_UI=1 npm run test:e2e:semantic
```

Official API references:

- <https://huggingface.co/docs/transformers.js/guides/webgpu>
- <https://github.com/huggingface/transformers.js/releases/tag/4.0.0>
- <https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/tree/b0561d9a97e6b298da39f0ef3e7d3cf153b1b29a/onnx>
