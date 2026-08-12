# Airship architecture

> [`CANON.md`](CANON.md) defines the current product boundaries, vocabulary,
> surface model, and implementation status. This document is the detailed
> technical architecture; the canon governs any later product decision that
> supersedes an older example here.

## Decision summary

Airship's authoritative browser host is TypeScript with a Preact shell. The
active agent loop, workspace/context codecs, browser Git adapter, and Vault
envelope path are TypeScript and WebCrypto today. Two reviewed Rust/WASM modules
are active at narrow boundaries: Chutes E2EE and local Intel DCAP quote
verification. `crates/airship-runtime` is a tested reference/recovery crate; it
is not currently linked as a unified browser kernel and must not be presented
as one.

That split is deliberate. Agent orchestration is dominated by network waits,
structured events, browser APIs, and UI interop; compiling that glue to WASM
adds copies and complexity without a measured throughput win. Codecs or
compute-heavy indexing may move to Rust/WASM only after browser integration,
byte-for-byte compatibility, cancellation, provenance, and bundle gates prove
the production path. The static shell remains framework-light and imports no
server framework.

## System view

```text
+----------------------- user device ------------------------+
| Preact/PWA UI                                               |
|   | approvals, events, presence, security posture           |
|   v                                                         |
| Agent runtime (framework independent)                       |
|   |-- immutable session log + stable prompt snapshot        |
|   |-- tool registry + capability policy                     |
|   |-- context/memory planner                                |
|   |-- cancellation, checkpoints, retries                    |
|   |                                                         |
|   +--> InferenceTransport --> Chutes E2EE/TEE or provider   |
|   +--> WorkspacePort -----> Ephemeral or encrypted Vault    |
|   +--> ClientCache -------> optional OPFS / IndexedDB cipher|
|   +--> IndexPort ---------> local router + streamed experts |
|   +--> SourceControlPort -> client Git object/index engine   |
|   +--> ContinuumPlanner --> browser job or paired executor   |
|   +--> ToolPort ----------> web / MCP HTTP / native / cloud |
|   +--> AuthPort ----------> Chutes/passkey/service identity  |
|   +--> AccountTelemetry --> direct balance/quota/usage reads |
|   +--> PaymentPort -------> direct payment service + receipt |
+-------------------------------------------------------------+
       | direct browser calls; no Airship application server
       +--> Chutes inference + evidence
       +--> Google Drive / S3-compatible user-selected Vault
       +--> identity, payment, MCP, or execution services
```

## Narrow-waist contracts

The runtime depends only on these ports; entries marked (target) are contract
names, not symbols in this tree:

- `InferenceTransport`: streams typed text, tool-call, usage, completion, and
  failure events and reports its verified security posture.
- `JournalBackend` (src/core/journal.ts): atomically appends immutable events
  and reads checkpoints.
- `WorkspacePort`: normalized path-based file operations with optimistic
  revisions; implementations declare limits and durability.
- `Tool`: JSON Schema declaration plus cancellable execution and an effect
  classification (`read`, `write`, `network`, `execute`, `identity`).
- `ApprovalPolicy`: decides, asks, or denies based on tool, arguments, origin,
  session, and capability tier.
- `ObjectStore`: conditional immutable put/get/list for ciphertext objects.
- `WalrusBlobTransport`: immutable encrypted blob/Quilt data plane; it remains
  separate because Walrus blob IDs do not provide S3 keys, listing, or
  compare-and-swap.
- `Keyring` (target): derives purpose-separated workspace keys and wraps them
  for enrolled devices.
- `AttestationVerifier` (target): verifies fresh evidence and emits granular
  claims; provider assertions alone cannot set a verified claim.
- `ReceiptStore` (target): stores/exports content-addressed evidence without
  changing the canonical conversation.
- `AuthPort` and `PaymentPort` (target): direct browser integrations returning
  scoped capabilities and portable receipts; the agent never handles raw
  payment authority.
- `AccountTelemetryPort` (target): cancellable, cache-bypassing, partial-result
  reads of provider balance, quota, subscription windows, usage, and live
  invocation headers. Provider telemetry never upgrades a cryptographic proof claim.
- `ContinuumPlanner` and `RemoteExecutorPort` (target): resolve an immutable
  approved job to a browser runtime or an independently verified paired
  executor, then expose bounded process frames without transferring browser
  authority.
- `WorkspaceSnapshotPort` (target): captures a coherent read-only base and
  conditionally adopts a verified copy-on-write delta; it is separate from the
  current per-file `WorkspacePort`.
- `Clock`, `IdSource`, and `Logger` (target): injected so recovery behavior is
  testable.

