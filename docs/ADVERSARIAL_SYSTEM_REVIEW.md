# Airship adversarial system review

Status: independent code-evidence review, updated 2026-07-19. This is a release gate,
not marketing copy. Findings were produced in parallel by runtime/recovery,
trust/privacy, and product/interaction reviewers. Each reviewer inspected the
live tree and tried to disprove the product claim from a different direction.

## 2026-07-19 current-tree acceptance addendum

This addendum is authoritative wherever it contradicts the original 2026-07-18
matrix below. The detailed matrix remains useful as threat history, but several
composition failures have since closed.

Closed and tested in the current tree:

- the verified local Vault is adopted as the live encrypted S3 workspace,
  journal, and Git-checkpoint runtime; an exact-compatible session is audited
  and resumed across fresh browser contexts without creating reload sessions;
- agent `write_file` and `remove_file` effects synchronize into the same Git
  worktree shown by Workspace and Sources, with compensating rollback and exact
  unstaged-diff tests;
- Workspace is a route-loaded browser workbench with a virtualized explorer,
  keyboard navigation, context actions, drag/drop moves, CAS editor tabs,
  mobile Files/Editor panes, and real stage/unstage/commit state;
- image attachments have bounded page-memory previews and survive Retry,
  Edit & resend, and Fork without entering local or cloud storage;
- arbitrary authenticated Chutes stream chunk boundaries are accepted by the
  incremental SSE parser; the old one-chunk/one-event assumption is gone;
- local confidential OAuth is described honestly as a loopback bridge, while a
  static release fails sign-in closed unless it is built with a distinct exact
  HTTPS Browser/native PKCE registration;
- every route, trust tab, menu, density mode, profile switch, composer, and
  Workspace layout passes the current desktop/mobile Chromium acceptance suite.

Current launch blockers are narrower but still material:

1. production Vault onboarding still needs OIDC-to-temporary-credentials,
   recovery-key enrollment, tenant IAM/CORS, and deployment-specific CSP;
2. Git branch/worktree controls do not transactionally project checked-out
   bytes into Workspace, and multiple external worktrees of one repository can
   collide at one virtual root;
3. custom profiles, themes, and global/profile skill settings are not yet
   versioned and restored from the encrypted Vault;
4. retrieval still defaults to deterministic hash embeddings and a memory-only
   flat index rather than encrypted streamed semantic generations;
5. Intel verification remains `partial`, so the production inference gate
   cannot honestly promote an endpoint receipt to independently attested;
6. the durable request idempotency key is not yet transported to Chutes; and
7. required release coverage is Chromium-only, with live Chutes vision,
   WebContainer, Firefox, WebKit/Safari, offline recovery, and DCAP canaries
   remaining separate opt-in/provider gates.

## Verdict

Airship is a serious browser-native prototype with unusually strong building
blocks. It is not yet the private, durable, attestable cloud agent described by
the product vision. The local lab proves the UI, local agent loop, S3 protocol,
encrypted adapters, Rust kernels, and Chutes API contracts independently. It
does **not** prove that the shipped UI composes those parts into one durable
runtime. A green adapter probe is not cloud adoption; encrypted transport is
not endpoint attestation; a hash chain is not external authorship; a model
catalog response is not credential verification.

The release must remain a developer preview until the current addendum's launch
blockers are closed by integration or fault-injection tests. A polished surface
does not lower that bar.

## Remediation ledger for this review

These are narrow closures, not a declaration that their surrounding subsystem
is production-ready:

- **Closed and tested:** cancelled and failed turns are excluded from future
  provider-message projection while their journal evidence remains intact.
- **Closed and tested:** a message receipt action selects the exact session,
  turn, and receipt; Proof deep links/history preserve that identity and fail
  closed on incomplete or mismatched triples.
- **Closed and tested:** real Chutes receipts are finalized at the journal
  boundary with canonical request and plaintext-response digests while their
  ciphertext/evidence commitments and endpoint-only claims remain unchanged.
  The integrated transport-to-auditor fixture verifies cleanly and equal-length
  request/response mutations fail.
- **Closed and tested:** omitted or failed account, balance, subscription,
  usage, and quota sources render neutral Unknown/Unavailable. Omission no
  longer implies good standing, PAYG, zero usage, or unlimited quota.
- **Closed and tested:** OAuth authorization accepts only the exact callback in
  the reviewed registration, not an arbitrary HTTPS redirect.
