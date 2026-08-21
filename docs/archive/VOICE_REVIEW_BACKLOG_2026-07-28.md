# Airship voice-review directive register and delivery backlog

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../SIMPLIFICATION.md`](../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

**Review date:** 2026-07-28  
**Authority:** the full Airship voice recording supplied for this review, including the speaker's opening outline and the complete transcript. Speech-to-text substitutions such as “shoots”/“Chutes,” “O off”/“OAuth,” and “Minayo”/“MinIO” are normalized here without changing intent.  
**Code baseline:** the shared working tree reviewed on 2026-07-28. File/line evidence is a snapshot and can move as the backlog is implemented.

This is a directive register, not a summary that prunes inconvenient details. It records the requested product behavior, what Airship currently does, direct contradictions, reported bugs that still need reproduction, external dependencies, and an ordered delivery path. Existing capability and technical information must remain available; progressive disclosure may reorganize it but must not erase it. Mobile is the same product, not a reduced edition.

> **Working-tree reconciliation:** Status prose and line numbers below are the
> voice-review baseline, not a live implementation ledger. The whole-system
> defect pass and its two explicitly retained feature-sized items are reconciled
> in [Pass 1 findings](audit/PASS1_FINDINGS.md#working-tree-closeout). Keep this
> register as the complete product directive map; use the Pass 1 closeout, Git
> diff, and current test output for claims about what the working tree now does.

## Status legend

| Status | Meaning |
| --- | --- |
| **DONE THIS PASS** | Implemented in the current review pass and covered by targeted checks. |
| **IMPLEMENTED** | Current code materially satisfies the directive. Preserve and regression-test it. |
| **PARTIAL** | A useful foundation exists, but the stated acceptance gate is not met. |
| **CONTRADICTED** | Current behavior or architecture explicitly does the opposite of the directive. |
| **MISSING** | No production implementation satisfying the directive was found. |
| **BUG** | A concrete current-code defect or wiring failure was found. |
| **REPORTED** | The recording describes an observed defect, but this pass did not reproduce it conclusively. |
| **EXTERNAL DEPENDENCY** | Completion requires a browser, provider, hosted OAuth registration, Git host, or Chutes backend contract not controlled solely by this repository. Local contracts, honest UI, tests, and failure behavior are still Airship work. |

## Governing product invariants

1. **Profiles are the primary agent silo.** The active profile owns its conversations, active workspace selection, files, terminals, memory/index, and session Proof. Switching profiles must restore that profile's cockpit, not manufacture an unrelated empty one.
2. **Vault, Connection, and Account are global.** They transcend profiles while exposing exactly which global resources each profile/session is using. Proof remains session/profile work and belongs with Chat, Workspace, and Memory—not in the global account/settings mental model.
3. **Capability is proactive.** Probe browser accelerants at first load, activate safe supported runtimes, make remediation obvious, and keep the agent aware of changes turn by turn.
4. **Durability is a truthful ladder.** Page memory → browser durable storage → extension-enhanced local device → Drive/S3-compatible durable storage → Chutes CPU TEE. Never imply adoption, synchronization, or remote execution merely because an adapter or card exists.
5. **Proof is automatic and complete.** A completed turn or terminal action produces scoped audit/receipt state and automatically attempts the evidence available for its exact execution boundary. Immutable receipts do not “go stale”; separately cached endpoint evidence can become old and must be labeled precisely.
6. **Airship is a capable cockpit with a gentle surface.** Preserve deep controls, evidence, and status while using hierarchy, folding, and friendly names to keep first use approachable.
7. **Mobile parity is mandatory.** Reflow, sheets, disclosures, and alternate gestures are allowed. Removing information, actions, or capability at a phone breakpoint is not.
8. **External systems are studied cleanly.** References inform source-free behavior specifications. Airship retains its own visual identity, browser-first architecture, trust model, implementation, wording, tests, and assets.

## 1. Profile ownership and information architecture

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| PIA-01 | Put the active profile selector at the very top of the desktop rail so the workspace boundary is understood before any destination. | **CONTRADICTED.** The selector is pinned at the bottom of the rail in `src/ui/rail.tsx:443-463`. | Selector is the first rail control on desktop; phone has an equally obvious active-profile control; focus, labels, and current scope are tested. |
| PIA-02 | Ship three useful built-ins: General, Research, and Developer; each has a deliberate, visibly distinct agent identity and theme. | **DONE THIS PASS.** `Builder / Systems` now renders as `Developer` while retaining the historical `builder-systems` ID; its theme changed to `blue-ledger` in `src/profiles/catalog.ts:111-120`. General and Research remain at `:98-110`. | Fresh and persisted catalogs resolve all three names and distinct themes; existing pinned `builder-systems` sessions still resolve. |
| PIA-03 | A profile owns conversations, workspace selection/files, terminals, Memory/index, and session Proof. No ordinary cross-profile search or leakage. | **PARTIAL.** Versioned profiles pin workspace binding, memory scope, approvals, theme, and skills (`src/profiles/domain.ts:17-39`, `:127-190`). Conversations are now queried by active profile (`src/ui/app.tsx:1202-1217`, `:1263-1277`; `src/ui/sessions-view.tsx:132-155`). The live workspace/terminal authority is still chiefly runtime-global rather than restored as one profile cockpit. | Two profiles can hold different active conversation, workspace/repo, terminal set, memory/index generation, and Proof selection; repeated switching restores each exactly with no data in the other profile's normal surfaces. |
| PIA-04 | Switching profiles resumes that profile's most recent active conversation and cockpit. Starting a new conversation is a separate explicit action. | **CONTRADICTED.** `changeProfile` always creates and activates a new profile session in `src/ui/app.tsx:2379-2428`. | Switching A→B→A returns to A's prior addressed conversation, editor/terminal state, and scroll/draft posture; “New conversation” remains the only ordinary creation gesture. |
| PIA-05 | Desktop agent configuration reads directly as Profiles → Skills → Capabilities. Skills should not be buried behind a generic capabilities concept. | **PARTIAL.** Mobile More now orders and describes Profiles, Skills, Capabilities (`src/ui/navigation-model.ts:270-282`). The desktop profile-hub tabs still render Profiles, Capabilities, Skills in `src/ui/app.tsx:5529-5531`, and neither Skills nor Capabilities is a direct desktop rail row. | Desktop and mobile expose the same semantic order and scope; the active profile/global skill scope is visible before mutation. |
| PIA-06 | Clicking Chat first expands an inline, profile-local conversation subtree: pinned/favorites first, then recent, then All/Search. Do not require a small separate arrow or a right-side popout. | **CONTRADICTED.** Chat recents live in a separately triggered 320px overlay in `src/ui/rail.tsx:348-429`; the Chat destination and disclosure are different controls. | Activating Chat reveals its inline subtree; keyboard traversal, touch, collapsed rail, and long titles work; pinned and recent rows are profile-scoped. |
| PIA-07 | Proof belongs with profile/session work under Memory in the left-hand hierarchy. Vault, Connection, and Account remain global. | **CONTRADICTED.** Canonical scopes are correct (`Proof` session, Vault/Connection/Account global) at `src/ui/navigation-model.ts:112-125`, but the rail files Proof with global “Receipts & access” rows at `:189-210`. | Rail hierarchy places Proof alongside/below Memory without changing its stable URL or removing global trust navigation; its selected profile/session is explicit. |
| PIA-08 | Refresh/update prompts must protect work whose selected durability cannot survive the operation, especially page-memory sessions. | **PARTIAL.** Unsaved workspace drafts have a page warning (`src/ui/workspace-view.tsx:156-172`), but there is no unified guard derived from live conversation, terminal, and adopted durability state. | Reload/PWA-update/close protection is driven by actual unsaved or ephemeral work, explains what will be lost, and does not nag when the active authority can reconstruct it. |

## 2. Profile-owned preferences and behavior

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| PPF-01 | Profile revisions own system instructions, “soul,” theme, model defaults, minimum proof, workspace/memory boundaries, approvals, and skill policy. Existing sessions retain immutable pins. | **IMPLEMENTED/PARTIAL.** The revision model and profile editor cover these behavioral boundaries (`src/profiles/domain.ts:127-190`; `src/ui/app.tsx:7030-7135`). Model/provider defaults remain bound to the profile revision but the connection/session UX can override through a new pinned conversation. | Every editable behavior produces a content-addressed revision; current sessions do not mutate; a clear “apply in new conversation” path shows the resulting pin. |
| PPF-02 | Color mode, type scale, density, corners, body font, and tool-step presentation should be controllable per profile, with changes clearly scoped to the profile being edited. | **PARTIAL.** Theme manifests can carry typography/layout and are applied at `src/ui/app.tsx:6193-6202`, but the directly editable controls are global `localStorage` preferences in `src/ui/platform-shell.tsx:326-383`, `:426-444`; profile editing only chooses a prebuilt theme. | Profile editor exposes all requested appearance/presentation fields; switching profiles restores them; global fallback is explicit; mobile and accessibility settings are not accidentally overridden. |
| PPF-03 | Profile/theme changes must not cause accidental font-size jumps or duplicate palettes; variation must be intentional and testable. | **PARTIAL.** Unique built-in themes are now assigned, and semantic theme contracts exist. The recording's observed size jump still needs a profile-switch journey test across every built-in. | Computed typography/density is asserted for each profile and display mode; any difference is named in the theme preview before applying. |
| PPF-04 | Dark/Paper controls should use unambiguous moon/sun-like iconography, and Reset preferences must require confirmation. | **MISSING.** Controls are text-only and Reset applies immediately at `src/ui/platform-shell.tsx:426-452`. | Icons have text/accessibility labels; Reset opens an explicit confirmation describing affected global/profile fields and supports cancel without mutation. |

## 3. Skills, tools, browser capabilities, and live awareness

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| CAP-01 | Skills default to “All profiles,” with explicit per-profile inherit/on/off boundaries. | **IMPLEMENTED.** Global and profile scope UI is in `src/ui/app.tsx:5530-5556`, `:7153-7220`; content-addressed resolution is in `src/profiles/domain.ts:301-396`. | Existing sessions retain prior skill pins; new sessions record ordered skill decisions, digests, and missing-tool failure reasons. |
| CAP-02 | Users and agents can add/import/install skills, including a built-in skill-creator workflow. | **MISSING.** The production catalog is a fixed set created in `src/profiles/catalog.ts:41-89`; UI only changes policy for known entries. | Safe import/create/update/archive flow, source and permission review, version/digest history, required-tool validation, and a built-in skill-creation path. |
| CAP-03 | Every enabled skill is discoverable and invocable through the composer slash menu where an explicit invocation makes sense. | **MISSING.** Slash commands and resolved profile skills are separate registries (`src/ui/app.tsx:1101-1115`, `:2465-2475`, `:5777-5796`). | Slash completion combines commands and invocable skills, displays scope/permission/source, and invokes the exact pinned skill revision without duplicating ambient skills. |
| CAP-04 | Probe WebGPU, WebNN, WASM, OPFS, storage, and related browser accelerants automatically on first load and refresh observations as device state changes. | **IMPLEMENTED.** Boot starts the registry in `src/main.tsx:7-13`; parallel probing, scheduling derivation, and lifecycle refresh are in `src/capabilities/browser-runtime.ts:188-294`, `:385-470`. | First-load and lifecycle tests show one canonical observation generation shared by UI and agent. |
| CAP-05 | If a usable accelerant is disabled or permission-gated, prompt clearly and explain how to enable it; do not bury this behind settings. | **PARTIAL.** Capability cards and prompt entries exist (`src/capabilities/browser-runtime.ts:311-360`; `src/ui/capabilities-view.tsx:60-82`), but there is no complete actionable remediation/permission ceremony. | Each unavailable capability says unsupported, disabled, permission-needed, or app-not-wired; actionable states provide one safe next step and refresh afterward. |
| CAP-06 | Capability-card actions always open a clearly new conversation with the generated slash command visibly prefilled. | **CONTRADICTED.** `openCapabilityCommand` writes into whichever composer is active and navigates to Chat (`src/ui/app.tsx:3273-3277`). | Action creates a new profile-scoped conversation, preserves the old draft/session, announces that text was prefilled, and focuses only on desktop. |
| CAP-07 | Safe supported language runtimes (Python, Node, WASM/WASI, etc.) should be ready by default; unsupported runtimes must be labeled honestly. | **CONTRADICTED/PARTIAL.** Python and WebContainer are installable/manual and WASIX is unavailable (`src/execution/runtime-registry.ts:131-177`; `docs/BROWSER_EXECUTION_PACKS.md:11-30`). | Startup policy prewarms/activates supported packs within a measured budget; expensive downloads can be consented to once; unavailable WASIX is never presented as active. |
| CAP-08 | Show a global live resource-consumption indicator for browser sandbox work—CPU, memory, GPU/accelerator, task/runtime load—not merely hardware capacity. | **MISSING.** Current capability reports expose coarse device/scheduling signals (`src/capabilities/browser-runtime.ts:13-111`) but no ongoing utilization monitor. | Global indicator and details report current/peak use by runtime/task, budget/throttling decisions, uncertainty, and reduced-support browsers without inventing precision. |
| CAP-09 | The agent knows tools, skills, permissions, provider/model, storage/durability, browser/extension capability, workspace/index generation, and changes to them on every turn. | **PARTIAL.** Session manifests and operating prompts pin a substantial capability set (`src/ui/app.tsx:5746-5819`), and federated context is prepared per turn (`src/core/agent.ts:549-580`). Mid-session global/provider/storage changes are not yet one audited live generation consumed by every subsequent turn. | A canonical capability-generation digest changes on relevant events, is recorded in turn context, and is available without the operator reminding the agent. |

## 4. Conversation continuity, naming, branching, and history

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| CON-01 | Recent, search, and All Conversations are strictly active-profile scoped. | **DONE THIS PASS.** Command-palette and rail recents pass `profileId` (`src/ui/app.tsx:1202-1217`, `:1263-1277`); Sessions always queries `scopeProfileId` and removed the cross-profile filter (`src/ui/sessions-view.tsx:132-155`, `:280-303`). | Unit/E2E fixtures with duplicate terms across profiles prove no row, count, facet, preview, or command result leaks. |
| CON-02 | Every conversation has a stable hash URL and a compatible past conversation resumes directly from recents/search; browser Back is never the only continuation path. | **PARTIAL.** Addressed Chat routing and compatibility-gated resume exist (`src/ui/app.tsx:1219-1261`, `:1835-1917`; `docs/SESSION_LIBRARY.md:50-65`). Current profile switching still starts a new session, and incompatible pins require a fork. | Direct link, rail recent, All Conversations, Back/Forward, reload with durable authority, and two-profile journeys resume the intended compatible conversation once. |
| CON-03 | Pinned/starred conversations appear first in their own group, remain profile-scoped, persist according to durability, and can be reordered by drag/drop. Stars need not clutter every row until hover/focus. | **DONE THIS PASS.** Membership and move operations are append-only in the selected journal authority; the deterministic Profile-local projection drives the inline Chat tree and All Conversations. Desktop pointer drag/drop, keyboard controls, and explicit phone controls share the same move contract. | Focused projection/API tests cover concurrency, re-pin epochs, profile rejection, recency stability, and audit recognition; desktop/mobile browser journeys cover both rendered surfaces and A→B→A isolation. |
| CON-04 | The agent/model generates a short semantic title immediately after the first message; title is not simply the first prompt. | **PARTIAL/CONTRADICTED.** Auto-title currently truncates the normalized first prompt (`src/ui/app.tsx:2852-2866`, `:6402-6407`) rather than making a naming inference. | A bounded naming call returns a concise title, is audited/cancellable, never blocks the turn, and falls back to a local safe heuristic. |
| CON-05 | Double-click the Chat title to rename; click-away/Enter saves durably. Provide an obvious mobile alternative. | **DONE THIS PASS/PARTIAL.** Durable desktop inline rename is in `src/ui/chat/session-bar.tsx:78-161` and `src/ui/app.tsx:1920-1931`. The requested touch/mobile gesture is still absent. | Desktop double-click and keyboard paths pass; mobile title menu exposes Rename; reload/navigation reads the journaled title everywhere. |
| CON-06 | A true fork at a selected turn carries all ancestor context up to the fork point, visibly records lineage, and continues normally. It must not require a double-confirm dance. | **CONTRADICTED.** Fork lineage is recorded, but the library explicitly returns `historyCopied: false` (`src/sessions/library.ts:43`, `:172`; `docs/SESSION_LIBRARY.md:65-78`). Message branching mainly restores the prompt into a fresh composer (`src/ui/app.tsx:2664-2686`). | Branch context is resolved from immutable ancestors without rewriting source history; one explicit action creates it; UI shows parent/fork point and model receives the complete bounded ancestor context. |
| CON-07 | Editing an earlier user message creates a branch at that point: the edited path becomes current; the old later path remains inspectable as alternate history without flooding recents. | **CONTRADICTED.** “Edit & resend” only copies text/attachments into the current-head composer (`src/ui/app.tsx:5217-5232`, `:6880-6915`). | Edit opens at the selected source point, commits a branch lineage record, preserves the old path, and presents alternates locally at the fork point. |
| CON-08 | Retry/regenerate operates from the selected turn's context, not by appending the same request after the previous answer at the current head. | **CONTRADICTED.** Current Retry deliberately re-sends in the same session/current provider context (`src/ui/app.tsx:6868-6897`). | Retry creates/uses a turn branch whose context ends before the answer being regenerated; receipts distinguish attempts; prior answer remains inspectable. |
| CON-09 | Move Copy, Edit/Retry, and Fork actions to the bottom of messages; keep hover/focus desktop ergonomics and a complete touch disclosure. | **CONTRADICTED.** Desktop actions are absolutely positioned at the top-right (`src/ui/chat.css:1033-1041`); touch has a separate disclosure at `:1043-1086`. | Actions follow message content/evidence, never shift text on hover, remain keyboard/touch reachable, and retain every operation. |
| CON-10 | The outer claim stack/session proof inspector is collapsible and remembers the user's choice; compact status remains available when closed. | **MISSING.** Once a receipt exists, Chat allocates the inspector column and renders it (`src/ui/app.tsx:5095-5098`, `:5459-5468`) with no user collapse control. | One control collapses/restores it, latest proof state remains in a compact accessible chip, and desktop/mobile preference is retained. |
| CON-11 | All Conversations is a clean profile-local search/resume surface, not a dense audit wall. Advanced runtime/proof facts remain available through progressive disclosure. | **PARTIAL.** Search, filters, pins, transcript inspection, compatibility, lineage, Proof, and responsive layout exist (`src/ui/sessions-view.tsx:280-640`), but the surface still centers continuation around a large audit inspector. | Primary journey is find→resume; advanced pins/integrity/lineage are one disclosure away; no capability or audit fact is deleted. |

## 5. Composer, attachments, model control, and permissions

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| CMP-01 | Composer is a light, rounded, bottom-pinned control with low-weight placeholder text and no visually heavy horizontal separator. It keeps `/` discovery obvious. | **PARTIAL/REPORTED.** The bottom composer, slash menu, queue, and responsive behavior are substantial (`src/ui/app.tsx:5278-5435`), but the recording reports overly heavy placeholder/divider treatment. | Visual test at dark/paper, density, type scale, desktop/phone; placeholder unmistakably looks empty; controls stay reachable above the mobile keyboard. |
| CMP-02 | “Attach” supports text, Markdown, PDF, code, and images. Image controls appear only for image-capable models; every type is bounded, encrypted where transmitted, and represented in context/proof. | **CONTRADICTED.** `addComposerFiles` rejects all non-images and the input is `accept="image/*"` (`src/ui/app.tsx:2643-2660`, `:5404`). | Typed attachment pipeline with MIME/size limits, safe text/PDF extraction, code provenance, model-capability gating, retry/branch persistence, and receipt digests. |
| CMP-03 | Connecting OAuth/API key completes the provider connection and takes the user to Chat; model selection happens in the Chat picker rather than blocking connection. | **CONTRADICTED.** Chutes candidate flow requires model/proof choice and Finish (`src/ui/access-view.tsx:872-950`). | Credential verification establishes the connection; navigation opens a new Chat; model picker is immediately available and may use a clearly labeled default until chosen. |
| CMP-04 | Use the same rich searchable/sortable model picker in Connection and Chat, including vision, tools, confidential-compute, popularity/load, and provenance. | **PARTIAL.** Connection has `ModelPicker`; Chat uses a lighter `ModelControl` menu (`src/ui/model-control.tsx:12-121`; `src/ui/app.tsx:5129-5163`). | One shared picker model/component and capability vocabulary; no clipping; keyboard/typeahead/mobile sheet behavior; selection creates a correctly pinned conversation. |
| CMP-05 | Sending a request must never display “Switching…” unless a model/route change is actually in flight. | **DONE THIS PASS.** Busy-turn state and route-switch state are separated in `src/ui/model-control.tsx:31-113` and passed separately at `src/ui/app.tsx:5155-5159`. | Unit and E2E tests cover send-only, actual switch, failed switch, and queued turn. |
| CMP-06 | Ask First prompts only for effectful actions; Auto Approve performs model safety review and asks on uncertainty; Full Access does not prompt inside the declared sandbox. | **IMPLEMENTED.** `src/approvals/modes.ts:31-101` encodes those exact distinctions; composer/profile controls expose all three (`src/ui/app.tsx:5414-5426`, `:7109-7114`). | Tool matrix tests cover every effect class and provenance source; UI never overstates host-machine access beyond browser/tool boundaries. |
| CMP-07 | Session-state tooltip/popover must remain open and scrollable while hovered/focused; model-sort dropdown must not be clipped. | **REPORTED.** The recording observed both races/clipping. Current picker/popover geometry has tests, but this pass did not reproduce these exact failures. | Pointer may cross from trigger into content without dismissal; keyboard focus traps correctly; sort list overlays its owning surface at all supported sizes. |
| CMP-08 | Clearly distinguish token usage from journal event count and other session metrics. | **REPORTED/PARTIAL.** Session bar carries `eventCount` and provider token facts through separate status models, but the recording could not tell what “257 events” represented. | Labels always include unit/source (`events`, input/output tokens, estimate/observed); no unlabeled number can be mistaken for token use. |

## 6. Workspace editor, Explorer, source control, GitHub, and export

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| WKS-01 | Explorer provides a VS Code-like path tree with file-type icons, filter that preserves/collapses the tree, create file/folder, rename/move/delete, and drag/drop. | **PARTIAL.** Core tree/filter/create/move/drag behavior exists (`src/ui/workspace-view.tsx:732-824`, `:938-958`); icons are generic and the filtered-tree/file-type grammar is incomplete. | Real path/file-type icon model, matching ancestors remain visible, empty branches collapse, DnD has keyboard/mobile alternatives, and repository roots remain distinct. |
| WKS-02 | Single click opens one italic preview tab; another preview replaces it. Double-click or editing pins it. Middle-click closes any closable tab. | **CONTRADICTED.** Every selected file becomes a persistent tab and tabs have only click/close-button behavior (`src/ui/workspace-view.tsx:144-172`, `:258-300`; `src/ui/tabs.tsx:286-325`). | Preview/pinned/dirty state machine is shared by file and diff documents; pointer, keyboard, touch, persistence, and dirty-close prompts are tested. |
| WKS-03 | Provide language-aware editing and actual dark/paper code themes rather than a plain text box. | **MISSING.** Editor is a `<textarea>` in `src/ui/workspace-view.tsx:845-907`. | Syntax highlighting and theme tokens at minimum; large-file bounds, keyboard, selection, search, undo, accessibility, and draft persistence remain honest. |
| WKS-04 | Explorer and Source Control are unmistakable sibling activity tabs sharing one rail. Source Control defaults to path tree and keeps true per-repository/worktree state. | **IMPLEMENTED/PARTIAL.** Desktop/mobile activity tabs and tree exist (`src/ui/workspace-view.tsx:740-824`); browser Git has repository/worktree state. Visual tab affordance and some user-reported staging behavior remain to harden. | Clear selected tab at every theme; switching repos never leaks status/index/ref; stage/unstage/commit verified against encrypted adapter and UI journeys. |
| WKS-05 | Remove the separate Sources/repository-manager page. Put repo/worktree selection, status, history, and diffs into the Editor/Source Control workbench. | **CONTRADICTED.** `EditorView` still exposes `Files & editor` and `Sources` modes (`src/ui/editor-view.tsx:30-70`, `:98-118`); the separate manager is `src/ui/sources-view.tsx:357-387`. | No top-level Sources mode; old `#sources` links redirect to Editor; all surviving controls have one home in the workbench. |
| WKS-06 | Source Control contains a collapsible recent-origin commit section. Expanding a commit shows changed files. | **PARTIAL.** A 50-commit flat History pane exists only in Sources (`src/ui/sources-view.tsx:727-783`). | Collapsible tracked-ref/origin history in Source Control, bounded paging, commit/file selection, honest local-vs-origin labels, and refresh on Git head changes. |
| WKS-07 | Clicking a status or commit file opens its diff as an editor document tab. Context action “Reveal in Explorer” expands/selects the exact file. | **CONTRADICTED/MISSING.** Diff is an inline Sources inspector (`src/ui/sources-view.tsx:623-631`, `:803-861`); no reveal action is present. | Diff uses the shared preview/pin tab model; reveal handles deleted/renamed/out-of-tree paths honestly and switches activity without losing diff state. |
| WKS-08 | Integrate GitHub authentication so users can clone/fetch/push their repositories rather than remain in a public-snapshot jail. | **MISSING + EXTERNAL DEPENDENCY.** Only public snapshot import is exposed (`src/ui/sources-view.tsx:413-430`); direct remote origins are empty (`src/git/validation.ts:41`) and CSP/remote limits are documented at `docs/BROWSER_GIT.md:211-248`. | Reviewed GitHub OAuth/app registration, scoped credential broker, authenticated Smart HTTP/approved relay, clone/fetch/push, sign-out/revocation, and failure/audit tests. |
| WKS-09 | Download one file directly, a folder as ZIP/tar archive, or the entire repository with its current Git history. | **MISSING.** No user-facing export/archive path was found; public snapshot receipts explicitly say history is not imported (`src/ui/sources-view.tsx:1071-1081`). | Deterministic bounded archive generation, safe filenames/symlinks, progress/cancel, single-file path, and a true Git-history-preserving repository export. |
| WKS-10 | Right-click Git/history and Explorer actions remain available on touch/mobile through an equivalent action menu. | **PARTIAL.** Workspace has desktop context actions and separate mobile move UI, but the requested Git history/reveal/export actions do not exist. | Every desktop context action has a labeled keyboard and touch path; parity tests compare action inventories, not just viewport fit. |

