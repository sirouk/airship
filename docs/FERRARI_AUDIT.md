# Airship “Ferrari” audit

Status: code-evidence audit, 2026-07-18, with a verified implementation delta
through 2026-07-19. This is a launch gate, not a vision document.

## Verified implementation delta

The executive verdict and scorecard below preserve the original audit baseline.
These previously identified gaps are now closed in executable code and browser
tests:

- a successful Vault probe now migrates and replaces the live workspace,
  journal, session library, tool registry, and Git adapter; the local lab
  auto-adopts MinIO and retains an explicit Ephemeral toggle;
- encrypted Git state uses content-addressed objects and a CAS-fenced head,
  survives reload, preserves stage/index/worktrees, and rejects an offline
  checkpoint when its exact cloud base changed;
- the agent tool and Sources UI share one transactional public-GitHub snapshot
  importer, with rollback on Git-admission failure and immediate visibility in
  both Workspace and Sources;
- direct Chutes vision invocation and browser-readable endpoint evidence pass a
  live Chromium smoke test; the compact Intel checker remains honestly partial
  because it does not yet implement the complete Intel QVL collateral policy;
- the client context engine is injected into real turns and refreshes after
  workspace mutation; the semantic Worker seam remains an optional pack;
- JavaScript Worker and compact WASI Preview 1 execution are real browser tools;
  Python/WASIX/Node runtimes remain optional packs rather than phantom claims;
- desktop/mobile route, density, stable-message-action, styled-menu, vault,
  worker, Git import, and live Chutes paths have actual Playwright coverage.

The launch blockers that remain are still material: the Rust recovery kernel is
not yet the web turn-loop waist; complete CPU/GPU/model/conversation/payment
verification is absent; generic authenticated Git remotes need direct CORS or a
separately authorized host/native adapter; production tenant S3 credentials and
multi-device key recovery are not deployed; and the bundled retrieval tier is
not yet a production semantic model.

## Executive verdict

Airship is a credible executable architecture, not yet a private edge-agent product. The repository already contains unusually good primitives: a small Preact shell, a deterministic Rust state machine, a bounded Chutes E2EE transport, direct model discovery, granular receipt types, an independent session auditor, a fail-closed approval dock, encrypted immutable journal segments, a real SigV4 S3 adapter, temporary Cognito credentials, content-addressed profiles, a live-workspace context engine, a page-memory Git state machine, and an expert-page retrieval prototype. Those pieces justify continuing the architecture.

The shipped UI now composes more of those primitives: mutually exclusive Chutes connection modes, direct model selection, the session library and full auditor, the approval dock, automatic client context refresh, the local Sources workbench, the Vault coordinator/setup/probe surface, and a dedicated Attestations ledger are live paths. It still constructs a `MemoryWorkspace` and `MemoryJournalBackend` on page load and begins with `DemoInferenceTransport` (`src/ui/app.tsx`). Sessions, workspace files, profiles, the memory graph, the context index, and Git state are therefore lost on reload. The Vault can prove an independently configured object store and construct encrypted journal/workspace adapters, but the agent has not adopted them as its canonical live runtime. The browser still executes the TypeScript `runTurn` loop rather than the stronger Rust kernel. Chutes evidence acquisition remains deliberately `evidence-only`: there is no independent DCAP/NVIDIA/model/transcript verifier or pre-invocation attestation gate.

Do not market the present build as “full TEE,” “absolutely attestable,” “cloud-synced,” “offline,” “durable/remote Git,” “production semantic retrieval,” “compliant,” or “CLI-equivalent.” The honest description is: **a strong browser-native foundation with working page-memory agent, session, approval, context, and local Git demonstrations plus tested service adapters that are not yet composed into a recoverable product path.**

The principal architectural decision is sound: keep the static client and use independently operated services for inference, object storage, identity, and payment. “No Airship backend” must not become “trust browser redirects as payment proof,” “ship shared storage credentials,” or “pretend a suspended tab is a daemon.” Where a service does not expose browser-safe scoped authorization, verifiable receipts, CORS, and the necessary consistency primitive, the feature is unavailable until that service does.

## Audit method and reference disposition

The audit treated executed code as evidence and prose as a claim. This follows the strongest practice in ArcLink’s `CANON.md`: prove both sides of a seam, preserve disagreement, and never turn a green-sounding name into proof.

Reviewed inputs:

- Airship TypeScript, Rust crates, tests, PWA assets, security headers, and design documents.
- `~/hermes-agent`, especially the agent/session lifecycle, compression lineage, approval isolation, desktop session surfaces, and behavior tests.
- `e2ee-test`, the Chutes E2EE compatibility origin. It correctly states that WASM is not a secrecy boundary and that browser plaintext remains inside the trusted browser boundary (`e2ee-test/SECURITY.md:9-24`).
- `~/arclink/CANON.md` and the relevant reconciled billing, memory, workspace, diagnostics, test, CI, and provenance pieces. ArcLink is useful for evidence discipline and failure semantics, not as an architecture to copy: its control plane is intentionally backendful.
- `~/claw-code`, including its Rust runtime subtree. Its own `PARITY.md` calls the Rust surface partial and missing orchestration layers (`claw-code/PARITY.md:38-47,157-166`), so it is an implementation reference, not a security authority.
- A separate local `~/claude-code-rs` checkout was not present. The available Rust origin/reference was the `claw-code/rust` subtree; this absence is recorded rather than silently substituted.

## Current capability scorecard