- **Closed and verified live:** development and lab UI listeners default to
  `127.0.0.1`; LAN exposure requires the explicit `dev:lan`/`preview:lan`
  command. The disposable S3 service remains loopback-only.

## P0 release blockers

| ID | Status | Failed adversarial claim | Current result/failure | Required proof to close |
| --- | --- | --- | --- | --- |
| AR-001 | **Closed in this pass** | A receipt icon proves its exact turn | Canonical provider-receipt bindings and exact Proof routing now pass the integrated clean/mutation and two-turn/deep-link fixtures. | Keep `receipt_exact_turn_and_mutation` in every release gate; external transcript authorship remains a separate attestation requirement. |
| AR-002 | **Closed in this pass** | Stopping or failing a turn removes its authority | Cancelled/failed turns remain auditable but their entire provider-message projection is excluded from future inference. | Keep cancelled and failed hostile-prompt regressions in every release gate. |
| AR-003 | **Open** | Vault ready means the product is durable | The live app constructs page-memory sessions, workspace, Git, profiles, and journal. Vault setup only probes independently constructed adapters. Reload loses state. | Configure, migrate, atomically switch, reload/new-tab recover, and reproduce exact files/sessions/profiles. CAS conflicts branch visibly and never discard an acknowledged revision. The UI distinguishes `probed` from `active runtime`. |
| AR-004 | **Open** | Private files cannot leave without consent | File reads auto-approve and tool results are sent to the remote model on the next step. Encryption does not constrain the model endpoint after decryption. | A taint-aware egress gate shows destination/model, exact files and byte classes, redactions, and grant scope. `.env`/key fixtures send zero bytes until a one-shot or session grant is durably approved. |
| AR-005 | **Open** | Tool effects are validated and exactly once | Tool JSON is not schema-enforced at both boundaries; repeated provider IDs and crash-after-effect can duplicate side effects. | Compiled schema validation before approval and execution; bounded unique call IDs; durable operation ledger and idempotency key. Duplicate, oversized, deeply nested, prototype-shaped, and crash-window fixtures fail closed without a second effect. |
| AR-006 | **Open** | The recovery kernel shown in the architecture is the shipped kernel | The browser runs the TypeScript loop while the stronger deterministic Rust kernel is not its canonical state machine. The two protocols already differ around approval persistence and grant consumption. | One versioned kernel ABI in a worker; native Rust and browser WASM produce identical golden traces for success, denial, cancellation, provider failure, and crashes at every persist/effect boundary. |
| AR-007 | **Open** | Concurrent tabs cannot corrupt a turn | Journal CAS serializes writes but there is no active-turn lease/fencing invariant; two tabs can produce a grammatically invalid interleaving. | Cross-tab lease/fencing tests prove one writer per session epoch. Lost writers become an explicit branch or read-only recovery state. |
| AR-008 | **Open** | A successful remote invocation has a known billing outcome | An idempotency key is journaled but not transmitted to Chutes. A lost response can represent an unknown, potentially charged invocation. | Provider-supported idempotency is sent and bound into the receipt, or unknown outcomes are never retried automatically and are surfaced for reconciliation. |

## Feature-by-feature attack matrix

