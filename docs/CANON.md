# Airship Canon

**Status:** Canonical project overview and product contract  
**Last reconciled:** 2026-07-28
**Applies to:** the Airship client, browser runtime, optional companions, provider adapters, user experience, and trust language

**Maturity:** executable browser-native foundation; not yet a production,
fully attestable multi-device agent

Airship is a private, stateful agent runtime whose authoritative loop executes
on the user's device. Its primary distribution is a static, installable web
application. Airship has no application backend: the client talks directly to
selected inference, identity, storage, account, payment, and optional execution
services through narrow adapters.

This is the one-document introduction to the complete project. It defines what
Airship is, what it must never pretend to be, how the system fits together, what
the current repository actually implements, and which capabilities remain
future or conditional. Detailed subsystem documents remain normative for wire
formats and implementation-specific contracts.

## 1. Document authority

When project documents disagree:

1. This canon governs the product definition, invariants, vocabulary, surface
   model, and the boundary between implemented and future work.
2. Executable tests and versioned protocol schemas govern exact machine
   behavior. A discrepancy with this canon is a bug or documentation defect;
   it never permits a stronger privacy or verification claim.
3. `ARCHITECTURE.md`, `PROTOCOLS.md`, trust records, and subsystem documents
   govern their named technical contracts.
4. `AIRSHIP_DESIGN_BLUEPRINT.md`, audits, experiments, and earlier storage
   briefs preserve design reasoning but are not authoritative where later
   product decisions or shipped navigation differ.

The words **implemented**, **conditional**, and **planned** have precise meaning
here:

- **Implemented:** executable in this repository and covered by an appropriate
  automated or live test.
- **Conditional:** implemented, but useful operation depends on browser support,
  user configuration, provider CORS/scopes, or an external service response.
- **Planned:** an intended contract or adapter, not a claim about the current
  release.

## 2. Product thesis

A capable agent should feel local without requiring every device to be a
workstation and without placing a proprietary application server between the
user and their data. Airship gives the browser ownership of:

- the agent turn loop and session semantics;
- plaintext assembly, decryption, and context selection;
- the virtual workspace, source-control state, and local execution adapters;
- permissions, approval decisions, cancellation, and retry behavior;
- profiles, skills, memory derivation, and retrieval routing;
- receipts, evidence inspection, and the language used for trust claims.

Independent services provide what the client should not or cannot provide
itself: large-model inference, durable object storage, identity, account
telemetry, payment, and optional heavy or privileged execution.

The north-star experience is a world-class local agent CLI expressed through a
fast desktop and mobile interface: persistent conversations, streaming turns,
files, Git, terminal-like execution, tools, approvals, searchable context,
portable state, and evidence that can be inspected rather than merely trusted.

## 3. Non-negotiable invariants

### 3.1 The device owns the agent

The client controls each turn, tool call, approval, context selection, state
transition, and proof presentation. A provider may return inference or execute a
specific delegated capability; it does not become the Airship runtime.

### 3.2 No hidden Airship backend

The production web application is static HTML, CSS, JavaScript, WASM, a service
worker, and versioned assets. There is no Airship session API, plaintext
database, inference proxy, credential broker, billing server, or server-rendered
application hidden behind the interface.

An optional native companion, local development bridge, or user-selected remote
sandbox is an explicit capability adapter. It is never silently required and
never changes the meaning of the browser-only tier.

### 3.3 Cloud state is ciphertext, not trust

Durable sessions, workspace objects (including conventional Git metadata), index generations, and
derived memory artifacts are encrypted before leaving the client. A storage
provider can observe account metadata, object sizes, timing, and access patterns,
but must not receive logical paths or plaintext through Airship's storage
protocol.

Successful storage does not prove inference confidentiality. Successful
inference encryption does not prove a TEE. Authentication, authorization,
durability, attestation, conversation integrity, and payment standing are
separate claims.

### 3.4 History is immutable

Turns are append-only event sequences. Current protocol-v2 sessions pin their
turn-retrieval policy and journal a verified, query- and silo-bound
`turn.context.selected` event before inference. Historical protocol-v1 sessions
are replay-only and must be forked before new work. Sessions also pin their
prompt, tool schema, profile revision, skill resolution, provider, model,
provider-declared context window/compression semantics, capability tier,
workspace, and proof policy.
Changing any pinned meaning creates a new session or explicit fork; Airship does
not rewrite prior history to make it fit current settings.

Each profile's active conversation is also an append-only journal fact, not a
page-global recency guess. `profile.active-conversation.selected` uses a
profile-bound monotonic generation; concurrent equal-generation writes
converge by persisted timestamp, event ID, then host-session ID. The pointer
belongs to the currently selected storage authority: it is page-lifetime in
page memory and durable when the adopted encrypted journal is durable. A
missing, deleted, cross-profile, or runtime-incompatible target falls back to
an existing compatible conversation without creating one. Only the explicit
new-conversation action may manufacture a replacement conversation.

Favorite membership and order follow the same immutable authority boundary.
`session.favorite.changed` records the current membership epoch on the owned
conversation. `profile.favorite-order.moved` records a profile-bound move tied
to that epoch and, when present, the anchor's epoch. Move generations are
Lamport counters; equal-generation writers replay by persisted timestamp,
event ID, and host-session ID, so concurrent devices converge without replacing
history. Removing and re-adding a favorite creates a new epoch and cannot
resurrect an obsolete position. Preference-only events advance the journal
head but do not change the derived conversation-activity time used for Recent.

The user-facing conversation operations have distinct immutable meanings:

- **Continue** appends a new user turn to the same session only while its pinned
  bindings remain compatible.
- **Edit** creates a branch from immediately before the selected message and
  appends the replacement there; the original message and branch remain
  addressable.
- **Retry** creates a new attempt from the same immutable input, selected
  context, and pins. It records the attempt separately and recovers completed
  stable operation IDs instead of duplicating effects.
- **Fork** creates an explicitly separate conversation/session from a selected
  historical point, records parent lineage, and may deliberately adopt new
  pinned settings.

An implementation may use the same branch primitive underneath these actions,
but the interface, audit trail, and resulting navigation must not collapse
their meanings.

The pinned capability tier is the page observation at session creation, not a
ceiling on the stable installed tool schema. An explicitly approved optional
runtime may become ready and run in that same session. Its install and execution
events append normally, and each result binds the live tier and engine that
actually produced it; no earlier event or manifest byte is mutated.

### 3.5 Capabilities are explicit and fail closed

Browser, network, write, execute, identity, and destructive effects are exposed
through typed tools with limits and cancellation. The approval policy—not model
text—decides whether an operation proceeds. Missing capability, ambiguous state,
expired evidence, and unsupported provider behavior remain unavailable rather
than being simulated.

Capability discovery is proactive. At bootstrap and after material device,
provider, extension, storage, permission, or runtime changes, Airship probes
every safe observable accelerator and adapter it knows how to use. Low-cost,
already-authorized capabilities should become ready without menu archaeology;
capabilities that require a download, browser permission, credential, or
material resource commitment require a clear prompt. Discovery never grants an
effect, weakens approval policy, or turns an unsupported feature into a claim.

The agent receives the current capability generation on every turn: available
tools and Skills, permissions, provider/model, durability authority, extension
state, execution runtimes, resource constraints, workspace/index generation,
and proof posture. A user must not have to remind the agent that a capability
was present at session creation or became available mid-conversation. This live
awareness supplements immutable session pins; it never rewrites them.

### 3.6 Trust language is evidence-bound

Airship may say **local**, **encrypted but unattested**, or **encrypted and
attested** only when the corresponding evidence supports that exact scope.
Provider metadata and assertions never silently become verified facts.

### 3.7 Interoperability lives at narrow contracts

Canonical events contain no UI framework, provider SDK, database, cloud, or
chain type. Inference, storage, workspace, Git, tools, identity, telemetry,
payment, attestation, and execution are replaceable adapters with explicit
capabilities.

### 3.8 Performance is architectural

The baseline stays a small, route-lazy Preact client. Heavy editors, Git,
terminal support, semantic models, execution runtimes, and cryptographic
verifiers load only when required. Work is bounded, cancellable, streamed, and
moved to workers or WASM where that materially improves responsiveness.

### 3.9 Remote compute is delegated, never authoritative