| Capability | Evidence-backed state | Release meaning |
| --- | --- | --- |
| Static client / no Airship request server | Implemented | Sound foundation |
| Local agent demonstration | Implemented | Demo only; page-memory state |
| Deterministic crash-recoverable kernel | Implemented in Rust, not wired to web host | Production path blocked |
| Chutes encrypted transport | Implemented and bounded | Compatibility mode is unattested |
| Chutes connection/model control | Exclusive already-issued `cak_`/`cpk_` paths, direct catalog, optional enrichment, immutable model/session pinning | OAuth exchange is not browser-safe; first protected invocation proves permission, not TEE |
| Endpoint/model/conversation attestation | Live bounded endpoint evidence client, exact invocation-time instance/key correlation, dedicated ledger, and typed verifier ports; production verifiers absent | Evidence/key matches remain partial; CPU, GPU, model, conversation, and payment proof remain unavailable until verified |
| Session integrity | Hash-chained events plus the independent auditor wired into Proof and resume | Full local consistency is testable; authorship is not yet anchored |
| S3 data plane | Real SigV4/CAS/range/list adapter, temporary-credential provider, mounted Vault probe, and successful disposable loopback MinIO contract run | Production tenant IAM/CORS and browser-origin behavior remain unproved; live agent adoption remains blocked |
| Encrypted cloud journal | Implemented and composed by the Vault coordinator after a successful probe | Setup/probe UI is mounted; agent/session/workspace runtime is still page-memory-backed |
| Workspace | In-memory UTF-8 virtual files | No reload/cloud durability |
| Sessions/tasks | Page-memory list/search/filter/sort, bounded transcript, exact-pin audited resume, and immutable clean fork | No reload durability, task queue, archive/delete/import/export, or ancestor transcript branch |
| Tool approvals | Bounded fail-closed dock with redaction, identity, timeout, abort, and duplicate denial | Decision is not a durable, atomically consumed canonical argument-digest grant |
| Git/worktrees | Page-memory Ephemeral state plus CAS-versioned, content-addressed encrypted workspace checkpoints for vault mode; status/diff/stage/unstage/commit/branch/worktree state machine | No OPFS adapter, general remote transport, merge, or hostile pack/object import |
| Client indexing | Automatic live-workspace refresh, hash embeddings, flat hybrid search, cancellation, generation and query lineage | Deterministic bootstrap only; main-thread/page-memory, not production semantic retrieval |
| Context Fabric | Encrypted segmented expert routing prototype | Not wired to workspace/session |
| Mobile | Responsive shell/navigation plus narrow layouts for implemented Sessions, Sources, Context, Proof, and approvals | Parity, accessibility, and low-end-device budgets are not gated |
| Offline | Static shell cache | No offline state or work |
| Accessibility | Some semantic labels/focus/reduced motion | Not WCAG-gated; severe small-text/touch risks |
| Production supply chain/compliance | Threat model, lockfile, disabled source maps, and deterministic unsigned artifact gate | No signed release/SBOM/deployed-header/rollback evidence |

## Ruthless priority order

### P0 — trust or data-loss blockers

| ID | Owner | Failure if shipped | Required artifact | Hard acceptance gate |
| --- | --- | --- | --- | --- |
| P0-01 | Runtime | Browser runs the weaker TypeScript loop while the replay-safe Rust kernel is dormant. A reload after `tool.approved` can leave an unknown side effect and no reconciliation. | One canonical kernel ABI in a module worker; TypeScript becomes effect host only. | Golden traces for success, denial, provider failure, cancellation, crash before/after every persist/effect boundary, and replay all produce the same projection in Rust native and browser WASM. No external effect is issued before its intent is durable. Unknown outcomes are never retried automatically. |
| P0-02 | State/sync | A reload loses the current session and workspace; “synced” would be false. | Encrypted cloud journal/workspace composition, strict-mode key lifecycle, transactional outbox, writer lease/fencing, and recovery UI. | Kill/reload fault injection at every append/upload/CAS boundary yields zero acknowledged event loss. Online sync RPO is under 5 seconds p95. Two tabs cannot both commit under one fencing epoch. Offline divergence creates a visible branch, never last-writer overwrite. |
| P0-03 | Tool safety | The new broker/dock is bounded, redacts display arguments, keys requests by session/turn/operation, and denies on timeout, abort, duplicate, overflow, or page teardown. Reads still auto-allow, and the allow result is not a durable, atomically consumed canonical argument-digest grant. | Immutable argument digest, scoped one-shot/session grants, sensitive-path and destination policy, durable decision events, and atomic executor consumption. | Every effect class has allow/deny/timeout/concurrency/TOCTOU tests. Silence and UI loss deny. Approval UI shows exact target, scope, data leaving device, diff/command, and expiry. No model text can change policy. Cross-session approval confusion and mutated/replayed/expired grant tests pass. |
| P0-04 | Trust | The independent auditor now recomputes chains and protocol/receipt bindings for Proof and before resume, but a local chain and head can still be rewritten together and import/export/cloud advancement are not yet universally gated. Local consistency is not authorship. | Run the audit at every trust boundary plus add a separately trusted signed head/receipt or transparency anchor. | Any byte, order, session ID, manifest, operation lifecycle, request/response binding, or trusted-head mutation quarantines the session read-only. UI uses separate states for chain integrity, completeness, external anchor, endpoint TEE, model, and conversation proof. |
| P0-05 | Inference trust | Current live UI explicitly has no DCAP verifier; endpoint evidence is not a conversation signature. | Reviewed Intel/NVIDIA/model verifier ports, pinned policy, downgrade handling, and provider-issued enclave transcript receipt protocol. | `encrypted-attested` cannot be selected or displayed before a fresh verifier result binds the invoked key/instance/policy. Conversation icon stays unavailable until a signature binds canonical request, ordered response, model artifact, runtime policy, and terminal state. Negative quote/cert/TCB/debug/model/replay/expiry corpus passes. |
| P0-06 | Identity/storage | Static clients cannot safely hold bucket-owner keys or a public sponsored wallet. Temporary credentials exist in code but are not deployed/wired/proved. | Per-user OIDC/Cognito identity mapping to prefix-scoped, expiring S3 credentials; CORS; quotas; revocation; lifecycle policy; live conformance evidence. | A credential cannot read/list/write another tenant prefix, expires in at most one hour, is memory-only, and revokes within the documented window. AWS/R2 candidate passes conditional create/CAS, exact range, pagination, outage, ambiguous commit, deletion, and CORS tests from the production origin. |
| P0-07 | Commerce/access | A browser return URL is not proof of payment, and Stripe webhooks cannot be safely received by a static page. | Provider-owned entitlement or signed proof-token flow. Airship may launch hosted checkout but consumes only Chutes/service-signed standing and entitlement evidence. | Closing/replaying/tampering with checkout does not unlock access. Currency/product/price/paid state/identity/nonce are verified by the issuing service. Refund, dispute, grace, expiry, and account switch converge without an Airship secret. No Stripe secret or webhook signing secret enters the bundle. |
| P0-08 | Release engineering | Same-origin release compromise defeats every browser privacy control. Source maps are now disabled and the deterministic post-build gate rejects map/credential-shaped payloads, enforces artifact budgets, checks static policy, and emits an explicitly unsigned SHA-256 inventory. It does not provide signed provenance, an SBOM, deployed-header evidence, or a rollback drill. | Reproducible build record, signed artifacts, SBOM, dependency policy, CSP report strategy, incident rollback/kill switch, and independent review. | Clean-room rebuild matches declared hashes; all JS/WASM/assets are tied to a signed release manifest; no production source map exposes source unless explicitly access-controlled; critical dependency/advisory scan is clean; previous safe release can be restored within 15 minutes. |