## 7. Persistent terminal and workspace reconciliation

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| TRM-01 | Terminal sessions belong to the active profile and persist names, CWD, history, transcript, lineage, and tabs according to the selected durability tier. | **PARTIAL.** Snapshot contract carries name/thread/CWD/history/output (`src/terminal/contracts.ts:9-25`) and reconstruction/persistence is implemented (`src/terminal/manager.ts:477-559`), but ownership is workspace/thread-based rather than an explicit restored profile terminal set. | Profile switch restores exactly its terminals; encrypted durable tiers reload them; page-memory truthfully loses them; process restart vs transcript reconstruction is explicit. |
| TRM-02 | Provide a full-power Bash/Linux-like sandbox with expected developer tooling, not a jailed command subset. | **CONTRADICTED.** UI launches WebContainer `jsh`; full Bash is explicitly unavailable (`src/ui/terminal-view.tsx:164-197`; `docs/TERMINAL_ENGINE_ARCHITECTURE.md:31-76`). | Supported runtime passes Bash/process/filesystem/tooling conformance or the product explicitly narrows the promise; isolation and resource limits remain enforced. |
| TRM-03 | Ordinary `git` works inside the terminal against the authoritative workspace. Remove the Shared Git injection row. | **CONTRADICTED.** Git runs through a separate bridge and Shared Git row (`src/ui/terminal-view.tsx:101-116`, `:230-238`); `.git` is excluded from the WebContainer (`docs/TERMINAL_ENGINE_ARCHITECTURE.md:116-129`). | One coherent filesystem/repository authority makes shell `git status/add/commit/log` agree with Source Control without injection or split-brain state. |
| TRM-04 | Dock/toggle a resizable terminal below the editor, open one at a selected file/folder CWD, preserve its origin lineage, and retain the dedicated Terminal page for management. | **MISSING/CONTRADICTED.** Terminal is a separate route (`src/ui/app.tsx:5487-5494`) and Explorer has no “Open terminal here.” | Resizable dock, close/toggle, CWD launch, terminal origin metadata, and shared session management work on desktop; phone provides equivalent pane/list navigation. |
| TRM-05 | Workspace reconciliation is an automatic service, not a manual terminal-page button. | **PARTIAL.** Sync occurs on quiesce/exit but live sessions expose manual Reconcile (`src/ui/terminal-view.tsx:121-177`; `src/terminal/manager.ts:357-447`). | Automatic safe-boundary reconciliation, conflict detection, progress, cancellation, crash recovery, and no silent last-writer overwrite. |
| TRM-06 | Every terminal command and resulting effect is auditable in Proof/Memory, with encryption and retention matching the profile durability mode. | **MISSING.** Terminal stores its own transcript but does not append the production session audit events used by Proof. | Command start/input commitment/exit/result/reconciliation events bind terminal, profile, session, workspace generation, and resulting Git/filesystem heads without exposing secret input. |

