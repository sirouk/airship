# Airship protocol contracts

This document defines the stable shapes the simplified runtime converges on.

## Canonical event envelope

```json
{
  "version": 1,
  "eventId": "01...",
  "sessionId": "01...",
  "turnId": "01...",
  "sequence": 42,
  "recordedAt": "2026-07-18T12:00:00.000Z",
  "type": "assistant.completed",
  "payload": {},
  "previousDigest": "sha256:base64url",
  "digest": "sha256:base64url"
}
```

`DurableEvent` in `src/core/journal.ts` is the shape above. A digest is the
string `sha256:` followed by 43 characters of unpadded base64url; the first
event's `previousDigest` is the literal `genesis`. The preimage and the
recomputation rule are written out in [`WORK_BUNDLE.md`](WORK_BUNDLE.md).

The digest chain makes later editing and forks visible. It does not by itself
prove author identity, and nothing in it is signed.

## Core event families

`KNOWN_EVENT_TYPES` in `src/core/session-audit.ts` is the complete list. The
families are:

- session: `session.created`, `session.renamed`, `session.favorite.changed`,
  `session.model-changed`, `session.approval-policy-changed`,
  `session.fork.context.seeded`
- turn: `turn.requested`, `turn.context.selected`, `turn.reasoning`,
  `turn.plan.restated`, `turn.completed`, `turn.failed`, `turn.cancelled`
- inference: `inference.started`, `assistant.completed`, `inference.usage`
- tool: `tool.requested`, `tool.approved`, `tool.denied`, `tool.resulted`,
  `tool.failed`
- local command, human intent, terminal activity, context summary, profile
  ordering, and the `prime.*` engine records

Assistant text streams to the screen but is journaled once, as
`assistant.completed`; there is no per-delta event. A fork is recorded by the
new session's `lineage` manifest commitment and its
`session.fork.context.seeded` seed, not by an event on the source. There are no
`workspace.changed`, `memory.derived` or `sync.committed` events.

An event type this list does not name raises `EVENT_TYPE_UNKNOWN`, which makes
the history report incomplete and blocks ordinary resume.

## Inference transport

```ts
interface InferenceTransport {
  readonly id: string;
  readonly posture: SecurityPosture;
  stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
}
```

`InferenceRequest` in `src/core/contracts.ts` carries:

- request, session, and turn IDs;
- the target model;
- the system prompt;
- ordered canonical messages;
- tool definitions;
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
  "version": 1,
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

`/workspace/local` is a reserved mount. While a folder on this device is open,
paths under that mount are served from the real directory by
`LocalFolderWorkspacePort`, and nothing is copied in either direction.
