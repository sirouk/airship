# Airship master-prompt acceptance ledger

**Acceptance posture:** not yet fully accepted. Airship has a real browser-owned
runtime, Git repository, retrieval loop, encrypted Vault fabric, and tested
responsive shell. The master prompt also asks for capabilities that the current
product deliberately rejects or has not yet proven: a browser Rust toolchain,
generally available Bash, a live production Google Drive acceptance run, and
the future Chutes CPU enclave. Conventional linked Git worktrees are now
implemented and tested.

This ledger is subordinate to [CANON.md](./CANON.md). It records what the code
can prove now; it does not turn roadmap language, a provider assertion, or a
test fixture into a product claim.

## Status vocabulary

- **Implemented** — a production code path exists and deterministic acceptance
  evidence exercises the real primitive.
- **Conditional** — the code path is real, but operation depends on an explicit
  opt-in, browser facility, downloaded runtime pack, CORS policy, account, or
  external provider. The UI must describe that dependency.
- **Unavailable** — there is no production path, or the product intentionally
  rejects the operation. It must not be advertised as available.

## 1. Runtime authority and capability truth

| Requirement | Status | Evidence and boundary |
|---|---|---|
| The browser is the authoritative runtime; there is no hidden Airship application backend | **Implemented** | The operating contract is encoded in [operating-charter.ts](../src/core/operating-charter.ts) and verified by [operating-charter.test.ts](../src/core/operating-charter.test.ts). The release is a static PWA and the artifact gate rejects bundled secrets/source maps in [release-gate.mjs](../scripts/release-gate.mjs) and [release-gate.test.mjs](../scripts/release-gate.test.mjs). External inference, identity, and object storage remain explicit services. |
| The model receives exact session-pinned tool schemas and browser capability observations and does not invent unavailable tools | **Implemented** | [operating-charter.ts](../src/core/operating-charter.ts), [agent.ts](../src/core/agent.ts), and [execution-tools.contract.test.ts](../src/tools/execution-tools.contract.test.ts) bind the prompt to registered tools and session-time browser observations. Installable execution-pack readiness remains a dynamic query through [runtime-registry.ts](../src/execution/runtime-registry.ts); it is not overstated as an immutable live-availability claim. |
| Deterministic slash commands work without inference | **Implemented** | Command routing and local execution are covered by [commands.test.ts](../src/commands/commands.test.ts); browser acceptance exercises `/ls` in [master-browser-acceptance.spec.ts](../e2e/master-browser-acceptance.spec.ts). |
| One unified Rust/WASM browser kernel owns codecs, crypto, verification, and execution | **Unavailable** | The active host, workspace/context codecs, and Vault envelopes are TypeScript/WebCrypto. Chutes E2EE and Intel DCAP QVL are genuine narrow Rust/WASM modules, while `crates/airship-runtime` remains a tested reference/recovery crate rather than a browser dependency. [ARCHITECTURE.md](./ARCHITECTURE.md) records the exact boundary. |
| “No mocks or placeholders remain in the critical path” | **Conditional** | Production paths do not silently fall back to mocks. Deterministic browser tests do substitute explicit Google/HTTP boundaries, and real Google, semantic-model, WASIX, WebContainer, and Chutes behavior require separate live gates. OpenAI, Anthropic, and xAI are named explicitly here because their transports have never executed against a real endpoint: [browser-cloud.live.test.ts](../src/inference/providers/browser-cloud.live.test.ts) is the env-gated Node wire gate and is unexecuted, a cross-origin browser gate for those three does not exist, and the dated manual probes in [PROVIDER_FABRIC.md](./PROVIDER_FABRIC.md) are the weaker evidence those gates would supersede. Therefore the stronger claim is not accepted until those provider gates pass in the release environment. |

## 2. Real Git and one workspace