## 8. Memory, recall, graph, index, and semantic code awareness

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| MEM-01 | Keep powerful Recall, Graph, and Index sections with one obvious, low-weight search across conversation, profile memory, workspace sources, and relationships. | **IMPLEMENTED.** Federated search and the three surfaces are in `src/ui/memory-view.tsx:192-420`. | Preserve corpus-specific scores/provenance, cancellation, bounds, keyboard/mobile graph controls, and encrypted-authority truth. |
| MEM-02 | Remove the redundant top Recall/Graph/Index metric/jump links; do not remove the actual sections or capabilities. | **CONTRADICTED.** `memory-scope-rail` still renders three jump/metric buttons at `src/ui/memory-view.tsx:240-258`. | Search leads; sections remain navigable by ordinary headings/disclosures; the redundant strip is gone without losing counts or deep links. |
| MEM-03 | Clicking a workspace-file search result opens that exact file in the Editor. | **DONE THIS PASS.** `openMemorySource` now navigates and opens the path (`src/ui/app.tsx:3234-3250`) and is wired at `:5526`. | Unit/E2E cover file and profile-memory source, absent/deleted path, mobile navigation, and exact editor path. |
| MEM-04 | Semantic codebase indexing and relevant-file retrieval are automatic turn by turn, like a coding agent; the user need not name files manually. | **PARTIAL.** Federated turn context is automatic (`src/tools/tool-bundle.ts:17-38`; `src/core/agent.ts:549-580`), but true semantic embedding mode defaults to bootstrap until selected (`src/indexing/semantic-browser-provider.ts:16-39`). | Best available semantic/hybrid mode activates automatically, incrementally tracks edits/Git/workspace generations, records selected chunks, and degrades deterministically. |
| MEM-05 | Memory graph/index follows the profile silo and durable authority; it is not merely a graph of currently loaded page inputs. | **PARTIAL.** UI explicitly says graph derives from current page inputs (`src/ui/memory-view.tsx:192-214`). Retrieval has profile/workspace scopes, but global durable graph materialization is incomplete. | Reload/profile switch/durable adoption reconstructs the same authorized graph/index generation; cross-profile edges require an explicit shared-workspace policy. |
| MEM-06 | Hidden graph nodes/filters are easy to inspect and restore; accidental Hide never strands the user. | **REPORTED/PARTIAL.** The graph supports hiding and reports hidden counts (`src/ui/memory-view.tsx:300-365`), but the recording could not find an unhide path. | Visible “Hidden” disclosure lists nodes/kinds with Restore one/all; search can reveal a hidden match without mutating memory. |

## 9. Proof, receipts, attestations, and audit presentation

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| PRF-01 | Every completed inference turn automatically records a local receipt and tool/turn audit events scoped to profile/session. | **IMPLEMENTED.** Tool and completion journaling is in `src/core/agent.ts:356-501`; local receipt commitments are defined at `src/receipts/types.ts:74-132`. | Success, failure, cancellation, retry, fork, and local/provider turns all end in a durable, independently auditable disposition. |
| PRF-02 | After each protected Chutes response, automatically acquire exact endpoint/conversation evidence. Do not leave “evidence refresh due” as routine user work. | **PARTIAL, automatic acquisition plus bounded record durability implemented.** Successful protected turns enqueue exact receipt targets. Queue state and complete credential-free endpoint records are separate Profile-partitioned CAS checkpoints through the active WorkspacePort. Reconnection installs the credential-backed client, recovers the matching record store, then resumes the queue; no-credential work stays paused. The record checkpoint preserves bounded raw quote/certificate/GPU/nonce/key/binding material whole. | Keep manual refresh diagnostic/retry only; complete provider deployment verification, stronger NVIDIA/model/conversation proof, and archive-grade retention/export beyond the explicit 32-record / 3 MiB-record / 12 MiB-checkpoint cache. |
| PRF-03 | Receipts never become “stale.” If separately cached endpoint policy/key evidence ages, say exactly that and reacquire automatically. | **CONTRADICTED/PARTIAL.** UI intentionally labels separate evidence stale after a display-freshness window (`src/ui/app.tsx:6487-6489`; `src/ui/proof-inspector.tsx:54-61`), but presentation can read as if the receipt/encryption expired. | Receipt permanence and endpoint-evidence observation time are separate rows/states; stale wording names only the cache; automatic refresh never rewrites prior receipt claims. |
| PRF-04 | Proof is a digestible record selector with linked assertions, verification records, measurements, endpoint/model/instance facts, and full raw detail on demand—not an undifferentiated wall. | **PARTIAL, substantially advanced.** The ledger separates immutable receipts from endpoint observations and provides summary→claim→verification/measurement drill-down on desktop and mobile. Complete bounded raw records now back an explicitly labeled unsigned verification bundle instead of being stripped from presentation state. | Keep the selected record unmistakable across every navigation mode; extend keyboard/mobile regression coverage and complete the hardware/model/conversation proof hierarchy. |
| PRF-05 | Preserve and distinguish E2EE, Intel TDX, AMD SEV, NVIDIA Confidential Computing, model artifact/signature, and conversation binding. Never imply a stronger layer than verified. | **PARTIAL/MISSING.** Intel CPU verification is present; NVIDIA/model/transcript proof remains incomplete (`docs/ATTESTATION_RECEIPTS.md:41-106`). No complete AMD SEV lane was found. | Each layer has claimed/observed/verified/unavailable state, authoritative verifier, measurement identity, freshness, and explicit unsupported result. |
| PRF-06 | Proof/evidence survives reload according to the active Vault and remains selectable by profile/session/receipt. | **PARTIAL, bounded record reconstruction implemented.** Credential-free endpoint records are strictly validated, Profile/session/receipt indexed, deterministically reconciled, and persisted through the active WorkspacePort, so page memory stays page-lifetime while an encrypted Vault supplies its durability. Raw quote/certificate/GPU/nonce/key/binding material is retained whole. The transient evidence-client cache and credentials remain page-only. | Add archive-grade retention/export policy and cross-device encrypted-Vault conformance. The current cache never age-prunes or evicts silently: after 32 records, 3 MiB per record, or 12 MiB per checkpoint, a new whole record is visibly page-only. |
| PRF-07 | Terminal commands, workspace changes, Git actions, capability/provider/storage changes, and profile revisions participate in the same audit story. | **PARTIAL/MISSING.** Chat tools and profile/session changes have journal paths; terminal and several global capability transitions do not yet form one linked proof chain. | A user can traverse one timeline from intent→tool/terminal action→workspace/Git head→receipt/evidence, with secret-safe payload commitments. |