No provider SDK, UI framework, database, or chain type appears in canonical
events.

## Canonical turn lifecycle

1. Acquire the session writer lease.
2. Append `turn.requested` with a stable turn ID and user content.
3. Materialize the byte-stable system/tool snapshot and append-only context.
4. Start an inference attempt with a stable idempotency key.
5. Batch streamed text into immutable `assistant.delta` events without blocking
   paint; periodically checkpoint the assembled content.
6. On tool call, persist the complete requested call before policy evaluation.
7. Persist approval, execute once under an operation ID, then persist the tool
   result. Retrying reads the prior result instead of repeating side effects.
8. Continue inference until a terminal model event or the configured step cap.
9. Append `turn.completed` and release the lease. A Vault-backed journal has
   already committed each acknowledged append directly to its configured
   provider; Ephemeral mode retains the page-memory journal without implying a
   background sync outbox.

User and assistant role order remains strict. Tool results are explicit events;
the runtime never injects synthetic user text to repair alternation.

## Prompt caching invariant

At session creation Airship freezes:

- system prompt bytes and version;
- tool definitions and their canonical order;
- provider/model compatibility settings;
- initial policy-visible page-capability observation.

The prefix is reused byte-for-byte for the life of that session. New plugins or
configuration apply to a new session/fork. Context compression is the only
operation that substitutes a checkpoint, and the source-event range and digest
remain in the log.

## State model

### Device state

Strict mode stores the decrypted working set in memory only. Cache Storage may
retain versioned static application assets and contains no session data.

The implemented ciphertext acceleration cache uses OPFS first, IndexedDB next,
and page memory last only for already-enveloped immutable workspace objects
(including conventional Git metadata stored through that workspace) and
encrypted Context Fabric segment pages/ranges. Session/journal/profile heads,
event streams, credentials, keys, cursors, and provider inventories are not
currently admitted. OPFS runs in a dedicated worker and prefers a
successfully probed synchronous access handle. Mutable heads, listings, and CAS
always reach the Vault provider. The runtime must remain correct when this cache
is disabled, absent, evicted, corrupt, quota-limited, or only available through
a worker. `localStorage` is limited to
non-sensitive display preferences and opaque last-used identifiers; it never
contains bearer tokens, S3 credentials, plaintext, or raw workspace keys.

### Authoritative cloud objects

Payload objects are immutable and encrypted before a direct browser upload. A
small encrypted manifest maps logical streams to their current heads and is
updated with compare-and-swap. Conflicts create a branch; they never overwrite
history. Agent turns require a writer lease while human-edited text files may
use a CRDT adapter. Browser CORS and short-lived, prefix-scoped service
authorization are mandatory adapter capabilities.

The executable journal follows that rule directly. Each append seals and
creates an immutable event segment, verifies the event digest chain, then
advances one encrypted session-head object with `If-Match`. Concurrent writers
using the same ETag produce exactly one winner; the loser receives a journal
conflict and its unpublished segment is a safe garbage-collection candidate.
Session listing reveals only the opaque head-object prefix and ciphertext.
See [`EncryptedObjectJournalBackend`](../src/storage/encrypted-object-journal.ts).

### Memory

Memory is derived state, not privileged hidden truth. A memory record contains
source event IDs, author/agent origin, creation policy, scope, expiry, and
embedding/index version. Retrieval runs locally over decrypted candidates when
possible. Remote embedding or reranking uses the selected inference posture.

### Indexing and Context Fabric dataflow

Workspace events and Git tree changes become a typed incremental plan:

```text
manifest diff -> extractor -> canonical document -> deterministic chunks
              -> local embedding batch -> scoped expert pages
              -> encrypted generation shards + lineage manifest -> Vault provider

query + active scope -> local sparse router -> selected expert pages only
                     -> parallel range/patch stream -> local score/fusion
                     -> provenance-bearing context under byte/time budgets
```

Content hashes suppress unchanged work. Extractors declare MIME types, limits,
and required capabilities. The always-available baseline is a memory-only flat
exact index with deterministic bootstrap embeddings. An explicit, pinned local
semantic pack can instead run a real quantized model in an isolated worker,
preferring WebGPU and falling back to WASM when its same-origin artifacts and
browser facilities are available; this is conditional, never a startup claim.

The implemented encrypted Context Fabric publishes immutable generation shards
and a small routing mirror, then streams only selected byte ranges with exact
generation and digest lineage. Persisted quantized-vector routing, segmented
ANN tiers, and automatic active-directory/repository/worktree/branch routing
remain future promotion gates. Every active retrieval records the generations,
object ranges, ETags, plaintext block digests, byte count, completion state, and
provenance it actually used. Vectors are sensitive derived data and receive the
same encryption and deletion policy as source content. See
[CONTEXT_FABRIC.md](CONTEXT_FABRIC.md).