### P1 — required before “full-featured private beta”

| ID | Required outcome | Measurable acceptance |
| --- | --- | --- |
| P1-01 Sessions | Promote the implemented page-memory list/search/inspect/audited-resume/clean-fork foundation to encrypted durable state; add rename, retry/undo-as-branch, archive/delete, export/import, and full ancestor lineage. | Reload resumes the last committed session. Listing/search over 10,000 session headers is under 100 ms p95 after warm index. Retry/undo never rewrites an existing event chain. Parent/root/head/depth survive export/import. |
| P1-02 Tasks | Durable user-visible task queue with dependencies, checkpoints, cancellation, approval waits, and capability placement. | Every task has one terminal or explicit recoverable state. Reload during each state preserves it. Browser suspension is shown as paused, never “running.” Native/remote handoff records capability and receipt. |
| P1-03 Git/worktrees | Promote the implemented page-memory local state machine to a durable browser object database and worker-backed checkout/index manifests; add merge/conflict, CORS-safe fetch/push, credential lifecycle, and encrypted checkpoints. | Malicious-repo corpus covers traversal, `.git` confusion, symlink/submodule escape, pack/object bombs, duplicate paths, ref injection, and credential leakage. A 250k-file status scan is incremental and cancellable; changed-file status p95 under 500 ms on reference desktop. No Git credential persists in plaintext. |
| P1-04 Indexing | Promote the implemented coalesced/cancellable live-workspace engine to workers; add ignore/secret policy, real pinned semantic embeddings, persisted encrypted generations, and incremental invalidation. | Unchanged workspace performs zero embedding calls. 100k-chunk hybrid search is under 100 ms p95 desktop. Main thread has no indexing task over 50 ms. Indexed plaintext/vectors follow source deletion and encryption policy. Secret fixtures never reach a remote embedder without explicit approval. |
| P1-05 Context Fabric | Wire active directory/repository/worktree/branch/profile/task routing to bounded encrypted range reads and prompt assembly. | Default query reads at most 4 experts/8 MiB/1.5 s (`src/retrieval/context-driver.ts:17`) and records generation, byte ranges, digests, budget, and incomplete status. Corrupt/missing/rolled-back pages fail visibly and never become silent context. |
| P1-06 Mobile parity | All product actions have touch-first views, including approval, proof, sessions, workspace, Sources, conflict resolution, and recovery. | WCAG 2.2 AA; 44×44 CSS-pixel targets; 320 CSS-pixel width without hidden required actions; VoiceOver and TalkBack smoke scripts; low-end Android cached interactive p75 under 1.5 s. Unsupported native capabilities are labeled, not hidden behind dead controls. |
| P1-07 Diagnostics | Local, redacted structured activity ledger and exportable support bundle with consent. | Every network/effect/sync operation has correlation ID, duration, bounded error code, retry/commit state, and posture. Prompts, file contents, bearer tokens, object keys, and sensitive paths are absent by default. Redaction regression corpus and 10k-event export budget pass. |
| P1-08 Accessibility/performance CI | Automated accessibility, keyboard, contrast, visual, bundle, heap, and long-task budgets. | Zero critical/serious automated findings plus manual screen-reader/keyboard sign-off. Runtime JS+workers at most 224 KiB compressed with a separately capped 110 KiB entry; crypto WASM under 350 KiB; 2,000-event warm open under 150 ms p95; local append under 25 ms p95; INP p75 under 200 ms. |

### P2 — enterprise and billion-device operations

- Device enrollment, recovery kit, rotation, revocation, crypto-erasure, legal hold/retention policy, and disaster-recovery drills.
- Region/residency policy, controller/processor data map, DSR/export/delete workflows, vendor assessments, and chosen SOC 2/ISO/FIPS evidence. Architecture is not certification.
- Adapter SLOs, quota and abuse budgets, staged rollout cohorts, protocol-version deprecation, kill switches, and capacity evidence. “One billion devices” means partitioned protocols and delegated service scale, not one shared bucket, wallet, or manifest.
- Native companion and remote confidential executor only as explicit capability tiers. Browser baseline never promises PTY, arbitrary host files, background daemon behavior, or shell equivalence.
- Organization policy packs: allowed models/measurements/storage regions/tool grants, signed profile catalogs, administrator evidence export, and separation of personal versus managed workspaces.

## Detailed product and security findings

### 1. Trust, provenance, and the receipt icons

What is strong:

- Session creation pins system prompt, provider/model, sorted tool definitions, workspace, capability tier, and optional profile resolution (`src/core/contracts.ts:34-63`, `src/core/agent.ts:44-65`). This preserves the prompt-cache invariant.
- Each TypeScript event includes sequence, previous digest, and canonical SHA-256 digest (`src/core/journal.ts:13-30,99-131`). Encrypted object-journal reads independently recompute event digests and validate segment commitments (`src/storage/encrypted-object-journal.ts:268-323`).
- Receipt vocabulary separates encryption, freshness, CPU/GPU TEE, endpoint key, model, conversation, and payment (`src/receipts/types.ts:15-67`). The UI exposes each claim and says endpoint and conversation proof differ (`src/ui/app.tsx:1300-1354`).
- Default verifier ports fail to unavailable, not verified (`src/attestation/verifiers.ts:23-40,95-132`). Required transport mode fails closed when no valid endpoint receipt exists (`src/inference/chutes/transport.ts:657-697`).
- The mounted evidence client now acquires exact-instance Chutes records with a fresh 32-byte challenge, enforces response/cache byte bounds and account partitioning, compares the quote's documented nonce/key construction locally, and correlates a message only when both the invocation-time instance and endpoint-key digest match. Raw quote, GPU, certificate, key, nonce, URL-query, and report-data material stays out of React state; conversation receipts remain assertion-only.
- The dedicated Attestations ledger keeps endpoint acquisitions separate from conversation receipts and renders transport, freshness, CPU TEE, GPU TEE, endpoint key, runtime/model, conversation, and settlement as independent claim states. Its default export is fixed-vocabulary and unsigned; it omits free-form prose, identity metadata, raw provider artifacts, and dictionary-testable plaintext commitments.

What blocks trust:

- The ordinary memory and IndexedDB backends enforce head CAS and link shape while appending but do not recompute every event digest when reading. IndexedDB also does not validate every intra-batch link before writing (`src/core/indexeddb-journal.ts:78-120`). Imported or corrupted histories therefore require an independent verifier.
- A chain whose events and head live under the same mutable authority has no authorship or anti-rollback guarantee. A separately signed commitment, trusted monotonic device record, or provider receipt must anchor it.
- `createLocalReceipt` binds request/response digests but contains no release/build identity and explicitly has no external signer (`src/receipts/types.ts:87-123`). It is useful evidence, not absolute proof.
- The endpoint quote/key binding can prove where ciphertext is decryptable. It cannot prove a particular model produced a particular transcript. Airship’s own threat model states the missing provider protocol precisely (`docs/THREAT_MODEL.md:99-108`).
- Production DCAP signature/collateral/TCB/debug-state verification, NVIDIA verification, model-artifact binding, and an enclave-signed terminal transcript are still absent. A local byte match or provider policy-feed match is never upgraded to a verified hardware/model/conversation claim.
- A 2026-07-18 server-side diagnostic retrieved 14 public instance evidence records with eight GPU evidence objects each, but the observed evidence and policy `GET` responses lacked browser-readable `Access-Control-Allow-Origin`. The reviewed source also classified private evidence requests as `evidence:read`; the configured `chutes:invoke` grant could discover endpoints yet receive 403 on evidence. This workspace now contains a least-privilege `chutes:invoke` route-classification fix plus an explicit non-credentialed wildcard ACAO ingress contract and 25 focused regressions. Those changes are not production evidence until deployed and browser-probed. The observed failures are provider integration blockers, not evidence of TEE failure, and Airship installs no proxy.

Decision: use at least four independent icons/states in the conversation row:

1. **Journal integrity** — new local audit passed.
2. **Completion** — no unresolved/unknown operation.
3. **Endpoint** — fresh external attestation passed for the invoked key.
4. **Conversation/model** — enclave signature and model binding passed.

An anchor match is not a signature verification by itself. Color is never the only signal, and a later downgrade must update the relevant icon without rewriting the historical receipt.

### 2. Agent loop and recovery

The TypeScript loop has good first principles: it checks provider/tool pins, persists `turn.requested`, persists `inference.started`, persists complete tool calls before review, persists approval before execution, and records terminal turn events (`src/core/agent.ts:69-91,93-131,160-237,248-281`).

It is not the production loop:

- Every step rereads and rematerializes the full event history (`src/core/agent.ts:102-105`), producing O(steps × history) work and no context/token budget or provenance-preserving compaction.
- Stream text is transient UI state until one `assistant.completed`; there is no durable delta/checkpoint. A long response is lost on tab death.
- On crash after approval or network dispatch, the TypeScript path has no replay projection that reconciles the operation. The outer catch writes a turn terminal when possible but deliberately swallows a failed terminal append (`src/core/agent.ts:273-281`).
- Raw provider/tool error messages can become durable event content (`src/core/agent.ts:222-228,350-352`). Error taxonomy/redaction is not centralized.
- Tool calls execute sequentially. That is safe as a baseline, but safe parallel reads need an explicit deterministic merge policy rather than ad hoc concurrency.

The Rust kernel is the better waist. It has replay/recover APIs (`crates/airship-runtime/src/kernel.rs:155-194`), persist effects distinct from inference/tool effects (`crates/airship-runtime/src/schema.rs:324-409`), strict replay violations, deterministic operation IDs, and tests for recovery, cancellation, reordered tools, manifest drift, and persistence failures (`crates/airship-runtime/tests/kernel.rs:396-713`). No TypeScript source imports it. The next milestone is wiring and protocol convergence, not adding a second collection of agent features to `runTurn`.

Hermes supplies the product behaviors to preserve while simplifying the implementation: stable session identity, resume after restart, bounded context compression with lineage, explicit approval waits, and broad behavior-contract coverage. Do not copy Hermes’s Python/Node/local-shell attack surface or its giant orchestration files into the browser.

### 3. Tool safety and approvals

Current registry strengths are unique validated names, immutable cloned definitions, abort checks, and a 1 MiB output ceiling (`src/tools/registry.ts:10-57`). Workspace paths are normalized and writes support optimistic revision checks (`src/workspace/memory.ts:26-59`).

`ApprovalBroker` and `ApprovalDock` materially improve the shipped interaction: non-read effects enter a bounded concurrent queue keyed by session, turn, and operation; display arguments are recursively bounded/redacted; duplicate, overflow, timeout, abort, and page-teardown paths deny. The broker retains no raw argument object after constructing the display copy (`src/approvals/broker.ts`). That is a useful fail-closed review surface, not yet an execution capability:

- all `read` effects auto-allow, although a read result is inserted into the next remote inference request;
- the dock can show the bounded arguments and Git descriptors supplied to it, but there is no canonical digest proving that those are exactly the arguments later executed;
- no allow-once/session/always scope, revocation, deny reason, or policy provenance is durable;
- review and execution are not bound by a consumed capability artifact;
- effect class alone cannot distinguish `read /workspace/README.md` from a credential file or `network` to an approved API from arbitrary exfiltration.

Hermes shows why concurrency identity and fail-closed routing matter. It uses context-local session/turn/tool identifiers (`hermes-agent/tools/approval.py:37-63`), an unconditional safety floor (`:334-503`), redacted observers (`:123-160`), scoped/permanent approvals (`:2017-2259`), and timeout/absence denial (`:2274-2406,2676-2735`). Its ACP bridge validates returned option IDs and auto-denies on timeout/failure (`hermes-agent/acp_adapter/permissions.py:76-107,110-173`). Airship should take those invariants but implement structured capability grants over typed arguments, not a growing regular-expression shell firewall.

Required grant identity:

```text
grant = H(version, session, turn, operation, tool revision,
          canonical arguments, effect, resource scope, destination,
          issued-at, expiry, one-shot nonce, policy revision)
```

The executor atomically consumes that grant. Any mismatch, mutation, reuse, expiry, lost approval surface, or unknown choice denies and emits a bounded durable reason.

### 4. Sessions, tasks, and CLI-equivalent UX

The application now uses `SessionLibrary` over the active journal. Its UI lists, searches, filters, and sorts bounded session metadata; inspects a stable snapshot; materializes a bounded user/assistant transcript; allows resume only when provider/model/posture/tool/workspace/profile pins match and the full independent audit verifies; opens Proof for any listed session; and creates a clean immutable fork with a source-head lineage commitment (`src/sessions/`, `src/ui/sessions-view.tsx`, `src/ui/app.tsx`). Profile and model changes continue to create new pinned sessions rather than rewriting history.

This is still a page-memory session control surface. Reload loses the journal, and the clean fork does not copy or resolve the ancestor transcript. There is no durable task queue, rename, retry/undo-as-branch, archive/delete, import/export verification, or cross-reload recovery.

Hermes is the useful product reference here:

- its gateway lifecycle persists metadata/transcripts, resumes after crash, and distinguishes hard suspension from recoverable resume (`hermes-agent/docs/session-lifecycle.md:56-96,144-180`);
- its desktop contains session search, export, branch tree, switcher, watchdog, and rewind behaviors;
- compression continuations preserve root/current/parent/depth provenance and have real database tests (`hermes-agent/tests/acp/test_session_provenance.py:16-101`).

Airship should express those behaviors as immutable branch heads over encrypted objects. “Retry,” “undo,” compression, profile change, tool-set change, and model change all create a new head with parent/source-range provenance; none rewrites a receipt-bearing chain. Task state must be visible separately from chat text. A browser task that needs the tab alive is `paused` when suspended. Only native or remote capability tiers may claim detached execution.

### 5. Sources, Git, and worktrees

The Sources view now drives `BrowserGitClient` and a concrete `MemoryGitAdapter` (`src/git/`, `src/ui/sources-view.tsx`). The reference path implements bounded status, staged and working diffs, stage/unstage, local commits, create/switch branch, and create/remove worktree. It uses optimistic worktree/repository generations, one in-page writer per scope, cancellation before the adapter commit point, strict portable path/ref/remote validation, and approval descriptors that say whether data leaves the device.

This proves local control-plane semantics only. Git state is page-memory and reload-volatile. Clone/fetch/push fail closed because no remote transport is installed; there is no hidden proxy. Merge/rebase/conflict resolution, arbitrary repository/pack import, durable OPFS storage, multi-tab fencing, credential lifecycle, signing, LFS/submodules, and encrypted cloud checkpoints remain absent.

Implementation constraints:

- Git objects are immutable encrypted cloud objects; checkout/index/worktree heads are small CAS-updated manifests.
- Multiple worktrees share object content but have independent checkout/index/approval scopes.
- Remote fetch/push is direct only when the provider exposes CORS-safe HTTPS and scoped credentials. No hidden Airship Git proxy.
- Stage and commit are human-visible, argument-bound write effects. Push is a separate network/identity effect and never implied by commit.
- Repository input is hostile. Enforce path/ref/object/count/pack limits before materialization; reject traversal, device names, case-fold collisions, symlink/submodule escape, ambiguous Unicode, and decompression bombs. Secrets and `.gitignore` policy are resolved before indexing.
- Mobile gets the same status/diff/stage/commit/conflict model with touch-oriented presentation, not a truncated desktop tree.

### 6. Client-side vectorization and Context Fabric

The live Context view now runs `ClientContextEngine` against the active virtual workspace. It normalizes and snapshots candidates, coalesces equivalent refreshes, cancels superseded refresh/search work, verifies the exact workspace snapshot before and after search, pins results to one generation, and emits content/chunk/revision/generation/query lineage. The underlying indexer discovers a useful set of text/code extensions, skips files over 8 MiB, hashes revisions, chunks deterministically, and avoids unchanged revisions in page memory (`src/indexing/`).

The embedding remains a signed feature hash, not a semantic model. `FlatClientIndex` scans every chunk and sorts all scores. Refresh still reads and embeds changed files on the calling thread, retains generations only in memory, and has no production ignore/secret/symlink/archive policy. Context results are inspectable in their own view but are not yet injected into canonical prompt assembly.

The Context Fabric prototype is the right large-workspace shape: a small routing mirror gates expert pages by directory/profile/branch/worktree/source, fetches selected encrypted blocks in parallel, enforces fanout/byte/deadline limits, and emits a retrieval commitment (`src/retrieval/context-driver.ts:17-125,165-199,243-315`). It is not connected to the live workspace or prompt assembly, and expert blocks encode full floating-point vectors and text as JSON, capped at 16 MiB (`src/retrieval/codec.ts:21-45`).