| Surface | What is real now | Adversarial failure or abuse case | Exit criterion |
| --- | --- | --- | --- |
| Static shell | Preact/Vite static client, no Airship request server | Same-origin JS compromise defeats browser confidentiality; unsigned release inventory cannot prove what ran | Reproducible signed release, SBOM, deployed CSP/header evidence, service-worker upgrade/rollback drill, artifact hash shown in Proof |
| Chutes connection | Mutually exclusive memory-only API credential modes, model catalog, honest authorize-only OAuth diagnostic, exact registered redirect allowlist | API-key “check” is public discovery, not credential validation; OAuth confidential exchange cannot run safely in the browser; shared discovery inherits the first caller's abort signal | Non-billable authenticated capability probe; provider-supported public PKCE exchange or an explicit unavailable state; no secret in bundle/storage/log/cache; two concurrent discovery consumers remain isolated when one cancels |
| OAuth scopes | `profile`, `chutes:invoke`, `billing:read` requested | Provider route enforcement does not yet map cleanly to least-privilege account/billing endpoints | Positive and negative route-by-scope matrix in Chutes API and browser integration; separate profile, balance, quota, usage, and invocation grants where needed |
| Model selection | Direct model discovery and immutable model/session pinning | Discovery can succeed while invocation permission, TEE policy, or model identity is unproved | First protected call proves invocation; selected model identity/policy is bound into preflight attestation and terminal receipt; model changes fork a session |
| Billing/account | Direct client fetch, capability-aware presentation, and tested per-source Unknown/Unavailable states | Provider scope/enforcement and entitlement truth remain external; a browser must not infer standing from a checkout return | Preserve independent partial/failure fixtures; consume only issuer-signed account/standing/entitlement evidence |
| E2EE transport | Bounded Chutes E2EE compatibility transport | Ciphertext privacy can be misread as endpoint or model proof; cancellation and ambiguous network completion remain distinct problems | UI keeps encryption, endpoint TEE, model, and transcript claims independent; required mode gates before plaintext release; cancellation and unknown completion are durable states |
| Endpoint attestation | Bounded evidence acquisition and exact invocation-time instance/key correlation | Generic verifier only checks shape/subject/time; no independently pinned CPU/GPU trust root, freshness policy, model artifact, or signed transcript | Replayed/stale quote, forged verifier, debug enclave, swapped key/instance/model, policy downgrade, and one-byte transcript mutation all fail closed |
| Receipts/Proof | Hash-chained events, canonical Chutes request/response bindings, exact message-to-Proof routing, independent auditor, dedicated Attestations route | Historical records are capped; local chain and head share one mutable authority; raw wall-clock regression can falsely quarantine a valid multi-device chain | Signed external head/transcript commitment, stable historical pagination/export, explicit integrity/completeness/endpoint/model/conversation states, and HLC/logical ordering with ±24-hour skew tests |
| Agent loop | Persist-before-inference/tool ordering, cancelled/failed projection isolation, and bounded local demo | Broad catch can mislabel an append failure as tool failure; committed-but-lost S3 responses can yield contradictory terminals; writer limits can exceed the auditor's 2 MiB event limit; full-history rematerialization grows per step | AR-006; one shared protocol-limit table/property corpus; read-after-unknown reconciliation with exactly one terminal; split effect from persist error domains; compaction with provenance |
| Tool approval | Bounded fail-closed approval queue for non-read effects | Reads silently become remote egress; reviewed display is not a consumed canonical argument grant; sequential duplicate call IDs can re-execute | AR-004/005 and canonical grant digest over session/turn/op/tool/args/effect/resource/destination/expiry/nonce/policy |
| Sessions | Search/filter/sort, audit-before-resume, clean fork in page memory | Reload loss, fixed list cap, no durable archive/delete/import/export, fork lacks ancestor transcript | Encrypted durable headers and branch lineage; 10k-session warm search budget; branch operations never rewrite a receipt-bearing chain |
| Tasks | Architectural intent only | Browser suspension can look like an executing daemon; no durable dependencies/checkpoints/cancel states | Explicit durable task state machine; suspended web task says paused; native/remote execution is a separately receipted capability tier |
| Vault/S3 | Real SigV4, CAS/range/list, temporary-credential port, encrypted journal/workspace adapters, live MinIO conformance | Adapters are not adopted by app; mutable store can replay an older AEAD-valid head; session creation is non-atomic; large heads/listing scale linearly | AR-003 plus monotonic signed witness/checkpoint, atomic create, segmented indexes, two-writer conflict tests, tenant isolation and expiring credential tests on production S3 |
| Key lifecycle/deletion | Locally generated recovery material and encrypted immutable objects | No enrollment/rotation/revocation; deleting a manifest entry leaves ciphertext; old device can retain authority | Per-object DEKs wrapped by epoch keys, device enrollment/revocation, rotation and crypto-erasure/GC policy with recovery and revoked-device tests |
| Workspace/files | In-memory UTF-8 virtual workspace and optimistic revisions | Blind cloud overwrite and full manifest rewrite if wired; selected-file UI can become stale; no hostile binary/path/size policy | Encrypted incremental manifests, hard byte/count/path/MIME limits, visible conflicts, stale selection invalidation, fault tests at every upload/CAS boundary |
| Sources/Git | Page-memory status/diff/stage/commit/branch/worktree state machine | Workspace and Git are separate snapshots; reload loses objects; no remotes/merge/conflicts; repository input can be hostile | One canonical workspace/object graph; OPFS/cloud checkpoints; traversal/symlink/case/ref/pack bomb corpus; direct CORS-safe scoped remote credentials; push remains separate approval |
| Profiles | Built-in/page-memory profile selection and immutable pinning intent | Active session identity can diverge from catalog UI; reload loss; profile edits can imply history mutation | Content-addressed durable profiles; active UI always renders pinned revision; changes fork; import/export is signed or explicitly untrusted |
| Skills | Global/per-profile toggles in page memory | Skill prompt is not tightly bounded; enablement may not be the immutable session pin; no capability manifest/signing | Bounded versioned skill packages, signed provenance, declared tools/network/data scopes, immutable session resolution, negative permission tests |
| Themes/UI identity | Responsive theme/profile controls | Theme or current catalog persona can visually overwrite historical agent identity | Theme is presentation only; every historical turn renders its pinned profile/theme-neutral identity and proof linkage |
| Memory graph | Lightweight Graphology/Sigma relationship visualization | Page-memory graph can be mistaken for durable memory; main-thread layout can stall; visualization may imply causal truth | Durable provenance-bearing facts/edges, worker layout, bounded node/edge budgets, explicit inferred vs asserted edges, accessible table alternative |
| Client indexing | Incremental deterministic hash embedding baseline and live workspace refresh | Not semantic; main-thread flat scan; snapshots accept insufficiently bounded plaintext paths/text/vectors; secrets can be indexed | Worker pipeline, ignore/secret classification, pinned local embedding with capability fallback, authenticated encrypted generations, NaN/dimension/count/poison corpus |
| Context Fabric | Segmented expert routing/range-read prototype with lineage | Route-local and not injected into the agent; deadline starts after embedding/mirror/routing work; selected expert reads launch without a concurrency ceiling; shallow validation and large pre-limit allocations remain | Entry-time end-to-end deadline, bounded expert concurrency, canonical prompt assembly, keyed commitments, stream bounds before allocation, and visible corrupt/missing/rollback failures |
| Mobile | Responsive navigation and narrow layouts | Critical trust status can disappear; hover-only help; small targets; suspension and memory/thermal ceilings untested | Same actions and trust vocabulary at 320 CSS px; 44×44 targets; keyboard/VoiceOver/TalkBack gates; low-end device memory/INP/thermal budgets |
| Accessibility | Some semantics, focus styling, reduced motion | Approval modal lacks a proven focus trap; invalid landmark/listbox patterns and color/hover reliance remain | WCAG 2.2 AA automated and manual gate; approval focus containment/restoration; screen-reader interaction scripts |
| Offline/PWA | Static shell cache | No offline state, outbox, conflict model, or dependable background execution | Encrypted durable outbox with visible paused/sync/conflict states; shell never claims offline work or daemon execution before capability is present |
| Performance | Small shell, bounded transport, release artifact budgets | Unbounded session/history/response/skill projection, flat vector scan, full workspace/journal heads, and Promise-all listing undermine device scale | Reference-device budgets for 10k sessions, 100k chunks, 250k files, 2k events; worker long-task ceiling; stream/count/byte limits enforced before allocation |
| Storage adapters | Direct S3 and quarantined generic/Walrus transports | Redirects, fallback ETags, and buffered unbounded list/error/response bodies can weaken CAS or exhaust memory | Strong ETag required; `redirect: error`; streamed bounded readers; credential-free endpoints; signed digest/size/audience/expiry upload grants; hostile 1 GB fixture |
| Commerce | No Airship backend is required by the architecture | Stripe return URL is not entitlement proof; a static browser cannot safely receive webhook truth; shared sponsored wallet becomes a middleman and abuse pool | Airship launches hosted checkout only; Chutes/storage issuer returns signed account-bound standing/entitlement; replay/refund/dispute/account-switch tests; no Stripe secret in client |
| Protocol evolution | Typed events and version fields exist | Unknown critical events, Rust/TS drift, and no migration matrix can create unsafe recovery | Compatibility/migration matrix; unknown critical semantics fail closed; golden fixtures for every supported version across native/WASM/TypeScript readers |
| Diagnostics | Local proof and some bounded errors | Raw provider/tool errors may enter durable events; no complete redacted support bundle | Structured bounded error taxonomy and correlation IDs; export omits prompts, tokens, object keys, and sensitive paths by default; redaction corpus |

