# Airship product specification

Status: executable architecture, milestone 0  
Date: 2026-07-18

> **Current authority:** [`CANON.md`](CANON.md) is the reconciled project
> overview and implementation-status ledger. This specification supplies the
> detailed product contract; where later shipped decisions differ, the canon
> governs.

## Product definition

Airship is a portable, private agent runtime whose authoritative execution
loop runs on the user's device. Its primary distribution is a static,
installable web app with no Airship application backend. The client calls
independent inference, storage, identity, payment, and execution services
directly. Optional Tauri/native and remote confidential-execution surfaces
implement the same contracts when the browser sandbox cannot provide a
capability.

The experience should feel like a good local agent CLI: persistent sessions,
streaming turns, files, tools, cancel/retry, resumable work, visible approvals,
and deterministic recovery after a crash. "CLI-like" does not mean pretending
the browser has OS privileges it does not have.

## Users and jobs

1. Continue a private agent session from phone, tablet, laptop, kiosk, or an
   embedded WebView without moving plaintext history through an Airship server.
2. Work against a durable virtual workspace and explicitly grant tools access
   to browser, remote sandbox, or native capabilities.
3. Select an inference provider without changing session semantics.
4. Inspect which security guarantees are active for every turn.
5. Export, migrate, delete, or self-host all state without vendor lock-in.
6. Open small proof icons beside a response and independently verify or export
   the exact evidence supporting each claim.

## Required product properties

### Device-executed, cloud-authoritative

- Agent reasoning, decryption, indexing, tools, and rendering execute on the
  client. Durable sessions, memory, receipts, workspaces, source repositories,
  and indexes are encrypted on the client and committed directly to the user's
  configured Google Drive or S3-compatible Vault provider.
- Strict mode retains no durable application data on the device. Cache Storage
  may retain the static app shell; memory holds the active decrypted working
  set. An encrypted IndexedDB/OPFS offline cache is explicit opt-in.
- A turn is not shown as durable until its encrypted journal segment and
  compare-and-swap manifest are committed. Streaming UI may be optimistic and
  visibly marked `syncing`.
- A transactional in-memory outbox retries while the page is alive. Reliable
  offline continuation requires the opt-in encrypted cache.
- The active device is the fenced writer for an agent turn. Other devices can
  read or fork; explicit leases prevent two models from advancing one session
  concurrently.

### Private by construction

- API credentials are memory-only unless a user explicitly enrolls a
  hardware-backed or OS-backed secret store.
- Long-lived storage credentials are never persisted by Airship. Direct
  storage uses memory-held Google authorization or short-lived,
  prefix-scoped capabilities/STS credentials supplied by the selected
  identity/storage service.
- Session, memory, and workspace payloads are encrypted before cloud storage.
- Storage providers see opaque object identifiers, ciphertext sizes, timing,
  account metadata, and access patterns, but not logical paths or content.
- Inference posture is reported as `plaintext`, `encrypted-unattested`, or
  `encrypted-attested`; no UI copy collapses those categories.
- Every turn has a receipt with independent claim states for encryption,
  freshness, key-to-TEE binding, Intel quote/TCB policy, NVIDIA GPU evidence,
  model artifact, request/response transcript, and payment. Missing proof is
  visible and fails closed.

### Portable and interoperable

- Baseline: current evergreen Chromium, Firefox, and WebKit browsers, including
  installed PWAs. IndexedDB and Web Crypto are mandatory; OPFS, Web Locks,
  passkey PRF, SIMD, threads, and native bridges are optional accelerators.
- Core protocols are versioned and provider-neutral.
- Inference adapters target OpenAI-compatible chat/response semantics without
  storing provider-specific fields in the canonical session log.
- Tools use JSON Schema and a small MCP-compatible shape. Remote MCP requires a
  browser-safe authenticated transport; local stdio MCP requires a native
  companion.
- Workspaces export as a documented encrypted bundle plus NDJSON event log.

### Reliable

- Every mutation has a stable operation ID and is safe to retry.
- Inference attempts, model output, tool requests, approvals, tool results, and
  failures are immutable events.
- Cancellation is cooperative and propagates through inference and tools.
- Corrupt or unsupported records are quarantined rather than silently skipped.
- Context compaction produces a signed/hashed checkpoint and never rewrites the
  original history.

### Automatic client indexing

- Workspace and source-manifest changes feed a client-side incremental dataflow
  pipeline: discover, extract, normalize, chunk, embed, index, checkpoint.
- Every chunk retains lineage to content digest, file path, Git commit/worktree,
  extractor, chunker, embedding model, and index format.
- Only changed content is re-embedded. Deleted content produces tombstones;
  incompatible model/chunker upgrades create a new index generation.
- Dense vector retrieval and lexical search run locally. WebGPU is the preferred
  embedding accelerator; WASM SIMD is the portable fallback.
