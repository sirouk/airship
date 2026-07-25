# Airship

Airship is a local-first, browser-native agent runtime for private, stateful
work on capability-compatible browsers and devices. The browser owns the turn loop, encrypted state,
workspace, permissions, receipts, and tool orchestration. It is a static PWA:
there is no Airship application backend. Inference, storage, identity,
payments, and optional heavy tools are direct service adapters behind narrow
interfaces.

This repository is the first executable milestone. It is intentionally honest
about the browser boundary:

- a browser can provide a fast agent loop, a virtual workspace, encrypted
  persistence, streaming inference, and installable PWA UX;
- a browser cannot provide arbitrary host shell/filesystem access, reliable
  background execution after the OS suspends it, or a hardware TEE for its own
  plaintext;
- encrypted Chutes transport is not called attested confidential inference
  until the client verifies a signed instance key and approved enclave
  measurement.

The canonical one-document project overview is [CANON.md](docs/CANON.md). The
detailed product contract is in [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md). Start
technical work with [ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[THREAT_MODEL.md](docs/THREAT_MODEL.md) before changing a trust boundary.
The turn-level proof format is specified in
[ATTESTATION_RECEIPTS.md](docs/ATTESTATION_RECEIPTS.md).
The segmented retrieval design is in
[CONTEXT_FABRIC.md](docs/CONTEXT_FABRIC.md), and the Walrus/WalruS3 decision is
in [WALRUS_STORAGE.md](docs/WALRUS_STORAGE.md).
The provider-account boundary and exact meaning of balance, burst, quota, and
usage telemetry are in [ACCOUNT_TELEMETRY.md](docs/ACCOUNT_TELEMETRY.md).
The explicit browser-to-paired-executor design is in
[COMPUTE_CONTINUUM.md](docs/COMPUTE_CONTINUUM.md); workspace recovery wrappers,
passkey PRF, device enrollment, and the safe boundary for any future Bitwarden
adapter are in
[KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md](docs/KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md).

## Current milestone

- installable responsive web shell;
- framework-independent TypeScript agent runtime;
- append-only sessions with a byte-stable prompt/tool snapshot;
- a bounded browser-native session library with search, filter, sort, exact-pin
  resume, immutable clean forks, and full digest/protocol auditing before
  resume;
- capability-gated workspace tools;
- a fail-closed approval dock with a bounded concurrent queue, recursively
  redacted arguments, timeout/abort denial, and session/turn/operation identity;
- an ephemeral page-memory workspace plus a real encrypted offline device Vault
  (OPFS first, IndexedDB fallback), client-encrypted Google Drive, and
  S3-compatible workspace/journal modes; Google Drive is the
  ordinary-user default, while the loopback MinIO lab is an explicit advanced
  provider selection; deterministic Drive boundary acceptance is green, while
  real-account production acceptance remains a release gate;
- client-side encrypted object envelopes and a storage-provider seam;
- independently authenticated encrypted segments with exact range reads;
- a cloud-authoritative encrypted journal backend that commits immutable event
  segments before atomically advancing one encrypted session head;
- a dependency-free browser S3 adapter with SigV4, temporary-token enforcement,
  namespace confinement, exact ranges, conditional create/CAS, bounded retries,
  and a destructive-in-the-small live conformance harness;
- a dependency-free Cognito Identity enhanced-flow credential provider for
  OIDC-authenticated, per-user AWS session credentials with no custom broker;
- an S3 Context Fabric prototype that routes locally, streams only selected
  expert pages, and emits byte-level retrieval commitments;
- an immutable Walrus browser transport with constrained upload grants and
  multi-aggregator range-read failover;
- Chutes E2EE v1 compatibility transport using an opaque Rust/WASM response
  context;
- mutually exclusive, in-memory-only Chutes connection paths for already-issued
  `cak_` OAuth user tokens and `cpk_` inference keys, with their identity,
  billing, and invocation capabilities kept visibly distinct;
- direct provider model discovery, optional live management enrichment, and
  active model selection that creates a new profile revision and pinned session
  rather than rewriting prior history;
- simultaneous, page-lifetime inference connections for Chutes, OpenAI,
  Anthropic, xAI, Ollama, and LM Studio; every conversation pins the provider
  revision, exact credential generation, model, authentication kind, and
  transport boundary, while the agent receives only a bounded,
  credential-free live availability directory;
- fixed-origin browser transports for OpenAI Responses, Anthropic Messages,
  and xAI Responses plus exact-loopback Ollama and LM Studio discovery and
  streaming; cloud API keys are an explicit advanced compatibility path and
  are never presented as consumer-account OAuth;
- Authorization Code + S256 PKCE Chutes sign-in with direct exchange for public
  browser/native clients; the loopback lab can instead use its same-origin,
  development-only confidential-client bridge without exposing the secret to
  browser JavaScript;
- explicit security posture states: local, encrypted/unattested, and
  encrypted/attested;
- a browser-direct Chutes evidence engine with exact receipt-instance E2E key
  discovery, fresh nonces, strict bounded quote/GPU/certificate parsing,
  published-measurement comparison, account-partitioned byte-bounded caches,
  cancellation, and conservative `evidence-only` records; current live
  evidence and measurement endpoints are directly browser-readable, while any
  future CORS/scope/network failure remains visibly fail-closed;
- a unified, lazy-loaded Proof ledger with claim-scoped status icons,
  endpoint evidence kept separate from assertion-only conversation receipts,
  historical freshness handling, verifier/measurement inspection, and an
  unsigned privacy-safe status-summary export that omits raw evidence and
  plaintext commitments;
- inspectable receipt/attestation badges and privacy-safe, unsigned status
  summaries on every assistant turn; a deferred pure-Rust `dcap-qvl` WASM pack
  can perform Intel collateral, CRL, QE Identity, validity-window, signature,
  debug, and TCB evaluation locally when the pack and collateral are available,
  while the compact WebCrypto checker remains an honest partial fallback;
- an independently recomputed session audit in the Proof view that distinguishes
  local consistency, completeness, and receipt binding from unproved
  authenticity and unavailable external attestation;
- deterministic Rust recovery kernel plus a functional demo provider so the
  complete agent/tool/workspace loop works without credentials;
- a responsive original interface for sessions, proof claims, profiles,
  context candidates, and account posture, plus a route-lazy Workspace
  workbench with a virtualized ARIA file tree, multi-file tabs, dirty-draft
  protection, revision-fenced editing, desktop drag/drop and context menus,
  mobile move sheets, and a bounded Source Control rail;
- a standards-compatible browser Git adapter over the same Workspace used by
  Editor, Source Control, the terminal Git bridge, and agent tools: real
  `.git` objects, refs, `HEAD`, config, and binary index back status, diff,
  stage/unstage, commit, branch creation, and branch switching; Vault mode
  migrates those exact files through the encrypted Workspace adapter; public
  GitHub snapshots become genuine local repositories, direct Smart HTTP clone
  and fetch remain conditional on remote browser CORS, and direct Smart HTTP
  push is available for anonymous-capable remotes or an integration-supplied,
  page-memory-only credential broker; browser CORS/remote policy still apply,
  ambiguous push outcomes require fetch-before-retry; conventional linked
  worktrees use real `.git` pointers and `.git/worktrees` administration
  records with independent `HEAD` and binary index state over shared objects
  and refs;
- an automatic client context engine over the live virtual workspace with
  coalesced refresh, cancellation, generation-pinned hybrid retrieval, and
  exact digest/revision/chunk/query lineage; its hash embeddings are a
  deterministic bootstrap, not a semantic model;
- an opt-in pinned local semantic embedding pack with WebGPU/WASM backend
  reporting and an isolated live browser gate; download, activation, and
  production-hosted generation acceptance remain conditional;
- real disposable JavaScript Worker execution and a compact WASI Preview 1
  command runner with args/env/stdout/stderr; an explicit install action probes
  locked Pyodide 314.0.2 and promotes real disposable-worker Python to ready,
  including bounded workspace snapshots and revision-checked text writeback;
  the optional Node/WebContainer pack runs direct Node/npm project commands in
  an isolated browser filesystem when its StackBlitz provider boot succeeds,
  while Wasmer/WASIX remains explicitly unavailable in this release;
- a fail-closed compute-continuum foundation that chooses browser-first
  placement, blocks every remote promotion until a private evidence/channel/
  approval broker exists, and structurally validates bounded, binary-safe,
  digest-linked remote process records without claiming peer authorship; no
  remote executor is registered or advertised yet;
- immutable profile revisions, semantic whole-interface themes, globally or
  per-profile resolved skills, and a lazy WebGL relationship graph derived from
  real page-memory lineage;
- a direct Chutes Account view for effective balance, actual charged usage,
  subscription-cycle and fixed four-hour runway, quota records, and live
  invocation telemetry, with `cak_` and `cpk_` capabilities kept distinct.
- a mounted Vault coordinator and setup workbench that validates direct S3,
  encrypted-journal, encrypted-workspace, and CAS contracts, then replaces the
  active runtime only after migration succeeds; fresh pages reopen and verify
  the repository registry and conventional `.git` state, while stale
  Ephemeral writers remain fenced.

Walrus Quilts, universal remote-interoperable browser Git, production-hosted and
persisted semantic generations, multi-device key ceremony/recovery, native shells, complete
NVIDIA verification, and enclave-signed conversation receipts are
adapters or later milestones, not assumptions baked into the runtime. WalruS3
is explicitly experimental until it can satisfy Airship's auth, range,
metadata-recovery, and conditional-write contracts.

## Develop

Requires Node.js 22 or newer. Rebuilding the cryptographic WASM module also
requires stable Rust and `wasm-pack`.

```bash
npm install
npm run dev
npm run check
npm run build
```

For a reproducible browser + disposable S3 environment, use:

```bash
npm run lab:start
npm run lab:status
# Open http://localhost:4173
npm run lab:test
# If a readiness or test step fails:
npm run lab:logs
# When finished; permanently removes the disposable lab bucket volume:
npm run lab:stop
```

See [Local full-system lab](docs/LOCAL_FULL_SYSTEM_LAB.md) for the exact Vault
fields, feature walkthrough, trust boundaries, and teardown behavior.

The destructive-in-the-small loopback S3 harness is opt-in and skipped by the
ordinary test suite. Supply its six `AIRSHIP_LOCAL_S3_*` variables from the
calling environment, then run `npm run test:vault:live`; see
[Strict browser vault composition](docs/VAULT_COMPOSITION.md#opt-in-live-loopback-harness).

Every production build ends at the deterministic, fail-closed release gate.
It rejects source maps and credential-shaped payloads, enforces raw and gzip
budgets, validates the static-service boundary, and writes an explicitly
unsigned SHA-256 inventory to `dist/release-manifest.json`. See
[RELEASE_GATE.md](docs/RELEASE_GATE.md) for the exact contract and limits.

Airship does not persist inference credentials. Chutes tokens and API keys for
other cloud providers stay in browser memory for the active page lifetime;
Ollama and LM Studio use exact loopback service connections without a remote
account.

The checked-in local OAuth registration uses `http://localhost:4173` with the
exact callback `http://localhost:4173/auth/chutes/callback`; the Vite loopback
bridge performs its confidential token exchange without exposing the secret to
browser JavaScript. A static production build never reuses that registration.
It enables sign-in only when the build supplies both:

- `VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID`, registered at Chutes as
  Browser/native PKCE with token-endpoint authentication `none`; and
- `VITE_AIRSHIP_PUBLIC_ORIGIN`, an exact HTTPS origin. The registered callback
  is `<origin><base-path>auth/chutes/callback`; the repository Pages workflow
  builds with `/airship/` as its base path.

If either value is missing or malformed, the production sign-in control fails
closed while the deliberate page-memory API-key path remains available.

Google Drive is the default durable Vault provider. A production or real local
Drive run must also supply `VITE_GOOGLE_CLIENT_ID` for a Google OAuth Web
application whose exact Airship origin is an Authorized JavaScript origin and
whose project has the Drive API and `drive.file` consent configured. This is a
public identifier, not a client secret. Recovery imports open an existing
app-created hierarchy or fail closed; only a newly generated key may create one.

## Design and trust records

- [Canonical project overview](docs/CANON.md)
- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Protocols](docs/PROTOCOLS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Attestation receipts](docs/ATTESTATION_RECEIPTS.md)
- [Context Fabric](docs/CONTEXT_FABRIC.md)
- [Session library](docs/SESSION_LIBRARY.md)
- [Browser-native Git](docs/BROWSER_GIT.md)
- [Browser-native coding execution](docs/BROWSER_EXECUTION_PACKS.md)
- [Chutes model discovery](docs/MODEL_DISCOVERY.md)
- [Authoritative storage conformance](docs/STORAGE_CONFORMANCE.md)
- [Encrypted local-device Vault](docs/LOCAL_DEVICE_VAULT.md)
- [AWS S3 browser reference](docs/AWS_S3_REFERENCE.md)
- [Strict browser vault composition](docs/VAULT_COMPOSITION.md)
- [Shelby integration brief](docs/SHELBY_INTEGRATION.md)
- [Walrus storage decision](docs/WALRUS_STORAGE.md)
- [Access and commerce](docs/ACCESS_AND_COMMERCE.md)
- [Chutes account telemetry](docs/ACCOUNT_TELEMETRY.md)
- [Static release gate](docs/RELEASE_GATE.md)
- [Local full-system lab](docs/LOCAL_FULL_SYSTEM_LAB.md)
- [Adversarial system review](docs/ADVERSARIAL_SYSTEM_REVIEW.md)
- [Design language](docs/DESIGN_LANGUAGE.md)
- [Roadmap](docs/ROADMAP.md)
- [Lineage](docs/LINEAGE.md)

## Design lineage

Airship takes behavioral inspiration from Hermes Agent (stable prompt prefixes,
append-only turns, a narrow core, tools at the edge) and implementation ideas
from `sirouk/claw-code` and `sirouk/claude-code-rs`. It is a clean browser-first
design, not a source fork. See [LINEAGE.md](docs/LINEAGE.md) for the provenance
and licensing record.