## Adversarial regression corpus

The release suite should include these named scenarios so the claims stay
executable rather than aspirational:

1. `receipt_exact_turn_and_mutation`
2. `cancelled_prompt_has_no_future_authority`
3. `vault_reload_and_two_writer_fence`
4. `read_file_requires_remote_egress_grant`
5. `tool_duplicate_and_crash_exactly_once`
6. `tee_quote_replay_key_model_and_policy_swap`
7. `s3_valid_ciphertext_head_rollback`
8. `credential_tenant_escape_expiry_and_revocation`
9. `billing_partial_responses_never_imply_good_standing`
10. `hostile_git_pack_path_ref_and_symlink_import`
11. `index_snapshot_poison_and_secret_exclusion`
12. `mobile_approval_suspend_resume_and_focus_loss`
13. `service_worker_modified_release_and_rollback`
14. `checkout_return_replay_refund_and_account_switch`
15. `protocol_unknown_critical_event_and_cross_kernel_trace`
16. `multi_device_clock_skew_preserves_logical_order`
17. `writer_limits_are_always_auditor_readable`
18. `ambiguous_commit_reconciles_one_terminal`
19. `context_deadline_includes_routing_and_bounds_concurrency`
20. `shared_discovery_abort_is_consumer_local`

## Local-lab interpretation