Airship may place an immutable, explicitly approved job on a paired executor,
but placement is resolved before spawn and the browser remains the control
authority. A remote runtime cannot advance the session journal, workspace or
Vault head, Git ref, profile, or context generation. It returns bounded output,
a terminal receipt, and optionally a copy-on-write delta for browser validation
and adoption. Airship does not claim arbitrary live process migration between
browser runtimes and Linux.

## 4. What the key terms mean

- **Client-side / device-executed:** plaintext orchestration and authoritative
  agent state transitions occur in the user's browser or an explicitly selected
  local companion.
- **Edge:** the user-controlled client boundary, not an Airship-owned edge
  function that secretly becomes a backend.
- **Cloud-native:** durable and compute-intensive services are consumed through
  direct, retryable, provider-neutral protocols; it does not mean Airship owns a
  cloud control plane.
- **Local-first:** the product remains useful with its deterministic local agent
  and can use an encrypted, browser-owned OPFS/IndexedDB Vault without a cloud
  provider. Ephemeral page memory remains an explicit option. This does not
  promise arbitrary host access, guaranteed browser retention, or offline
  background execution.
- **Private:** Airship minimizes plaintext disclosure and encrypts supported
  durable state. It cannot protect against a compromised browser, extension,
  device OS, same-origin supply chain, or content a user deliberately sends to a
  service.
- **Portable:** state and protocols are versioned, exportable, and adapter-based;
  portability is not a claim that every provider implements every capability.

## 5. Product objects and scope

| Object | Meaning | Scope and lifetime |
| --- | --- | --- |
| Conversation | The user-facing thread shown under Chat | Belongs to one Profile and references one or more immutable runtime sessions through explicit forks |
| Session | A pinned runtime identity, manifest, journal, and receipt chain | Immutable semantics; resume only when bindings match |
| Turn | One user request and its model/tool lifecycle | Append-only events with a terminal success, cancellation, or failure |
| Workspace | The agent-visible virtual filesystem | Owned by the active Profile's selected workspace binding; encrypted when a Vault is active |
| Source | A repository/checkpoint and its browser-owned Git state | Profile-local and managed inside the Workspace Editor rather than as a separate top-level product |
| Profile | Versioned agent persona, prompt, model, theme, skills, workspace binding, memory scope, approval policy, and trust floor | Primary working silo; changes create revisions and applying one starts a new pinned conversation session |
| Skill | Versioned instruction module with optional tool references | Global default or explicit per-profile inherit/on/off resolution |
| Capability | An actually available execution or integration boundary | Device/runtime scoped and distinct from skill instructions |
| Memory | Derived, provenance-bearing recall over real source material | Profile-local and rebuildable; never a hidden second authority |
| Receipt | Turn- or action-scoped record of what was requested, observed, and verified | Session/profile-local, portable, and inspectable; individual claims retain independent states |
| Vault | The selected encrypted durability adapter and its verified contract | Global authority available to every Profile without merging their plaintext silos |

The Profile is the primary human and storage silo. Its conversations and
threads, workspace bindings, repositories and files, terminal sessions and
transcripts, Memory and index generations, and session-specific Proof all stay
with that Profile. Workspace and contextual memory may be shared across that
Profile's conversations when they use the same explicit binding. Conversation
history and prompt meaning remain session-bound. Resolved Skills remain
profile-bound unless an explicit global default is inherited.

Vault, Connection, and Account are global services. They may provide encrypted
durability, inference credentials, identity, and telemetry to multiple
Profiles, but global scope never merges profile-local conversations, files,
terminal history, Memory, indexes, or Proof. A Profile switch must therefore
change the visible working set while leaving the selected global services
available.

The current working-tree enforcement boundary is narrower than that complete
storage target. A Profile switch atomically replaces the visible conversation,
Chat draft/viewport/favorites/search, Workspace tabs and repository/worktree
selection, terminal tab set, Memory page presentation, and session Proof
selection. Those are Profile-owned cockpit state. The selected `WorkspacePort`
is still the underlying filesystem/Git authority: when two Profiles explicitly
resolve to the same workspace binding, they observe the same file bytes,
repository objects, refs, and worktree inventory even though each retains its
own selection and presentation. The derived Memory index follows that
authority. Airship therefore does not yet claim that changing Profiles creates
separate physical filesystem or index authorities; that requires distinct
bindings or the remaining durable authority work recorded in section 17.
Within the enforced cockpit, a copied session UUID is an address rather than a
capability: session commands, fork sources, and direct Proof links must verify
active-Profile ownership before reading or presenting session detail. Async
workspace listings likewise publish only while their exact WorkspacePort,
workspace identity, Profile, and newest request generation remain current.

## 6. Canonical surface model

This is the normative information architecture. A row marked as implemented in
the product ledger may still need shaping work to satisfy this complete model;
unimplemented parts remain requirements, not implied release claims.

Desktop begins with the active **Profile** and its Profile-local working set.
The Profile selector is the first orientation control, followed by **Skills**
and **Capabilities**, then the Profile-local **Chat**, **Workspace**, **Memory**,
and **Proof** surfaces. Global **Vault**, **Connection**, and **Account** follow
as services available to every Profile. Mobile may use four persistent
controls—**Chat**, **Workspace**, **Trust**, and **More**—but must expose the same
routes, state, operations, and evidence; nesting is responsive presentation,
not a reduced product.

| Surface | Purpose | Nested surfaces |
| --- | --- | --- |
| Profile | Select and manage the active agent silo and revision | Profiles, Skills, Capabilities |
| Chat | Profile-local conversations, streaming agent turns, attachments, tools, reasoning, receipts, and slash commands | Favorites, Recent, All conversations/search |
| Workspace | Profile-local files, editing, browser Git, and execution bound to one virtual workspace | Editor, Source Control, Terminal |
| Memory | Federated search, relationship exploration, and index lineage | Search, Graph, Index |
| Proof | Profile/session-local conversation and terminal receipts, journal audit, and endpoint evidence | Summary verdict, Receipt & journal, Attestation evidence, raw details |
| Vault | Global durability provider, encryption path, live contract evidence, and provider transitions | Provider setup and technical details |
| Connection | Global provider identity, model discovery/selection, and proof policy | Chutes first; advanced providers and credentials |
| Account | Global provider identity, standing, balance, quota, reset, and usage telemetry | Provider-specific tabs where APIs permit |
| Settings | Appearance, density, approval policy, and durability preference | Overlay rather than a competing destination |

Source Control is part of the Workspace Editor. Historical `#sources` links
resolve to Editor. Sessions are user-facing as conversations; the detailed
session library remains available for search, audit, resume, and forking. A
fork does not copy the ancestor's journal, but it is not started blind either:
it carries a digest-sealed, bounded copy of the ancestor's context up to the
selected boundary, and says what that copy left out.

Chat navigation is inline with the active Profile rather than hidden in browser
history or a detached flyout. Favorited conversations form a stable, reorderable
section above rotating recents; a star may appear on hover for unstarred rows but
remains visible once selected. Search and **All conversations** are
Profile-scoped by default, and selecting a row resumes it without losing its
immutable session identity.

## 7. Primary user journeys

### 7.1 Start with no external account

1. Load the static PWA.
2. Airship initializes a deterministic local provider, an explicit page-memory
   Profile workspace, and safe capability probes.
3. The user can chat, inspect and edit files, use local slash commands, run
   available browser capabilities, and create local receipts.
4. Before work can be mistaken for durable state, the interface labels the page
   as ephemeral and offers the encrypted Local Device rung without requiring an
   external account.
5. Connection and remote Vault providers are offered when the requested action
   benefits from them; they do not block local work.

### 7.2 Move up the durability and capability ladder

Airship presents one truthful ladder rather than a flat list of vaguely stronger
options:

1. **Page memory — implemented:** deliberately ephemeral plaintext working
   state. Closing or refreshing the page can end the session; the UI says so
   before the user relies on it.
2. **Browser-persistent Local Device — implemented, browser-conditional:** an
   encrypted OPFS/IndexedDB Vault with recovery ceremony, storage-persistence
   request, export/restore, and browser retention limits. It is bound to this
   browser profile and is not cross-device sync.
3. **Extension-enhanced/local-device — conditional and bounded:** an installed
   companion may add an allowlisted provider relay, ciphertext cache, and
   measured compute helpers. Today that extension is an enhancement, not a
   stronger authoritative Vault; any future authoritative companion store must
   pass the same encrypted object, CAS, recovery, and proof contracts.
