# Airship protocol contracts

This document defines the stable shapes the simplified runtime converges on.

## Canonical event envelope

```json
{
  "v": 1,
  "eventId": "01...",
  "sessionId": "01...",
  "turnId": "01...",
  "sequence": 42,
  "recordedAt": "2026-07-18T12:00:00.000Z",
  "type": "assistant.delta",
  "payload": {},
  "previousDigest": "base64url-sha256",
  "digest": "base64url-sha256"
}
```

The digest chain makes tampering and forks visible. It does not by itself prove
author identity.

## Core event families

- `session.created`, `session.forked`
- `turn.requested`, `turn.completed`, `turn.failed`, `turn.cancelled`
- `session.model-changed`
- `inference.started`, `assistant.delta`, `assistant.completed`, `inference.usage`
- `tool.requested`, `tool.approved`, `tool.denied`, `tool.resulted`, `tool.failed`
- `workspace.changed`, `memory.derived`, `sync.committed`

Unknown critical events stop materialization.

## Inference transport

```ts
interface InferenceTransport {
  readonly id: string;
  stream(request: CanonicalInferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
}
```

The canonical request contains:

- target model;
- byte-stable system prefix;
- ordered messages;
- tool schemas;
- response constraints;
- an idempotency key.

Transport boundaries are limited to:

- `provider-tls`
- `loopback-local`

## Session model changes

Model switching is journaled rather than hidden in mutable UI state. A
`session.model-changed` event changes the target model for later turns only.
Earlier turns keep their recorded provenance.

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

Logical names live inside encrypted payloads. Storage providers see opaque IDs,
lengths, and timing, not plaintext filenames or conversation content.

## Object-store minimum contract

- immutable put with create-if-absent behavior;
- exact reads and exact range reads;
- conditional compare-and-swap for mutable heads;
- bounded listing for repair and maintenance;
- browser-usable scoped authorization.

## Workspace paths

Canonical paths are absolute UTF-8 slash paths under `/workspace`. `.` `..`
backslashes, NUL, control characters, and escape paths are rejected.