| Requirement | Status | Evidence and boundary |
|---|---|---|
| Editor and Terminal share one browser-owned Git worktree, index, refs, and object database | **Implemented** | [workspace-adapter.ts](../src/git/workspace-adapter.ts) uses `isomorphic-git` over the authoritative workspace filesystem. [workspace-adapter.test.ts](../src/git/workspace-adapter.test.ts) verifies real `.git/HEAD`, `DIRC` index bytes, refs, objects, status, diff, stage, commit, branch, and repository/worktree versions. [terminal-commands.test.ts](../src/git/terminal-commands.test.ts) proves terminal Git mutations appear through the same client. |
| Imported snapshots create real local Git state and survive encrypted Vault reload | **Implemented** | [github-import.spec.ts](../e2e/github-import.spec.ts) imports a public snapshot, stages/commits it, reloads from live MinIO, and verifies the head. [encrypted-workspace-adapter.test.ts](../src/git/encrypted-workspace-adapter.test.ts) preserves opaque `.git` bytes. Snapshot import is honest about not manufacturing upstream history. |
| Status, diff, stage/unstage, commit, branch, and switch are real | **Implemented** | Implemented by [workspace-adapter.ts](../src/git/workspace-adapter.ts) and accepted in [workspace-adapter.test.ts](../src/git/workspace-adapter.test.ts). |
| Smart HTTP clone/fetch | **Conditional** | Real `isomorphic-git` Smart HTTP is wired in [workspace-adapter.ts](../src/git/workspace-adapter.ts); success depends on the remote's browser CORS policy. [workspace-adapter.test.ts](../src/git/workspace-adapter.test.ts) verifies that CORS/provider failure is surfaced rather than replaced with a snapshot claim. |
| Smart HTTP push | **Conditional** | [workspace-adapter.ts](../src/git/workspace-adapter.ts) performs a genuine `isomorphic-git` Smart HTTP push after separate identity/change-remote approval. Anonymous-capable remotes work directly; integrations can inject a page-memory-only credential broker whose values never enter the request descriptor, Git config, Workspace, terminal history, or Vault. Browser CORS and remote policy still decide interoperability. A lost terminal response becomes `push-outcome-unknown` and requires fetch before retry, never a false rollback claim. Unit evidence covers accepted, credentialed, and ambiguous outcomes; no public write target is used by the deterministic release suite. |
| Linked Git worktrees | **Implemented** | [workspace-adapter.ts](../src/git/workspace-adapter.ts) creates a conventional worktree `.git` pointer plus `.git/worktrees/<id>` `HEAD`, binary index, `commondir`, and back-pointer metadata. Its filesystem projection keeps per-worktree state isolated while objects, refs, config, and packed refs resolve to one physical common store. [workspace-adapter.test.ts](../src/git/workspace-adapter.test.ts) covers branch exclusivity, create/edit/stage/commit, shared refs/objects, reload, nested-root exclusion, and clean removal. |
| Checkpointing the workspace, including `.git` | **Implemented** | Encrypted Vault snapshot/checkpoint persistence is byte-preserving. A separate lossy “Git semantic checkpoint export” is intentionally not claimed. |
| Historical `#sources` navigation resolves to the real Editor | **Implemented** | The compatibility alias is resolved in [navigation-model.ts](../src/ui/navigation-model.ts) and exercised by [conversation-navigation.spec.ts](../e2e/conversation-navigation.spec.ts). |

## 3. Execution, shell, and tool composition