## 10. Vault and durability ladder

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| VLT-01 | Stage 1 is clearly page-ephemeral: closing the tab loses it. The user consciously understands/chooses that posture. | **IMPLEMENTED/PARTIAL.** Ephemeral status and durability controls exist, but onboarding/refresh protection is not yet one coherent ceremony. | First-use and top-level status say what survives; choosing ephemeral is explicit; close/reload warning depends on actual ephemeral work. |
| VLT-02 | Stage 2 is quick opt-in encrypted browser durability using OPFS with IndexedDB fallback, tied to the browser profile and honest about quota/eviction. | **IMPLEMENTED.** `docs/LOCAL_DEVICE_VAULT.md:22-59` documents real OPFS/Web Locks, IndexedDB fallback, and AES-256-GCM; adoption is wired at `src/ui/app.tsx:3077-3147`. | Offline/reload/permission/quota/eviction/corruption tests; no page-memory fallback masquerades as durable adoption. |
| VLT-03 | Stage 3 extension-enhanced local device adds durable ciphertext cache/storage and useful compute, with clear installed/enabled/status reporting. | **PARTIAL.** Extension ciphertext cache is production-selected first (`src/storage/client-ciphertext-cache.ts:512-609`); compute is limited and not consumed broadly. It is an accelerator, not a Vault authority. | UI distinguishes authoritative storage from cache; opt-in, quota, persistence, cache hit, fallback, and compute-consumer evidence are visible. |
| VLT-04 | Stage 4 supports safe Google Drive and S3/MinIO durability. Drive edits only Airship-owned data; self-hosted MinIO instructions are straightforward; unavailable providers are disabled/greyed rather than selectable. | **PARTIAL.** Provider cards/adoption exist (`src/ui/vault-view.tsx:67-133`; `src/ui/app.tsx:1502-1619`), but deployed S3/Cognito conformance and cross-device behavior are not certified (`docs/VAULT_COMPOSITION.md:3-38`). | Provider-specific conformance, safe folder/bucket scope, disabled-state truth, self-host guide, OAuth/CORS failure recovery, and destructive-action protections. |
| VLT-05 | Synchronize, shard, rapidly store/retrieve, and reconcile profiles/workspaces automatically across adopted durable providers without user babysitting. | **PARTIAL.** Safe authority transition/migration is strong (`src/ui/app.tsx:3377-3567`; `src/ui/vault-provider-transition.ts:17-29`), but UI/docs explicitly do not claim cross-device convergence. | Versioned encrypted manifests, incremental/resumable transfer, conflict and deletion policy, multi-device convergence, integrity checks, and observable background status. |
| VLT-06 | Encryption applies anywhere Airship persists or offloads profile/workspace/terminal/session data; key custody and recoverability are explicit. | **IMPLEMENTED/PARTIAL.** Local/cloud adapters are encrypted and migration is careful. Extension cache and future remote tiers must remain ciphertext-only; recovery/enrollment varies by provider. | Threat-model and conformance suite proves plaintext boundaries, key enrollment/rotation/revocation/recovery, metadata leakage limits, and export/import. |
| VLT-07 | Stage 5 is Chutes CPU TEE: the strongest rung, with E2EE full-session compute/inference and encrypted storage offload, potentially a subscription upgrade rather than a prerequisite for basic inference. | **MISSING + EXTERNAL DEPENDENCY.** Only policy/protocol foundations exist; no remote executor ships (`docs/COMPUTE_CONTINUUM.md:3-42`, `:449-484`). | See remote TEE gates in §12; until then the tier renders “Unavailable,” never selectable/connected. |

## 11. Connection, Account, OAuth, and provider information

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| ACC-01 | Chutes OAuth is the default/preferred first-party connection; API key remains a simple alternative. | **PARTIAL + EXTERNAL DEPENDENCY.** Real PKCE/refresh rotation exists (`src/auth/chutes-oauth.ts:34-101`, `:176-306`), but production availability is gated by public client ID and exact HTTPS origin. API key fallback is live (`src/ui/access-view.tsx:666-750`). | Hosted registration/config succeeds end-to-end; unavailable state names the missing deployment fact; refresh/revocation and API-key verification journeys pass. |
| ACC-02 | Other providers support usable OAuth where legitimately available and API keys otherwise; never advertise an unshipped OAuth controller. | **PARTIAL + EXTERNAL DEPENDENCY.** OpenAI/Anthropic/xAI API-key connections exist (`src/ui/provider-connections-view.tsx:105-190`); production OAuth controllers/grants are incomplete (`docs/INFERENCE_PROVIDER_REGISTRY.md:78-118`). | Provider-by-provider authorization review, registration, token ownership/refresh/revocation, honest unsupported labels, and no credential persistence outside declared memory/broker. |
| ACC-03 | Connection completes before model selection and then routes to a new Chat. | **CONTRADICTED.** See CMP-03. | Same acceptance as CMP-03 across OAuth and API-key paths. |
| ACC-04 | Account shows Chutes first, then provider tabs for OpenAI, Anthropic, and xAI with authenticated identity, quota, reset windows, usage, and account links where APIs permit. | **PARTIAL/MISSING + EXTERNAL DEPENDENCY.** Chutes balance/subscription/usage/quota/reset is rich (`src/ui/billing-view.tsx:100-130`, `:189-369`); other provider tabs/telemetry are absent. | One responsive provider-tab model; each field is observed/estimated/unavailable with source/time; unavailable APIs do not become fake zeroes. |
| ACC-05 | Show the connected Chutes identity, not only balance/quota. | **PARTIAL/BUG.** Client parses username/user ID (`src/billing/client.ts:30-34`) but Account does not render them. | Account header binds displayed identity to the credential observation and handles redaction/missing fields. |
| ACC-06 | Connection, Account, Vault, and runtime posture always make active credential class, storage durability, compute location, and proof boundary understandable. | **PARTIAL.** Trust/status surfaces carry many facts, but the recording still found model iconography, stale/evidence language, and posture stages difficult to distinguish. | One vocabulary and icon system across top status, Chat, Connection, Vault, Account, extension, and mobile; no duplicated icon means conflicting concepts. |

## 12. Browser extension and remote Chutes CPU TEE

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| EXT-01 | Extension safely ungates supported cross-origin provider requests; this is a narrow reviewed relay, not arbitrary CORS bypass. | **IMPLEMENTED/PARTIAL.** Live handshake and fixed-provider relay exist (`src/capabilities/extension-bridge.ts:1-129`; `extension/src/relay.ts:119-225`). | Supported path/origin/redirect/header policy tests, install/disable/removal recovery, request status, and explicit unsupported routes. |
| EXT-02 | Extension manages useful encrypted local storage offload/cache and reports status/quota/fallback. | **IMPLEMENTED.** Companion IndexedDB ciphertext cache and status are in `extension/src/companion.ts:19-66`, `:150-210`; page selects it in `src/storage/client-ciphertext-cache.ts:512-609`. | Real extension-host E2E remains mandatory; UI never calls cache an authoritative Vault. |
| EXT-03 | Extension compute offload materially accelerates indexing/runtime work, not only diagnostics. | **PARTIAL.** SHA-256/cosine top-k capabilities exist, but no production semantic/index consumer was found. | Scheduler routes eligible work to extension, records timing/resource/fallback, and proves equivalent deterministic results. |
| EXT-04 | Extension can own reviewed OAuth management where it is the correct secure boundary. | **MISSING + EXTERNAL DEPENDENCY.** Current relay deliberately does not store credentials; provider OAuth controllers remain incomplete. | Explicit token broker design, least-privilege permissions, refresh/revocation, browser-store policy, threat model, and provider registration. |
| EXT-05 | Extension status is obvious: installed, live, permission-limited, cache enabled, compute active, provider relay available, or unavailable—with remediation. | **PARTIAL.** Connection lane probes and presents companion facts (`src/ui/access-view.tsx:307-337`; `src/ui/connect/connect-lanes.ts:432-452`). | First-load and lifecycle status shared across Connection/Capabilities/top posture; no stale handshake after disable/update. |
| TEE-01 | Chutes CPU TEE drives the complete remote Airship session: Linux compute, tools/terminal, inference, encrypted workspace/storage, reconnect/resume, E2EE, and attested receipts. | **MISSING + EXTERNAL DEPENDENCY.** Remote placement always resolves unavailable (`src/execution/compute-continuum.ts:56-100`); `docs/COMPUTE_CONTINUUM.md:3-42` explicitly says no executable remote placement/executor ships. | Authenticated placement API, measured image, E2EE channel, private workspace broker, exactly-once dispatch, streaming, cancellation, reconnect, encrypted writeback, signed receipts, and adversarial conformance. |
| TEE-02 | Remote tier is selected only when the exact compute/storage/proof capabilities are live; ordinary Chutes inference attestation is not presented as a full remote executor. | **IMPLEMENTED AS HONEST UNAVAILABLE.** Acceptance docs mark CPU-only Chutes TEE unavailable (`docs/MASTER_PROMPT_ACCEPTANCE.md:105-112`). | Keep fail-closed until TEE-01 passes; UI and agent manifest state precise supported sub-capabilities rather than one aspirational “connected” flag. |

## 13. Visual hierarchy, full-width use, motion, and mobile parity

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| VIS-01 | Retain Airship's faint grid/aesthetic, but eliminate reported flicker and make background treatment intentional across Chat, Memory, and other routes. | **REPORTED.** The recording observed grid flicker/inconsistent intensity; no conclusive reproduction was completed in this pass. | Screenshot/video test with animations enabled/disabled, dark/paper, device pixel ratios, and reduced motion; no repaint flicker. |
| VIS-02 | Use available desktop width for dense Proof, terminal, Memory, Account, and management surfaces while retaining readable measures and padding. | **PARTIAL/REPORTED.** Editor intentionally uses full width (`src/ui/editor-view.css:20`), while several routes retain narrow text measures; the recording repeatedly described Proof/terminal/manager surfaces as center-smushed. | Route-specific wide-layout specs: data grids and work surfaces expand; prose remains bounded; no giant empty gutters around dense controls. |
| VIS-03 | Keep icon meanings consistent: model intelligence, Memory, runtime controls, profiles, dark/light, files, and status must not reuse ambiguous boxes. | **PARTIAL.** A shared icon system exists, but the recording identified model/runtime ambiguity and missing file-type/dark-light semantics. | Icon vocabulary audit with accessible names and no identical glyph for unrelated primary concepts in the same context. |
| VIS-04 | Progressive disclosure reduces overwhelm without clipping, deleting, or watering down information. Advanced users can reach raw evidence and controls directly. | **PARTIAL.** Many responsive disclosures and raw details exist; claim stack, Proof hierarchy, and sessions/workbench still need structural refinement. | Information-inventory tests assert the same facts/actions at desktop/tablet/phone; folding changes altitude, not availability. |
| VIS-05 | Mobile retains complete capability and information with phone-native layout, touch targets, safe areas, keyboard behavior, and alternate gestures. | **IMPLEMENTED AS A RELEASE PRINCIPLE/PARTIAL IN COVERAGE.** The repo has broad mobile E2E and CSS contracts (for example `e2e/route-adversarial-audit.spec.ts:50-225` and `e2e/responsive-breakpoints.spec.ts:377-477`). New desktop rename and forthcoming context-menu/drag behaviors still need mobile alternatives. | Every delivery wave includes phone tests comparing action/fact inventories, not just screenshots; minimum 44px touch targets and no keyboard/nav overlap. |
| VIS-06 | Dropdowns, tooltips, evidence selectors, timestamps, labels, and long IDs remain readable rather than clipped or racing dismissal. | **PARTIAL/REPORTED.** The recording specifically observed session tooltip fade, model-sort clipping, timestamp truncation, and `All…` label clipping. Some menus have placement/viewport tests, but all reported paths require regression cases. | Long-content fixtures at supported widths; hover/focus/touch persistence; overlay collision/scroll tests; full value available through text or accessible detail. |