Production sequence:

1. Worker discovers changes from workspace/Git manifests and applies ignore/secret/data-classification rules.
2. Extractor workers produce canonical documents under MIME, recursion, byte, time, and memory limits.
3. Pinned WebGPU embedding model runs locally; WASM SIMD/quantized fallback handles unsupported devices. Hash embeddings remain a deterministic test baseline only.
4. Matryoshka/quantized vectors and lexical sketches form scoped expert pages. Persist encrypted immutable generations; update only the small routing head with CAS.
5. Query routing happens locally. Fetch only selected encrypted ranges; decrypt, score/fuse, and return provenance-bearing context.
6. Prompt assembly records source chunk/revision/generation and never silently crosses the active repository/worktree/profile/task scope.

This is the requested “MoE of vector results” model without loading a global vector database into every phone. S3 is the durable encrypted backbone; the client retains only a bounded working mirror and selected pages.

### 7. Mobile and capability truth

The shell has responsive breakpoints, hides the desktop sidebar below 640 px, and supplies a scrollable mobile navigation (`src/ui/styles.css:3016-3245`). Reduced motion and reduced transparency are handled (`src/ui/styles.css:3612-3629`). This is good shell work.

The implemented Sessions, Sources, Context, Proof, connection, and approval surfaces now have responsive/narrow layouts, so they are no longer merely placeholder navigation. Full parity is still not demonstrated. Mobile-specific risks include PWA suspension, smaller memory ceilings, thermal throttling during embeddings, unreliable background sync, virtual-keyboard viewport changes, download/import affordances, and approval loss during app switching. The UI must persist an encrypted intent before invoking a chooser or leaving the page and must treat return without a correlated result as unknown/denied.

Capability truth is non-negotiable:

- web baseline: virtual workspace, browser Git, HTTP tools, encrypted sync;
- web enhanced: OPFS, Web Locks, WebGPU/WASM SIMD where detected;
- native: selected files, PTY/process, keychain, background jobs;
- remote confidential: isolated remote execution with its own receipt.

Desktop and mobile share session data and policy, not identical physical layout. Unsupported actions remain visible with an explanation and handoff path.

### 8. Offline, local retention, and S3 sync

The service worker caches only the same-origin shell/assets and skips authorization/range requests (`public/sw.js:1-46`). That is privacy-conscious, but “offline” currently means only that the shell can open. The app’s state is in memory. `IndexedDbJournalBackend` exists but would store plaintext events if wired directly.

The user requirement—device retains almost nothing while S3 is authoritative—is feasible with two explicit modes:

- **Strict mode (default for private cloud use):** auth cookie/service session plus non-sensitive preferences; decrypted workspace, credentials, and keys remain in memory. A turn is not acknowledged until its encrypted journal segment and head CAS are durable in cloud storage. Reload without network cannot resume work.
- **Encrypted offline mode (opt-in):** IndexedDB/OPFS stores only ciphertext, opaque IDs, sync cursors, and wrapped/non-extractable key material. An encrypted outbox may acknowledge locally before cloud sync. Plaintext, bearer/S3 credentials, and raw workspace keys never enter localStorage/Cache Storage.

The product must not combine strict-mode language with offline-mode promises. Both modes need quota-eviction, device lock/logout, account switch, key loss, and browser “clear site data” tests.

The S3 implementation is materially real: it signs SigV4, requires expiring production credentials, supports conditional create/CAS, exact ranges, bounded paginated listing, and ambiguous commit state (`src/storage/s3-object-store.ts:66-92,100-258,310-360,427-444`). The Cognito provider caches only temporary credentials in memory and invalidates refresh on reset (`src/storage/cognito-identity-credentials.ts:33-50,80-137`). The mounted Vault coordinator now composes these with encrypted journal and workspace adapters only after the store contract passes. A disposable scoped-user MinIO run on 2026-07-18 passed all 16 checks, including duplicate/concurrent conditional create, exact ranges, special-key injectivity, prefix listing, CAS success/conflict/ambiguity, encrypted journal, encrypted workspace, and disclosure checks. That is useful loopback protocol evidence, not a production deployment claim: browser-origin CORS, tenant isolation, temporary Cognito credentials, revocation, lifecycle/deletion, outage behavior, and cross-device synchronization still require the real provider report and IAM review.

Walrus/Shelby can remain optional immutable sidecars or future primary candidates. A public funded wallet shared by all browsers is prohibited: extraction enables unlimited sponsored abuse. Sponsorship requires a service-issued, one-time, parameter-bound grant and per-user/global budgets. S3 remains the baseline until another provider passes the same authorization, CAS/vault-head, range, deletion, recovery, and outage contracts.

### 9. Observability and independent-professional evidence

The UI exposes runtime status, event count, receipt details, and live Chutes account telemetry. The Context Fabric can emit read commitments. That is a useful start.

Missing operational evidence:

- no local activity ledger for sync attempts, writer leases, operation retries, approval wait time, storage CAS conflicts, cache generation, retrieval selection, or recovery decisions;
- no redacted support bundle or user-selectable disclosure package;
- no release/build identity in ordinary local receipts;
- no SLO/error-budget aggregation that works without transmitting plaintext;
- generic `DirectObjectStore` includes up to 500 characters of remote response body in thrown errors and parses list JSON without a response-size/page bound (`src/storage/direct-object-store.ts:169-181,199-201`). Raw remote detail must not flow into durable session events or support logs.

Adopt a typed error envelope: service, operation, request/correlation ID, bounded code, retryable, commit state (`not-committed`, `committed`, `unknown`), posture, start/end monotonic time, and redacted public detail. Raw provider bodies stay ephemeral behind explicit developer disclosure. Diagnostics are local-first and opt-in; absence of telemetry is supported, not an error.