| Requirement | Status | Evidence and boundary |
|---|---|---|
| JavaScript worker execution with streamed, bounded output and real cancellation | **Implemented** | [execution-tools.ts](../src/tools/execution-tools.ts) and [browser-worker.spec.ts](../e2e/browser-worker.spec.ts) exercise an actual worker, output streaming, limits, timeout, and cancellation. |
| WASI command execution | **Implemented** | The compact runtime executes real precompiled `wasm32-wasip1` artifacts; [browser-worker.spec.ts](../e2e/browser-worker.spec.ts) exercises a real WASI command. This is not a browser compiler. |
| Python via Pyodide with workspace snapshot and byte-safe CAS writeback | **Conditional** | The real runtime and writeback live in [execution-tools.ts](../src/tools/execution-tools.ts) and are accepted by the opt-in Pyodide case in [browser-worker.spec.ts](../e2e/browser-worker.spec.ts). It depends on installing/loading the pinned pack and compatible browser policy. |
| Node/npm projects through WebContainer | **Conditional** | [master-browser-acceptance.spec.ts](../e2e/master-browser-acceptance.spec.ts) runs a real Node process, writes a file, reconciles it to the workspace, and observes it in Editor/SCM. Availability depends on a supported browser, isolation headers, and the external WebContainer runtime/terms. |
| POSIX shell in the browser | **Implemented, and deliberately not called Bash** | `airship-sh` is a first-party POSIX-sh interpreter in [src/execution/shell/](../src/execution/shell/): real lexer, parser, expansion, arithmetic, globbing, redirection, here-documents, control flow, functions, builtins, and workspace utilities, executing over the one authoritative `WorkspacePort` with streaming output, faithful exit codes, and bounded budgets. 198 tests pass, including a table-driven suite of real `sh` scripts asserted against exact stdout/stderr/status. It is the universal tier: no Worker, no downloaded pack, and no cross-origin isolation, so it runs on Safari and mobile. It is **not GNU Bash** and never claims bash-specific behaviour; [runtime-registry.ts](../src/execution/runtime-registry.ts) reports the shell as `airship-sh`. The separately pinned WASIX/Wasmer Bash candidate remains a **NO-GO** and stays fail-closed at `unavailable`: its live Chromium gate never proved faithful child status, separated output, bidirectional writeback, and cancellation together. |
| Rust source compilation in the browser | **Unavailable** | Airship can execute a precompiled Rust-produced WASI artifact, but it does not ship `rustc` or Cargo. “Rust via a compiled WASM engine” is accepted only as precompiled WASI execution, not as a source toolchain. |
| Programmatic `text_editor` calls from executed code | **Implemented** | The manifest-bound workspace-program bridge in [execution-tools.ts](../src/tools/execution-tools.ts) permits declared file tools only; [browser-worker.spec.ts](../e2e/browser-worker.spec.ts) verifies approval-gated edit composition and completion of started calls. |
| Programmatic Bash calls from executed code | **Unavailable** | The bridge intentionally rejects undeclared shell calls in [execution-tools.contract.test.ts](../src/tools/execution-tools.contract.test.ts). A governed Bash tool and “code that calls Bash” are distinct capabilities; the latter is not present. |
| Lazy heavy packs, bounded snapshots/output, cancellation, and explicit provenance | **Implemented** | The cross-runtime contract is centralized in [runtime-registry.ts](../src/execution/runtime-registry.ts) and [execution-tools.ts](../src/tools/execution-tools.ts), with browser evidence in [browser-worker.spec.ts](../e2e/browser-worker.spec.ts). Conditional packs remain labeled conditional. |
| Terminal context reconstructs after refresh | **Implemented** | [manager.ts](../src/terminal/manager.ts) persists a bounded transcript tail, bounded command history, cwd, name, and thread association through the active encrypted Workspace metadata, then the Terminal route automatically starts a fresh process and renders a prominent reconstruction boundary. [manager.test.ts](../src/terminal/manager.test.ts) verifies bounded v2 persistence and v1 migration. |
| Terminal survives refresh as the same live process | **Unavailable** | Page destruction terminates the WebContainer process. Airship reconstructs visible context and starts a new process; it never calls that process resurrection. Genuine live-process resume requires a separately evidenced machine-state runtime. |

## 4. Context, memory, and compression