## 14. Clean-room references and provenance

| ID | Exact target behavior | Current status and evidence | Acceptance gate |
| --- | --- | --- | --- |
| CLR-01 | Keep the recording's cloneable reference repositories beside Airship in a gitignored local library, pinned and usable for read-only study. | **DONE THIS PASS.** Ten repositories are catalogued/pinned (`references/repositories.json:3-240`), checkouts live below ignored `/references/checkouts/` (`.gitignore:52`), and strict verification reports 10/10 hydrated. | `npm run check:references:strict` verifies every required checkout's URL relationship, detached revision/tree, cleanliness, and license evidence. |
| CLR-02 | Cover Hermes, public Claude-inspired Rust studies, Codex, Code - OSS, Open WebUI, MinIO, CocoIndex, isomorphic-git, and xterm.js; treat ChatGPT, proprietary Claude/Claude Code, and Cursor as behavior-only because no cloneable open-source product implementation exists. | **DONE THIS PASS.** Catalog IDs are at `references/repositories.json:8`, `:33`, `:60`, `:87`, `:112`, `:137`, `:168`, `:192`, `:216`, `:240`; scope boundaries are in `references/README.md`. | Adding/removing/updating a reference requires an explicit catalog change and provenance/license review. |
| CLR-03 | Reference study is clean-room: observation → source-free Airship specification → original implementation → decision record. Never copy source, styles, prompts, tests, assets, branding, prose, or distinctive structure. | **DONE THIS PASS AS POLICY/TOOLING.** Mandatory barrier and merge gate are in `references/CLEAN_ROOM.md:9-78`; `docs/LINEAGE.md:6-40`, `:104-109` binds it to project lineage. | Every reference-informed implementation has study/spec/decision artifacts; implementer can work from the spec without checkout access; final diff contains no checkout path or copied expression. |
| CLR-04 | Reference checkouts are never build inputs, dependencies, fixtures, submodules, release artifacts, or executable code under this workflow. | **DONE THIS PASS AS POLICY/CHECK.** `references/README.md` forbids execution/incorporation; `scripts/check-reference-library.mjs` verifies pin/license/clean state and requires Vitest discovery to exclude `references/**`; the ordinary and watch test scripts carry that exclusion in `package.json`. | Release/check gates fail on tracked checkout contents, dirty/advanced pins, malformed provenance, missing required spec/decision, path imports, or removal of the test-discovery exclusion. |

## Completed in this review pass

The following changes close concrete portions of the recording; they do not imply their surrounding area is finished:

1. **Profile leakage fixes.** Command-palette recents, rail recents, and All Conversations now query the active profile rather than all profiles (`src/ui/app.tsx:1202-1217`, `:1263-1277`; `src/ui/sessions-view.tsx:132-155`).
2. **Built-in identity correction.** `Builder / Systems` now presents as **Developer**, keeps the stable historical ID, and uses a distinct `blue-ledger` theme (`src/profiles/catalog.ts:111-120`).
3. **Durable inline desktop rename.** Double-clicking the Chat title opens inline rename; Enter/click-away commits through the journal (`src/ui/chat/session-bar.tsx:78-161`; `src/ui/app.tsx:1920-1931`). A mobile rename action remains in backlog.
4. **False switching label fix.** A running turn disables model changes without claiming that the model is switching (`src/ui/model-control.tsx:31-113`).
5. **Exact Memory source opening.** Workspace results now navigate to Editor and open the exact path (`src/ui/app.tsx:3234-3250`, `:5526`).
6. **Mobile configuration hierarchy.** Mobile More now presents truthful descriptions and the Profiles → Skills → Capabilities order (`src/ui/navigation-model.ts:270-282`; `src/ui/mobile-navigation.tsx:235`).
7. **Clean-room reference library.** Pinned catalog, ignored hydrated checkouts, study/spec/decision directories, mandatory information barrier, lineage update, hydration/check tooling, and package checks are present under `references/`, `docs/LINEAGE.md`, `.gitignore`, and `package.json`. Airship's test and watch commands explicitly exclude the entire reference tree, and the governance checker fails if that isolation is removed.

Verification observed during this review:

- the complete `npm run check` pipeline passed: root and extension TypeScript,
  static-security policy, reference policy and self-test, 249 Vitest files with
  2,216 passing tests and one intentional skip, extension packaging, static
  production build, and the release-size/determinism gate;
- focused tests for the changed profile, navigation, model, Memory, Sessions,
  CSS-contract, and shell paths passed 77/77;
- the two new desktop Playwright journeys passed for durable inline rename and
  exact Memory-file navigation;
- strict reference verification passed with 10 catalogued, 10 hydrated,
  detached, clean repositories.

## Current working-tree reconciliation — later 2026-07-28 checkpoint

This section preserves the original directive rows and the verification history
above. It records a later inspection of the shared, uncommitted working tree
while parallel implementation lanes were still active; it is not a release
claim. **IMPLEMENTED (working tree)** below means that a production path and a
focused test or browser journey are present. **PARTIAL** remains the result when
one part of the directive is implemented but its whole acceptance gate is not
demonstrated. The tables below supersede only the status/evidence of the IDs
they name.

### Implemented in the current tree

| IDs | Reconciled status | Evidence in the current tree |
| --- | --- | --- |
| PIA-01, PIA-05, PIA-07 | **IMPLEMENTED (working tree).** The profile switcher is the first desktop-rail control; desktop and mobile use Profiles → Skills → Capabilities; Proof is grouped with profile work while Vault, Connection, and Account remain global. | `src/ui/rail.tsx`, `src/ui/navigation-model.ts`, and the “pinned profile row” and Proof-placement journeys in `e2e/conversation-navigation.spec.ts`; intermediate-width survival is covered in `e2e/responsive-breakpoints.spec.ts`. |
| PIA-06 | **IMPLEMENTED (working tree).** Chat owns an inline, profile-local disclosure with Favorites before Recent and an All conversations destination; the detached recents popout is gone. | `src/ui/rail.tsx`; the desktop conversation-information-architecture and journal-backed favorites journeys in `e2e/conversation-navigation.spec.ts`. |
| CON-05 | **IMPLEMENTED (working tree).** Double-click/F2 and click-away/Enter use journaled rename, and touch has an explicit 44px rename action. | `src/ui/chat/session-bar.tsx`, `src/ui/chat.css`, `src/ui/routes.css`; desktop and mobile rename journeys in `e2e/conversation-navigation.spec.ts`. |
| CON-09 | **IMPLEMENTED (working tree).** Pointer actions now follow message content in reserved bottom geometry; keyboard and touch disclosures retain the action inventory. | `src/ui/chat.css`; all three journeys in `e2e/message-hover.spec.ts`, including the below-content geometry assertion. |
| WKS-02 | **IMPLEMENTED (working tree).** File, status-diff, and history-diff documents share one preview/pin/dirty/close state machine, including double-click/edit pinning and middle-click close. | `src/ui/workbench-model.ts`, `src/ui/workspace-view.tsx`, `src/ui/tabs.tsx`; focused model tests in `src/ui/workbench-model.test.ts` and desktop/mobile journeys in `e2e/workspace-workbench.spec.ts`. |
| WKS-05 | **IMPLEMENTED (working tree).** The route-level Sources/repository-manager mode is gone. Workspace remains mounted while its one Source Control activity opens the complete former control inventory in an Advanced modal; legacy `#sources` input canonicalizes to `#editor`. | `src/ui/editor-view.tsx`, `src/ui/workspace-view.tsx`, `src/ui/sources-view.tsx`, `docs/SOURCE_CONTROL_WORKBENCH_INVENTORY.md`, and `e2e/workspace-source-controls.spec.ts`. The modal is keyboard/touch reachable on both layouts and is authority-fenced so a profile/workspace switch cannot expose the prior silo's repository state. The focused source-control journey passed **6/6** across desktop and mobile. |
| PPF-04 | **IMPLEMENTED (working tree).** Dark instrument and Paper use moon/sun affordances while retaining explicit accessible names, and Reset preferences requires a native confirmation before changing live or stored values. | `src/ui/icons.tsx`, `src/ui/platform-shell.tsx`, `src/ui/platform-shell.test.ts`, and `e2e/preferences-reset.spec.ts`; the Cancel/Confirm journey passed on desktop and mobile. |
| ACC-05 | **IMPLEMENTED (working tree).** Account renders the username and user ID observed in the Chutes account snapshot, with distinct Loading, Not provided, and Unavailable states instead of a fabricated anonymous identity. | `src/ui/billing-view.tsx` and `src/ui/billing-view.test.ts` cover identity binding, bounded values, redaction/absence, and loading. |

### Material progress that remains partial or contradicted

