# Airship protocol contracts

This document defines the stable shapes implementations converge on. Milestone
0 uses JSON for inspectability; canonical binary encodings may be added without
changing semantic event types.

## Canonical event envelope

```json
{
  "v": 1,
  "eventId": "01...",
  "sessionId": "01...",
  "turnId": "01...",
  "sequence": 42,
  "recordedAt": "2026-07-18T12:00:00.000Z",
  "type": "tool.resulted",
  "operationId": "01...",
  "payload": {},
  "previousDigest": "base64url-sha256",
  "digest": "base64url-sha256"
}
```

`sequence` is allocated atomically by the current session writer. The digest
chain detects corruption and makes forks explicit; it does not replace a device
signature when authorship proof is required.

Core event types:

- `session.created`, `session.forked`, `session.checkpointed`;
- `context.summary.updated` with digest-linked source ranges and explicit
  summarizer/fallback provenance;
- `turn.requested`, `turn.cancelled`, `turn.failed`, `turn.completed`;
- `turn.context.selected` (critical in a session-manifest v2 turn and always
  verified before inference);
- `inference.started`, `assistant.delta`, `assistant.completed`,
  `inference.usage`;
- `tool.requested`, `tool.approved`, `tool.denied`, `tool.resulted`,
  `tool.failed`;
- `workspace.changed`, `memory.derived`, `sync.committed`.

Unknown event types are retained and ignored only when their envelope version
is supported and they are explicitly non-critical. Unknown critical types stop
materialization.

## Session manifest versions

Manifest v1 is the historical transcript contract. It has no separately
journaled turn-retrieval policy; an embedded context selection is accepted only
for replay compatibility.

Manifest v2 makes `turnContext` mandatory (`required` or `disabled`). A client
that does not understand manifest v2 must refuse to resume the session. In a
v2 `required` session, `turn.context.selected` is a critical event and must be
canonical, digest-verified, bound to the current query and session silo, and
journaled before inference begins. A v2 `disabled` session rejects either the
new event or the historical embedded selection shape.

## Inference transport

```ts
interface InferenceTransport {
  readonly id: string;
  posture(): Promise<SecurityPosture>;
  stream(request: CanonicalInferenceRequest, signal: AbortSignal):
    AsyncIterable<InferenceEvent>;
}
```

The canonical request contains model, byte-stable system prefix, ordered
messages, tool schemas, response constraints, and an idempotency key. Provider
extensions live in a namespaced compatibility field and are copied into
provenance events.

Inference events are `text-delta`, `tool-call-delta`, `tool-call`, `usage`,
`completed`, or `failed`. Transports must bound buffers and surface an
incomplete authenticated stream as failure, never success.

## Encrypted object envelope v1

```json
{
  "v": 1,
  "suite": "AES-256-GCM/HKDF-SHA-256",
  "workspaceEpoch": 1,
  "objectId": "base64url-hmac-name",
  "revision": "immutable-operation-id",
  "nonce": "base64url-96-bit",
  "ciphertext": "base64url",
  "aad": {
    "namespace": "session-events",
    "objectId": "base64url-hmac-name",
    "revision": "immutable-operation-id",
    "contentType": "application/x-airship-events+json;v=1"
  }
}
```

AAD is encoded canonically. The logical filename/session name is encrypted in
the payload. An object encryption key is derived per immutable object; nonce
reuse under one key is forbidden. Implementations enforce plaintext,
ciphertext, and decompression limits before allocation.

## Object store

The minimum adapter contract is:

- immutable `put(objectId, bytes, ifAbsent=true)`;
- `get(objectId)` with integrity metadata;
- bounded/ranged read for large chunks;
- conditional manifest update `compareAndSwap(id, expectedTag, bytes)`;
- paginated listing by opaque prefix for repair only;
- explicit deletion behavior and documented consistency/durability;
- short-lived scoped authorization usable from a browser without exposing a
  bucket-wide credential.

Every implementation also exposes a versioned capability record. Exact range
reads, create-if-absent, and compare-and-swap are exact-or-fail contracts;
network adapters still require a live conformance result for the selected
deployment. Upload capability separately reports single-request, multipart, or
active-call resumable behavior. A Drive resumable session URI is never persisted
as an Airship capability.

Provider conformance tests inject dropped responses, stale reads, duplicated
requests, reordering, conflicts, quota errors, and partial outages.

## Workspace paths

