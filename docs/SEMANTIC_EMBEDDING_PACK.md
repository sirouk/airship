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
