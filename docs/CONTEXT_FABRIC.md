# Airship Context Fabric

## Decision

Airship treats the selected encrypted `ObjectStore`—Google Drive by default,
S3-compatible storage as an advanced adapter, or page memory while
Ephemeral—as the authoritative substrate for workspace context. The browser
does not download a whole vector database and does not depend on a continuously
running retrieval service. It holds a small decrypted routing mirror in memory,
selects a sparse set of context experts, range-fetches only their independently
authenticated pages when the active adapter has passed its exact-range contract,
scores them locally, and streams useful results into the active turn.

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

The current executable slice implements steps 1–6 and the retrieval commitment
in `src/retrieval/`. `FederatedTurnContextProvider` is the provider-neutral seam
called by every model turn. It selects separately governed active-profile
memory and workspace results, then seals a version-two context commitment. Each
hit references a shared generation record containing source revision/digest,
extractor, chunker, embedding provider/dimensions/posture, index format,
persistence, session/profile/workspace scope, and generation digest. This avoids
copying that metadata into every hit while retaining complete lineage.

`VaultTurnContextProvider` implements the same seam for encrypted object shards.
It routes a compact mirror, range-fetches only selected authenticated blocks,
and seals the adapter, exact range contract, mirror/result digests, expert IDs,
object/block IDs, offsets, lengths, ETags, plaintext digests, byte count, and
completion state into the turn selection. When an encrypted Vault becomes the
active runtime, the built-in application rebuilds the exact local generation
and read-only resolves an existing routing mirror. A matching mirror activates
the ranged provider behind the same federated turn seam; a missing, malformed,
or stale mirror leaves the local generation active and exposes that fallback
reason. Runtime adoption never publishes a shard. Publication is a separate
operation whose API requires the literal `explicit-user-approved` policy, so a
Vault connection or page reload cannot silently upload an index. The production
Vault screen is the sole built-in caller: **Publish encrypted index** snapshots
the current local generation, encrypts its derived expert shards, and advances
the authenticated routing mirror. **Update encrypted index** performs the same
explicit operation for a newer generation. The installed ranged provider is
generation-fenced on every turn; if the workspace has changed since publication,
the fresh on-device generation serves that turn until the user republishes.
Neither publication nor provider replacement rewrites the active session
manifest or its append-only journal.

The bootstrap index still uses full vectors in encrypted JSON pages and a
deterministic feature-hash embedding provider for testability. Those are
bootstrap codecs, not the production quality target.

## Turn history compression

The session manifest copies authoritative provider-catalog context-window
metadata when the session is created; Airship never guesses capacity from a
model name or re-reads a mutable catalog while replaying an old conversation.
Historical manifests without that optional pin retain full history. The trigger
is configurable from 80–85% (82% in the current remote-client policy). It
preserves recent complete turns and summarizes only boundaries ending at
`turn.completed`, so tool-call/result pairs are never split.

Remote sessions pin a tool-free inference-transport summarizer. It calls the
already selected transport directly—not the agent loop—and records its adapter,
provider, model, posture, request digest, response digest, and optional receipt
ID in the summary commitment. Its input is exact journal-linked source records
plus the previous bounded projection. Empty, oversized, malformed, tool-calling,
or incomplete output fails validation. The pinned failure policy either retains
full history or uses the deterministic extractive fallback; fallback events are
explicitly labeled with the failed attempt and are never presented as
model-intelligent summaries.

Compression is iterative and append-only. Each `context.summary.updated` event
stores only the newly covered summary delta plus exact journal sequence/digest
anchors and the prior summary digest. Provider materialization substitutes one
bounded digest-linked reference projection for the covered prefix; the raw
journal remains authoritative, replayable, and audit-verifiable. Old source
messages and prior summary bodies are not copied into each update. A malformed
range, digest, or chain fails audit and is not trusted.

This follows the useful Hermes pattern of iterative re-compression, protected
recent context, and boundary-aware compaction. Airship's 80–85% policy is a
product requirement, not a claim that it is Hermes' current default.

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

Whole-object AES-GCM is not used for large index objects because it defeats
range reads. `src/storage/encrypted-segments.ts` provides the independently
decryptable page format; `ObjectStore.getRange` enforces exact `206` ranges and
rejects a storage endpoint that ignores or changes a requested range.

Every adapter exposes a versioned capability record distinguishing in-process
enforcement from live-provider evidence. The conformance probe returns a
time-stamped result only after exact ranges, atomic create, and CAS have all
passed. It does not turn one successful probe into a permanent provider claim.
Google Drive additionally supports active-call resumable uploads for large
immutable shards; S3 in this repository retries shard objects but does not claim
multipart/resumable upload. No adapter persists a resume bearer capability.

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

The private default uses opaque, encrypted page objects in the selected Vault.
Managed vector APIs, including S3 Vectors, are optional non-E2EE adapters because
the service must see embeddings and filter metadata to search them.

Encryption does not hide every access pattern. Google Drive or S3 can observe
object identifiers, requested ranges, sizes, timing, and frequency. Mitigations
are selectable because each costs bandwidth:

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
- Turn selection is capped at eight hits and 32 KiB; the ordinary federated
  policy uses six hits and 24 KiB.
- Summary deltas default to 12 KiB (64 KiB hard maximum), and the materialized
  digest-reference chain is capped at 48 KiB. The tokenizer-agnostic estimate
  and measured reductions are workload evidence, not a universal ratio claim.
- Recent writes are searchable before compaction.
- An unavailable expert degrades recall and produces a visible receipt warning; it does not corrupt the session.

“Billion-device compliant” means static global delivery, no per-device application server, bounded memory, capability negotiation, and no centralized workspace database. It does not mean a phone should load a billion vectors. Corpus scale is handled by sparse routing and bounded range reads; device scale is handled because the services remain object storage, auth, payment, and inference—not an Airship session backend.

## Required storage behavior

Any remote Vault selected for streamed context must pass:

- CORS for the Airship origin;
- `GET`, `HEAD`, and conditional `PUT`;
- request header `Range`;
- exposed response headers `ETag`, `Content-Length`, `Content-Range`, and `Last-Modified`;
- exact `206 Partial Content` behavior for every requested range;
- short-lived least-privilege credentials or presigned capabilities;
- versioning/lifecycle policies where the provider offers them.

S3 deployments additionally require the listed CORS/exposed-header policy.
Google Drive uses its authorized `files.get?alt=media` byte-range path and its
own CORS/auth contract. Airship tests range semantics during connection setup
and refuses to label a store “streaming ready” when it silently returns whole
objects.