### Agent profiles

Profiles are content-addressed. In Ephemeral mode the active catalog is
page-memory-only by design. After a Vault is actually adopted, the catalog is
an encrypted, validated CAS head over the same provider-neutral object store as
the workspace and journal; provider readiness alone does not make it durable.
Sessions pin a profile ID, immutable revision, and digest. Editing a profile
creates a new revision, and stale cross-device writers are rejected rather than
silently overwriting one another. This preserves prompt caching and makes
device/profile switches auditable.

### Browser Git

`BrowserGitClient` normalizes repository, checkout, index, diff, stage, commit,
branch, clone, and fetch operations. The lazy `isomorphic-git` adapter reads and
writes conventional objects, refs, `HEAD`, config, and `DIRC` index bytes through
the authoritative `WorkspacePort`; the active encrypted Vault therefore stores
the same files without a second semantic checkpoint. Editor, Source Control,
agent tools, and Terminal's deterministic Git bridge share that client. The
interactive WebContainer excludes `.git` so an arbitrary process cannot bypass
Workspace CAS. Direct Smart HTTP clone, fetch, and push require remote browser
CORS and use the same reviewed adapter. Linked worktrees add conventional `.git`
pointers and `.git/worktrees` administration records over one filesystem
`commondir` projection, so per-worktree indexes stay isolated while objects and
refs are physically shared.

## Tool architecture

The core ships only universally useful virtual workspace operations. Extra
capability arrives as:

1. browser-safe in-process tools;
2. skills that teach the model to combine existing tools;
3. MCP over authenticated HTTPS;
4. a native companion exposing a user-approved capability channel;
5. an isolated/attested remote sandbox.

Each tool declares effects, input/output limits, timeout, resumability, and
whether replay is safe. Network, write, execute, identity, and destructive
effects are denied or explicitly approved by policy; model text never grants a
capability.

### Prepared remote effects

Remote placement adds executor identity, evidence lease, channel, mounts,
egress, secret identifiers, resource ceilings, and optional price to the
effect. Those values are resolved into a canonical prepared-plan digest before
approval. Any later change requires preparation and approval again.

The browser stages a coherent immutable snapshot, dispatches one idempotent
job, verifies its digest-linked stream and terminal receipt, and alone decides
whether to adopt the returned overlay. A lost dispatch acknowledgement enters
reconciliation; it is never assumed safe to repeat. The remote cannot advance
the session journal, Vault/workspace head, Git ref, profile, or context
generation.

The current repository implements browser-only placement, an isolated
browser-job transition skeleton, and structural transcript-validation
contracts. It deliberately blocks all remote promotion and registers no remote
executor. The transition skeleton is neither integrated nor authority-bearing;
structural digest validation does not authenticate a peer. Those require the
future private effect broker, attestation-bound channel, durable reconciliation,
and/or signed receipt. This preserves the real future seam without manufacturing
a sandbox or TEE claim. The normative design and promotion gates are in
[`COMPUTE_CONTINUUM.md`](COMPUTE_CONTINUUM.md).

## Deployment topology

The shipped app is a set of static HTML, CSS, JavaScript, WASM, manifest, and
service-worker assets. Any CDN or object host can serve it with the documented
security headers. There are no Airship request handlers or server-side renders.
The page calls the user's chosen services directly. An adapter is unavailable
when a service lacks browser CORS, scoped client authorization, or a safe
end-to-end protocol; Airship does not insert a hidden proxy to make it work.

The product UI is original. External dashboard screenshots inform only the
information architecture and feature inventory; Airship does not copy their
theme, branding, component styling, or layout proportions.

## Why storage is an adapter

Airship correctness cannot depend on one network, chain, SDK, or consistency
model. Any provider must pass its applicable conditional-write,
read-after-write, exact range/patch-read, expiry, outage, recovery, and deletion
contracts. Walrus is modeled as an immutable data plane with a separate
linearizable vault root; it is not forced into the `ObjectStore` interface.
See [WALRUS_STORAGE.md](WALRUS_STORAGE.md).

The normative primary-store behavior and executable live probe are in
[STORAGE_CONFORMANCE.md](STORAGE_CONFORMANCE.md). Shelby is a preferred
candidate once it supplies browser-safe delegated authorization plus either S3
`If-Match` or an atomic Aptos vault registry; see
[SHELBY_INTEGRATION.md](SHELBY_INTEGRATION.md).