4. **Google Drive or S3-compatible — implemented adapters, externally
   conditional:** user-selected encrypted remote durability. Drive is the
   ordinary cross-device provider path; S3/MinIO is the advanced/self-hosted and
   conformance path. Neither may claim sync until convergence gates pass.
5. **Chutes CPU TEE — planned/external:** eventual E2EE, attested remote compute,
   inference, and encrypted-storage offload controlled by the browser. It is not
   a selectable executor or Vault in the current release.

Moving between rungs requires explicit adoption. Airship probes the exact
primitives it relies on and adopts a new authority only after configuration,
encryption, migration, recovery requirements, and the applicable contract
succeed. A capability enhancement and a durability authority are labeled
separately. Provider success is shown separately from untested cross-device
convergence, and no rung inherits a TEE claim from another.

### 7.3 Connect private inference

1. Open Connection. Scoped **Sign in with Chutes** is the first-party default
   and primary action; direct API keys and other providers are explicit advanced
   paths.
2. Discover models from Chutes and select an eligible model.
3. Choose **Verify & record** (recommended) or deliberately enable the advanced
   **Strict fail-closed** endpoint-proof policy.
4. Airship creates a new provider/model-pinned session.
5. Each supported turn uses the Chutes E2EE transport and independently evaluates
   fresh endpoint evidence before promoting any TEE claim. Verify & record keeps
   incomplete claims explicit without breaking encrypted chat; Strict fail-closed
   stops before inference unless every required CPU, GPU, freshness, policy, and
   endpoint-key claim verifies.
6. The completed turn exposes its receipt and claim stack in Chat and Proof.

Localhost uses the deployed confidential Chutes registration through a
same-origin token handler whose secret exists only in the local process. The
browser still generates S256 PKCE and keeps tokens in page memory. A static
production PWA must use a reviewed public Browser/native registration and
exchange directly with Chutes. A shared secret is never embedded in JavaScript,
WASM, an extension, or a distributed binary.

### 7.4 Work on code

1. Import a supported public repository snapshot or create files in Workspace.
2. Use VS Code's proven workbench grammar without adopting its branding or
   source: Explorer and Source Control share one activity rail; single-click
   opens one italic preview, double-click or editing pins it, middle-click
   closes a tab, and file-type icons, filtering, drag/drop, and tree expansion
   behave consistently.
3. Inspect Source Control as a path tree, expand recent origin commits, open
   working or historical diffs as editor tabs, reveal a changed file in
   Explorer, stage/unstage, commit, and manage browser-owned branches and linked
   worktrees. Each linked checkout has its own conventional `HEAD` and index
   while objects and refs remain one shared browser-owned Git database.
4. Authenticate to GitHub through a reviewed memory-only browser flow when
   available, or import/export files, folders, and complete repository archives
   through explicit capability paths.
5. Open a resizable terminal in the workbench at the selected file/directory or
   manage the same persistent Profile-local sessions in the full Terminal view.
6. Workspace changes feed the client context pipeline and become eligible for
   provenance-bearing retrieval.

The browser terminal is a real browser execution surface, not a fake host shell.
It does not imply Bash, SSH, arbitrary host files, or native process access.
The product target is nevertheless persistent Bash in a Linux sandbox;
the current browser runtimes are evidence-bound intermediate capability tiers,
not permission to redefine that target downward.

### 7.5 Inspect trust

1. Open the proof chip on a completed response or navigate to Proof.
2. Read the dominant verdict and plain-language summary first.
3. Distinguish encrypted transport, fresh evidence, protected CPU/GPU claims,
   endpoint-key binding, model artifact, conversation binding, and payment
   standing.
4. Inspect the named authority, freshness, measurements, warnings, and raw-data
   availability for each claim through progressive disclosure. Receipts,
   quotes, measurements, assertions, verification records, TDX evidence,
   NVIDIA confidential-computing evidence, and conversation evidence remain
   accessible; simplification may reorganize them but never discard them.
5. Export the privacy-safe status summary or receipt where supported.

The canonical flow requires evidence acquisition after every supported
completed turn and governed terminal action. Manual refresh is a
retry/diagnostic control, not the normal route to proof. Missing, stale,
unsupported, and failed acquisition states remain distinct and explain their
security consequence. Section 17 records current inference and terminal
coverage rather than implying that the complete target has shipped.

### 7.6 Change agent behavior

1. Create or revise a Profile.
2. Select a semantic theme and global/per-profile Skills.
3. Inspect actual device Capabilities independently of instructions.
4. Apply the revision, which starts a new pinned conversation session.
5. Existing conversations retain their original prompt, skills, theme digest,
   tool schema, provider/model, and receipt policy.

## 8. System architecture

```text
+------------------------ user-controlled device -------------------------+
| Static PWA shell: Preact, CSS, service worker, route-lazy UI             |
|                                                                          |
| Agent runtime                                                            |
|   immutable session journal · turn loop · context assembly               |
|   tool registry · approvals · cancellation · receipts · profiles         |
|                                                                          |
| Browser adapters                                                         |
|   virtual workspace · Git · terminal/execution · indexing · memory       |
|   Web Crypto · Rust/WASM E2EE and verifier packs · encrypted Vault       |
|                                                                          |
| Narrow ports                                                             |
|   Inference · Workspace · Session · ObjectStore · SourceControl          |
|   Tool · Approval · Auth · Attestation · Account · Payment · Execution   |
+-----------------------------+--------------------------------------------+
                              | direct, scoped service calls
          +-------------------+--------------------+------------------+
          | Chutes inference and evidence          |                  |
          | Google Drive or S3-compatible storage  |                  |
          | Identity, account/payment, MCP, or optional sandbox       |
          +-----------------------------------------------------------+
```

TypeScript owns browser orchestration and UI interop. Rust/WASM is used where
portable codecs, cryptography, verification, recovery, or compute density
justify it. Airship does not move all glue into WASM merely to claim a single
implementation language.

### 8.1 Narrow-waist contracts

- `InferenceTransport` streams typed model, tool-call, usage, completion, and
  failure events and reports only its established posture.
- `SessionStore` appends immutable events and reads bounded materializations.
- `WorkspacePort` provides revision-aware virtual file operations.
- `ObjectStore` provides the conditional immutable operations needed by
  encrypted manifests and journals.
- `SourceControlPort` normalizes browser-owned repository and worktree state.
- `Tool` declares JSON input, effects, limits, cancellation, and replay safety.
- `ApprovalPolicy` asks, permits, or denies an operation independently of the
  model's request.
- `AttestationVerifier` emits granular evidence results without turning
  assertions into verified claims.
- the compute-continuum planner keeps browser and remote executors behind one
  prepared job contract while preserving their different authorities and proof;
- `AuthPort`, `AccountTelemetryPort`, and `PaymentPort` keep identity, provider
  telemetry, and payment authority outside canonical agent events.
- execution and semantic packs advertise availability before use and remain
  optional.

No provider SDK or UI component belongs in the canonical session format.

### 8.2 Canonical turn lifecycle

1. Acquire or validate the session writer identity.
2. Append the raw user request with stable session and turn IDs.
3. For a retrieval-enabled v2 session, select, canonicalize, verify, and append
   query- and silo-bound context; failure still receives exactly one durable
   terminal event.
4. Materialize the pinned prompt, tools, profile/skills, and bounded context.
5. Establish the required inference/evidence posture.
6. Stream typed assistant parts and checkpoint bounded deltas.
7. Persist a complete tool request before approval.
8. Approve or deny; execute at most once under a stable operation ID; persist
   the result.
9. Continue until completion, cancellation, failure, or the step limit.
10. Finalize the receipt, append the terminal event, reconcile an ambiguous
    storage acknowledgement by reading the journal head, advance durable state
    when configured, and release the writer.

Retries recover prior immutable results instead of repeating side effects.
Optimistic UI never upgrades a durability or proof claim before its commit.

## 9. State, storage, and recovery

### 9.1 Device state

Decrypted working state and bearer credentials are page-memory values by
default. Cache Storage may retain versioned static assets. Local storage is
limited to non-sensitive preferences and opaque navigation hints. Airship does
not place bearer tokens, provider secrets, plaintext workspaces, or raw
workspace keys there.