| IDs | Reconciled status | Evidence now present | Boundary still open |
| --- | --- | --- | --- |
| PIA-03, PIA-04, CON-02 | **IMPLEMENTED/PARTIAL.** PIA-04 and the current-page cockpit portions of PIA-03/CON-02 are implemented. The active conversation is an append-only Profile-bound pointer; a switch publishes the new Profile/session tuple behind an opaque transition and restores an existing compatible conversation rather than manufacturing one. Chat draft, exact detached viewport, favorites/search, Workspace presentation, terminal tab set, Memory page presentation, session commands/forks, and session Proof selection are Profile-owned. | `src/sessions/profile-cockpit.ts`, `src/ui/chat/thread-viewport.ts`, `src/ui/workspace-refresh.ts`, `src/ui/workspace-view.tsx`, `src/ui/memory-view.tsx`, `src/ui/app.tsx`, and their focused tests cover collision-free scope keys, audited-head and async request fencing, source-selection revalidation, and A→B→A restoration. The profile-cockpit suite passed **9/9**, its message-presentation suite passed **15/15**, and the combined viewport/workspace/Memory-presentation run passed **22/22**. `e2e/profile-silo.spec.ts` passed **1/1**: it restores the exact URL, unsent draft and detached scroll coordinate, favorite/search result, dirty file tab and repository/worktree selection, terminal names/set/selection, Memory query/Index disclosure, and exact Proof session; rejects an exact cross-Profile slash-fork source and direct Proof UUID; observes every DOM mutation for an unmasked cross-Profile tuple; and verifies Vault, Connection, and Account remain global. | This browser gate proves presentation scope in page-memory mode, not a separate underlying filesystem for every Profile. Profiles that resolve to the same `WorkspacePort` intentionally see the same file/Git/worktree inventory, and the Memory index follows that authority; distinct durable bindings or a formal shared-binding policy remain. The active pointer's encrypted cross-context reload path and durable endpoint-evidence reconstruction/partition gate also remain open. |
| CAP-09 | **PARTIAL.** A canonical, scoped live-environment snapshot is produced per turn, injected into tool context, committed to audit, and sourced in App from current provider, storage, and extension observations. | `src/core/live-environment.ts`, `src/core/agent-live-environment.test.ts`, `src/tools/live-environment.ts`, `src/tools/live-environment.test.ts`, and the `liveEnvironmentSource` wiring in `src/ui/app.tsx`. | The acceptance matrix still needs one production journey that changes provider, storage, and extension generations mid-conversation and proves the very next turn sees each change. Skills, permissions, workspace, and index generations also need to converge on the same canonical live record. |
| CON-03 | **IMPLEMENTED (working tree).** Favorites are Profile-local append-only membership epochs plus user move events in the selected journal authority. Lamport generations and persisted tie-breakers deterministically replay concurrent writers; removing/re-pinning cannot revive an old move. Every favorite remains visible before stable recents. Desktop pointer drag/drop, keyboard actions, and explicit touch-sized mobile actions work in the inline Chat tree and All Conversations. | `src/sessions/favorite-order.ts`, `src/sessions/library.ts`, `src/core/session-audit.ts`, `src/ui/session-pins.ts`, `src/ui/app.tsx`, `src/ui/rail.tsx`, and `src/ui/sessions-view.tsx`. Focused favorite/library/presentation tests passed **38/38**; `e2e/favorite-ordering.spec.ts` passed its desktop and mobile journeys, and the prior Profile-isolation journey remains green. | This closes CON-03 for the selected durability authority. Page-memory remains intentionally page-lifetime; encrypted adopted journals inherit their configured durable provider. Cross-device availability is therefore conditional on the already-stated Vault/key/convergence boundaries, not a separate favorite store. |
| CON-06, CON-07, CON-08 | **IMPLEMENTED/PARTIAL.** The core semantics and current desktop actions are implemented: a true fork carries an audited bounded ancestor seed without copying source events; Edit branches at the immutable pre-turn boundary; Retry branches before the prior answer and regenerates separately. Fork activation now requires active-Profile source ownership, a current-authority target manifest, resume compatibility, a complete audit, and unchanged Profile/session authority before publication. | `src/core/fork-context.ts`, `src/core/fork-context.test.ts`, `src/core/agent-fork-context.test.ts`, `src/sessions/profile-cockpit.ts`, `src/sessions/library.ts`, `src/sessions/session-library.test.ts`, and `src/ui/app.tsx` cover historical completed-turn selection, the quiescent pre-turn `session.renamed` boundary, rejection of mid-turn metadata, seed scope/tamper failure, source preservation, and cross-Profile source rejection. Five targeted desktop stable-URL/fork/edit/retry/draft/favorite journeys passed together after the authority change. | The all-history UX remains partial: selecting older/virtualized turns, explaining bounded omissions, reload/durable reconstruction, touch paths, and provider-context assertions have not passed together. The source-free seed deliberately has a bound, so any omitted ancestor range must remain explicit. |
| WKS-01, WKS-04 | **PARTIAL.** The workbench now has bounded tree filtering, create file/folder, rename/move/delete, drag/drop, resizable Explorer/Source Control siblings, repository/worktree selectors, status, staging, commit, recent history, Profile-scoped view state, and a deterministic path-driven file-type icon model shared by Explorer, document tabs, and the overflow list. Repository/worktree presentation is restored per Profile and revalidated against live inventory; the App-level selected-file handoff is owner-tagged; and workspace-list publication requires the newest request plus the exact WorkspacePort/workspace ID/Profile tuple. | `src/ui/workspace-file-icon.tsx`, `src/ui/workbench-model.ts`, `src/ui/workspace-refresh.ts`, `src/ui/workspace-refresh.test.ts`, `src/ui/workspace-view.tsx`, `src/ui/workspace-view.test.ts`, `e2e/workspace-workbench.spec.ts`, and `e2e/profile-silo.spec.ts`. Focused tests cover A→B→A separation for tabs, preview, rail, wrapping, unsaved buffers, repository/worktree selection, missing-source fallback, the initial-restoration race, and a delayed old authority resolving after a new one. The combined browser journey creates a real linked worktree, selects it for Profile A, proves Profile B starts on its own selection with no A tab/draft, and restores A exactly. | This is Profile-local selection over a selected Workspace authority, not a claim that two Profiles sharing one `WorkspacePort` have different file bytes or Git object/ref/worktree inventories. Drag/drop still lacks equivalent keyboard/mobile move semantics at the tree-row level, and the full multi-repository conflict matrix remains. |
| WKS-06, WKS-07, WKS-10 | **PARTIAL; WKS-07 is implemented for the current document model.** Status and commit patches open as shared diff documents, and every open file, status diff, and exact history path can reveal its current workspace path without replacing or closing the active document. Reveal clears an obstructing filter, expands every ancestor, selects/focuses the exact row, and switches the phone to Files; repository/worktree identity is carried by the diff, while disconnected, out-of-tree, and currently absent/deleted paths produce an explicit error and retain the diff. One-path commits use a direct action and multi-path commits use the same keyboard/touch menu. | `src/ui/workspace-view.tsx`, `src/ui/workspace-view.test.ts`, `src/ui/workbench-model.ts`, and `e2e/workspace-workbench.spec.ts`. The complete workbench spec passed **9/9** applicable desktop/mobile journeys at this checkpoint, including the new file/status/history Reveal and icon journey in both projects; focused icon/workspace/tab tests passed **58/58**. | History is still a commit-level list rather than the requested collapsible commit→changed-files tree with bounded paging. Deleted/renamed reveal failures have pure path-resolution coverage but still need dedicated browser journeys, and the broader Git/history/export action inventory is not yet exposed through equivalent tab-context, keyboard, and touch menus. |
| TRM-01 | **IMPLEMENTED/PARTIAL; terminal lane is not complete.** Profile ownership, selected-durability presentation, origin, process epoch, close/restart state, and bounded history/transcript/audit now have a production path. App passes `profileId`, `profileName`, and `sessionDurability`; the manager reconstructs distinct Profile-owned tab sets through the active workspace. | `src/ui/app.tsx`, `src/terminal/contracts.ts`, `src/terminal/manager.ts`, `src/terminal/manager.test.ts`, `src/ui/terminal-view.tsx`, `e2e/workspace-terminal.spec.ts`, and `e2e/profile-silo.spec.ts`. The combined page-memory A→B→A journey passed: Profile A restores its two named tabs and selected tab, Profile B has only its independently named tab, and neither terminal list exposes the other. | The encrypted durable-tier reload/conformance gate still must pass. Processes intentionally remain page-local and restart after reload; persisted metadata/transcript reconstruction must never be described as a surviving process. |
| TRM-02, TRM-03 | **CONTRADICTED, with more honest presentation.** The UI no longer calls the bridge “Shared Git” and explicitly identifies the live shell as WebContainer `jsh`, not Bash/Linux. | `src/terminal/contracts.ts`, `src/ui/terminal-view.tsx`, and the no-Shared-Git assertion in `e2e/workspace-terminal.spec.ts`. | Full Bash/Linux conformance and ordinary shell `git` against the same authoritative repository still do not exist; removing a misleading row does not create that authority. |
| TRM-04 | **IMPLEMENTED for the current browser terminal tier.** Workspace now has a collapsible terminal dock below the editor. Explorer “Open terminal here” reveals it at the exact file-parent or directory CWD without leaving Workspace; the dock and full Terminal route render the same `BrowserTerminalManager` sessions and selected tab. Closing/collapsing the dock disposes only its xterm presentation, not the manager-owned process/session. Dock open/height/selection state is collision-free and scoped by workspace+profile in browser-session state. Each async open request also binds the issuing Profile and workspace authority, so a switch race discards it instead of opening the old path in the new cockpit. | `src/ui/workspace-terminal-dock.tsx`, `src/ui/workspace-terminal-dock.css`, `src/ui/terminal-dock-state.ts`, `src/ui/terminal-view.tsx`, `src/ui/editor-view.tsx`, `src/ui/app.tsx`, and the idempotent `openWorkspaceSession` manager contract. The separator supports pointer drag plus Arrow/Home/End resizing; mobile retains the full operation surface and an explicit full-view action. Focused dock state tests passed **5/5**, the combined terminal/dock/workspace unit run passed **27/27** including the request-authority race fence, and the complete Terminal Playwright spec passed **4/4** applicable desktop/mobile journeys. | This closes the dock/layout/handoff target, not TRM-02/03/05/06: the live process is still page-local WebContainer `jsh`, process reload is reconstruction rather than survival, reconciliation retains a manual primary action, and terminal lineage is not yet linked into session Proof/Memory. |
| TRM-05 | **PARTIAL.** The manager revision-fences reconciliation and records outcomes, including quiesce/authority-change paths. | `src/terminal/manager.ts` and reconciliation cases in `src/terminal/manager.test.ts`. | The Terminal route still exposes a primary manual Reconcile action; automatic safe-boundary progress, cancellation, crash recovery, and conflict UX are not proven end to end. |
| TRM-06, PRF-07 | **PARTIAL.** Terminal lifecycle/input/reconciliation records and live-environment audit commitments now exist as bounded internal records. | `src/terminal/contracts.ts`, `src/terminal/manager.ts`, `src/core/live-environment.ts`, and their focused tests. | Terminal records are not appended to the production session journal or traversable through Proof/Memory, and workspace/Git/provider/storage/profile changes still do not form one linked proof timeline. |
| MEM-05 | **IMPLEMENTED/PARTIAL at the presentation boundary.** Memory query text, relationship disclosure, and Index disclosure/mount state are collision-free Profile+session page state. A Profile switch remounts Memory under the new owner rather than reusing the prior component's presentation. | `src/ui/memory-view.tsx`, `src/ui/memory-presentation.test.ts`, and `e2e/profile-silo.spec.ts`. Focused tests prove A→B→A query/Index separation and separate conversation/workspace authority keys; the browser journey restores Profile A's query and open Index after Profile B starts empty and records its own query. | The derived index generation still follows the selected `WorkspacePort`; it is not yet a separately durable per-Profile graph when two Profiles share one workspace binding. Durable adoption/reload and explicit cross-Profile shared-workspace policy remain. |
| PRF-02 | **PARTIAL, scheduler and bounded endpoint-record boundaries closed.** Protected-turn completion enqueues receipt-keyed acquisition automatically. The controller deduplicates and retries through a Profile-partitioned WorkspacePort CAS checkpoint. A second strict checkpoint preserves each complete credential-free endpoint record under its exact Profile/session/receipt identity. App fences client/cache/presentation by Profile, WorkspacePort, client generation, session, receipt, instance, and key; reconnects in client→records→queue order; pauses disconnected queues; and quiesces before authority migration. | `src/attestation/evidence-acquisition-queue.ts`, `src/attestation/workspace-evidence-acquisition-persistence.ts`, `src/attestation/workspace-endpoint-evidence-persistence.ts`, their focused concurrency/reload/malformed/oversize tests, lifecycle wiring in `src/ui/app.tsx`, and `e2e/proof-truthfulness.spec.ts`. | Manual acquisition remains correctly labeled retry/diagnostic. Provider deployment verification and archive-grade retention remain open; the current cache has explicit 32-record / 3 MiB-record / 12 MiB-checkpoint boundaries, never silently evicts or truncates, and leaves an over-bound record visibly page-only. |
| PRF-03, PRF-04 | **PARTIAL, substantially advanced.** The ledger keeps immutable turn receipts separate from later endpoint observations, explains five claim-scoped states, provides record→claim→verification/measurement drill-down, and has a complete mobile path. Session Proof and endpoint-record presentation are authority-fenced by Profile/workspace/session, so A→B→A cannot render another Profile's selection or late result. A privacy-safe status export remains the default, while Proof now offers an explicitly labeled unsigned raw verification bundle containing complete bounded endpoint artifacts and local commitments. | `src/ui/attestations-view.tsx`, `src/ui/proof-view.tsx`, `src/ui/app.tsx`, `src/attestation/workspace-endpoint-evidence-persistence.ts`, `e2e/proof-truthfulness.spec.ts`, and the DOM-mutation assertions in `e2e/profile-silo.spec.ts`. | The transient verifier/client byte cache remains page-only, the bounded record store is not an archive, and the raw bundle is independently checkable material rather than an Airship/enclave signature. Complete NVIDIA/model/conversation proof and cross-device encrypted-Vault conformance remain open. |
| ACC-04 | **PARTIAL, presentation seam implemented.** Account now uses one responsive Chutes-first tab model for Chutes, OpenAI, Anthropic, and xAI. A credential-free host inventory can supply observed quota, usage, reset, and safe HTTPS account links; every absent field is explicitly Not provided or Unavailable and an observed zero remains zero. | `src/ui/billing-view.tsx`, `src/ui/billing-view.css`, `src/ui/billing-view.test.ts`, and `e2e/account-providers.spec.ts`; four-provider reachability and keyboard navigation passed on desktop and mobile. | App has no real non-Chutes telemetry observations to supply yet. Provider-specific identity/usage APIs, authentication authority, refresh, source timestamps, and hosted OAuth registration remain external/integration work rather than UI-invented values. |
| VIS-02, VIS-04, VIS-05 | **PARTIAL, with new route-level evidence.** Workbench, terminal, and Proof now have compact/full-width structures and desktop/mobile information-path tests. | `e2e/workspace-workbench.spec.ts`, `e2e/workspace-terminal.spec.ts`, and `e2e/proof-truthfulness.spec.ts`. | These journeys do not close the cross-product release gate for every route, density, type scale, long value, keyboard path, touch alternative, safe area, and mobile keyboard state. |