| Requirement | Status | Evidence and boundary |
|---|---|---|
| Relevant workspace and profile memory are selected on every retrieval-enabled inference turn | **Implemented** | New session manifests explicitly pin turn context as `required` or `disabled`. For every non-empty `required` turn, [agent.ts](../src/core/agent.ts) requires a provider, verifies and canonicalizes its selection before journaling or inference, and fails closed otherwise. [agent-context.test.ts](../src/core/agent-context.test.ts) proves selection, inference use, non-replay, and audit verification; [agent-preprocessing.test.ts](../src/core/agent-preprocessing.test.ts) covers required, disabled, malformed, and historical-manifest behavior. |
| Retrieval, compression, and summarization failures remain complete durable turns | **Implemented** | The raw `turn.requested` event is committed before preprocessing. [agent-preprocessing.test.ts](../src/core/agent-preprocessing.test.ts) and [agent-compression.test.ts](../src/core/agent-compression.test.ts) prove rejection and cancellation produce exactly one durable terminal event and never reach inference when preprocessing fails. A commit-with-lost-acknowledgement fixture additionally proves terminal read-back reconciliation does not append a contradictory second terminal. |
| Profile and workspace retrieval are federated without accidental scope leakage | **Implemented** | [federated-turn-context.ts](../src/retrieval/federated-turn-context.ts) and [federated-turn-context.test.ts](../src/retrieval/federated-turn-context.test.ts) preserve separate governance and verified lineage. |
| Revision-aware hybrid indexing and full lineage | **Implemented** | [client-context-engine.ts](../src/indexing/client-context-engine.ts) tracks source revision, content digest, extractor, chunker, embedding generation, and scope; [client-context-engine.test.ts](../src/indexing/client-context-engine.test.ts) verifies indexing, hybrid ranking, revision replacement, and binary exclusion. |
| Real semantic embeddings in-browser | **Conditional** | [semantic-browser-provider.ts](../src/indexing/semantic-browser-provider.ts) supplies an optional same-origin worker/model path. [live-semantic-embedding.spec.ts](../e2e/live-semantic-embedding.spec.ts) is the opt-in live gate. Deterministic bootstrap embeddings remain honest fallback retrieval, not a claim of neural equivalence. |
| Iterative context compression at an 80–85% threshold using digest-linked references | **Implemented** | [context-compressor.ts](../src/core/context-compressor.ts), [context-compressor.test.ts](../src/core/context-compressor.test.ts), and [agent-compression.test.ts](../src/core/agent-compression.test.ts) verify the threshold, bounded/fail-closed summary updates, prior-summary references, digest lineage, and audit trail. |
| Universal 60–78% storage reduction | **Conditional** | A deterministic fixture proves a substantial reduction, but no representative cross-workload benchmark establishes a universal percentage. Airship implements reference-based deduplication; the numeric product claim remains unaccepted pending a published benchmark corpus and methodology. |

## 5. Encrypted Vault and streaming ranges

