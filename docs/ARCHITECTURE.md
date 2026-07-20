# Airship architecture

## Decision summary

Airship uses a deterministic Rust/WASM kernel with a thin TypeScript browser
host. Cryptography and future CPU-heavy indexing are also Rust/WASM. The static
web shell uses Preact because its job is lightweight rendering and browser API
integration, not server rendering. Runtime packages import no UI or server
framework. Agent scheduling and crypto move to module workers as the
implementation matures.

Rust is not used for the entire UI. Agent orchestration is dominated by network
waits, structured events, browser APIs, and UI interop; compiling that glue to
WASM adds copies and complexity without a useful throughput win. Rust is used
where memory discipline, portable codecs, and compute density justify it.

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
|   +--> WorkspacePort -----> IndexedDB / OPFS / native       |
|   +--> StateStore --------> memory / opt-in encrypted cache |
|   +--> SyncPort ----------> encrypted S3 / Walrus objects   |
|   +--> IndexPort ---------> local router + streamed experts |
|   +--> SourceControlPort -> client Git object/index engine   |
|   +--> ToolPort ----------> web / MCP HTTP / native / cloud |
|   +--> AuthPort ----------> Chutes/passkey/service identity  |
|   +--> AccountTelemetry --> direct balance/quota/usage reads |
|   +--> PaymentPort -------> direct payment service + receipt |
+-------------------------------------------------------------+
       | direct browser calls; no Airship application server
       +--> Chutes inference + evidence
       +--> S3 / R2 / Walrus / user-selected storage
       +--> identity, payment, MCP, or execution services
```

## Narrow-waist contracts

The runtime depends only on these ports:

- `InferenceTransport`: streams typed text, tool-call, usage, completion, and
  failure events and reports its verified security posture.
- `SessionStore`: atomically appends immutable events and reads checkpoints.
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
- `Keyring`: derives purpose-separated workspace keys and wraps them for
  enrolled devices.
- `AttestationVerifier`: verifies fresh evidence and emits granular claims;
  provider assertions alone cannot set a verified claim.
- `ReceiptStore`: stores/exports content-addressed evidence without changing
  the canonical conversation.
- `AuthPort` and `PaymentPort`: direct browser integrations returning scoped
  capabilities and portable receipts; the agent never handles raw payment
  authority.
- `AccountTelemetryPort`: cancellable, cache-bypassing, partial-result reads of
  provider balance, quota, subscription windows, usage, and live invocation
  headers. Provider telemetry never upgrades a cryptographic proof claim.
- `Clock`, `IdSource`, and `Logger`: injected so recovery behavior is testable.

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
9. Append `turn.completed`, release the lease, and flush the sync outbox.

User and assistant role order remains strict. Tool results are explicit events;
the runtime never injects synthetic user text to repair alternation.

## Prompt caching invariant

At session creation Airship freezes:

- system prompt bytes and version;
- tool definitions and their canonical order;
- provider/model compatibility settings;
- policy-visible capability tier.

The prefix is reused byte-for-byte for the life of that session. New plugins or
configuration apply to a new session/fork. Context compression is the only
operation that substitutes a checkpoint, and the source-event range and digest
remain in the log.

## State model

### Device state

Strict mode stores the decrypted working set in memory only. Cache Storage may
retain versioned static application assets and contains no session data.

An optional encrypted offline cache can use IndexedDB/OPFS for:

- session metadata;
- immutable events keyed by `[sessionId, sequence]`;
- encrypted workspace nodes and chunks;
- sync outbox/inbox cursors;
- wrapped device/workspace keys;
- provider metadata that is safe to persist (never bearer credentials).

The runtime must remain correct when this cache is disabled, absent, evicted,
quota-limited, or only available through a worker. `localStorage` is limited to
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
              -> encrypted generation shards + lineage manifest -> S3/Walrus

query + active scope -> local sparse router -> selected expert pages only
                     -> parallel range/patch stream -> local score/fusion
                     -> provenance-bearing context under byte/time budgets
```

Content hashes suppress unchanged work. Extractors run in sandboxed workers and
declare MIME types, limits, and required capabilities. A quantized embedding
model runs through WebGPU where available and WASM SIMD otherwise. The client
keeps a small encrypted routing mirror—scopes, centroids, lexical terms, and
page handles—rather than loading a global approximate-nearest-neighbor graph.
It gates by active directory, repository, worktree, branch, profile, and source,
then streams only the selected encrypted expert pages. A flat exact index is the
small/mobile baseline; quantized and segmented implementations are production
tiers. Every retrieval records queried generations, exact byte ranges or Quilt
patches, ciphertext and result digests, budgets, and provenance. Vectors are
sensitive derived data and receive the same encryption and deletion policy as
source content. See [CONTEXT_FABRIC.md](CONTEXT_FABRIC.md).

### Agent profiles

Profiles live in the encrypted cloud manifest and are content-addressed.
Sessions pin a profile ID, immutable revision, and digest. Editing a profile
creates a new revision. This preserves prompt caching and makes device/profile
switches auditable.

### Browser Git

`SourceControlPort` normalizes repository, worktree, index, diff, stage, commit,
branch, merge, fetch, and push operations. Git objects and indexes are processed
in memory/WASM and checkpointed as encrypted storage objects. Multiple browser
"worktrees" share immutable objects but keep separate encrypted checkout/index
manifests. Remote transports are direct host APIs or CORS-enabled smart HTTP.

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