The implemented Local Device Vault is a browser-owned durability authority,
not the cache described below. It stores client-encrypted objects and encrypted
heads through OPFS with IndexedDB fallback, enrolls a non-extractable local key
handle, requires an explicit recovery ceremony, can request persistent browser
storage, and supports encrypted export/restore. Its proof is scoped to the
observed browser profile and storage backend; it cannot claim cross-device
availability or protection against browser/OS eviction.

An OPFS-first, IndexedDB-fallback acceleration cache is implemented for bytes
that have already crossed the client encryption boundary. A dedicated worker
uses `FileSystemSyncAccessHandle` only after a real probe succeeds. Mutable
heads, listings, conditional creation, and CAS remain provider-authoritative;
cache corruption or eviction is a miss. The cache never receives plaintext,
bearer credentials, or the workspace root key and is not a prerequisite for
correctness. Browsers and operating systems may suspend or evict a PWA;
Airship does not promise background execution after suspension.

### 9.2 Durable object model

Airship encrypts independently authenticated objects and advances a small
encrypted head/manifest through conditional writes. Immutable segments are safe
to retry. A stale writer loses the compare-and-swap rather than overwriting a
newer head. Conflicts branch or stop; they do not silently merge agent history.

| Vault mode | Current status | Canonical use |
| --- | --- | --- |
| Local Device | Implemented; conditional on browser OPFS/IndexedDB, key-handle, locking, quota, and retention behavior | Recommended first durable rung for encrypted, offline, browser-profile-local work |
| Google Drive | Implemented preview, conditional on Google client configuration, browser authorization, and outstanding real-provider release gates | Recommended user-owned encrypted workspace folder |
| S3-compatible | Implemented; full local MinIO conformance path, provider deployment remains conditional | Advanced provider integration and development lab |
| Ephemeral | Implemented | Page-memory testing and deliberate non-durable work |
| Extension/companion | Implemented enhancement interfaces, not an authoritative Vault | Allowlisted relay, ciphertext cache, and measured helpers until a store passes the full Vault contract |
| Chutes CPU TEE | Planned/external; no operational executor or storage authority | Future attested E2EE compute, inference, and encrypted-storage offload |
| Walrus / WalruS3 | Experimental transport/design work | Not an authoritative Vault until auth, lookup, range, and atomic-head contracts pass |
| Shelby | Integration candidate | Preferred only after browser-safe delegated auth and authoritative head semantics exist |

A successful provider probe establishes only the operations it measured. It
does not certify multi-device convergence, availability outside the observation
window, or inference security.

Google Drive requests `drive.file` plus basic OpenID identity scopes. It can
access only Airship-created files, not the user's whole Drive. Its top-level
workspace folder is user-visible and renameable; the encrypted routing index and
opaque segment files below it are implementation data. Real Google ETag/CORS
CAS, independent-context races, garbage collection, sharded indexes, and
recovery UX must pass before the adapter may say `synced` or `cross-device
ready`.

## 10. Inference, authentication, and proof

### 10.1 Connection methods

- **Chutes sign-in (first-party default):** Authorization Code with S256 PKCE and the requested
  `openid`, `profile`, `chutes:invoke`, and `billing:read` scopes. Actual grants
  remain provider-authoritative.
- **Direct Chutes API key:** an explicit advanced alternative for model,
  inference, profile, and account reads that the key is actually authorized to
  perform.

The two methods are mutually exclusive in one page session. Credentials remain
in memory and may be cleared at any time. OAuth identity does not itself prove
model access, account standing, E2EE use, or TEE identity.

### 10.2 Chutes E2EE

Supported Chutes turns use the repository's Rust/WASM E2EE v1 transport.
Encryption protects application payloads to the compatible endpoint. It is not
presented as attestation until fresh evidence binds the endpoint key and named
runtime measurements to the exact policy used by the turn.

### 10.3 Attestation and receipts

Proof is claim-scoped. The claim stack keeps at least these dimensions separate:

- encrypted transport;
- evidence freshness and nonce use;
- protected CPU runtime / Intel TDX evidence;
- protected accelerator / GPU evidence;
- endpoint-key binding;
- model artifact and runtime policy;
- request/response conversation binding;
- payment or account standing.

The browser evidence engine performs bounded acquisition and parsing. A deferred
Rust/WASM DCAP QVL pack can perform Intel collateral, CRL, QE identity,
signature, validity-window, debug, and TCB evaluation locally. GPU evidence,
published measurements, model identity, and signed conversation/payment claims
remain independently evaluated and may be partial or unavailable.

Conversation receipts record what Airship observed. Unless backed by a named
signer or authority, they are portable integrity records—not proof of authorship
or an enclave signature. Journal auditing checks local structure, ordering,
protocol, manifest, and receipt bindings; a valid local hash chain is not remote
attestation.

For supported completed turns, evidence acquisition is automatic, bounded, and
linked to the exact session, turn, endpoint, and policy. The Proof surface first
presents a comprehensible verdict and claim stack, then preserves access to all
underlying receipts, quotes, measurements, assertions, verification records,
warnings, and raw-data availability. A manual refresh can retry acquisition or
diagnose an external failure; it is not evidence itself and must not be required
for the normal successful path. Terminal and other governed local actions must
join the same Profile/session audit model as their adapters become capable of
emitting receipts. Section 17 distinguishes the supported inference path from
the still-planned durable terminal and complete evidence paths.

The acquisition scheduler is Profile-partitioned and CAS-checkpointed through
the active authoritative `WorkspacePort`. Page-memory mode remains explicitly
page-lifetime; a client-encrypted Vault gives the checkpoint that port's
encrypted durability. Authority transitions dispose the old page controller
before workspace migration, and reconnection recovers interrupted work without
assuming it completed. Complete credential-free endpoint records are now a
separate Profile/session/receipt-partitioned CAS checkpoint through the same
active port, including bounded raw quotes, certificates, GPU/provider evidence,
nonces, endpoint keys, report data, bindings, measurements, and verifier
results. Recovery is ordered credential-backed client → matching record store →
queue; without a credential the queue remains paused rather than failed. The
cache retains at most 32 complete records, 3 MiB per record, and 12 MiB per
Profile checkpoint, with no silent age pruning or eviction. Anything beyond a
boundary remains visibly page-only as a whole record and is never silently
truncated. Client request caches and credentials remain page-memory only, and
this bounded cache is not a complete proof archive.

### 10.4 Account and commerce

The Account surface reads balance, subscription/runway, provider-reported
charges, quota, and live invocation headers directly from Chutes when the
credential permits it. Telemetry is time-scoped provider data, not a
cryptographic receipt.

Account uses one Chutes-first provider inventory followed by OpenAI, Anthropic,
and xAI. It renders authenticated identity, quota, usage, reset windows, and
account-management links only when an authorized integration has actually
observed them. A missing field is **Not provided** or **Unavailable**, never a
fabricated zero or anonymous identity; each supplied observation carries its
source boundary and time. The implemented presentation seam is
credential-free, so Account cannot gain provider authority merely by rendering
host-supplied telemetry. Chutes identity and rich telemetry are implemented;
the other provider observations remain conditional on their real integrations.

Airship-managed subscriptions, pooled Chutes funding, Stripe entitlement
issuance, and settlement receipts are not implemented. Any future commerce
adapter must preserve the no-hidden-backend rule or identify the external
authoritative service plainly.

## 11. Agent, tools, and approvals

The system prompt situates the model in the capabilities actually available to
the current browser runtime. It must not teach the model to claim tools that are
not installed or ready.

The core includes virtual workspace inspection and mutation, browser-safe
network retrieval, context search, planning, Git operations, and execution-pack
controls. Slash commands expose deterministic operations even without an
inference connection.

Approval modes are:

- **Ask First:** obtain user approval for governed effects.
- **Auto Approve:** perform an additional bounded model review and automatically
  proceed only when policy permits; the reviewer cannot grant a missing
  capability.
- **Full Access:** skip discretionary prompts within the capabilities and
  boundaries the user has explicitly made available. It does not escape the
  browser sandbox or provider authorization.

Arguments shown for approval are bounded and recursively redacted. Timeout,
abort, malformed identity, and stale-session conditions deny safely.

## 12. Workspace, Git, and execution

### 12.1 Workspace Editor

The Editor combines a hierarchical file explorer, multiple editable tabs,
revision-fenced saves, drag/drop or mobile move actions, and a Source Control
rail. File and Git views project the same browser-owned workspace; importing a
repository must update both rather than creating an invisible second store.