| Requirement | Status | Evidence and boundary |
|---|---|---|
| Provider-neutral encrypted object fabric with generation-fenced reads | **Implemented** | [context-fabric-port.ts](../src/vault/context-fabric-port.ts) publishes encrypted generations and reads exact ranges. [context-fabric-port.test.ts](../src/vault/context-fabric-port.test.ts) verifies exact generations/ranges, malformed or stale fallback, and read-only resolution. |
| Encrypted, offline local-device Vault authority | **Implemented** | [local-device-object-store.ts](../src/storage/local-device-object-store.ts) implements opaque encrypted records over OPFS + cross-tab Web Locks with IndexedDB fallback, exact ranges, single-winner conditional writes, an authenticated wrong-key anchor, schema migration, and bounded atomic backup restore. [local-device-vault.ts](../src/vault/local-device.ts) composes the same workspace/journal/profiles/context-fabric runtime shape used by cloud Vaults. Unit conformance and [local-device-vault.spec.ts](../e2e/local-device-vault.spec.ts) exercise real Chromium OPFS, concurrent openers, reload, and restore. Browser retention remains subject to reported storage policy and user backup. |
| Vault retrieval participates in the exact inference turn with durable lineage | **Implemented** | [vault-aware-context.test.ts](../src/tools/vault-aware-context.test.ts), [agent-vault-context.test.ts](../src/core/agent-vault-context.test.ts), and [agent-vault-context.live.test.ts](../src/core/agent-vault-context.live.test.ts) verify generation fencing, per-turn refresh, local fallback, journal inclusion, and audit. The live test additionally requires a real MinIO `206` response and exact `Content-Range`. |
| Publication is explicit and user-approved | **Implemented** | `resolveExisting` is read-only; installation requires the literal `explicit-user-approved` policy in [context-fabric-port.ts](../src/vault/context-fabric-port.ts). The UI's explicit publish/update action is in [vault-view.tsx](../src/ui/vault-view.tsx). |
| MinIO/S3 advanced provider | **Implemented** | The live lab and `test:vault:live` exercise real S3-compatible storage, encryption, CAS/generation behavior, and HTTP range reads. It remains an external service selected by the user, not an Airship backend. |
| Google Drive is the default, renameable user-visible Vault provider | **Implemented** | Default selection is encoded in [platform-shell.tsx](../src/ui/platform-shell.tsx) and the provider UI in [vault-view.tsx](../src/ui/vault-view.tsx). [google-drive-object-store.ts](../src/storage/google-drive-object-store.ts) implements the shared object-store interface, workspace naming, range reads, CAS, and resumable upload recovery. |
| The Drive default only ships where the build is configured | **Implemented** | `VITE_GOOGLE_CLIENT_ID` is inlined at build time, so an unconfigured build has no Drive connect branch left in the bundle. [pages.yml](../.github/workflows/pages.yml) forwards `vars.VITE_GOOGLE_CLIENT_ID` and sets `VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER` to `google-drive` only when that variable is non-empty, otherwise to `local-device`. [google-drive-auth.ts](../src/storage/google-drive-auth.ts) exports `isDeployableGoogleOAuthClientId`, the same predicate the authorizer enforces at construction. **This repository ships unconfigured** unless a maintainer sets that repository variable, so the published artifact currently defaults to the Local Device vault. Not yet done: a browser that visited an earlier build still has `vaultBackend: "google-drive"` persisted in `airship.display-preferences.v1`, and `loadPreferenceOverrides` in [platform-shell.tsx](../src/ui/platform-shell.tsx) does not yet downgrade it. |
| Runtime reclamation of provider-side probe litter | **Partial** | `ReclaimableObjectStore.trash(keys)` in [object-store.ts](../src/storage/object-store.ts) is an optional capability implemented only by [google-drive-object-store.ts](../src/storage/google-drive-object-store.ts) and forwarded by [caching-object-store.ts](../src/storage/caching-object-store.ts) only when the authority has it. [coordinator.ts](../src/vault/coordinator.ts) sweeps a successful probe's own keys and reports only provider-confirmed removals; unconfirmed keys and non-reclaiming providers keep the original out-of-band warning verbatim. Superseded workspace revisions and untracked lost-race orphans are **not** reclaimed — those need the aged candidate queue and segments-folder enumeration of Drive release gate 3. |
| Live Google Drive account acceptance | **Conditional** | [google-drive-object-store.test.ts](../src/storage/google-drive-object-store.test.ts), [google-drive-auth.test.ts](../src/storage/google-drive-auth.test.ts), and [google-drive-vault.spec.ts](../e2e/google-drive-vault.spec.ts) deterministically prove the contract, memory-only token handling, and a storage-empty second browser recovering the exact hierarchy without creating a replacement at explicit simulated GIS/Drive boundaries. A configured, consented Google account must still prove production ETag/CAS and GIS/FedCM behavior under the deployed headers before “fully functional Google Drive” is accepted for a release. |
| Partial reads and resumable writes | **Implemented** | The Drive adapter coalesces indexed ranges and uses resumable upload for large objects, including unknown-commit recovery; the MinIO gate proves actual HTTP byte ranges. Provider availability remains conditional as described above. |
| OPFS-first acceleration for workspace, Git, and vector/index bytes | **Conditional** | [client-ciphertext-cache.ts](../src/storage/client-ciphertext-cache.ts) probes dedicated-worker `FileSystemSyncAccessHandle`, falls back to async OPFS, IndexedDB, then page memory, and persists only already-enveloped Vault bytes. [caching-object-store.ts](../src/storage/caching-object-store.ts) keeps mutable heads, listing, conditional creation, and every CAS at provider authority. Unit tests cover corruption/ranges/CAS; [opfs-ciphertext-cache.spec.ts](../e2e/opfs-ciphertext-cache.spec.ts) proves real Chromium sync-handle persistence. Other engines/devices remain conditional on their actual APIs and quotas. |
| Streamed remote-Linux/enclave workspace shards | **Unavailable** | The narrow object/range and tool contracts are reusable, but no paired remote enclave transport exists yet. |

