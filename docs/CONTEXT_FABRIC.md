# Airship Context Fabric

## Decision

Airship treats ordinary S3-compatible object storage as the encrypted, authoritative substrate for workspace context. The browser does not download a whole vector database and does not depend on a continuously running retrieval service. It holds a small decrypted routing mirror in memory, selects a sparse set of context experts, range-fetches only their independently authenticated pages, scores them locally, and streams useful results into the active turn.

This is a data mixture-of-experts, not a claim that a neural MoE is running in the browser. The gate routes over directory, Git, profile, task, source, recency, lexical, and semantic signals. Each expert owns a bounded partition of the context index.

## Query path

1. Derive the active focus from the selected agent profile, workspace directory, repository, worktree, branch, open files, recent turns, and explicit source filters.
2. Embed the query locally. Prefer a pinned, integrity-checked embedding model through WebGPU; fall back to quantized WASM/CPU.
3. Score the in-memory routing mirror. It contains opaque object references, authenticated generation metadata, centroids or compact codes, lexical sketches, scopes, and byte ranges—not source text.
4. Select the smallest useful set of experts under explicit byte, latency, energy, and context-token budgets.
5. Fetch expert pages concurrently with HTTP `Range` requests. Every page is independently AEAD encrypted so the browser can authenticate and decrypt it without reading the rest of the object.
6. Run hybrid lexical and semantic candidate scoring in a worker. Stream partial top-k results as expert pages finish; support cancellation immediately.
7. Fetch full-precision vector tails or source chunks only for finalists, then optionally run a local cross-encoder or late-interaction reranker.
8. Inject cited chunks into the turn and commit the mirror digest, query digest, exact object ranges, ETags, page digests, selected experts, and result digest to the conversation receipt.

The current executable slice implements steps 1–6 and the retrieval commitment in `src/retrieval/`. It uses full vectors in encrypted JSON pages and a deterministic feature-hash embedding provider for testability. Those are bootstrap codecs, not the production quality target.

## Cloud object layout

```text
encrypted root pointer (small, mutable by CAS)
└── immutable generation manifest
    ├── model + chunker + index format pins
    ├── encrypted routing mirror
    ├── immutable expert object A
    │   ├── independently encrypted page 0
    │   ├── independently encrypted page 1
    │   └── independently encrypted page N
    ├── immutable expert object B
    ├── recent delta segments
    └── tombstone/version segments
```

Logical names are HMAC-derived opaque object IDs. A generation is immutable and content-addressed. A small root object advances through conditional writes (`If-Match`/ETag), so a crashed or competing client cannot silently replace a generation. Page descriptors live inside an authenticated encrypted manifest. Page AAD binds workspace epoch, namespace, opaque object, revision, block ID and index, byte offset, lengths, and plaintext digest.

Whole-object AES-GCM is not used for large index objects because it defeats range reads. `src/storage/encrypted-segments.ts` provides the independently decryptable page format; `ObjectStore.getRange` enforces exact ranges and rejects a storage endpoint that ignores non-zero ranges.

## Routing mirror and experts

An expert is a bounded partition, commonly one of:

- directory or package;
- Git repository, worktree, branch, or diff state;
- agent profile and its pinned tools/instructions;
- source connector or imported corpus;
- recent-session delta;
- task- or language-specialized partition;
- global fallback.

The router combines semantic centroid similarity, lexical overlap, and explicit focus affinity. Scope is a boost, not an unconditional filter: the current directory should dominate when useful, while a clearly relevant result elsewhere remains reachable. The router is deterministic and inspectable. The UI can show “why this context was read” and the bytes spent for every expert.

