# Airship edge-runtime capability ladder

Status: implementation doctrine, 2026-07-19.

## Product invariant

Airship is a client application, not a disguised session backend. The device owns
the agent loop, prompt assembly, tool policy, workspace plaintext, indexing,
retrieval, Git state, encryption keys, session DAG, and receipt verification.
Static asset delivery is allowed. Chutes provides identity, account data,
inference, and attestation evidence. A user-selected S3-compatible service stores
opaque encrypted objects. No Airship service receives workspace or conversation
plaintext.

"Runs anywhere" is implemented as a capability ladder. It does not mean every
browser can emulate a daemon, POSIX terminal, or host filesystem. A capability is
advertised only after a live probe; a receipt names the tier actually used.

| Tier | Minimum surface | State | Compute and tools | Honest limitation |
|---|---|---|---|---|
| Web baseline | modern browser, Web Crypto, Worker, fetch | page memory or direct encrypted S3 | agent loop, typed workspace tools, JS worker, direct CORS fetch, public GitHub snapshot import | tab must remain alive; no arbitrary host shell |
| Web enhanced | OPFS, Web Locks, WASM SIMD, optional WebGPU | encrypted S3 plus optional ciphertext-only device cache | worker indexing, local embeddings, large Git/object cache, faster execution | capabilities vary by engine/device |
| Installed PWA | enhanced tier plus install/background APIs | same authoritative S3 objects and bounded encrypted outbox | recoverable foreground jobs and opportunistic sync | browser suspension is `paused`, never falsely `running` |
| Native companion | explicit user-installed, scoped bridge | same portable encrypted object model | PTY, host filesystem, native Git/WASI, long-running jobs | separate capability and approval boundary |
| Confidential remote executor | explicit service capability | encrypted task objects and receipts | detached work inside a verified confidential environment | not "the browser did it"; independently receipted |

## One runtime, multiple adapters

The domain interfaces remain stable while adapters change:

```text
Agent kernel
  +-- WorkspacePort  -> page memory | OPFS | File System Access | encrypted S3
  +-- JournalBackend -> page memory | encrypted immutable S3 segments
  +-- ContextRuntime -> exact hybrid | WebGPU/WASM semantic | segmented S3 experts
  +-- BrowserGit     -> memory | OPFS/WASM | host API | native bridge
  +-- ToolRegistry   -> bounded browser tools | explicit companion capabilities
  +-- Inference      -> local deterministic test | Chutes E2EE + evidence
```

Changing an adapter creates a pinned session boundary. Airship migrates using
read-copy-verify-adopt, then keeps the old source independently recoverable. A
failed copy leaves the active runtime unchanged.

## Context engine: local gate, encrypted expert pages

Airship's scalable retrieval shape is a data mixture-of-experts:

1. Incrementally classify and chunk changed workspace files on the device.
2. Compute content, transform, model, and lineage digests.
3. Search a recent exact delta immediately; unchanged chunks reuse prior output.
4. Keep a small routing mirror in memory, keyed by directory, repository,
   worktree, branch, profile, task, source, recency, lexical sketch, and centroid.
5. Select a bounded expert set locally.
6. Fetch only independently authenticated encrypted page ranges from S3.
7. Fuse lexical and semantic scores locally and inject a token/byte-bounded
   packet with citations.
8. Journal generation, query, selected ranges, ETags, page digests, omissions,
   and the final context digest before inference.

This avoids loading a global vector database onto a phone. HNSW is useful for a
downloaded hot partition, but is not the default remote layout: dependent random
graph reads turn object-store latency into the bottleneck. Centroid/posting pages
and batched range reads are the durable WAN shape.

The baseline exact hybrid index is deliberately dependency-light. The semantic
tier is a lazy worker capability: a pinned Transformers.js embedding model uses
WebGPU when available and its WASM backend otherwise. Model download, model hash,
backend, dimensions, quantization, and warm/cold latency are visible. A failure
falls back to the exact deterministic tier; it never labels hash features as
semantic embeddings. Transformers.js documents both browser inference and WebGPU
execution: <https://huggingface.co/docs/transformers.js/en/index> and
<https://huggingface.co/docs/transformers.js/guides/webgpu>.

For larger hot partitions, benchmark USearch's compact WASM HNSW implementation
behind the existing index interface rather than placing it on the startup path:
<https://github.com/unum-cloud/usearch>. PGlite is an optional structured-data
pack—not the default workspace database—because it brings browser Postgres and
pgvector in roughly a few compressed megabytes but remains a single-user process:
<https://pglite.dev/docs/about>.

## Browser persistence

S3 is authoritative. Optional device persistence stores only ciphertext, opaque
object identifiers, sync cursors, and wrapped/non-extractable key material. The
Origin Private File System is the preferred enhanced-tier cache because its
synchronous access handles are Worker-only and optimized for in-place file work.
SQLite's official WASM distribution includes OPFS-backed VFS options and explains
their concurrency tradeoffs: <https://sqlite.org/wasm/doc/tip/persistence.md>.
Chrome's OPFS/SQLite documentation also records the Worker-only fast path:
<https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system/>.