- Hot vectors live in memory. Encrypted index shards/checkpoints sync through
  the configured Vault provider and may be rehydrated by another device
  without reprocessing the workspace.
- The interface surfaces supported, pending, current, changed, too-large,
  private/excluded, and failed candidates before automatic processing.

### Profiles and source control

- An agent profile is a versioned immutable manifest of prompt, provider/model,
  tools, skills, memory scope, workspace, permissions, and receipt policy.
  Switching profiles starts or forks into the selected pinned manifest; it does
  not mutate an active conversation prefix.
- Workspace Editor combines Files and Sources. Sources manages registered
  repositories, the real checkout/index, diffs, staging, commits, branches,
  and conditional direct fetch/clone/push through a client Git engine. Push is
  separately identity-approved, accepts only an out-of-band page-memory
  credential callback, and treats a lost terminal response as an unknown
  remote outcome. Linked worktrees have conventional per-worktree metadata and
  one shared object/ref store; unsupported merge behavior remains labeled
  unavailable.
- Git object/index operations run on the device. Remote operations require a
  Git host with browser CORS and OAuth/scoped credentials or a direct host API;
  Airship does not provide a proxy.
- Terminal's Shared Git bridge dispatches to that same client and approval
  policy; arbitrary WebContainer processes do not receive a divergent `.git`
  mirror.
- Desktop and mobile expose the same profiles, repository state, actions, and
  receipts. Mobile uses tabs/drawers and progressive detail, not a read-only
  reduced feature set.

### Themes, skills, and memory relationships

- Every profile selects a versioned theme manifest. Themes contain only audited
  semantic tokens (surface, ink, accent, signal, density, and motion); they
  cannot inject CSS. Activating a profile applies its theme to the complete
  interface, including proof, workspace, source, and mobile surfaces.
- A skill is a versioned instruction/capability manifest with a content digest.
  Skills may be enabled globally, inherited by a profile, or explicitly enabled
  or disabled for one profile. The resolved skill set and composed system prompt
  are pinned when a session is created. Changing a switch never mutates the
  meaning of an existing session.
- The Memory view is a client-derived materialized graph, not a new database or
  authority. It relates real session messages, workspace documents, profiles,
  skills, and extracted terms; selecting and searching nodes never sends those
  values to Airship.
- Airship's own derivation owns the bounded in-browser graph model, and a
  hand-written, lazy-loaded 2D canvas draws it
  (`src/memory-graph/canvas-renderer.tsx`). Graphology and Sigma.js were
  surveyed and not adopted; neither is a dependency of this repository, and the
  survey is kept as the record of that decision in
  `MEMORY_RELATIONSHIP_GRAPH.md`. This gives a Neo4j-like exploratory
  experience without requiring Neo4j Server, exposing browser database
  credentials, or adding an Airship backend. A relationship list/inspector
  remains available beside the canvas.
- Durable graph snapshots, derived statistics, and extraction checkpoints use
  the same encrypted object generations as other memory artifacts. The graph is
  reproducible from its lineage and may be discarded or rebuilt at any time.
- Large workspaces never hydrate one global graph. The context driver fetches a
  bounded relationship neighborhood selected by active profile, workspace
  directory, source/worktree, task, and retrieval result; encrypted Vault
  segment ranges remain the durable backbone.

### Account standing and provider runway

- The Account view reads effective balance, configured quotas, subscription
  windows, and UTC-month usage directly from Chutes with a user-scoped token.
  Requests run in parallel, bypass caches, remain cancellable, and expose
  partial-source failures instead of converting them to zeros.
- Actual charged USD and subscription-covered pay-as-you-go-equivalent usage
  are separate measures. Four-hour subscription capacity is labeled as the
  fixed UTC bucket implemented by Chutes, never as a rolling window.
- Quota/rate-limit response headers from an invocation are a memory-only live
  observation. They are unsigned and must not receive a proof badge or be
  mistaken for the post-invocation account balance.
- Normal inference API keys cannot unlock the account surface. Airship accepts
  only a user-scoped OAuth token for account reads and never requests an admin
  key. Hosted Chutes billing remains the mutation/commerce surface.

### Chutes sign-in boundary

- Airship implements OAuth Authorization Code request preparation with S256
  PKCE, state validation, an exact redirect allowlist, and short-lived browser
  attempt state.
- Chutes currently documents a mandatory `client_secret` for both code exchange
  and refresh, and directs applications to perform token operations on a server.
  That secret must never be shipped in the static client. Until Chutes offers a
  public-client exchange (PKCE without a secret) or a disclosed minimal access
  notary is deployed, the production static client uses an explicitly
  memory-only user credential for inference.
