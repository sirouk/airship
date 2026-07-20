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
| Model | `mixedbread-ai/mxbai-embed-xsmall-v1` |
| Model revision | `b0561d9a97e6b298da39f0ef3e7d3cf153b1b29a` |
| Output | 384 dimensions, mean pooling, normalized float32 |
| WebGPU | `q4f16`, preferred only with a usable adapter |
| WASM | `q8`, automatic fallback |

`semantic.worker.ts` owns Transformers.js, ONNX Runtime, tokenization, and all
workspace-text embedding. The application entry bundle contains only the
small worker facade; Vite emits Transformers.js and the worker as optional
chunks requested on first semantic indexing. The worker protocol supports
progress, cancellation, bounded batches, finite-vector and dimension checks,
and disposal.

## Artifact and network posture

The model and ONNX runtime are served below the application origin at
`/semantic-pack/`. `env.allowRemoteModels` is false,
`env.allowLocalModels` is true, and the pipeline uses `local_files_only`.
Before model construction, the worker fetches every backend-specific asset and
refuses byte-length or SHA-256 drift against
`semantic-artifact-manifest.json`. The revision, dtype, dimensions, pooling,
and normalization are also pinned in source.

Run `npm run semantic:prepare` to materialize the reviewed public artifacts in
`.airship-lab/semantic-pack`. The Vite development plugin exposes only that
directory on the same origin. Production hosting must publish the same
verified directory at the same URL; the model pack is intentionally not
folded into the startup bundle.

Transformers.js may use the browser Cache API for these public, immutable
model/runtime files. Airship does not give it workspace files, credentials,
messages, vectors, or index snapshots to persist. Workspace text crosses only
the page-to-same-origin-module-worker boundary. Vectors and the flat index are
discarded with the page runtime and rebuilt from the active workspace.

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
AIRSHIP_LIVE_SEMANTIC=1 npx playwright test \
  e2e/live-semantic-embedding.spec.ts --project=desktop-chromium
```

Official API references:

- <https://huggingface.co/docs/transformers.js/guides/webgpu>
- <https://github.com/huggingface/transformers.js/releases/tag/4.0.0>
- <https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/tree/b0561d9a97e6b298da39f0ef3e7d3cf153b1b29a/onnx>