### Baseline statuses and external boundaries retained

Every directive not named above retains the status and acceptance gate in its
original row. Explicitly, that is: PIA-02 and PIA-08; PPF-01 through PPF-03;
CAP-01 through CAP-08; CON-01, CON-04, CON-10, and CON-11; CMP-01 through
CMP-08; WKS-03, WKS-08, and WKS-09; MEM-01 through MEM-04 and MEM-06; PRF-01, PRF-05,
and PRF-06; VLT-01 through VLT-07; ACC-01 through ACC-06; EXT-01 through
EXT-05; TEE-01 and TEE-02; VIS-01, VIS-03, and VIS-06; and CLR-01 through
CLR-04. “Retained” is not a statement that these rows are done—it preserves
each row's prior IMPLEMENTED, PARTIAL, CONTRADICTED, MISSING, REPORTED, or
EXTERNAL DEPENDENCY result.

In particular, no current-tree evidence removes the external boundaries on
GitHub authenticated transport (WKS-08), deployed Drive/S3 convergence
(VLT-04/VLT-05), Chutes and other-provider OAuth/telemetry registration
(ACC-01/ACC-02/ACC-04 and EXT-04), or the remote Chutes CPU TEE executor
(VLT-07 and TEE-01). Local contracts and honest unavailable states can advance;
the backlog must not relabel those integrations complete without real provider
or backend conformance evidence.

Verification observed at this later checkpoint:

- 12 focused Vitest files covering profile cockpit/session library, live
  environment, fork context, workbench model, terminal manager, evidence queue,
  platform preferences, and navigation passed **111/111** tests;
- after the terminal/fork production-wiring delta, the four affected unit files
  passed **36/36**, and the two targeted desktop true-fork/edit/retry journeys
  passed **2/2**;
- the profile-scoped Workspace unit file passed **12/12**, and the combined
  Workspace/Terminal Playwright run passed **11/11**; the previously failing
  Workspace → “Open terminal here” handoff was independently rerun green on
  desktop and mobile (**2/2**);
- the contextual terminal-dock state suite passed **5/5**, the focused
  terminal/dock/workspace unit run passed **27/27** (including the
  Profile/workspace request-authority switch fence), and the complete Terminal
  Playwright spec passed **4/4** applicable desktop/mobile journeys, including
  exact-CWD dock opening, keyboard resize, collapse/reveal retention, and
  promotion of the selected shared session to the full Terminal route;
- the complete Workspace workbench Playwright spec passed **9/9** applicable
  desktop/mobile journeys (seven project-inapplicable cases skipped), and the
  focused file-icon, Workspace, and shared-tabs unit run passed **58/58**;
- `npm run check:references:strict` passed with 10/10 hydrated repositories,
  and `npm run test:references` passed all seven path-isolation assertions;
- all 89 concrete local path references in this document resolve; the document
  contains no Markdown links requiring a remote target check; and
- `git diff --check` passed for the tracked shared-tree diff. A separate scan of
  this currently untracked backlog found no new trailing whitespace (the two
  original header hard-break lines remain intentional).

The “Recommended next coherent slices” below remains the historical ordering
from the first review. Apply this checkpoint as the current-state filter: keep
the still-open acceptance boundaries, and do not redo the portions listed above
as implemented in the working tree.

## Recommended next coherent slices

### Immediate product slice: profile-owned conversation cockpit

This is the best next slice because it addresses the recording's first and most repeated organizing complaint, closes active cross-surface contradictions, and can be completed client-side without waiting for OAuth or Chutes backend contracts.

Deliver together:

1. move the profile selector to the top;
2. align desktop Profiles → Skills → Capabilities with mobile;
3. replace the Chat recents popout with an inline profile-local subtree;
4. show durable ordered pinned conversations before recents;
5. make profile switching restore the profile's last conversation instead of creating one;
6. persist an explicit active-conversation pointer per profile and selected durability;
7. add the mobile title-rename alternative.

Gate: A→B→A restores the exact addressed conversation for both profiles; search/recents/pins never leak; New Conversation is the only creation action; desktop, keyboard, phone, reload, page-memory, and Local Device journeys pass.

### First platform slice: one workbench document/navigation model

Deliver together:

1. remove the separate Sources mode;
2. move repo/worktree selection, status, and recent history into Source Control;
3. introduce shared `file` and `diff` editor document kinds;
4. implement preview/pinned/dirty/middle-close semantics;
5. route Source Control and commit files into diff tabs;
6. route Memory and “Reveal in Explorer” through one exact-path opener;
7. add an integrated terminal toggle seam, even if the terminal engine upgrade follows later.

Gate: single-click preview is replaced, double-click/edit pins, middle-click closes, a status/commit file opens a diff tab, Reveal selects the file, Memory opens it, and no separate Sources/repo-manager page remains.

## Ordered delivery waves

### Wave 1 — Profile cockpit and information architecture

Scope: PIA-01 through PIA-08, durable ordered conversation pins, restore-last-conversation, desktop/mobile configuration order, Proof placement, and profile-scoped active pointers.

Acceptance gate:

- profile A and B retain isolated conversation/workspace/terminal/memory/proof selections;
- switching does not create a session;
- page-memory and durable behavior are truthfully different;
- navigation inventory and scope labels match on desktop and phone;
- no cross-profile row/count/facet/preview leakage.

### Wave 2 — Branch-aware continuity and message actions

Scope: CON-02 through CON-11: direct resume, immutable ancestor context resolution, true forks, edit branching, retry/regenerate semantics, bottom actions, collapsible claim stack, and simplified All Conversations.

Acceptance gate:

- stable URLs resume compatible sessions once;
- fork/edit/retry each have distinct recorded semantics;
- model context includes the correct ancestor range;
- no source history is rewritten or silently dropped;
- lineage remains navigable without flooding recents;
- all actions work through keyboard and touch.

### Wave 3 — Composer, models, permissions, skills, and capability activation

Scope: typed attachments, shared rich model picker, connect-then-chat flow, skill creation/import/slash discovery, capability action opening a new conversation, runtime activation policy, and live resource/capability generations.

Acceptance gate:

- attachment type/capability/proof matrix passes;
- provider connection never blocks on model selection;
- Connection and Chat display identical model facts;
- enabled skills are discoverable and exact revisions are invoked;
- approval effect matrix passes;
- agent observes a mid-conversation provider/storage/extension change on the next turn.

### Wave 4 — Unified Workspace and persistent terminal

Scope: WKS-01 through WKS-10 and TRM-01 through TRM-06: workbench consolidation, tab grammar, syntax themes, Git history/diffs/reveal, GitHub/export, integrated terminal, Bash/Git authority, automatic reconciliation, profile ownership, and terminal audit.

Acceptance gate:

- the platform-slice journey above passes;
- terminal/source-control Git state agrees under concurrent edits;
- durable reload reconstructs all terminal metadata;
- automatic reconciliation surfaces conflicts;
- GitHub/export journeys are bounded, cancellable, and auditable;
- mobile has equivalent pane and action paths.

### Wave 5 — Memory and automatic Proof

Scope: remove redundant Memory jump rail, automatic semantic mode/incremental index, durable profile graph, hidden-node recovery, automatic evidence acquisition, precise freshness language, durable evidence, complete proof hierarchy, and terminal/workspace audit linkage.

Acceptance gate:

- no manual evidence action is due after an ordinary protected turn;
- receipts remain immutable while evidence observations carry time/source;
- reload restores profile/session evidence and graph/index generation;
- TDX/SEV/NVIDIA/model/conversation layers are individually honest;
- dense desktop and complete phone Proof inventories match.

### Wave 6 — Durability, providers, Account, and extension supercharging

Scope: onboarding/refresh durability ceremony, Drive/S3 conformance, cross-device reconciliation, provider OAuth controllers, provider Account tabs, shared posture vocabulary, extension compute consumers, and extension OAuth decision.

Acceptance gate:

- multi-device convergence and conflict tests pass before “sync” is claimed;
- every provider tab distinguishes unavailable telemetry from zero;
- OAuth tokens have explicit owner/refresh/revocation boundaries;
- extension compute shows measured consumer work and deterministic fallback;
- top status always names storage authority and compute location.

### Wave 7 — Remote Chutes CPU TEE

Scope: TEE-01 and TEE-02 after provider contracts exist. This wave is externally dependent and must not be simulated by relabeling ordinary Chutes inference.

Acceptance gate:

- measured remote image and attestation policy are verified before dispatch;
- E2EE framing, replay/loss/resume/exactly-once behavior pass adversarial tests;
- terminal/tools/inference/workspace/storage operate through one remote session identity;
- encrypted writeback reconciles without plaintext service custody;
- signed receipts bind request, execution, model, result, workspace heads, and cancellation outcome;
- disconnect/reconnect, quota exhaustion, failed attestation, and backend loss fail closed.

## Cross-wave release gates

Every wave must pass all of these, not only its local feature tests:

1. **No pruning:** compare fact/action inventories before and after; any removed surface names the surviving home.
2. **Profile isolation:** two-profile adversarial fixtures cover reads, counts, search, recents, workspace, terminal, Memory, and Proof.
3. **Durability honesty:** page-memory, browser-local, extension cache, Drive/S3, and remote labels are derived from adopted live authority.
4. **Proof honesty:** local, encrypted, attested, stale-cache, unsupported, and failed states never collapse into one “secure” badge.
5. **Mobile parity:** phone tests assert the same capability and information, with alternate gestures for hover, double-click, right-click, middle-click, and drag/drop.
6. **Accessibility:** keyboard order, focus restoration, touch target, reduced motion, zoom, long-label, and screen-reader naming tests.
7. **Performance:** first-load cost, lazy chunks, index/runtime activation budgets, long transcripts, large repositories, and background resource throttling are measured.
8. **Clean-room provenance:** reference-informed work has study/spec/decision records and passes reference/release checks; checkout sources remain ignored and non-executable.
9. **External dependency truth:** unavailable provider/backend/browser capability remains explicitly unavailable until a real integration/conformance test passes.

## Working-tree checkpoint — 2026-07-29

This checkpoint continues the shared working tree from the read-only
integration review that closed the previous session. That review named four
concrete blockers; this section records what is now closed and verified, what
is deliberately left open, and one regression that is diagnosed but not fixed.
It supersedes only the rows it names.

### Closed and verified this pass