Canonical paths are absolute UTF-8 slash paths. `.` and `..`, NUL, backslashes,
control characters, and paths escaping `/workspace` are rejected. Case
sensitivity is canonical even when a native adapter targets a case-insensitive
filesystem. Symlinks are not part of the baseline virtual workspace.

## Capability handshake

Every runtime surface advertises versioned capabilities rather than relying on
user-agent strings. Examples: `workspace.opfs`, `tool.native-process`,
`sync.background`, `crypto.wasm-simd`, `auth.passkey-prf`, and
`inference.attested-v2`. Sessions record the negotiated set.

## Index generation manifest

Every index generation pins:

- source workspace/repository manifest heads;
- extractor and canonicalization versions;
- chunker version and parameters;
- embedding model artifact digest, quantization, dimensions, and runtime;
- vector index algorithm/parameters and lexical index version;
- chunk lineage and tombstones;
- encrypted shard object IDs and integrity digests.

A device may reuse a shard only when all compatibility fields match. Generated
embeddings are treated as sensitive data, encrypted before storage, and never
sent to a vector database by the core client.

A ranged turn selection commits its routing-mirror and result digests, selected
experts, exact encrypted object/block ranges, ETags, plaintext block digests,
byte count, and completion state. Hits reference one shared generation lineage
record rather than duplicating the same extractor/chunker/embedding metadata.

## Session context policy

Supported manifests may carry an optional immutable context policy. It copies
the provider catalog's exact context-window field, the 80–85% trigger, target,
protected recent-turn count, maximum summary-delta bytes, summarizer adapter,
and failure behavior. Old manifests without the field remain valid and retain
full history. A runtime must not infer the limit from the model name or replace
the pin with a later catalog value.

## Agent profile manifest

Profiles are immutable content-addressed records. A session pins the complete
profile digest. Profile edits produce a new revision, and switching an active
session forks it unless the digest is identical.

## Source control manifest

Repository records contain remote identity (encrypted), immutable Git object
pack references, refs, and one checkout/index manifest per worktree. Stage and
commit update the client index and persist encrypted objects before CAS-moving a
ref. Remote credentials are memory-only service capabilities and are never part
of a repository manifest.

## Compute-continuum placement v1

Placement is resolved before spawn. The stable runtime ID is one of the
browser execution IDs or `linux-process`. Policies are `browser-only`,
`prefer-browser`, and `remote-confidential`.

The current executable contract is
[`compute-continuum.ts`](../src/execution/compute-continuum.ts). It may select a
caller-reported compatible browser runtime, whose adapter must still pass its
own invocation/readiness checks. It cannot select `linux-process` or any
remote executor: provider assertions, evidence-verification records, and
channel-binding records are observations rather than executable capabilities.
All such paths fail with an explicit unavailable result. `prefer-browser`
selects a caller-reported compatible browser runtime before considering
disclosure, and `remote-confidential` never downgrades.

Future promotion requires verifier-owned, non-forgeable readiness and approval
capabilities bound to the exact executor, evidence lease, endpoint/channel key,
runtime/artifact, operation, canonical effect plan, time window, mounts,
secrets, egress, byte ceilings, and workspace access. Plain JavaScript records
must never satisfy that gate. No planner may fall back after any executor has
accepted a job.

## Remote process start and channel v1

`airship.remote-process-start.v1` is a target wire record that commits to:

- job, operation, and executor identity;
- exact runtime, artifact, arguments, working directory, I/O mode, and timeout;
- exact prepared-plan, approval, and channel-binding digests;
- an optional immutable workspace-snapshot digest;
- mount, egress, and secret-set digests;
- input and output byte ceilings.

Possession of this plain data record never authorizes spawn. It contains no
workspace root key, Google token, S3 credential, Bitwarden token, generic
environment-secret map, or independently usable storage grant.

No `RemoteProcessChannel` implementation is shipped. The target channel will
expose bounded stdin, stdin close, PTY resize, declared signals, cancellation,
close, and an asynchronous frame stream. WSS is the compatibility transport;
WebTransport is conditional on live browser/endpoint probes. Either transport
still requires application E2EE bound to verified executor evidence.

## Remote process frames v1

Every `airship.remote-process-frame.v1` contains:

