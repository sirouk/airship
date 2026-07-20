# Airship

Airship is a local-first, browser-native agent runtime for private, stateful
work on almost any device. The browser owns the turn loop, encrypted state,
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

The full product contract is in [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md). Start
with [ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[THREAT_MODEL.md](docs/THREAT_MODEL.md) before changing a trust boundary.
The turn-level proof format is specified in
[ATTESTATION_RECEIPTS.md](docs/ATTESTATION_RECEIPTS.md).
The segmented retrieval design is in
[CONTEXT_FABRIC.md](docs/CONTEXT_FABRIC.md), and the Walrus/WalruS3 decision is
in [WALRUS_STORAGE.md](docs/WALRUS_STORAGE.md).
The provider-account boundary and exact meaning of balance, burst, quota, and
usage telemetry are in [ACCOUNT_TELEMETRY.md](docs/ACCOUNT_TELEMETRY.md).

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
- an Ephemeral page-memory workspace plus a live-adopted client-encrypted S3
  workspace/journal mode; the local lab auto-connects its loopback MinIO vault
  and Preferences can switch safely between the two modes;
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
- a dedicated lazy-loaded Attestations ledger with claim-scoped status icons,
  endpoint evidence kept separate from assertion-only conversation receipts,
  historical freshness handling, verifier/measurement inspection, and an
  unsigned privacy-safe status-summary export that omits raw evidence and
  plaintext commitments;
- inspectable receipt/attestation badges and privacy-safe, unsigned status
  summaries on every assistant turn; a deferred pure-Rust `dcap-qvl` WASM pack
  performs complete Intel collateral, CRL, QE Identity, validity-window,
  signature, debug, and TCB evaluation locally, while the compact WebCrypto
  checker remains an honest partial fallback;
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
- a browser Git state machine and Sources surface for status, dual-plane diff,
  stage/unstage, commit, branch switching, and worktree management; Vault mode
  persists content-addressed objects and a CAS-fenced encrypted checkpoint;
  public GitHub snapshots import atomically into both Workspace and Sources,
  while general clone/fetch/push stays unavailable without direct CORS or a
  separately installed host/native adapter;
- an automatic client context engine over the live virtual workspace with
  coalesced refresh, cancellation, generation-pinned hybrid retrieval, and
  exact digest/revision/chunk/query lineage; its hash embeddings are a
  deterministic bootstrap, not a semantic model;
- real disposable JavaScript Worker execution and a compact WASI Preview 1
  command runner with args/env/stdout/stderr; an explicit install action probes
  locked Pyodide 314.0.2 and promotes real disposable-worker Python to ready,
  including bounded workspace snapshots and revision-checked text writeback;
  the optional Node/WebContainer pack runs direct Node/npm project commands in
  an isolated browser filesystem when its StackBlitz provider boot succeeds,
  while Wasmer/WASIX remains explicitly unavailable in this release;
- immutable profile revisions, semantic whole-interface themes, globally or
  per-profile resolved skills, and a lazy WebGL relationship graph derived from
  real page-memory lineage;
- a direct Chutes Account view for effective balance, actual charged usage,
  subscription-cycle and fixed four-hour runway, quota records, and live
  invocation telemetry, with `cak_` and `cpk_` capabilities kept distinct.
- a mounted Vault coordinator and setup workbench that validates direct S3,
  encrypted-journal, encrypted-workspace, and CAS contracts, then replaces the
  active runtime only after migration succeeds; fresh pages load the existing
  encrypted Git head, while stale Ephemeral writers remain fenced.

Walrus Quilts, general remote-interoperable browser Git, a shipped semantic
embedding model, multi-device key ceremony/recovery, native shells, complete
Intel/NVIDIA verification, and enclave-signed conversation receipts are
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
npm run lab:test
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

Airship does not persist API keys. Chutes credentials stay in browser memory
for the active page lifetime.

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

## Design and trust records

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