- The development registration uses `http://localhost:4173` and the exact
  callback `http://localhost:4173/auth/chutes/callback`. The enabled Account
  surface registers `profile`, `chutes:invoke`, and `billing:read`; Airship's
  authorization request additionally includes the standard `openid` scope,
  which the API accepts but its advertised checkbox inventory currently omits.
  Current self-service account routes are actually authorized by `profile`
  because Chutes maps it broadly to `account/read`; the explicit billing grant
  records enabled feature intent and makes that provider contract mismatch
  visible. See `ACCOUNT_TELEMETRY.md`.
- Chutes' current frontend omits the API's `public` field while the API defaults
  it to `true`. Until that form exposes visibility, create the development app
  through the API with `public: false` or explicitly patch visibility after
  creation. Never interpret this directory flag as OAuth public-client mode.

## Performance objectives

These are engineering targets, not claims about the current milestone.

| Measure | Target |
| --- | --- |
| Cached app interactive, p75 mid-tier phone | under 1.5 s |
| Warm session open, 2,000 events, p95 | under 150 ms |
| Local durable append, p95 | under 25 ms |
| UI response to input | under 100 ms |
| Token render cadence | one paint per frame, bounded batching |
| Crypto/runtime work on main thread | under 4 ms per frame |
| Crash recovery | no acknowledged local event loss |
| Cloud sync RPO while online | under 5 s |
| Incremental index of unchanged workspace | no embedding work |
| Local hybrid search over 100k chunks, p95 desktop | under 100 ms target |
| Automatically loaded startup JS + workers, compressed | at most 224 KiB target; entry at most 110 KiB |
| Crypto WASM, compressed | under 350 KiB goal |

Inference latency is dominated by provider queueing and model generation, so
Airship warms only short-lived provider leases that are safe to prefetch and
keeps local orchestration off the critical rendering path.

The startup target is not an installed-bundle ceiling. Git, Terminal,
execution, semantic, Proof, Memory, and other demand-loaded packs are classified
and capped separately, with an additional absolute installed-JavaScript
backstop. [`RELEASE_GATE.md`](RELEASE_GATE.md) is the executable budget
inventory; changing one of its reviewed ceilings requires a code and document
change together.

## Scale model

"One billion devices" is a protocol and operations constraint, not a claim
that a single bucket or chain handles a billion concurrent writers.

- Devices talk directly to the selected services using browser-safe scoped
  authorization. Agent turns never traverse an Airship application server.
- State is partitioned by tenant/workspace and immutable object ID.
- Manifests are small CAS-updated roots; payloads are immutable, deduplicated
  encrypted objects.
- Short-lived scoped capabilities replace global bucket credentials.
- Discovery, auth, rate limits, revocation, abuse controls, receipts, and
  attestation evidence are responsibilities of the selected services.
- Hot metadata may use a regional database; large encrypted objects belong in
  globally replicated object storage. A ledger is optional for receipts and
  commitments, never for personal plaintext or required hot-path writes.

## Capability tiers

| Tier | Runtime | Capabilities |
| --- | --- | --- |
| Web baseline | PWA + worker | agent loop, virtual files, client indexing/Git, HTTP tools, encrypted sync |
| Web enhanced | OPFS/WASM SIMD/Web Locks | large files, faster indexing/crypto, cross-tab ownership |
| Native shell | Tauri/mobile wrapper | selected host files, PTY/process tools, OS keychain, background jobs |
| Remote sandbox | attested or isolated worker | Linux CLI, builds, browsers, long-running jobs |

A session records its initial page-capability observation, while every execution
result records the live producing tier and engine. Optional page-local runtimes
can be activated and used immediately without rewriting the session or implying
that a browser performed a native action.

## Compliance posture

Airship can supply controls and evidence; architecture alone is not SOC 2,
ISO 27001, GDPR, HIPAA, FedRAMP, or FIPS certification.

Required production work includes data maps, controller/processor roles,
retention and erasure behavior, regional routing, incident response, vendor
agreements, accessibility testing, secure development evidence, cryptographic
module decisions, audit-log policy, and independent assessments. Immutable or
decentralized storage must support crypto-erasure and retention policy before
regulated personal data is enabled.

## Explicit non-goals for the browser-only tier

- arbitrary access to the host filesystem, processes, SSH agent, or terminal;
- guaranteed execution after the tab or PWA is suspended;
- protection from a compromised browser, extension, device OS, or same-origin
  supply-chain compromise;
- claiming remote TEE identity without client-verified attestation;
- putting raw memory, prompts, filenames, or credentials on a public ledger.
- running an Airship-owned proxy, API, session server, auth server, payment
  server, or plaintext database.

## Milestone acceptance

Milestone 0 is complete when a clean checkout can build, tests can run the
agent through a tool call and crash-safe session append, the web UI can repeat
that flow with the deterministic provider, encrypted storage envelopes reject
tampering, and the Chutes compatibility adapter can be exercised with an
explicit `encrypted-unattested` posture.
