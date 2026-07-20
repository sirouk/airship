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
- `turn.requested`, `turn.cancelled`, `turn.failed`, `turn.completed`;
- `inference.started`, `assistant.delta`, `assistant.completed`,
  `inference.usage`;
- `tool.requested`, `tool.approved`, `tool.denied`, `tool.resulted`,
  `tool.failed`;
- `workspace.changed`, `memory.derived`, `sync.committed`.

Unknown event types are retained and ignored only when their envelope version
is supported and they are explicitly non-critical. Unknown critical types stop
materialization.

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