For models trained with [Matryoshka Representation Learning](https://arxiv.org/abs/2205.13147), routing may use a short embedding prefix and expand dimensions only for survivors. Prefix truncation must never be enabled merely because a vector has many dimensions; the embedding model must explicitly support it.

## Index construction and change propagation

The client watches the workspace abstraction, not the browser filesystem globally. It surfaces indexable material before work begins and automatically processes approved/default-safe classes:

- chunk by language-aware syntax and document structure;
- hash source bytes, chunker configuration, embedding model, and transform versions;
- reuse unchanged outputs through lineage keys;
- append new vectors and lexical postings to a recent delta;
- record updates as new versions plus tombstones, never in-place mutation of an immutable generation;
- search the recent delta exactly alongside stable experts so new edits are immediately retrievable;
- compact locally when foreground pressure is low, the device is charging, or the user explicitly requests it;
- publish a new generation with compare-and-swap and retain the previous generation for rollback.

This adopts CocoIndex's useful ideas—incremental change detection, lineage, reusable transforms, and live update semantics—from its [core concepts](https://cocoindex.io/docs/programming_guide/core_concepts), without requiring its Python runtime or managed database.

## Production search tiers

| Corpus / device | Candidate structure | Final scoring |
|---|---|---|
| Small / constrained | exact SIMD scan of downloaded pages | full vector + lexical |
| Medium | centroid/IVF pages with scalar or binary codes | fetch full vectors for rerank |
| Large | IVF with RaBitQ/PQ pages, adaptive probes, recent exact delta | full precision or late interaction |
| Structured traces/data | Parquet row groups and column pages | lazy SQL/async UDF plus retrieval |

A global HNSW or DiskANN graph is a poor default over remote object storage: graph traversal creates many dependent random reads and turns network round-trip time into the bottleneck. HNSW remains useful inside a downloaded hot expert. Object-store-native routing should favor centroid/posting layouts and batched range reads, following the same physical insight described by [Turbopuffer's object-storage architecture](https://turbopuffer.com/docs/architecture) and the incremental local-rebuild ideas in [SPFresh](https://arxiv.org/abs/2410.14452).

For compact candidate codes, [RaBitQ](https://github.com/VectorDB-NTU/RaBitQ-Library) is a stronger production candidate than naive sign hashing: it supports fast low-bit distance estimates and bounded-error reranking. Full vectors remain the truth tier for finalists.

## Browser-native components worth evaluating

- [Transformers.js WebGPU](https://huggingface.co/docs/transformers.js/guides/webgpu) for local embeddings, with a quantized WASM fallback and pinned model hashes.
- [HypVector](https://www.npmjs.com/package/hypvector) for its very recent browser/S3 Parquet range-search implementation. Its binary-cluster-rerank path validates the core direction; Airship additionally needs encrypted pages, hybrid focus routing, mutation generations, and receipts.
- [Hyparquet](https://www.npmjs.com/package/hyparquet) for small, column-selective Parquet range reads.
- [A Query Engine for the Agents](https://arxiv.org/abs/2605.27785) for async-generator execution, downstream-demand laziness, and cancellation inside a client runtime.
- [Lance](https://docs.lancedb.com/lance) for object-store-native columnar layout and candidate/full-vector separation; use ideas or narrowly measured components rather than shipping a large engine by default.
- [USearch](https://github.com/unum-cloud/usearch) for WASM SIMD exact scan or an in-memory hot-partition index after bundle, license, and browser API verification.

No dependency is adopted solely because its benchmark is impressive. Airship records the version, license, bundle cost, model compatibility, memory ceiling, CORS behavior, and reproducible recall/latency results before promotion from experiment to default.

## Privacy boundary

The private default uses ordinary S3 objects containing opaque, encrypted pages. Managed vector APIs, including S3 Vectors, are optional non-E2EE adapters because the service must see embeddings and filter metadata to search them.

Encryption does not hide every access pattern. S3 can observe object identifiers, requested ranges, sizes, timing, and frequency. Mitigations are selectable because each costs bandwidth:

- fixed page classes and padded final pages;
- fetch coalescing and bounded cover reads;
- delayed/batched background writes;
- separate identities/buckets for sensitive workspaces;
- an advanced PIR/ORAM adapter when its latency and cost are justified.

Source plaintext, embeddings, lexical terms, paths, profile instructions, and routing scopes are not written unencrypted by the private mode.

## Reliability and performance budgets

- First route decision from a warm mirror: target under 10 ms on desktop and 25 ms on a mid-tier phone.
- First partial result: target under 250 ms on a warm regional object store.
- Default retrieval network budget: 8 MiB, adaptively reduced on cellular or low battery.
- Default expert fan-out: four, raised only when recall telemetry justifies it.
- Page size classes: benchmark 64 KiB–1 MiB; avoid hundreds of tiny WAN requests.
- All requests cancellable; stale directory/task queries are abandoned rather than completed in the background.
- Recent writes are searchable before compaction.
- An unavailable expert degrades recall and produces a visible receipt warning; it does not corrupt the session.

“Billion-device compliant” means static global delivery, no per-device application server, bounded memory, capability negotiation, and no centralized workspace database. It does not mean a phone should load a billion vectors. Corpus scale is handled by sparse routing and bounded range reads; device scale is handled because the services remain object storage, auth, payment, and inference—not an Airship session backend.

## Required storage behavior

The bucket or S3-compatible endpoint must support:

- CORS for the Airship origin;
- `GET`, `HEAD`, and conditional `PUT`;
- request header `Range`;
- exposed response headers `ETag`, `Content-Length`, `Content-Range`, and `Last-Modified`;
- exact `206 Partial Content` behavior for non-zero ranges;
- short-lived least-privilege credentials or presigned capabilities;
- versioning/lifecycle policies where the provider offers them.

Airship tests range semantics during connection setup and refuses to label a store “streaming ready” when it silently returns whole objects.

