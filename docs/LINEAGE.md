# Design lineage and provenance

Airship is informed by several existing agents but is implemented as a clean,
browser-first runtime with its own contracts.

## Hermes Agent

The local `~/hermes-agent` checkout is the primary behavioral
reference. Airship adopts these ideas conceptually:

- a byte-stable per-conversation prompt prefix;
- strict message-role alternation and append-only history;
- a narrow core with capabilities at adapters/plugins/skills;
- explicit sessions, memory provenance, context compression, tools, and
  cancellable streaming.

Python CLI, host terminal, SQLite, process environment, gateway, and server
assumptions are not copied into the browser runtime.

## `sirouk/claw-code` and `sirouk/claude-code-rs`

These repositories are additional Rust implementation references for compact
agent loops, streaming, tools, terminal/workspace behavior, and native
distribution. Before code is copied or adapted, its exact upstream lineage,
commit, and license compatibility must be recorded here and in source headers.

Current Airship milestone code does not copy source from either repository.

## Chutes E2EE browser test

The local `e2ee-test` prototype is the compatibility reference for Chutes E2EE
v1 framing. Airship preserves its on-wire ML-KEM/HKDF/ChaCha20-Poly1305 behavior
inside a separate Rust crate while changing the JavaScript secret lifecycle and
adding explicit compatibility/security labeling. Protocol-level changes require
a negotiated v2 server contract and are not silently inserted into v1.

## Context and storage research

The Context Fabric is a clean implementation informed by CocoIndex's
incremental-dataflow usefulness, object-storage-native search systems,
Matryoshka embeddings, quantized vector search, and recent segmented/streaming
retrieval work. Exact references and the boundary between implemented and
planned tiers are recorded in [CONTEXT_FABRIC.md](CONTEXT_FABRIC.md).

The Walrus adapter is informed by the official Walrus HTTP, Quilt, browser SDK,
publisher-authentication, and funding designs. `chainbase-labs/WalruS3` was
reviewed as a compatibility prototype; no source was copied. Airship's current
transport is an independent TypeScript implementation with deliberately
narrower immutable-blob semantics. See [WALRUS_STORAGE.md](WALRUS_STORAGE.md).

## Arclink

The local `~/arclink` checkout informed only product principles:
clear account standing, explicit entitlements, minimal authoritative surfaces,
and strong separation between identity, payment, service access, and user data.
Airship does not copy its lore, backend topology, visual theme, or source. The
resulting access boundary is recorded in
[ACCESS_AND_COMMERCE.md](ACCESS_AND_COMMERCE.md).

## Provenance rule

For every external implementation influence:

1. record repository URL, immutable commit, upstream/origin relationship, and
   license;
2. distinguish a reimplementation of an idea from copied/adapted source;
3. retain required copyright/license notices for adapted source;
4. do not import code with unclear or incompatible licensing;
5. keep provider-specific adaptations outside the stable runtime core.
