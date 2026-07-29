# Design lineage and provenance

Airship is informed by several existing agents but is implemented as a clean,
browser-first runtime with its own contracts.

## Local reference library

The tracked catalog at
[`references/repositories.json`](../references/repositories.json) records the
exact repository URL, immutable revision, upstream relationship, license
status, intended study areas, and reuse boundary for disposable external
checkouts. The source trees live under the gitignored
`references/checkouts/`; they are read-only research material and never build
inputs, vendored dependencies, fixtures, or release artifacts. The operating
rules are in [`references/README.md`](../references/README.md), and the mandatory
specification/implementation information barrier is in
[`references/CLEAN_ROOM.md`](../references/CLEAN_ROOM.md).

## Hermes Agent

The pinned
`references/checkouts/open-source/nousresearch--hermes-agent` checkout is the
primary behavioral reference. Airship adopts these ideas conceptually:

- a byte-stable per-conversation prompt prefix;
- strict message-role alternation and append-only history;
- a narrow core with capabilities at adapters/plugins/skills;
- explicit sessions, memory provenance, context compression, tools, and
  cancellable streaming.

Python CLI, host terminal, SQLite, process environment, gateway, and server
assumptions are not copied into the browser runtime.

## `sirouk/claw-code` and `sirouk/claude-code-rs`

These public repositories are approved clean-room behavior studies for
compact agent loops, streaming, tools, terminal/workspace behavior, and native
distribution. Their pinned fork revisions have no license, and both describe
work informed by an exposed proprietary Claude Code sourcemap. The local
checkouts carry an absolute no-source-reuse boundary: no source,
prompts, text, tests, structures, or assets may be copied or adapted into
Airship. Their exact fork/parent relationships and warnings are recorded in the
reference catalog.

Current Airship milestone code does not copy source from either repository.

## Conversation, workspace, terminal, and storage studies

OpenAI Codex is a behavioral and architectural reference for coding-agent
tools, environment awareness, permissions, sessions, model controls, and
in-flight work. Code - OSS is the interaction-grammar reference for Explorer,
editor tabs, source control, diffs, themes, keyboard behavior, and integrated
terminals. xterm.js and isomorphic-git are the upstream component references
behind Airship's pinned browser-terminal and browser-Git adapters.

Open WebUI is a clean-room behavioral reference only for conversation,
composer, attachment, branch, search, and responsive-message ergonomics. Its
custom license and branding restrictions prohibit treating it as a source for
Airship UI code or visual identity. The detailed boundary is in
[`OPENWEBUI_CLEANROOM_CHAT.md`](OPENWEBUI_CLEANROOM_CHAT.md).

The archived AGPL-licensed MinIO repository is a clean-room protocol and
local-lab reference for S3-compatible Vault behavior. It is not an Airship
source dependency, and its checkout is never a source-incorporation path.

## Chutes E2EE browser test

The local `e2ee-test` prototype is the compatibility reference for Chutes E2EE
v1 framing. Airship preserves its on-wire ML-KEM/HKDF/ChaCha20-Poly1305 behavior
inside a separate Rust crate while changing the JavaScript secret lifecycle and
adding explicit compatibility/security labeling. Protocol-level changes require
a negotiated v2 server contract and are not silently inserted into v1.

## Context and storage research

The Context Fabric is a clean implementation informed by the pinned
CocoIndex checkout's
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
   license in the reference catalog;
2. create a source-free functional specification covering behavior, inputs,
   outputs, interfaces, invariants, failure modes, and acceptance tests;
3. implement original Airship code from that specification rather than from the
   source tree, even when the reference uses a permissive open-source license;
4. do not import reference code, prompts, text, tests, assets, naming, or
   distinctive organization; any deliberate third-party dependency remains a
   separately reviewed package relationship with its own notices;
5. record the spec-to-implementation decision and keep provider-specific
   adapters outside the stable runtime core.