Every mutable root uses conditional writes. S3 `If-Match`/`If-None-Match` is the
compare-and-swap boundary, and large encrypted index objects use exact Range GETs:
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html>
and <https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html>.
Checksums and Airship's own AEAD/page digests are independent layers:
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html>.

## Git without false promises

Local Git semantics are fully client-side: object database, refs, index,
worktrees, diff, stage, commit, and branch operations. Airship has two direct
remote paths:

- Public snapshot import resolves an immutable commit/tree through GitHub's API
  and reads commit-pinned blobs from `raw.githubusercontent.com`. It is labeled
  snapshot import and does not invent history.
- Full-history clone/fetch/push requires a remote that grants the Airship origin
  CORS or a user-authorized host API/native capability. isomorphic-git documents
  the same browser CORS constraint: <https://isomorphic-git.org/docs/en/clone>.

No client code can bypass another origin's CORS policy. A generic hidden proxy
would be an Airship backend and violate the invariant. The durable solution is a
capability-negotiated adapter with truthful transport provenance.

## Execution without a server-shaped browser

The baseline executor now includes a bounded JavaScript Worker and a pinned,
real WASI Preview 1 command host with typed inputs, wall-clock/output/artifact
limits, abort, args/env/stdout/stderr, and an optional bounded in-memory
workspace snapshot with revision-checked writeback. It has no implicit DOM,
network, credential, host-filesystem, Bash, or compiler access. `inspect_execution_runtimes` reports what is actually
ready; `execute_code` never treats an optional label as an installed runtime.

Pyodide 314.0.2 is an explicitly installed pack that becomes ready only after a
real disposable-worker interpreter probe. Fuller WASI/WASIX toolchains and
Node/npm WebContainers remain separately-budgeted lazy packs behind the stable adapter ABI described in
`BROWSER_EXECUTION_PACKS.md`. Wasmer JS provides a browser runtime and the WASI
project defines the portability boundary:
<https://docs.wasmer.io/sdk/wasmer-js/> and <https://wasi.dev/>.

WebContainers are a useful Chromium opt-in for Node-compatible development
workloads, not the universal runtime. Their own browser-support matrix is the
capability gate: <https://developer.stackblitz.com/platform/webcontainers/browser-support>.
The Web Neural Network API remains progressive enhancement while its specification
evolves: <https://www.w3.org/TR/webnn/>.

## Approval modes

- **Ask First:** every write, network, execute, identity, and remote-Git effect
  enters a user-visible approval queue.
- **Auto Approve:** a separate tool-free model call receives a redacted action
  descriptor and returns a strict structured verdict. Unsafe is denied;
  unavailable, ambiguous, or malformed falls back to Ask First.
- **Full Access:** registered tools execute without prompts, but all schemas,
  path confinement, byte/time limits, origin rules, and immutable journaling
  remain active. It is not unrestricted host access.

Each decision records mode, reviewer kind, argument digest, verdict, reason,
timestamp, and operation identity. A model's prose never changes the registry or
grants a capability.

## Availability and failure semantics

Every subsystem has explicit states: `unavailable`, `probing`, `ready`,
`degraded`, `paused`, `conflicted`, and `failed`. No spinner is a state model.

- Loss of Chutes pauses remote turns; local tools and unsent prompts remain.
- Loss of S3 keeps acknowledged local work only when an explicit encrypted
  outbox capability exists; otherwise the write fails visibly.
- Browser suspension marks foreground tasks paused.
- A retrieval deadline returns cited partial context plus an incomplete receipt.
- A corrupt page, manifest, receipt, or attestation is excluded and surfaced.
- A CAS conflict refreshes the head and requires reconciliation; it is never a
  blind retry of a user-visible mutation.
- Switching to Ephemeral creates a page-memory runtime and closes the vault. It
  does not delete cloud state.

## Release budgets

| Concern | Baseline budget |
|---|---:|
| automatically loaded startup JavaScript | an engineering target only; the executable entry and baseline ceilings, and the figures for them, live in `RELEASE_GATE.md` |
| automatic context injected per turn | 6 chunks and 24 KiB plaintext default |
| remote context fan-out | 4 experts, 8 MiB, 1.5 s default |
| image input | 8 images, 10 MiB each, 20 MiB aggregate |
| direct text fetch | 512 KiB default, 2 MiB hard UI/tool ceiling |
| public repository snapshot | 2,000 files, 32 MiB default, transactional writes |
| one workspace file | 16 MiB encrypted-workspace ceiling |
| agent loop | 32 steps with cancellation and durable step boundaries |

Optional semantic, database, Git, and execution packs are lazy and separately
budgeted. WASIX Bash is currently fail-closed and the release gate permits zero
WASIX artifacts.
Cold download and initialization are included in their benchmark; a warm-cache
number is never presented as first-use latency.

## Definition of "works"

A capability ships only when it has:

1. typed adapter and fail-closed capability report;
2. live browser probe on every claimed origin;
3. cancellation, quota, corruption, conflict, and reload tests;
4. mobile memory and thermal/latency measurements;
5. immutable provenance in the session journal;
6. an honest unsupported/degraded UI; and
7. no credential, plaintext, or undeclared proxy in storage, logs, cache, or
   static assets.

This is how Airship can feel like one coherent agent across a phone, a browser,
an installed PWA, and a native bridge without pretending those environments have
identical powers.
