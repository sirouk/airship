# Airship roadmap

## M0: executable architecture

- framework-independent evented agent loop;
- demo provider and virtual workspace tools;
- IndexedDB and memory stores;
- encrypted object envelope with tamper tests;
- browser SigV4 S3 reference adapter, encrypted journal ordering, and provider
  conformance harness;
- Cognito Identity enhanced-flow credential provider with coalesced in-memory
  OIDC/session-token refresh and account-reset invalidation;
- Chutes E2EE v1 compatibility with accurate posture;
- mutually exclusive already-issued `cak_` OAuth-token and `cpk_` API-key
  connection paths, direct provider model discovery, model/session pinning, and
  honest capability separation;
- installable responsive shell and secure edge headers;
- granular proof badges and portable receipt schema;
- bounded direct Chutes endpoint-evidence acquisition with invocation-time
  instance/key correlation, redacted render state, a dedicated assertion-aware
  Attestations ledger, and fixed-vocabulary unsigned status export;
- direct Chutes account-standing telemetry with fixed-bucket subscription
  runway, month-to-date actual charges, and live quota/rate-limit headers;
- immutable profile/theme/skill resolution and a lazy bounded in-browser memory
  relationship graph;
- bounded page-memory session search/inspect/audited-resume/clean-fork library
  and a full local protocol/receipt auditor in Proof;
- fail-closed responsive approval dock with a bounded redacted queue and
  session/turn/operation identity;
- browser Git/source-control contracts plus a concrete page-memory
  status/diff/stage/commit/branch/worktree reference adapter with remote
  operations explicitly unavailable;
- automatic text/code discovery plus a coalesced, cancellable, generation-pinned
  on-device hybrid context engine using deterministic bootstrap embeddings;
- encrypted segmented objects, local expert routing, selected-page streaming,
  byte/latency budgets, and retrieval commitments;
- immutable Walrus blob transport with one-time grant seam, strict range
  validation, and multi-aggregator failover;
- deterministic fail-closed static release gate with source-map, credential,
  artifact-policy, and bundle-budget enforcement plus an unsigned hash
  inventory;
- architecture, protocol, threat-model, and lineage records.

## M1: private single-device beta

- module worker for runtime/crypto;
- crash/reload and quota fault-injection suite;
- actual OpenAI-compatible tool-call streaming;
- durable local memory extraction and semantic search with provenance;
- WebGPU embedding adapter, WASM SIMD fallback, encrypted index generations,
  Matryoshka/quantized vectors, and segmented expert search for large
  workspaces;
- durable worker-backed browser Git adapter for OPFS/File System Access, hostile
  repository hardening, optional CORS-safe remotes, and encrypted cloud
  checkpointing;
- encrypted durable session retention plus rename, retry/undo-as-branch,
  archive/delete, import/export, and user-visible task lifecycle;
- File System Access opt-in import/export;
- passkey/OS-backed device enrollment design review;
- accessibility and low-end Android performance budgets in CI.

## M2: multi-device encrypted sync

- workspace key enrollment/recovery/rotation;
- transactional outbox and immutable encrypted object DAG;
- writer leases with fencing and offline forks;
- live AWS/R2 browser-origin conformance reports and failure injection;
- Walrus Quilt batching, individually retrievable encrypted patches, expiry
  scheduler, and signed vault-root prototype;
- device revocation, crypto-erasure, export, and deletion workflows;
- production identity-pool deployment using short-lived scoped credentials and
  browser CORS conformance tests;
- production AWS S3 baseline with browser SigV4, Cognito/OIDC temporary
  credentials, conditional CAS, and live conformance report;
- Shelby adapter after browser authorization and vault-head CAS are available;
- encrypted manifest repair and disaster-recovery drills.

## M3: attested confidential inference

- browser-readable Chutes evidence/policy CORS plus a least-privilege OAuth/API
  scope for private evidence;
- Chutes-supplied signed evidence and challenge endpoint;
- verifier for supported enclave technology, certificate roots, measurements,
  TCB status, model digest, and expiry;
- E2EE v2 AAD, authenticated ordered streaming, terminal transcript digest;
- evidence/policy cache and fail-closed downgrade protection;
- enclave-signed conversation receipts binding request, response, model,
  runtime, and completion, if/when the provider exposes that protocol;
- independent cryptographic and enclave review.

Endpoint attestation is available through Chutes evidence endpoints. A stronger
third-party-verifiable conversation receipt depends on a TEE signing protocol
Chutes must expose; a client cannot manufacture that proof.

## M4: provider and execution ecosystem

- [x] capability-truthful execution broker, bounded JavaScript Worker, and
  compact WASI Preview 1 command runner;
- [x] explicitly installed locked Pyodide 314.0.2 runtime with a fresh bounded
  browser Worker per job, standard-library execution, and truthful readiness;
- atomic multi-file Python workspace adoption (the current bounded mount uses
  exact per-file CAS), plus optional WASIX and Node/WebContainer pack maturity;
- Shelby adapter after consistency/auth/deletion conformance validation;
- production Walrus mode after Mainnet, sponsorship, vault-root, recovery, and
  lifecycle gates in `WALRUS_STORAGE.md` pass;
- MCP Streamable HTTP bridge with browser-safe auth;
- Tauri native companion for PTY, selected host files, OS keychain, and jobs;
- isolated remote execution adapter with capability receipts;
- skills/plugins packaged outside the stable core tool snapshot.

## M5: production and compliance programs

- service-adapter SLO/error budgets and large-scale fault/load evidence;
- signed releases, dependency/SBOM/provenance and reproducible WASM build;
- privacy impact assessment, retention/residency controls, DSR workflows;
- SOC 2 / ISO 27001 control evidence as chosen by the operator;
- regulated profiles only after cryptographic module and vendor assessments;
- staged rollout, kill switches, protocol deprecation, and recovery exercises.

## Go/no-go gates

- No `encrypted-attested` label without client-side evidence verification.
- No storage provider becomes canonical before it passes conformance/failure
  tests and documents deletion and consistency.
- No funded publisher credential or wallet secret is distributed to an
  untrusted client; sponsored writes require one-time parameter-bound grants.
- No arbitrary shell promise in the web tier.
- No new core tool without broad utility and a stable prompt-cost review.
- No irreversible personal data written to a public ledger.