`npm run lab:start` intentionally starts a disposable, loopback-only MinIO
service and the static Airship UI. `npm run lab:test` runs web checks, both Rust
suites, live S3 adapter conformance, an actual browser-origin preflight, and
Chutes API scope/CORS regressions. Passing it means those components satisfy
their current contracts. It does not turn page-memory app state into Vault
state and it does not synthesize a TEE, billing, OAuth, or payment success.

The posted Chutes OAuth client secret must be rotated. It is not valid static
client material and must never enter source, build variables, browser storage,
logs, or a service-worker cache.

## Validation record

The combined `npm run lab:test` gate passed on 2026-07-18 against the live
loopback lab:

- TypeScript/static security plus 42 Vitest files: 246 passed, one intentional
  opt-in skip;
- production build and deterministic unsigned release inventory: 24 artifacts,
  104.39 KiB gzip entry JavaScript, 187.89 KiB gzip all JavaScript/workers,
  16.04 KiB gzip entry CSS, and 114.02 KiB gzip crypto WASM;
- Rust recovery kernel: 11 passed;
- Rust Chutes E2EE core: 10 passed;
- live S3/encrypted journal/workspace harness: five tests and all 16 provider
  checks passed, creating nine disposable immutable objects;
- Chutes authorization/evidence-scope/ingress contracts: 25 passed; and
- an independent MinIO preflight accepted the exact Airship origin, signed PUT
  headers, and method set.

The UI and MinIO listeners were independently verified as IPv4 loopback-only.
That 2026-07-18 run had no controllable browser attached and therefore made no
rendered-UI claim. The current record below supersedes that limitation with
real Playwright rendering/interaction coverage; screen-reader and visible
provider-credential consent remain separate gates.

### Current validation record — 2026-07-19

The superseding local acceptance run completed with:

- 106 Vitest files passed, three opt-in files skipped; 507 tests passed and
  five intentionally skipped;
- 34 Playwright desktop/mobile Chromium tests passed and 15 deliberate
  project/provider skips, including every-route screenshots, no-overflow and
  control-name checks, stable message-hover geometry, model/profile controls,
  Workspace desktop/mobile flows, GitHub import, JS/WASI/Python execution, and
  fresh-context Vault resume;
- production build and deterministic unsigned release inventory: 90.87 KiB
  gzip entry JavaScript, 127.44 KiB gzip always-available shell/workers,
  103.05 KiB gzip deferred capability pack, 254.19 KiB gzip total
  JavaScript/workers, 21.61 KiB gzip entry CSS, and 114.02 KiB gzip crypto WASM;
- 11 Rust recovery-kernel tests and 10 Rust Chutes E2EE/WASM tests passed;
- live loopback MinIO conformance passed all 16 S3/CAS/range/list/encrypted
  journal/workspace/disclosure checks; and
- 51 Chutes public-client OAuth, evidence authorization, and ingress contract
  tests passed against the reviewed local Chutes API source.

The visible provider login/consent itself was not completed in this run because
no interactive Chrome binding was attached. That is not represented as an
authenticated account result. The supplied throwaway password and previously
posted OAuth/API credentials were not written to source, fixtures, browser
storage, or subagent prompts and must be rotated.