```json
{
  "schema": "airship.remote-process-frame.v1",
  "jobId": "job-identity",
  "sequence": 0,
  "recordedAt": "2026-07-23T12:00:00.000Z",
  "previousDigest": null,
  "payload": {
    "type": "accepted",
    "executorId": "executor-identity",
    "runtime": "linux-process",
    "artifactDigest": "sha256:<base64url-32-bytes>",
    "ioMode": "pipes",
    "planDigest": "sha256:<base64url-32-bytes>",
    "approvalDigest": "sha256:<base64url-32-bytes>",
    "channelBindingDigest": "sha256:<base64url-32-bytes>"
  },
  "digest": "sha256:<base64url-32-bytes>"
}
```

The digest is SHA-256 over the canonical frame excluding `digest`. The current
structural validator requires the exact job ID, sequence beginning at zero, a
contiguous previous digest, non-regressing valid timestamps, exact known
fields, and canonical digest equality. This unkeyed chain does not authenticate
the sender; a malicious peer can recompute it.

The payload order is:

1. exactly one `accepted` event;
2. zero or more bounded `stdout`/`stderr` events;
3. zero or one `workspace-delta` commitment;
4. exactly one `exited` or `failed` terminal event.

The acceptance must match the exact executor, runtime, artifact, I/O mode,
plan, approval, channel, and optional snapshot in the locally constructed
policy. Output uses non-empty canonical base64url bytes rather than UTF-8-only
strings, with 256 KiB per-frame and 8 MiB aggregate hard ceilings. PTY mode
forbids a separate stderr stream. No output may follow the optional delta, and
the result binds the complete snapshot/base/delta/changed-path/size commitment,
not only its manifest digest. Terminal stream and result commitments are
recomputed locally.

A frame after terminal state, duplicate acceptance/delta, unauthorized or
oversized delta, output above a budget, invalid exit status, unknown field,
explicit `undefined`, non-canonical timestamp, digest mismatch, gap, replay,
mutation, missing terminal event, or attempted early `finish()` invalidates the
transcript and permanently fail-latches that validator instance.

The terminal frame digest becomes a local structural commitment. It is not a
portable execution proof or an attestation claim; that additionally requires
an AEAD channel and/or executor signature whose key is bound to independently
verified evidence.

## Continuum job transition skeleton v1

[`continuum-job-state.ts`](../src/execution/continuum-job-state.ts) is a strict
browser-placement-only structural transition skeleton. It reconstructs exact
known records, rejects coercible field types and illegal edges, makes
cancellation sticky, bounds recovery attempts/deadline and sequence, prevents
writeback before structural verification, leaves `lost` unresolved, and accepts
a later terminal observation.

It is not an authority capability, durable operation registry, dispatch lease,
provider-status query, receipt verifier, or CAS reconciler. Its phase requests
are caller-constructible and it is not integrated into active adapters. Future
critical edges must be emitted behind the private effect broker from exact
approval, dispatch acknowledgement, authenticated terminal transcript, result
verification, and adoption-CAS outcomes. A durable expected-revision operation
record must prevent two callbacks or browser instances from advancing the same
idempotency key independently.

## Remote workspace snapshot and delta target

Remote jobs will consume a coherent immutable snapshot and write into a
copy-on-write overlay. The executor never receives the active `WorkspacePort`
or authority to advance its head. A delta commits to the base snapshot,
create/replace/delete entries, base revisions and digests, output object
digests, bounds, and the job/plan.

The browser validates every path, base revision, object digest, and terminal
receipt, then either advances one workspace head or preserves the complete
delta as a conflict. The first remote policy excludes `.airship`, credentials,
and `.git`. A transactional remote Git delta is a separate later protocol.

Airship's current whole-file encrypted workspace is not the target remote
snapshot format. The target uses independently authenticated encrypted blocks
inside immutable segments so a range request always fetches and verifies whole
authentication units. See [`COMPUTE_CONTINUUM.md`](COMPUTE_CONTINUUM.md).

## Workspace keyset target

A future root-key-independent key-envelope store contains only authenticated
wrapped workspace seeds and recipient metadata. Recovery kit, passkey PRF,
enrolled-device, browser-profile, and optional external-custodian wrappers are
independent recipients. Unlock returns a page-memory, non-serializable key
lease; it never returns a persistable raw key from the coordinator.

Ordinary passkeys do not expose an encryption key. A passkey wrapper is valid
only when the exact credential returns a supported WebAuthn PRF result. A
Bitwarden machine token, if a future optional adapter accepts one, remains
user-owned and page-memory-only and can retrieve exactly one recovery wrapping
key; it is never embedded, persisted, shared, or delegated to an executor.
See [`KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md`](KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md).