The canonical workbench interaction grammar is behavioral, not decorative:

- Explorer and Source Control are adjacent activities in one workbench, not a
  separate repository-manager product;
- one single-click preview tab is italic and replaceable; double-clicking or
  editing pins it; middle-click closes a closable tab;
- file-type icons, tree filtering, reveal-in-Explorer, drag/drop, keyboard
  navigation, and mobile move actions operate on the same document model;
- working changes and recent origin commits remain path trees, and opening a
  changed or historical file creates a diff document in the editor;
- GitHub authentication, when available, uses reviewed browser-safe credentials
  and the same repository authority; file, folder, and repository export remain
  available without an account; and
- a resizable contextual terminal can dock below the editor at the selected
  directory while the full Terminal view manages those same sessions.

Source Control has one workbench home. Its compact rail carries repository and
worktree selection, status, staging, commit, history, and diff documents;
import, trust posture, branches, linked worktrees, full selection, tags, and
remote boundaries open in the **Advanced source controls** modal without
unmounting the editor. Historical `#sources` input redirects to the unified
`#editor`; it does not resurrect a second route or mode. The capability-
preservation gate is
[`SOURCE_CONTROL_WORKBENCH_INVENTORY.md`](SOURCE_CONTROL_WORKBENCH_INVENTORY.md).

This complete grammar is the product target. Section 17 records which pieces
are implemented and which still require work.

### 12.2 Browser Git

The lazy browser Git adapter uses a standards-compatible Git engine against the
same authoritative `WorkspacePort` as Editor and Terminal. Implemented local
operations include real status, diff, stage/unstage, commit, branch creation,
and branch switching over conventional objects, refs, `HEAD`, config, and
binary index files. Conventional linked worktrees use a `.git` pointer,
`.git/worktrees` administration metadata, independent indexes, and a filesystem
`commondir` projection onto the one shared object/ref database. Public GitHub
snapshot admission creates a genuine local repository while honestly omitting
upstream history. Full-history Smart HTTP clone and fetch are conditional on
remote browser CORS. Push uses a reviewed memory-only credential callback and
an explicit ambiguous-result contract. Airship does not insert a proxy.

Terminal Git uses a deterministic command bridge into that same adapter and
active approval policy. The Node WebContainer intentionally excludes `.git`
from arbitrary process snapshots, so it cannot bypass Workspace compare-and-
swap or silently diverge from Editor. This is one repository with two honest
interfaces, not a mirrored native checkout.

### 12.3 Terminal and execution packs

- disposable JavaScript Worker execution is implemented;
- a pinned `browser_wasi_shim` 0.4.2 WASI Preview 1 command runner is implemented
  with a bounded virtual-workspace snapshot and revision-checked writeback;
- Pyodide Python is an explicit, lazy, disposable execution pack with bounded
  workspace snapshot/writeback behavior;
- Node/npm projects can use a lazy WebContainer pack when the browser and
  provider boot and a real npm process probe successfully; sequential commands
  for one workspace root share page-local dependencies without persisting
  `node_modules`;
- a governed workspace-program Worker can compose only exact, predeclared
  workspace reads and revision-checked `text_editor` batches under one
  manifest-bound write approval;
- xterm renders real streaming terminal sessions over those browser runtimes.

JavaScript, WASI, Pyodide, and WebContainer execution expose bounded live output,
hard cancellation, and capability-tier provenance. Chromium acceptance runs a
real Rust-produced `wasm32-wasip1` artifact through WASI and proves stdout,
stderr, exact nonzero status, virtual-workspace I/O/writeback, failed-command
non-adoption, and termination of a runaway Worker. This is a precompiled-command
path, not a Rust compiler, Cargo, Bash, socket runtime, or host filesystem.

Current live terminal process state and unflushed stream bytes are page-memory
values. Bounded transcript/history metadata follows the selected workspace
durability. Revisiting an active route may retain the live browser process, but
refreshing the page makes that process restart-required; Airship does not claim
a background PTY daemon.