## 6. Interface, profiles, and evidence

| Requirement | Status | Evidence and boundary |
|---|---|---|
| Calm desktop/tablet/mobile shell with compact claim indicators and progressive disclosure | **Implemented** | [master-browser-acceptance.spec.ts](../e2e/master-browser-acceptance.spec.ts) covers desktop, iPad Pro 11, and iPhone 14 Pro Max Chromium projects. [responsive-breakpoints.spec.ts](../e2e/responsive-breakpoints.spec.ts) covers 320–1024 px, both density modes, menus, pinned profile rail, and approval picker. [claim-stack-layout.spec.ts](../e2e/claim-stack-layout.spec.ts) verifies contained progressive-disclosure claim rows. |
| Stable chat actions and proportionate header/composer | **Implemented** | [chat-layout.test.ts](../src/ui/chat-layout.test.ts) verifies reserved message-action height and responsive header hierarchy; [airship-shell.spec.ts](../e2e/airship-shell.spec.ts) verifies compact seals/tooltips without layout growth and the responsive shell. |
| Threads, semantic forks, Editor/Terminal navigation, unified Memory/Context, Profiles, and unified Proof/Attestation | **Implemented** | [conversation-navigation.spec.ts](../e2e/conversation-navigation.spec.ts) exercises disclosure/collapse, maximum visible thread list behavior, mobile navigation, source aliasing, profile routes, and unified trust navigation. |
| Friendly defaults and removable profiles | **Implemented** | Defaults live in [catalog.ts](../src/profiles/catalog.ts); profile selection/removal and dropdown behavior are exercised by [master-browser-acceptance.spec.ts](../e2e/master-browser-acceptance.spec.ts). |
| Profile, theme, and skill policy survives Vault adoption across refresh and fresh browser contexts | **Implemented** | [persistence.ts](../src/profiles/persistence.ts) stores one encrypted, validated, generation-linked catalog through the provider-neutral object-store contract. Writes use CAS and reject stale writers; [runtime-adoption.ts](../src/vault/runtime-adoption.ts) adopts an existing catalog only from a pristine bootstrap and never overwrites divergent user edits. Ephemeral mode remains intentionally page-memory-only. [persistence.test.ts](../src/profiles/persistence.test.ts) and [vault-auto-adoption.spec.ts](../e2e/vault-auto-adoption.spec.ts) prove fresh contexts against the same configured Vault and recovery material; they do not constitute physical cross-device enrollment or convergence certification. |
| Honest proof/attestation display | **Implemented** | Claim construction and evidence-scoped promotion are tested in [claim-stack-model.test.ts](../src/ui/claim-stack-model.test.ts) and the attestation suites; [proof-view.tsx](../src/ui/proof-view.tsx) displays unavailable/asserted/verified states without inventing Chutes evidence. |
| “Works on any device/browser” | **Conditional** | The focused master gate covers responsive Chromium sizes, and [edge-portability.spec.ts](../e2e/edge-portability.spec.ts) additionally exercises stable Chrome WebGPU, Firefox fallback, WebKit iPhone emulation, Chromium tablet emulation, constrained scheduling/reduced-motion signals, accessible naming/ID/tab invariants, and keyboard Proof navigation. These are not physical-device, assistive-technology, or billion-device certification. |

