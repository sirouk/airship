# Airship product specification

Status: current product contract for the simplified browser runtime.

## Product definition

Airship is a portable, browser-native agent workbench. Its authoritative
execution loop runs on the user's device. The app is shipped as a static,
installable web client with no Airship backend.

The product should feel like one place to chat, code, research, run tools, and
carry work across devices without surrendering the plaintext session history to
an application server.

## Core user jobs

1. Continue an agent conversation from a phone, tablet, or laptop.
2. Connect a chosen model provider without changing Airship's core semantics.
3. Work in a durable virtual workspace with explicit tool approvals.
4. Keep encrypted state on infrastructure the user controls.
5. Inspect exact provider/model provenance for every turn.
6. Fork, resume, export, or delete work without vendor lock-in.

## Required product properties

### Device-executed and provider-neutral

- The browser owns prompt assembly, context selection, tools, approvals,
  rendering, and client encryption.
- Providers are interchangeable adapters. No provider gets a special trust tier.
- The default cloud contract is direct browser API access with page-memory
  credentials.

### Honest inference boundaries

- Remote providers are labeled `provider-tls`.
- Loopback local providers are labeled `loopback-local`.
- Product copy must not imply remote attestation, enclave guarantees, or
  provider-side secrecy that the client cannot verify.

### Durable state under user control

- Airship starts in ephemeral page memory.
- Durable storage is explicit and client-encrypted.
- Supported rungs are Local Device, Google Drive, S3-compatible storage, and
  Walrus.

### Append-only sessions with light model switching

- Turns, tool calls, approvals, and failures are immutable events.
- A session records exact provider, connection generation, model, and transport
  boundary for each turn.
- Changing a session's model is an in-place override for the next turn.
- Forking remains an explicit user action for changing history, not the normal
  path for ordinary model changes.

### Concurrency and responsiveness

- Multiple conversations may run at once.
- Global navigation, provider management, and drafting in another conversation
  must stay available while one session is busy.
- Only actions that mutate the currently busy conversation may be blocked.

### Coding and research workbench

- The workspace provides real file editing semantics, typed tools, and a
  capability-gated approval layer.
- Airship exposes browser Git, a terminal, execution packs, and context/memory
  retrieval in the same product.
- PRIME is the default recursive agent engine.

### Static deployment

- The primary distribution is a static PWA.
- Static hosts, CDNs, and edge file servers are first-class deployment targets.
- Optional extensions or native helpers remain explicit companion capabilities,
  not hidden product dependencies.

## Out-of-scope claims

Airship does not claim host-root access, durable background daemon behavior,
or remote confidential-compute guarantees from ordinary provider APIs.