The implemented Workspace presentation has a resizable, collapsible terminal
dock below the editor. Explorer opens the dock at the exact selected directory
(or a selected file's parent), and the dock and full Terminal route share the
same Profile-owned `BrowserTerminalManager` session authority and selected tab.
Dock open/height/selection state is scoped by workspace and Profile for the
browser session. Collapsing the presentation does not close its tab or process;
an explicit close still reconciles and terminates that tab. Pointer and keyboard
resize controls are equivalent, and the phone layout keeps the operation set
plus an explicit full-view action. This is a WebContainer `jsh` surface and does
not strengthen the process/runtime claim below.

The current browser tier does not provide host Bash, Docker, SSH, arbitrary
native binaries, or unrestricted host filesystem access. A native companion or
remote sandbox may implement those same execution contracts later and must label
its capability tier on every result.

The canonical Terminal target is a persistent, Profile-owned Bash environment
in a Linux sandbox with ordinary Git and the developer tools its capability
manifest truthfully reports. A terminal session retains its stable ID and
user-visible name, Profile/workspace binding, CWD and editor origin, command
history, encrypted transcript, and audit lineage according to the active
durability rung. A page reload may require a process restart, but durable
history must distinguish that restart from a lost session. Workspace
reconciliation occurs automatically at safe boundaries, exposes conflicts,
and never silently overwrites Editor state.

Every command records bounded start, result, exit, and adopted filesystem/Git
effects into Profile/session-local Proof. Full Access may authorize destructive
work inside the selected sandbox; it does not grant host or provider access that
the runtime lacks. The present WebContainer/WASI/Worker terminal and Shared Git
bridge do not yet satisfy this complete Bash, persistence, direct-Git, and audit
target and remain labeled as implemented intermediate tiers above.

### 12.4 Browser-to-executor compute continuum

Airship's compute continuum is transparent at the typed tool/job boundary, not
at the operating-system process boundary. The implemented planner selects a
ready browser adapter by default. It deliberately cannot select a remote
executor: provider assertions, verified-evidence observations, and
channel-bound observations all remain non-executable until a private broker can
mint verifier-owned readiness and exact prepared-effect approval capabilities.
A `remote-confidential` job never downgrades.

The implemented remote-stream structural validator requires a single exact
acceptance, bounded binary-safe and digest-linked ordered frames, at most one
authorized encrypted workspace delta, locally recomputed stream/result
commitments, and a terminal event. Its unkeyed digest chain establishes only
internal consistency; the future AEAD channel or attested terminal signature
must establish peer authorship. The repository does not yet ship a Chutes
remote executor, attested application channel, remote Linux image, signed
terminal receipt, or workspace-delta adoption, so remote placement remains
unavailable. The implemented browser-only lifecycle skeleton adds strict
ordering, sticky cancellation, bounded recovery counters, and adoption guards,
but it is not an authority boundary or operational reconciler: it is not wired
to the execution adapters, and its critical edges do not yet consume
broker/verifier/CAS-minted outcomes.

The target data path stages an immutable browser-selected snapshot and receives
a copy-on-write overlay. It does not forward arbitrary file descriptors or
`mmap` calls across the WAN, delegate storage credentials, or give the executor
the workspace root key. See [`COMPUTE_CONTINUUM.md`](COMPUTE_CONTINUUM.md).

## 13. Context, vectorization, and memory

Workspace changes feed a client-owned incremental pipeline:

```text
discover -> extract -> normalize -> chunk -> embed -> index -> checkpoint
                                              |
query + active scope -> route -> stream selected expert pages -> local fusion
```

Every candidate and result retains lineage to the source revision, content
digest, extractor, chunker, embedding/index generation, scope, and retrieval
budget. Changed content is reprocessed; incompatible models create a new
generation; deletions create tombstones.

The shipped context engine provides bounded lexical and deterministic bootstrap
embedding retrieval over the live virtual workspace. A lazy semantic embedding
pack can use a local model where the browser supports it. WebGPU is an
accelerator, not a correctness requirement; workers/WASM provide portable
fallback paths.

Every eligible non-empty inference turn performs this client-side selection.
At a configurable 80–85% of the provider-catalog capacity copied into the
immutable session manifest, the client appends an iterative digest-linked
summary delta, preserves recent complete turns, and sends the materialized
reference chain instead of replaying the covered raw prefix. Remote sessions use
a separate tool-free call through the selected inference transport; the summary
records provider/model/posture and request/response commitments. A failed call
either retains history or produces an explicitly labeled extractive fallback as
dictated by the same pinned policy. Prior summaries are referenced rather than
copied into each new journal record; immutable source events remain available
for audit. The estimator is tokenizer-agnostic, so measured reduction is
workload evidence rather than a universal ratio claim.

Airship does not download a giant global vector database. It keeps a compact
local routing mirror and streams only selected encrypted expert pages/ranges for
the active workspace, directory, repository, worktree, branch, profile, and
conversation context. Vectors are sensitive derived data and receive the same
encryption and deletion policy as source content.

The Memory graph is a bounded, client-derived materialization over real
messages, files, profiles, skills, terms, and lineage. It offers Neo4j-like
exploration without deploying Neo4j or creating a new authority. It may be
discarded and rebuilt.

## 14. Profiles, themes, skills, and capabilities

Profiles are the primary agent-work silos. The active Profile owns its visible
Chat tree, immutable sessions and forks, workspace/repositories/files, terminal
sessions and transcripts, Memory/index generations, and session-scoped Proof.
Vault, Connection, and Account remain global. The management order is
**Profiles → Skills → Capabilities**: behavior and reusable instructions are
configured before the product reports the runtime resources that can actually
honor them.

A Profile revision pins:

- name, role, and system instructions;
- inference provider/model compatibility;
- semantic theme manifest;
- resolved Skills and tool schema digests;
- workspace binding and memory scope;
- approval policy;
- minimum proof posture.

The session manifest independently records the exact active workspace and
complete tool schema. A profile that names an exact workspace cannot start on a
different runtime workspace. Historical version-one profile pins remain
readable with explicit defaults; new version-two pins carry every silo field.
Approval provenance is still journaled on each governed operation.

The editable profile/theme/skill catalog follows the active storage authority.
Ephemeral mode keeps it only for the page lifetime. An adopted Vault stores one
client-encrypted, content-validated generation head through the provider-neutral
object-store contract. Catalog mutations use conditional writes; a stale device
receives a visible conflict and never overwrites another revision. A fresh,
pristine bootstrap may adopt an existing catalog, while a page with real local
edits must reconcile divergence explicitly.

Themes may change audited semantic tokens such as surfaces, ink, accent,
density, type scale, and motion. They cannot inject arbitrary CSS or remote
assets, and they cannot recolor truth states into misleading meanings.

Skills contribute versioned instructions. A reference to a tool does not grant
that tool. Capabilities report what the current runtime can actually execute.
Approval policy determines whether an available effect may run.

The canonical capability contract probes safe browser, device, extension,
storage, network, and runtime capabilities proactively and offers actionable
activation when consent or a download is required. Every agent turn consumes
the live capability generation so mid-conversation changes become usable
without user prompting. Activation remains bounded by resource budgets,
browser support, explicit permission, and approval policy; unsupported runtimes
stay unavailable rather than appearing as disabled promises. Section 17 keeps
the complete live-awareness target distinct from today's probe coverage.

## 15. Design doctrine

Airship should feel materially precise, calm, fast, and powerful—not themed like
another product and not decorated with unsupported claims.

The governing interface rules are:

1. Show the task before implementation detail.
2. Preserve robust information through progressive disclosure rather than
   deleting it or presenting every contract at once.
3. Give each page one dominant verdict or primary action.
4. Keep model, profile, durability, approval, and trust state stable while the
   user works; controls must not cause layout jumps.
5. Use the same information architecture on desktop and mobile. Mobile is not a
   “lite” product: it retains every route, operation, search, audit detail, and
   recovery path that the platform can support. It may change spatial
   presentation, nesting, and gesture, but not capability meaning; a genuinely
   unavailable device API is labeled as such rather than replaced by a dead end.
6. Use semantic truth tokens and claim-scoped receipt icons consistently.
7. Make failure specific, recoverable, and honest. Never display green because
   a weaker adjacent condition passed.
8. Respect comfortable and compact density across the entire layout, not only
   selected components.
9. Maintain keyboard access, visible control focus, safe-area handling, reduced
   motion, and a readable type floor.
10. Spend bundle, memory, network, and thermal budgets as carefully as visual
    space.

The desktop header labels the local kernel **Browser / Edge runtime**. A
disconnected inference slot is a single **Connect inference** action; it is
never described as “local inference.” Once connected, the compact header names
the provider and model while endpoint trust remains a separate claim-scoped
indicator. Mobile keeps the same meaning in a slim action-or-trust control.

Conversation navigation is deliberately thread-like: a first user prompt can
give a default conversation its bounded title, and the rail shows only title,
last-message preview, and update time. The composer is compact at rest and
expands on focus without hiding slash commands or approval state.

## 16. Portability, performance, and scale

The baseline targets current evergreen Chromium, Firefox, and WebKit browsers,
including installed PWAs and mobile WebViews where required APIs exist. OPFS,
Web Locks, WebGPU, WASM SIMD/threads, WebContainers, passkey PRF, and native
bridges are optional accelerators or capability tiers.

Airship scales differently from a centralized SaaS agent: static assets can be
served by a CDN, and each user talks directly to chosen services. There is no
Airship session database or inference fleet that becomes a global bottleneck.
Provider quotas, identity systems, storage consistency, browser limits, and
device resources still apply.

“Billion-device capable” is an architectural objective, not a completed load
test or compliance certification. Airship must earn that claim through browser
compatibility, accessibility, provider capacity, protocol conformance,
multi-device recovery, operational evidence, and measured deployment results.

Reliability comes from immutable events, stable operation IDs, bounded retries,
conditional writes, cancellation propagation, quarantine of unsupported data,
explicit forks, and deterministic recovery—not from assuming networks or tabs
remain alive.

## 17. Current implementation ledger

### Implemented

- static installable PWA and responsive desktop/mobile shell;
- framework-independent TypeScript agent loop and deterministic local provider;
- immutable session events, pinned manifests, conversation library, audited
  resume, forks seeded with a digest-sealed bounded ancestor context rather
  than copied history, an explicit Profile-local active-conversation pointer,
  and journal-backed user-ordered favorites with convergent concurrent moves;
- an inline Profile-local Chat tree and All conversations surface with
  Favorites before stable recents, pointer drag/drop, keyboard movement,
  explicit touch controls, and synchronous profile presentation fences;
- atomic Profile-cockpit publication with Profile/session-scoped Chat
  draft/viewport state, Workspace documents and repository/worktree selection,
  terminal tab sets, Memory page presentation, session-command/fork authority,
  and session Proof selection/direct-link ownership;
- virtual workspace, multi-file Editor, browser Source Control, and public
  GitHub snapshot import;
- a Profile-scoped resizable Workspace terminal dock with exact-CWD Explorer
  opening and the same manager-owned sessions in the full Terminal view;
- streaming/cancellable JavaScript, WASI, and governed workspace-program
  execution, with conditional Pyodide and WebContainer activation and explicit
  tier provenance;
- fail-closed browser-only compute-continuum placement, an isolated structural
  job-transition skeleton, and digest-linked structural remote-process
  contracts, without advertising or authorizing a remote executor;
- typed tools, slash commands, approval modes, cancellation, and bounded output;
- versioned Profile silos with friendly General, Research, and Developer
  defaults, semantic Themes, global/per-profile Skills, workspace/memory/
  approval boundaries, and runtime Capabilities;
- client context discovery, chunking, hybrid retrieval, full generation/range
  lineage, turn-integrated memory, pinned iterative compression, explicit
  encrypted context-generation publication/update, stale-generation local
  fallback, and Memory relationship graph;
- an encrypted Local Device Vault with OPFS/IndexedDB authority, recovery,
  export/restore, persistence probing, and runtime adoption;
- Google Drive remote, S3/MinIO advanced, and Ephemeral Vault interfaces with
  encrypted state composition, safe provider transitions, recovery material,
  adoption, live contract probes, exact range reads, and active-call Drive
  resumable upload for large encrypted immutable shards;
- OPFS-first dedicated-worker ciphertext acceleration for immutable workspace,
  Git, and context pages, with digest validation and IndexedDB/page-memory
  fallback while provider heads and CAS remain authoritative;
- Chutes OAuth/API-key connection, model discovery/selection, E2EE transport,
  supported-turn evidence acquisition, local Intel DCAP verification pack,
  Proof, and Account telemetry;
- boot and lifecycle browser-capability probing with explicit observed-state
  reporting;
- deterministic static release gate, bundle budgets, unit tests, browser tests,
  Rust tests, and a reproducible full-system local lab.

### Conditional

- Google Drive requires a configured Google OAuth client, successful direct
  browser authorization, and still has unmet real-provider production gates;
- production Chutes sign-in requires a public Browser/native PKCE registration;
- live inference, billing, model availability, and evidence depend on Chutes
  scopes, account standing, endpoint behavior, and browser-readable service
  contracts;
- a TEE badge requires fresh evidence and successful verification for the exact
  endpoint/turn; E2EE alone remains unattested;
- WebContainers, WebGPU, semantic models, OPFS, and advanced WASM features depend
  on browser/device support;
- extension relay, ciphertext-cache, and compute helpers depend on installation,
  explicit origin/provider allowlists, and observed companion readiness; they
  are not an authoritative Vault or general host bridge;
- remote Git operations require a browser-safe host transport or installed
  adapter;
- cross-device behavior is only as strong as the selected Vault and completed
  key/recovery protocol.

### Planned

- bind each Profile to a durable underlying workspace/files/Git authority, or
  model an intentionally shared binding explicitly, and carry that boundary
  through durable Memory/index generations rather than mistaking isolated UI
  selection for separate storage;
- extend the implemented Profile-partitioned encrypted endpoint-evidence cache
  into a complete proof archive with explicit retention/export policy, durable
  verifier-cache reconstruction, governed local-action Proof, and cross-device
  conformance; current raw records inherit the active `WorkspacePort` but remain
  bounded to 32 records / 3 MiB each / 12 MiB per Profile checkpoint;
- complete historical branch navigation and durable reconstruction for the
  implemented Profile-scoped search, active pointer, favorite order, and
  distinct continue/edit/retry/fork journeys;
- the remaining single-workbench VS Code interaction grammar beyond the
  implemented preview/pinned/diff documents, integrated history,
  reveal-in-Explorer, and contextual terminal: browser-safe GitHub
  authentication, complete tree/action equivalence, and file/folder/repository
  export;
- a persistent Profile-owned Bash/Linux sandbox with ordinary Git,
  encrypted session/history restoration, automatic workspace reconciliation,
  and command/effect receipts in Proof;
- proactive activation of every safe supported runtime, audited live capability
  generations available to each turn, enablement guidance, and bounded resource
  visibility;
- complete automatic, durable, Profile/session-scoped evidence acquisition for
  supported turns and governed local actions, with progressively disclosed Proof
  and manual refresh limited to retry/diagnosis;
- verified mobile feature parity for every route and operation whose underlying
  device capability exists;
- a live attested Chutes CPU TEE Linux sandbox, E2EE application channel,
  encrypted-storage offload, signed execution receipt, and transactional
  workspace-delta adoption;
- certified multi-device convergence and complete recovery ceremony;
- passkey-PRF unlock, enrolled-device key wrapping/revocation, and optional
  user-owned Bitwarden recovery;
- enclave-signed conversation/model/payment receipts across all dimensions;
- general browser Git clone/fetch/push for hosts without CORS through an
  explicitly installed and scoped adapter.

### Explicitly not promised

- arbitrary host shell/filesystem/process access in the PWA;
- guaranteed background work after browser suspension;
- a universal native companion and native PTY;
- Airship-managed pooled inference funding, Stripe subscriptions, or entitlement
  service;
- SOC 2, ISO 27001, GDPR, HIPAA, FedRAMP, FIPS, or other certification merely by
  virtue of this architecture;
- Walrus or Shelby as the authoritative default Vault before conformance gates
  pass.

## 18. Testing and release contract

The ordinary gate is:

```sh
npm run check
```

It covers TypeScript, static security policy, unit tests, production build, and
the deterministic release gate. The build rejects source maps and
credential-shaped payloads, enforces size budgets, checks static-service
boundaries, and produces an explicitly unsigned SHA-256 artifact inventory.
Every shipped JavaScript artifact has exactly one functional owner. Runtime,
route, fork, OAuth, evidence-acquisition, extension-observation, and error-path
chunks must remain absent from the HTML preload graph; the gate measures them
under narrow per-capability budgets instead of pretending deferred capability
is first-paint weight or hiding it inside an aggregate ceiling.

The standalone Playwright browser suite is deliberately separate and expects
the local lab (including MinIO) to be healthy plus outbound reachability to
GitHub for the real public-repository import journey:

```sh
npm run lab:start
npm run test:e2e
```

The local full-system lab is:

```sh
npm run lab:start
npm run lab:status
npm run lab:test
# On failure:
npm run lab:logs
npm run lab:stop
```

It adds a loopback MinIO provider, live storage conformance, Rust suites, Chutes
authorization/evidence contract tests, and the ordinary build/release gate. It
does not run the standalone Playwright suites. The focused master-prompt and
portability matrices are separate:

```sh
npm run test:e2e:master
npm run test:e2e:static-host
npm run test:e2e:portability
```

The static-host gate owns strict port 4193 and serves the built release without
COOP/COEP response headers. A fresh Chromium context must cross exactly one
service-worker takeover reload, become cross-origin isolated with
`SharedArrayBuffer`, avoid a reload loop, and execute Node in the real browser
terminal.
The portability matrix owns strict port 4189 and exercises stable Chrome,
Firefox, WebKit iPhone emulation, Chromium tablet emulation, and a constrained
signal profile. Emulation and API probes are not physical-device certification.
The deterministic Google Drive
browser acceptance path is also separate:

```sh
npm run test:e2e:google-drive
```

That Drive test substitutes only the external GIS and Google HTTP boundaries;
it is not real-Google acceptance. Real Chutes release acceptance is explicit,
fail-closed, and potentially billable:

```sh
AIRSHIP_CHUTES_API_KEY='<memory-only release credential>' \
AIRSHIP_CHUTES_TOOL_MODEL='<exact tool-capable model ID>' \
AIRSHIP_CHUTES_VISION_MODEL='<exact vision-capable model ID>' \
npm run check:release:live
```

Open <http://localhost:4173> after `lab:start`. Local Device is the ordinary
default when no deployable Google OAuth client is configured; selecting
**Vault → S3-compatible / MinIO** explicitly enables the baked loopback provider
and its automatic live probe.

No test may manufacture a green TEE, payment, provider, or durability claim.

## 19. Roadmap gates

Work advances by proved capability, not feature labels:

1. **Private single-device beta:** stable client runtime, local execution,
   recoverable encrypted durability, accessible cross-browser UX.
2. **Multi-device encrypted sync:** device enrollment, key wrapping/recovery,
   leases, conflicts, convergence, revocation, and crypto-erasure.
3. **Attested confidential inference:** production evidence availability,
   complete verifier policies, endpoint/model bindings, signed receipts, and
   failure-mode operations.
4. **Provider and execution ecosystem:** additional storage/inference adapters,
   browser-safe MCP, native companion, and isolated remote sandboxes.
5. **Production and compliance programs:** accessibility evidence, data maps,
   retention/erasure, incident response, regional behavior, vendor agreements,
   independent assessment, and operational SLOs.

## 20. Detailed document map

Start here, then use the smallest relevant specification:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime topology, ports, lifecycle, and
  state model.
- [`PROTOCOLS.md`](PROTOCOLS.md) — canonical encodings and protocol rules.
- [`THREAT_MODEL.md`](THREAT_MODEL.md) — assets, adversaries, and security
  boundaries.
- [`ATTESTATION_RECEIPTS.md`](ATTESTATION_RECEIPTS.md) and
  [`CHUTES_ATTESTATION_EVIDENCE.md`](CHUTES_ATTESTATION_EVIDENCE.md) — receipt
  and endpoint-evidence semantics.
- [`CONTEXT_FABRIC.md`](CONTEXT_FABRIC.md),
  [`SEMANTIC_EMBEDDING_PACK.md`](SEMANTIC_EMBEDDING_PACK.md), and
  [`MEMORY_RELATIONSHIP_GRAPH.md`](MEMORY_RELATIONSHIP_GRAPH.md) — retrieval,
  embeddings, and memory exploration.
- [`BROWSER_GIT.md`](BROWSER_GIT.md),
  [`SOURCE_CONTROL_WORKBENCH_INVENTORY.md`](SOURCE_CONTROL_WORKBENCH_INVENTORY.md),
  [`BROWSER_EXECUTION_PACKS.md`](BROWSER_EXECUTION_PACKS.md), and
  [`TERMINAL_ENGINE_ARCHITECTURE.md`](TERMINAL_ENGINE_ARCHITECTURE.md) — coding
  workspace capabilities; [`COMPUTE_CONTINUUM.md`](COMPUTE_CONTINUUM.md)
  defines explicit browser/paired-executor placement and remote job proof.
- [`LOCAL_DEVICE_VAULT.md`](LOCAL_DEVICE_VAULT.md),
  [`GOOGLE_DRIVE_VAULT.md`](GOOGLE_DRIVE_VAULT.md),
  [`VAULT_COMPOSITION.md`](VAULT_COMPOSITION.md), and
  [`STORAGE_CONFORMANCE.md`](STORAGE_CONFORMANCE.md) — durability providers and
  storage correctness; [`CLIENT_STORAGE_ACCELERATION.md`](CLIENT_STORAGE_ACCELERATION.md)
  defines the non-authoritative OPFS/IndexedDB ciphertext cache, and
  [`KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md`](KEY_CUSTODY_AND_DEVICE_ENROLLMENT.md)
  defines recovery wrappers and device enrollment.
- [`ACCESS_AND_COMMERCE.md`](ACCESS_AND_COMMERCE.md),
  [`ACCOUNT_TELEMETRY.md`](ACCOUNT_TELEMETRY.md), and
  [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md) — connection, account, and model
  behavior.
- [`AIRSHIP_DESIGN_BLUEPRINT.md`](AIRSHIP_DESIGN_BLUEPRINT.md) and
  [`DESIGN_LANGUAGE.md`](DESIGN_LANGUAGE.md) — design reasoning and visual
  system; use this canon for later navigation/product decisions.
- [`LOCAL_FULL_SYSTEM_LAB.md`](LOCAL_FULL_SYSTEM_LAB.md) and
  [`RELEASE_GATE.md`](RELEASE_GATE.md) — development and release verification.
- [`ROADMAP.md`](ROADMAP.md) — milestone sequencing; this canon determines
  whether a capability is described as implemented, conditional, or planned.
- [`VOICE_REVIEW_DISTILLED_2026-07-28.md`](VOICE_REVIEW_DISTILLED_2026-07-28.md)
  and [`VOICE_REVIEW_BACKLOG_2026-07-28.md`](VOICE_REVIEW_BACKLOG_2026-07-28.md)
  — the source-faithful product-shaping record and its implementation-status
  reconciliation. They guide future canon revisions but do not override this
  document's current implementation/trust claims on their own.
- [`LINEAGE.md`](LINEAGE.md) — inspiration, clean-room boundaries, and licensing
  provenance.

## 21. Decisions this canon explicitly supersedes

The following later decisions replace older descriptions that remain useful as
design history:

- Mobile uses four fixed controls—Chat, Workspace, Trust, More—not the Design
  Blueprint's earlier five-tab model. Those controls are responsive containers,
  not a reduced feature set; every canonical route and operation remains
  reachable where its underlying device capability exists.
- The active Profile, not the older Work/Agent/Trust filing, is the primary
  desktop orientation and data silo. Chat, Workspace, Memory, terminal state,
  indexes, and session Proof are Profile-local; Vault, Connection, and Account
  are global. Any currently shipped rail placement that disagrees is incomplete
  implementation, not a competing doctrine.
- Chat uses an inline Profile-local Favorites/Recent tree and Profile-scoped All
  conversations/search. This supersedes detached recent-conversation flyouts and
  browser-history-dependent resume behavior. Continue, edit, retry, and fork
  retain the distinct immutable meanings in section 3.4.
- Source Control is integrated into Workspace → Editor. It is not a separate
  top-level destination; `#sources` is only a compatibility alias.
- Attestation evidence is reviewed inside Proof. It is not a competing
  top-level Attestations destination; `#attestations` is a compatibility alias.
- The older “Google Drive first” wording now means first ordinary-user **remote**
  adapter, not the first durable rung. The canonical ladder is page memory →
  encrypted Local Device → extension-enhanced local capability → Drive or
  S3-compatible remote durability → future Chutes CPU TEE. Extension enhancement
  is not presently an authoritative Vault, Drive remains preview until its
  real-provider gates pass, and Chutes CPU TEE remains planned/external.
- The opt-in pinned semantic embedding pack is implemented and locally
  executable. Deterministic hash embeddings remain the startup baseline, and
  production-scale persisted semantic generations remain a later gate.
- The optional Node/WebContainer execution pack is implemented but conditional
  on browser and provider boot support; it is not universal host Node. This
  truthful current limit no longer defines the Terminal product target, which is
  a persistent, Profile-owned, audited Bash/Linux sandbox.
- Safe capability probing and activation are proactive, and every turn consumes
  the live capability generation. Older opt-in/manual runtime controls remain
  honest intermediate UX only where downloads, consent, cost, or unfinished
  implementation require them.
- Proof defaults to automatic supported-turn evidence acquisition and a complete
  progressively disclosed claim stack. Manual refresh is retry/diagnosis, not
  the normal proof path; terminal/action receipts and complete durable evidence
  remain planned where the ledger says so.
- Chutes OAuth sign-in is the first-party default Connection action. API keys
  and other providers remain explicit advanced alternatives; production OAuth
  is still conditional on a reviewed public registration.
- Chutes OAuth uses S256 PKCE in both modes: the checked-in localhost app uses
  its same-origin process-held token handler, while hosted static deployments
  require token authentication `none`. No extension or distributed binary can
  keep a shared embedded secret confidential from its owner.
- Browser-readable endpoint evidence and local Intel DCAP verification exist
  today. Complete bounded credential-free endpoint records inherit the active
  Profile's `WorkspacePort` durability and support an explicitly labeled raw
  verification bundle; the client cache and credentials remain page-only.
  Stronger model, NVIDIA, conversation, and settlement proofs remain separate
  future/provider protocol gates.
- A paired executor is a separately attested execution subject. It does not
  inherit proof from Chutes inference, and “transparent” means one Airship job
  contract rather than live browser-to-Linux process migration.
- Hermes' Bitwarden integration is local-CLI inspiration only. Airship never
  embeds or persists a shared machine-account token; any future integration is
  user-owned, optional, memory-only, and limited to one recovery wrapper.

## 22. Lineage and originality

Airship takes behavioral inspiration from Hermes Agent's narrow agent loop and
session discipline; `claw-code` and `claude-code-rs` as clean-room examples of
capable coding agents; Open WebUI's mature conversation ergonomics; VS Code's
workspace, source-control, editor, and terminal interaction grammar; and the
useful incremental-indexing/retrieval concepts associated with CocoIndex and
Pinecone. Those references inform jobs and interaction patterns, not Airship's
brand, visual theme, canonical protocols, or permission model.

Reference repositories are non-shipping research material. The clean-room
workflow is mandatory even when a repository is public or permissively
licensed:

1. Record the repository, revision, license, files/behaviors studied, and the
   Airship problem being informed in [`LINEAGE.md`](LINEAGE.md).
2. Extract a pure functional specification: user job, observable inputs and
   outputs, public interfaces, state transitions, invariants, error behavior,
   accessibility behavior, and interoperability constraints.
3. Implement original Airship code from that specification and Airship's own
   architecture. Do not copy source text, distinctive internal organization,
   assets, branding, product strings, or look-and-feel.
4. Review the result for independent naming, structure, tests, and protocol
   boundaries, and retain the provenance note with the implemented decision.

This information barrier does not erase license, notice, patent, trademark, or
other obligations. If code is deliberately reused under its license rather than
clean-room reimplemented, it must be treated as a dependency or vendored work
with explicit approval and attribution; it must not be described as clean-room
original. The default for the ignored reference library is idea-level study and
fresh implementation.

The resulting implementation is an original browser-first architecture rather
than a source fork. [`LINEAGE.md`](LINEAGE.md) remains the durable provenance,
clean-room-boundary, and licensing record.

## 23. One-sentence test

If a proposed feature cannot preserve this sentence, it is not yet an Airship
feature:

> Airship lets a user run a capable, stateful agent from their own device,
> disclose plaintext only to services they deliberately select, keep durable
> state encrypted and portable, grant every capability explicitly, and inspect
> the evidence behind every important claim—without depending on a hidden
> Airship application backend.