## 7. Remote Chutes enclave

| Requirement | Status | Evidence and boundary |
|---|---|---|
| Explicitly paired CPU-only Chutes TEE VM that preserves edge authority and the same tool contracts | **Unavailable** | This is later work by design. The current contract and capability registry are shaped for an additional provider, but no pairing, state transport, remote execution, or evidence-bound result path is shipped. It must not be implied by ordinary Chutes inference. |
| Pre-spawn browser/paired-executor placement and adversarial remote-stream validation | **Implemented foundation; remote unavailable** | [compute-continuum.ts](../src/execution/compute-continuum.ts) selects caller-reported compatible browser runtimes (whose adapters must still prove readiness), never downgrades confidential jobs, and blocks every remote observation until private capability minting exists. Its validator enforces strict schemas, binary-safe bounded output, PTY/delta ordering, exact executor/runtime/artifact/plan/approval/channel/snapshot acceptance, and locally recomputed stream/delta/result commitments without claiming peer authorship. [continuum-job-state.ts](../src/execution/continuum-job-state.ts) is explicitly an isolated browser-only transition skeleton with sticky cancellation, bounded recovery counters, unresolved late-result handling, and structural adoption gating—not authority-bearing or operational reconciliation. Tests cover malformed/coercible records, assertion downgrade, native-runtime contradiction, remote-not-ready states, mutation, replay/reordering, over-budget output, incorrect commitments, early-finish failure latching, cancellation/reconnect, late results, and illegal lifecycle transitions. No live remote executor, authenticated channel, or durable reconciler is claimed. |
| Session-pinned browser capability-tier labeling | **Implemented** | The active session manifest pins and displays the browser tier; runtime/tool outputs carry provenance metadata. |
| Per-result remote/tool capability-tier labeling | **Implemented when exact result provenance exists; remote unavailable** | [message-parts.ts](../src/ui/chat/message-parts.ts) accepts only exact capability-tier contract values from each durable tool result, and [message-parts-view.tsx](../src/ui/chat/message-parts-view.tsx) renders only that result-owned tier. The separate message pill displays the pinned session tier; it is never substituted as producing provenance. Parser tests reject malformed assertions and the disconnected browser journey proves the session label remains visible. No remote-enclave result path exists, so Airship cannot display a remote tier it has not received. |

## Master-prompt closure blockers

The deliverable cannot honestly be called “all green” until the applicable scope
is revised or these gaps close:

1. ~~Resolve the current WASIX **NO-GO**, then promote browser Bash.~~ **Closed differently, 2026-07-25.** Rather than wait on a third-party runtime bug, Airship shipped its own POSIX-sh
   interpreter, `airship-sh`. Browser shell is now a real, tested, universal capability; the
   WASIX candidate stays honestly `unavailable`. GNU Bash specifically remains unshipped, and the
   product no longer claims it.
2. Decide whether “Rust execution” means real precompiled WASI (present) or an
   in-browser Rust compiler/Cargo workflow (absent).
3. Run Google Drive acceptance against a real consented account and production
   OAuth configuration; deterministic boundary substitution is insufficient for
   the prompt's “fully functional” claim.
4. Define a benchmark corpus before publishing a 60–78% storage-reduction claim.
5. Add physical-device, assistive-technology, forced-colors/zoom, low-memory,
   suspension/recovery, and device-lab certification required for “any device.”
   The automated multi-engine emulation/probe, semantic-markup, keyboard, and
   reduced-motion matrix is present but cannot replace those runs.