### 10. Accessibility and performance

Positive evidence includes semantic navigation labels, `aria-live` status, explicit button labels, focus-visible styles, responsive layouts, and reduced-motion rules (`src/ui/app.tsx:579-605,644-689`, `src/ui/styles.css:89-94,3621-3629`).

Release blockers:

- dozens of labels use 7–10 px text, below practical mobile/low-vision readability;
- several controls have 27–40 px minimum heights, below the 44 px mobile target;
- no forced-colors/high-contrast rules were found;
- no automated accessibility, keyboard-flow, screen-reader, contrast, zoom/reflow, or touch-target tests;
- the custom concurrent approval dock is fail-closed and responsive but has not passed keyboard, screen-reader, focus-return, zoom/reflow, or interrupted-flow acceptance testing;
- `src/ui/app.tsx` and `src/ui/styles.css` are large monoliths, increasing ownership conflict, initial parse cost, and regression surface;
- production source maps are disabled and rejected by the post-build gate; the
  generated hash inventory remains unsigned and is not supply-chain provenance;
- session materialization and flat vector search are main-thread/full-scan paths.

Enforce WCAG 2.2 AA as a release requirement, not a late audit. Test 200% and 400% zoom, 320 px reflow, keyboard-only, VoiceOver, NVDA, TalkBack, reduced motion, high contrast, slow CPU, low memory, offline/reconnect, and interrupted approval flows.

### 11. Threat-model deltas

Airship’s written threat model is unusually candid (`docs/THREAT_MODEL.md:5-63,99-114`). The following implementation-specific cases must become executable tests:

| Threat | Present exposure | Required negative evidence |
| --- | --- | --- |
| Same-origin/supply-chain compromise | Browser bundle owns all plaintext; no signed release gate | Reproducible signed release, CSP regression, dependency/SBOM review, rollback drill |
| Storage rollback/fork | Hash head stored beside mutable data; no trusted monotonic anchor | Restore stale/forked heads across two devices and surface branch/rollback; verify external commitment |
| Cross-tab writer race | No Web Lock/lease/fencing in app path | Two-tab deterministic race, lease expiry, stolen lease, offline branch tests |
| Tool prompt injection | Read auto-allow; no taint/destination policy | Poisoned repo/email/web fixtures cannot disclose secrets or mutate without exact approval |
| Approval confused deputy | Broker identity is session/turn/operation-bound, but allow is not a durable canonical argument-digest grant consumed by the executor | Concurrent session/turn/tool UI tests; mutated/replayed/expired grant denies |
| Ambiguous side effects | TS recovery not wired | Crash after dispatch/before result marks outcome unknown and reconciles before any retry |
| Malicious repository | Page-memory local engine validates paths/refs/limits; arbitrary object/pack import and its hostile corpus are absent | Pack/path/ref/symlink/submodule/LFS/bomb fuzz corpus and strict budgets |
| Index poisoning/exfiltration | No ignore/secret/classification policy | Secret and prompt-injection corpus; provenance and deletion propagation |
| Quota/cost exhaustion | Up to eight agent steps; no workspace indexing budget UI | Per-turn/tool/index/storage budgets, rate/cost forecast, circuit breaker, cancellation |
| Attestation downgrade | Compatibility mode allowed by explicit consent | Required mode never falls back; key/instance/model/policy changes require re-verification |
| Receipt replay/misbinding | Full local auditor gates Proof/resume; no universal import/export gate or independently trusted anchor | Cross-session/turn/model/provider replay corpus and signature freshness/counter checks |
| Local eviction/device loss | Memory only now; future encrypted cache/key graph absent | IndexedDB eviction, key loss, revocation, recovery, logout/account-switch tests |
| Service-worker stale release | Cache-first immutable assets | Version migration, broken deploy, rollback, mixed-version worker/client tests |
| Error/log secret leakage | Raw tool/provider messages can persist | Central redaction and canary-secret corpus across UI, journal, diagnostics, export |
| Payment spoof/replay | Static client cannot receive trusted webhook | Signed entitlement nonce/identity/amount/state and refund/expiry replay tests |

## Independent hardening delivered in this audit

Implemented:

- [`src/core/session-audit.ts`](../src/core/session-audit.ts)
- [`src/core/session-audit.test.ts`](../src/core/session-audit.test.ts)

`auditSessionHistory()` accepts a session record plus its event history and returns a frozen, machine-readable report. It independently checks:

- bounded runtime-safe schema and JSON input;
- event ID uniqueness, session isolation, contiguous sequence, previous-digest links, canonical SHA-256 event digests, timestamps, and session-head agreement;
- system-prompt, tool-manifest, profile skill-set, and creation-snapshot bindings;
- one active turn, ordered inference steps, globally unique operation/tool-call IDs, approval-before-result, exact assistant-declared tool requests, terminal tool outcomes, and turn terminals;
- canonical request digest reconstructed from the transcript prefix;
- response digest and receipt session/turn/provider/model/request/response bindings;
- incomplete crash prefixes and outcome-unknown operations separately from corruption;
- an optional separately supplied trusted head.

The API deliberately returns `authenticity: "not-proven"` even when the local chain and supplied head match. The caller must verify the signature/trust of that external head separately. This prevents a green hash icon from being mislabeled as attestation.

Integration API:

```ts
import { auditSessionHistory } from "./core/session-audit";

const session = await journal.getSession(sessionId);
if (!session) throw new Error("Unknown session");
const events = await journal.readEvents(sessionId);

const report = await auditSessionHistory(
  { session, events },
  trustedCommitment
    ? {
        trustedHead: {
          sequence: trustedCommitment.sequence,
          digest: trustedCommitment.digest,
          source: trustedCommitment.verifier,
        },
      }
    : {},
);
```

Integration rules:

- Run before session import, resume, export, proof display, context materialization, or cloud-head advancement.
- `status === "invalid"`: quarantine read-only; do not infer, execute, or sync a new head.
- `status === "incomplete"`: show amber recovery state; reconcile the active operation; never replay a write/network/identity/execute effect automatically.
- `checks.chain`: journal-integrity icon only.
- `anchor.status`: external-head comparison only; signature verification remains outside this module.
- `checks.receiptBindings`: local receipt binding only; it does not verify DCAP, model artifacts, enclave transcript signatures, or payment signatures.

Focused verification currently covers a fully bound final turn, a two-step approved tool turn, payload tampering, intact crash prefix, unapproved tool result, mismatched trusted head, and profile skill-set binding.

## Rollout gates

These gates are sequential. A later feature does not waive an earlier truth/safety gate.

### G0 — claim discipline

- UI and documentation distinguish implemented, connected, verified, unavailable, and planned.
- No green proof/sync/payment icon is driven by configuration, naming, suffix, redirect, or fetch success alone.
- Every status has an evidence source and negative test.

### G1 — deterministic single-device runtime

- Rust/WASM kernel is the only turn state machine.
- Session auditor is wired on every load/import/export.
- Persist-before-effect and crash-prefix recovery matrix passes.
- Approval broker is argument/session/operation bound and fail-closed.
- 2,000-event warm open and append budgets pass on reference desktop and mid-tier phone.

### G2 — private S3-backed alpha

- Strict mode has no plaintext persistent state and acknowledges only cloud-durable encrypted events.
- Optional offline mode stores ciphertext/wrapped keys only and survives quota/reload faults.
- Production-origin S3/Cognito IAM/CORS/conformance report passes.
- Writer fencing, CAS conflicts, ambiguous commit, deletion, logout, and account-switch tests pass.

### G3 — functional private beta

- Session/task UX, browser Git/worktrees, production indexing, Context Fabric prompt integration, and mobile parity meet P1 criteria.
- Local diagnostics/support export and accessibility/performance CI are blocking checks.
- No feature depends on a hidden Airship server or a long-lived shared credential.

### G4 — attested beta

- Independent reviewed endpoint verifier is live and fail-closed.
- Model and conversation icons remain unavailable until the provider supplies and Airship verifies those distinct proofs.
- Evidence policy pinning, freshness, downgrade, revocation, and negative corpora pass.

### G5 — paid production

- Service-signed entitlement/standing flow passes spoof/replay/refund/expiry tests.
- Signed reproducible release, SBOM, incident rollback, vendor reviews, privacy/retention/export/delete controls, SLOs, and staged rollout are operational.
- Independent penetration test covers client, service adapters, storage IAM/CORS, OAuth/payment flows, WASM boundary, malicious repos, prompt injection, sync conflicts, and receipt verification.

### G6 — managed enterprise / scale claim

- Multi-device key graph and recovery drills pass.
- Regional, organizational policy, audit export, and chosen compliance evidence exist.
- Load/fault results demonstrate partition behavior and provider quotas at declared cohort sizes. Marketing states the tested scale; it does not jump from protocol shape to “one billion active devices.”

## Verification snapshot

The latest recorded deterministic gate run after the evidence, Vault, session,
audit, approval, context, Git, and route-splitting work passed:

- `npm run check`: TypeScript, static security-policy alignment, 36 Vitest
  files / 227 passing tests plus 1 explicit live-lab skip, the production Vite
  build, and the deterministic release gate.
- `npm audit --audit-level=high`: 0 known vulnerabilities from the live npm
  advisory service.
- `cargo test --manifest-path crates/airship-runtime/Cargo.toml`: all 11 Rust
  tests across three suites; `crates/chutes-e2ee-wasm`: all 10 Rust tests across
  two suites.
- Chutes API request-auth/IDP/ingress contract regression: 25 passing tests;
  Ruff clean for the changed middleware, integration, and test files.
- Production output: entry JavaScript 347.03 KiB raw / 103.58 KiB gzip; all
  JavaScript and workers 643.73 KiB raw / 186.47 KiB gzip; entry CSS 95.85 KiB
  raw / 16.04 KiB gzip; Chutes crypto WASM 262.02 KiB raw / 114.02 KiB gzip;
  24 hashed release artifacts. Context, Account, provider evidence, and the
  Attestations ledger are deferred chunks rather than startup cost.
- The disposable scoped-user MinIO harness passed all 16 object-store,
  encrypted-journal, encrypted-workspace, and disclosure checks. Its browser
  CORS and cross-device synchronization fields remain explicitly unevaluated.

These results prove a clean local build and current unit/contract behavior plus
one loopback S3 implementation. They do not prove production S3 IAM/CORS,
Cognito deployment, live-runtime vault adoption, multi-device recovery,
attestation roots/DCAP/NVIDIA/model/transcript verification, deployed Chutes
CORS/scope behavior, durable or remote Git, hostile-repository safety,
production semantic embeddings, accessibility conformance, payment standing,
or real-world scale.

## Final decision

Proceed with Airship, but treat composition and evidence as the product now. Do not add a wide plugin ecosystem, decorative dashboards, or more placeholder surfaces until G1 and G2 are real. The shortest credible path is:

1. wire the Rust kernel, extend the already-wired auditor to every trust boundary, and make approval grants canonical-digest-bound, durable, and atomically consumed;
2. adopt the proven Vault runtime as the agent's canonical strict encrypted S3 state with temporary per-user credentials, migration, and recovery semantics;
3. promote the session library to durable encrypted state and add the task lifecycle;
4. promote page-memory Git and context indexing to durable, worker-backed adapters against that same encrypted object model;
5. connect Context Fabric to canonical prompt assembly;
6. deploy and browser-probe the Chutes scope/CORS fixes, then require reviewed DCAP/NVIDIA/model verifiers in a pre-invocation gate before any endpoint icon can become verified;
7. gate paid production on signed service standing, release provenance, accessibility, and independent security evidence.

That sequence produces the “materially brilliant” experience the concept calls for: not because the interface looks powerful, but because every action survives interruption, every capability is scoped, every proof icon says exactly what was proved, and the device can reconstruct its workspace from encrypted service state without an Airship middleman.