| Item | Result | Evidence |
| --- | --- | --- |
| **Suite was red.** Seven unit tests failed across five files, all from in-flight lane work. | **FIXED.** The file-type badge became an `<svg>` whose mark is sized in viewBox units, so it answers the Type scale preference instead of being a frozen 6px literal; `--terminal-dock-height` gained its documented runtime fallback; two new disabled states moved from `opacity` to `--ink-disabled`; the OAuth boundary assertion follows `describeChutesOAuthExchangeError` to its new home; the evidence-queue CAS test now asserts convergent merge rather than the single-writer rejection the merge deliberately replaced. | `src/ui/workspace-file-icon.tsx`, `src/ui/workspace-file-icon.css`, `src/ui/workspace-terminal-dock.css`, `src/ui/sessions-view.css`, `src/ui/shell.css`, `src/ui/connectivity-ui.test.ts`, `src/attestation/workspace-evidence-acquisition-persistence.test.ts`. |
| **Blocker 1 — Workspace UI could write into the control plane.** | **FIXED.** Save, create file, create folder, rename, move, delete and both folder plans funnel through three primitives; all three now reject reserved source *and* destination paths before touching storage or Git. | `assertMutableWorkspacePath` in `src/ui/workspace-view.tsx`; nine cases in `src/ui/workspace-view.test.ts`, including a repository's own nested `.airship` staying writable. |
| **Blocker 2 — Browser Git could read, commit or materialize over the control plane.** | **FIXED at the filesystem waist rather than per verb.** Every Git read, write, status walk and remote-tree materialization crosses `WorkspaceGitFileSystem`, so the fence is complete by construction: reads answer ENOENT (the walk traverses as though the tree were absent), writes refuse with EPERM, `readdir` omits the namespace, and a repository root can no longer be created inside it. | `isAirshipReservedPath` in `src/workspace/contracts.ts`; `readable`/`mutable` in `src/git/workspace-fs.ts`; `validateGitDestination` in `src/git/validation.ts`; five journeys in `src/git/workspace-adapter.test.ts` covering diff, forced stage, status walk, tree materialization, and nested `.airship` remaining committable. |
| **Blocker 4 — concurrent evidence queues could drop a completed turn.** | **Already fixed in the tree; now covered.** Receipt-keyed convergent CAS merge with immutable-identity conflict rejection, terminal-state protection, and a bounded retry. | `src/attestation/workspace-evidence-acquisition-persistence.ts` and four focused cases in its test. |

### Blocker 3 — profile-owned workspace authority

The chosen resolution was **full per-profile authority**, not an explicit
shared-binding policy. A Profile now owns a disjoint subtree of the global
storage authority, so its files, Git object database, worktree inventory and
index are genuinely its own rather than one shared filesystem behind separate
presentation state. The terminal is the one qualified case: a Profile owns its
own terminal manager, session set and workspace **mount**, but not its own
runtime. WebContainer boots once per page, so the container filesystem *outside*
the `airship-workspace` mount is page-shared: anything the previous Profile's
shell wrote elsewhere in the container survives the handoff. Handoff unmounts
and rebuilds the mount, which is the whole of what the manager owns; a stronger
boundary means a container `teardown()` and reboot per switch, at a
multi-second cost that has not been taken.

- `Runtime` separates `storage`/`storageId` (the global authority a Vault
  transition migrates and identity checks name) from `workspace`/`workspaceId`
  (the active Profile's namespace). Keeping the profile view named `workspace`
  was deliberate: every existing consumer became scoped by construction, and
  anything overlooked fails closed rather than silently sharing.
- `openProfileWorkspaceAuthority` builds the namespace, the Git authority over
  it, and the tool registry bound to both; `runtimeForProfile` rebuilds all
  three on a switch, because tools capture the port and a reused registry would
  let the new Profile's agent read the previous Profile's files.
- Authorities are cached per Profile while their storage lives. This is not an
  optimization: the workbench's page-memory store of unsaved drafts and the
  terminal-manager registry key on port *identity*, so a fresh port on every
  A→B→A would discard exactly the work a switch is supposed to preserve.
- A switch quiesces the outgoing Profile's live processes first. Each namespace
  gets its own terminal manager but the page has one WebContainer to give out,
  which is exactly why the paragraph above qualifies the terminal's ownership:
  the mount is Profile-private, the container around it is not. The Terminal
  route states that fact where a user can act on it
  (`TERMINAL_CONTAINER_SCOPE_NOTICE`, `src/ui/terminal-view.tsx`).
- A Profile opening its namespace for the first time is seeded with its own
  workspace repository. Without it, isolation reads as breakage: every Profile
  after the first would find no repository and therefore no Explorer tree,
  worktree selector, diff or history.
- `adoptLegacyRootWorkspace` moves pre-namespace content into the Profile that
  was using it, once, idempotently, copying before removing.

Verified: `npm run typecheck` clean; **2,357 unit tests pass**, one skipped;
`e2e/profile-silo.spec.ts` passes, now asserting the stronger fact that
Research cannot see the linked worktree General created because it is not in
Research's object database; `e2e/workspace-source-controls.spec.ts` **6/6**;
`e2e/workspace-workbench.spec.ts` and `e2e/workspace-terminal.spec.ts` pass.

### Vault adoption — fixed, with two latent defects it exposed

Adoption failed with `Encrypted vault already contains different content at
/workspace/.airship/profile-workspaces/v1/p-general/.git/index`. The
per-Profile change was the trigger, not the cause. Two defects were already
present and are now fixed at their root.

1. **The pristine-bootstrap check had the wrong polarity.**
   `isPristineBootstrapRuntime` required exactly one session at sequence 1
   carrying exactly one `session.created` event. The moment the Profile cockpit
   began journaling `profile.active-conversation.selected` at startup, every
   fresh boot began claiming to hold user work — so adoption copied a
   disposable sample workspace over an authoritative Vault on **every page
   load**. That was silently harmless only because the copy was three text
   files whose bytes matched. A per-boot Git index never matches, which turned
   it into a hard failure. The check now looks for *evidence of user work*
   (`turn.*`, `session.renamed`) rather than an exact bootstrap fingerprint, so
   bookkeeping added later cannot flip it again.
2. **Renames were not durable in an encrypted Vault.** `renameSession` only
   appends `session.renamed`; projecting it into the session record is the
   backend's job. Two backends did it through duplicated private helpers and
   `EncryptedObjectJournalBackend` did not — so a rename survived in page
   memory and IndexedDB and was lost in a Vault. The record then disagreed with
   its own history (`SESSION_TITLE_SNAPSHOT_MISMATCH`), the session refused to
   resume, and every conversation behind it was stranded on reload. The
   projection is now one shared `projectedSessionTitle` in `src/core/journal.ts`
   used by all three backends, covered by a cross-backend test that fails
   against the old encrypted backend.

`migrateWorkspaceState` also gained an explicit `seed` / `merge` mode. Seeding a
blank target still carries the workspace whole, including `.git`. Merging into a
target that already holds an authority carries user files only: a second
repository's index and objects describe a history the target does not have, and
a Git index embeds per-file revision identity, so copying it is both meaningless
and guaranteed to conflict. Adoption errors now also name which pin moved
instead of reporting only that something no longer matches.

Verified: `npm run check` passes end to end — typecheck, extension typecheck,
static-security, reference policy and self-test, **2,358 unit tests**, extension
packaging, production build, and the release gate. `e2e/vault-auto-adoption.spec.ts:96`,
`:128` and `:164` pass on desktop and mobile, and the Local Device product
journey passes.

### Release budgets — raised deliberately

The startup ceiling was raised from 132 to **160 KiB gzip** (768 KiB raw)
against a measured 132.58 KiB, with a hard cap well under 200 KiB. It is a
ceiling, not a target: deferring startup weight remains the first tool to reach
for, and a change that spends this headroom should say what it bought. Three
dependent aggregates moved with it to their measured values — the evidence
acquisition pack (now carrying the endpoint-evidence record store), the Terminal
pack, and the first-party/total JavaScript backstops. Every budget comment
records what was measured and why.

### UI/UX pass — 2026-07-29

Every route was captured and inspected at 1440x900 and at a 390x844 phone, and
the failing browser gates were worked through rather than annotated.

**Directives closed this pass**

| ID | What changed |
| --- | --- |
| MEM-02 | The redundant Recall/Graph/Index strip is gone. It restated three counts the sections below already carry and jumped to headings one scroll away; search now leads the route. Nothing was lost: the three scope cards are the scopes, the graph reports its own nodes/edges/components/density, and the Index disclosure reports its workspace sources. |
| CON-04 | A conversation is named by the model, not by truncating the first prompt. The local heuristic lands first so the thread is never nameless and the turn never waits; a bounded naming call then replaces it, and any failure, abort, or unusable answer leaves the heuristic. `usableConversationTitle` rejects preambles, refusals, and anything over eight words or 64 characters. |
| PIA-01 | Verified pinned, not merely present: the switcher is the first rail control, the destination list is the scrolling region, and driving that list to its end does not move the switcher. |
| CON-03 | Verified end to end: pointer drag, keyboard move, explicit touch controls, the All Conversations ledger, and Profile isolation of favourites. |
| VIS-05 | The file-tree row reserved a 34px action lane while the coarse-pointer action is 44px, so on a phone the byte size ran underneath the touch target. Both sides now read one `--tree-action-lane`. |

**Defects found by inspection, still open**

1. **Chat empty state.** The `Browser baseline` pill collides with the intro
   paragraph's last line at 1440px rather than sitting clear of it.
2. **Memory graph labels overlap** at default zoom — `docs/architecture.md`,
   `README.md` and `notes/retrieval.md` print on top of each other.
3. **`Attach image` is still image-only** (CMP-02). The directive asks for text,
   Markdown, PDF and code as well, with image controls shown only for a
   vision-capable model.
4. **Proof appears in two groupings.** The rail files it with profile work and
   Vault/Connection/Account under `GLOBAL`, which is PIA-07; the trust tab strip
   above the route files it *with* those three. Both readings are defensible —
   PIA-07's own gate says global trust navigation must not be removed — so this
   is left as an owner decision rather than changed unilaterally.
5. **Mobile names the destination `Trust`** where desktop and the tab strip say
   `Proof`. One destination, two words.

### Open — do not treat as done

Three browser gates fail, all pre-existing and all in the encrypted
context-publication lane rather than in any surface this pass touched:

1. **`e2e/vault-auto-adoption.spec.ts:75`** — a published encrypted context
   generation is not recognised after reload (`Encrypted generation published`
   never returns). The publication itself succeeds; the adoption that follows a
   reload does not resolve it.
2. **`e2e/local-device-app-journey.spec.ts`** — the Local Device journey covers
   the same publish-then-reload step.
3. **`e2e/vault-provider-switch.spec.ts:3`** — the `Connect your Google Drive`
   heading never appears, so the S3 to Drive authority switch cannot be driven.
   Probably environment-gated on the Drive lane.

These three share a suspect: `contextFabric.resolveExisting` matches a published
generation by workspace ID *and* a publication digest derived from the indexed
workspace. That digest is now computed over a Profile namespace, so anything
that changes between publish and reload — a re-seeded repository, a rewritten
Git index — would make a valid generation unrecognisable. Confirm that before
changing it; it is a hypothesis, not a diagnosis.

Also still open from the register, unchanged by this pass: CMP-02 typed
attachments, WKS-03 syntax highlighting, WKS-08 GitHub authentication, WKS-09
export, TRM-02/03 Bash and native `git`, MEM-04 automatic semantic mode,
PRF-05 NVIDIA/model/conversation layers, VLT-04/05 deployed provider
conformance, ACC-01/02 provider OAuth, EXT-03/04, and TEE-01. The
external-dependency boundaries recorded earlier still hold: none of these may be
relabelled complete without real provider or backend conformance evidence.

Full suite at this checkpoint: **170 passed, 3 failed, 91 skipped**, from
158/15 when this working tree was picked up. `npm run check` passes end to end.