6. Treat the remote CPU enclave as a separate future milestone with explicit
   pairing and evidence contracts.
7. Decide whether the requested unified Rust/WASM kernel remains in scope, then
   either migrate the TypeScript/WebCrypto host or explicitly retain the current
   narrow Rust/WASM E2EE and DCAP modules.
8. Pass every applicable live-provider gate in the release environment; fixture
   substitutions prove contracts but cannot close Google, semantic-model,
   WebContainer, WASIX, or Chutes provider availability by themselves.

## Repeatable acceptance commands

Run from the `airship/` directory. These commands contain no credentials. Live
provider gates consume credentials/configuration from the operator's environment
and must never print or persist them.

```sh
# Static analysis, deterministic unit/integration tests, production build,
# artifact budgets, and static security checks. This does not contact Chutes
# and does not include Playwright.
rtk npm run check

# Focused master-prompt browser matrix: desktop Chromium, iPad Pro 11,
# and iPhone 14 Pro Max. The config owns strict port 4186 and refuses to reuse
# an unrelated server. WebContainer acceptance runs only where claimed.
rtk npm run test:e2e:master

# Start and verify the local MinIO/Vault laboratory, then exercise live encrypted
# generation publication and exact HTTP range retrieval in an inference turn.
rtk npm run lab:start
rtk npm run lab:status
rtk npm run lab:test

# Generic desktop/mobile Chromium product journeys use the running lab and
# outbound GitHub access for the public-repository import. They include
# Editor/Git, chat/thread, responsive, Vault-adoption, and shell gates.
rtk npm run test:e2e

# `lab:test` supplies the disposable loopback S3 environment to the underlying
# `test:vault:live` gate. Calling that lower-level script directly is
# intentionally fail-closed unless every AIRSHIP_LOCAL_S3_* value is supplied.

# Deterministic Google OAuth/Drive contract and browser UI acceptance.
rtk npm run test:e2e:google-drive

# Dedicated stable-Chrome/Firefox/WebKit/tablet/constrained-signal portability
# matrix. It owns strict port 4189; emulation is not physical-device proof.
rtk npm run test:e2e:portability

# Optional downloaded semantic-model gate. Prepare the pinned pack first; the
# dedicated stable-Chrome runner owns strict port 4190.
rtk npm run semantic:prepare
rtk env AIRSHIP_LIVE_SEMANTIC=1 AIRSHIP_LIVE_SEMANTIC_UI=1 npm run test:e2e:semantic

# Fail-closed paid-provider acceptance. All three settings are mandatory; the
# runner refuses to start when any is absent. It performs a real Chutes E2EE
# turn, a tool-using agent turn, then an isolated browser vision/attestation
# turn on strict port 4188. Credentials stay in child environments, not args or
# recordings.
rtk env \
  AIRSHIP_CHUTES_API_KEY='<memory-only release credential>' \
  AIRSHIP_CHUTES_TOOL_MODEL='<exact tool-capable model ID>' \
  AIRSHIP_CHUTES_VISION_MODEL='<exact vision-capable model ID>' \
  npm run check:release:live

# Opt-in real WASIX research/promotion gate. It currently proves the candidate
# fails closed; passing all semantics is required before Bash can be promoted.
rtk env AIRSHIP_LIVE_WASIX=1 npx playwright test e2e/browser-worker.spec.ts \
  --project=desktop-chromium \
  --grep 'pinned WASIX candidate records its live no-go'

# Release artifact classification, preload policy, byte budgets, and secret scan.
rtk npm run check:release

# Stop the local lab when acceptance is complete.
rtk npm run lab:stop
```

For a release record, preserve the command exit codes, browser/project names,
artifact manifest, external-provider identity/configuration (never credentials),
and the generated proof/audit digests. A green deterministic suite does not
override a skipped, unconfigured, or failed live-provider gate.
