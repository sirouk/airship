# Airship Pass 1 findings ledger

Baseline `d161491` on `audit/whole-system-pass-1`. Produced by 20 parallel read-only
discovery scouts, each claim then re-checked against the code by an independent
reviewer who did not write it. 139 claims survived validation.

`verdict` is the reviewer's, not the scout's. `smallestFix` and `acceptanceCriteria`
are the reviewer's proposal and have NOT been implemented unless this file says so.

| # | Sev | Cluster | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | blocker | proof-vault | adoptLegacyRootWorkspace buries the global encrypted-context routing mirror inside one Profile's namespace, so a published generation is never resolvable after reload | **FIXED** (see below) |
| 2 | high | accessibility | A deep link to #sessions/#profiles/#skills/#capabilities/#context leaves the primary nav with zero tab stops | open |
| 3 | high | accessibility | Paper (light) mode is broken for the Research and Developer profiles: inline theme colours outrank the light stylesheet | open |
| 4 | high | chat-threads | Every fork/edit/retry branch opens with "This build cannot replay a session.fork.context.seeded record" | open |
| 5 | high | chat-threads | Fork and Edit & branch are rejected on the message that follows a failed, cancelled or denied turn | open |
| 6 | high | chat-threads | Model auto-naming appends session.renamed concurrently with the in-flight first turn and can fail that turn with a journal conflict | open |
| 7 | high | chat-threads | Reload in the default posture leaves the URL addressing a dead conversation and prints `Unknown session: <uuid>` under the composer | open |
| 8 | high | chat-threads | Retry forks at the post-answer boundary, so the regenerated turn still sees the answer it is replacing | open |
| 9 | high | chat-threads | The attachment fail-closed guards for Edit/Retry are unreachable on any reloaded transcript, so an edited branch silently drops the image | open |
| 10 | high | composer-models | Typing `/` shows only the first 10 commands alphabetically, so `/help`, `/models`, `/sessions`, `/read`, `/write` are never discoverable | open |
| 11 | high | connections-account | Account provider tabs can never see a live OpenAI/Anthropic/xAI connection — no producer for providerInventory | open |
| 12 | high | connections-account | Chutes connection requires a second explicit "Finish" step, and abandoning the panel discards a completed OAuth exchange | open |
| 13 | high | connections-account | Chutes sign-out never revokes the OAuth grant; the shipped revocation path has no production caller | open |
| 14 | high | design-system-responsive | Mobile soft-keyboard compensation for the composer is inert: `bottom` on a statically positioned element | open |
| 15 | high | git-terminal | Every keystroke performs a compare-and-swap lease write; two in flight kill the process and permanently disable the tab | open |
| 16 | high | git-terminal | Fetch/Push are enabled and explained wrongly for remotes this build can never reach | open |
| 17 | high | git-terminal | Starting or switching to a second terminal tab rm -rf's the shared mount under the first tab's live process (and wipes node_modules) | open |
| 18 | high | git-terminal | deactivate_execution_runtime tears down the shared WebContainer without quiescing the terminal, silently discarding unreconciled terminal filesystem work | open |
| 19 | high | memory-sources | Memory graph has no zoom on touch, and its canvas eats vertical page scroll, while the route tells the user to zoom | open |
| 20 | high | memory-sources | Profile memory scope "This conversation" is honoured only by automatic turn context; recall_memory and the Memory profile lane still return sibling-session memories | open |
| 21 | high | memory-sources | The 2,000-entry presentation cap is handed to the index engine as the workspace revision authority, so a workspace above the cap can never validate | open |
| 22 | high | performance | Past 256 KiB of output the terminal clears and rewrites the entire buffer on every chunk | open |
| 23 | high | proof-vault | "Switch to ephemeral · keep a page copy" is undone a frame later: the Local Device auto-open effect re-adopts the Vault the user just released | open |
| 24 | high | proof-vault | Google Drive (and local-lab in a production build) stays selectable in a build that cannot open it, and choosing it detaches the adopted Vault first | open |
| 25 | high | proof-vault | Proof for a non-active conversation shows and exports the ACTIVE conversation's endpoint evidence and receipts | open |
| 26 | high | proof-vault | Proof route never receives `acquisitionFailure`, so its hero verdict silently drops the "evidence not pulled" fact the chat chip shows | open |
| 27 | high | proof-vault | The S3/MinIO rung's comparison row promises cross-device reach and "your bucket" durability that no shippable configuration provides | open |
| 28 | high | shell-nav-profile | A failed profile switch leaves the old profile's UI and conversation running on the new profile's workspace, tools and Git client, with no error shown | open |
| 29 | high | shell-nav-profile | Previewing a theme in the Profiles editor silently overwrites the user's global display preferences and never restores them | open |
| 30 | high | tools-permissions | A stopped turn's tool strip says "Working" forever, in the page and after reload | open |
| 31 | high | tools-permissions | Ask First write-consequence panel misdescribes what is being approved | open |
| 32 | high | tools-permissions | Changing the conversation's approval policy silently rewrites the profile default | open |
| 33 | high | tools-permissions | No path to add, import, create, or update a skill — and an adopted Vault permanently freezes the shipped skill set | open |
| 34 | high | workspace-editor | Reopening the file you just closed leaves the editor pane empty | open |
| 35 | high | workspace-editor | Workspace Explorer context menu never receives focus, so Shift+F10 opens a role="menu" the keyboard cannot enter | open |
| 36 | medium | accessibility | All six global skill switches share the accessible name "Global default" | open |
| 37 | medium | accessibility | Composer queue controls and the attachment-remove button are 30px/28px on phone while every sibling control is 44px | open |
| 38 | medium | accessibility | Explorer context menu is opened by keyboard but is not keyboard-reachable in order | open |
| 39 | medium | accessibility | Sessions search field has no focus indicator: outline:0 with no compensating :focus-within | open |
| 40 | medium | accessibility | Three hand-rolled tablists ignore the roving-tabindex/arrow-key contract that tabs.tsx declares itself the single owner of | open |
| 41 | medium | accessibility | Virtualized Explorer tree reports wrong item positions to screen readers | open |
| 42 | medium | accessibility | aria-label on role=generic containers is dropped, and for three controls it is the only accessible text | open |
| 43 | medium | chat-threads | A stopped turn reports the stop three times, once headed with the raw event type turn.cancelled | open |
| 44 | medium | chat-threads | All Conversations loses its only Sort control between 861px and 1180px, and a non-default sort cannot be cleared | open |
| 45 | medium | chat-threads | All Conversations provider/model filter facets are built before the profile filter, leaking the other profile's inventory | open |
| 46 | medium | chat-threads | Bounded fork context silently drops ancestor turns and images; the counts the library returns have no consumer | open |
| 47 | medium | chat-threads | Every branch becomes a peer row in Recent, so edit/retry floods the conversation list and no alternates appear at the fork point | open |
| 48 | medium | chat-threads | Mobile message-action disclosure loses its expanded state and declares a menu it does not implement | open |
| 49 | medium | chat-threads | Renaming a conversation from All Conversations leaves the Chat title and the rail recents showing the old name | open |
| 50 | medium | chat-threads | The All Conversations fork surface and SESSION_LIBRARY.md still describe forks as context-free | open |
| 51 | medium | chat-threads | The conversation-naming inference is a second unaudited provider call: its receipt and usage events are discarded | open |
| 52 | medium | chat-threads | The session bar still shows a bare unlabelled event count next to another bare number; the unit exists only on hover | open |
| 53 | medium | chat-threads | Toggling one per-profile skill mode strands that profile's current conversation: the next switch back opens an empty one | open |
| 54 | medium | composer-models | An attachment-only message can never be sent, with no feedback explaining why | open |
| 55 | medium | composer-models | Attachments beyond the 8-file cap are dropped silently and the notice reports "0 images are ready" | open |
| 56 | medium | composer-models | Chat and Connection use different model controls with different capability vocabularies | open |
| 57 | medium | composer-models | Skills are invisible to the slash registry: no skill can be discovered or listed from the composer | open |
| 58 | medium | composer-models | Stop does not stop the conversation: the next queued message dispatches immediately | open |
| 59 | medium | composer-models | The catalog-enrichment retry button is gated on an unreachable state, so a failed management read has no recovery | open |
| 60 | medium | composer-models | The composer's credential-posture chip and Enter-contract legend are built, styled and unit-tested but never rendered | open |
| 61 | medium | composer-models | The composer's scroll-fade selectors can never match, so a scrolled draft still renders a half-sliced top line | open |
| 62 | medium | composer-models | The model-sort dropdown can be clipped by the picker popover's own overflow:hidden | open |
| 63 | medium | connections-account | "Charged this UTC month" sums a single unpaginated usage page and cannot detect truncation | open |
| 64 | medium | connections-account | A rejected credential still reads "Connected · Verified" on Account; a total read failure is called "Partial" | open |
| 65 | medium | connections-account | Account usage ledger deletes its per-day Tokens column on phone with no disclosure | open |
| 66 | medium | connections-account | Chutes sign-out never revokes the OAuth grant at the IdP; `revokeChutesToken` and the whole `ChutesCredentialBroker` are unreachable from production | open |
| 67 | medium | connections-account | The Chutes sign-in notice is never cleared, so a connected user is told to "finish the connection" | open |
| 68 | medium | design-system-responsive | A theme's typography and layout can never take effect once the profile is active, so the preview shows a difference applying cannot produce | open |
| 69 | medium | design-system-responsive | Light-mode users get a full-screen dark boot flash; the boot screen renders off the density/type ramp | open |
| 70 | medium | design-system-responsive | Session bar transposes its safe-area insets on phone | open |
| 71 | medium | design-system-responsive | Soft-keyboard avoidance is inert: `bottom` is applied to a statically positioned composer, and the hidden nav still occupies its 56px grid track | open |
| 72 | medium | design-system-responsive | The answer/narration typographic hierarchy never renders: .markdown overrides both rules | open |
| 73 | medium | extension-remote | The Firefox extension re-registers a fresh blocking webRequest listener on every capability re-observation and never removes the previous one | open |
| 74 | medium | extension-remote | Unavailable capabilities offer no remediation, and a host-blocked runtime is described as unadvertised by the release | open |
| 75 | medium | git-terminal | Profile handoff deletes only the terminal mount, so anything the previous Profile's shell wrote elsewhere in the shared WebContainer survives into the next Profile | open |
| 76 | medium | git-terminal | Reconcile is disabled for a failed terminal whose mount is still reconcilable | open |
| 77 | medium | git-terminal | Terminal "New here" renders as an empty 44px box on every phone and in the workspace dock | open |
| 78 | medium | git-terminal | Terminal bridge remaps `git restore --worktree` to `--source=HEAD`, discarding staged content | open |
| 79 | medium | git-terminal | Terminal metadata persistence failures are swallowed while the footer keeps claiming the lineage is retained | open |
| 80 | medium | git-terminal | Workbench Source Control never clears the commit message, so the next commit silently reuses it | open |
| 81 | medium | memory-sources | Hidden graph nodes have no Hidden list and no Restore control; the only way back is an undocumented side effect of the "Most connected" launcher | open |
| 82 | medium | memory-sources | Opening a Memory result whose path no longer resolves announces "Opened …" while the previously open document stays on screen | open |
| 83 | medium | memory-sources | Profile memory scope "Shared workspace" cannot change any retrieved record — it is identical to "This profile" on every path | open |
| 84 | medium | memory-sources | Semantic embedding mode never activates from the capability probe; it stays on hash vectors until a user finds a button inside a collapsed disclosure | open |
| 85 | medium | memory-sources | The indexer's 21-suffix allow-list marks most source languages `unsupported`, so a C/C++/Ruby/Shell repository indexes to zero chunks | open |
| 86 | medium | performance | Capabilities renders a one-shot snapshot labelled "probe current" and never subscribes to the registry that re-probes on device changes | open |
| 87 | medium | performance | Every durable event in a turn re-reads and decrypts the entire journal twice to refresh the recents shortcut | open |
| 88 | medium | performance | No global live resource/utilisation indicator exists; only static device capacity is reported | open |
| 89 | medium | performance | OPFS sync-access-handle probe can never fire in production, so Capabilities permanently understates OPFS | open |
| 90 | medium | proof-vault | "Expired" is a rendered claim state that neither Proof legend defines; the ledger legend teaches "Stale observation" and the summary tab counts expiry as "Failed" | open |
| 91 | medium | proof-vault | Aged endpoint evidence is never reacquired automatically — "Evidence refresh due" is left as routine user work | open |
| 92 | medium | proof-vault | Evidence-ledger selection is dropped on deep link and on the message-chip path, so the ledger silently shows the newest record instead | open |
| 93 | medium | proof-vault | Preferences' Durability row can never state adoption: the one call site omits `vaultAdopted` | open |
| 94 | medium | proof-vault | Terminal audit records still never reach the session journal or Proof/Memory (TRM-06) | open |
| 95 | medium | proof-vault | The Durability row offers destinations the running deployment cannot reach; the availability predicate gates loading but never the option list | open |
| 96 | medium | proof-vault | The Vault route's adoption-failure line is unreachable: no caller passes `adoptionNotice` | open |
| 97 | medium | proof-vault | Vault route decides Drive availability with a weaker predicate than the preference sanitiser, so a malformed client ID reads as available | open |
| 98 | medium | shell-nav-profile | "Apply in a new session" on the Skills route silently switches the active Profile to the preview target and swallows every failure | open |
| 99 | medium | shell-nav-profile | "Apply in a new session" resumes the profile's existing conversation instead of creating one | open |
| 100 | medium | shell-nav-profile | Archiving the scoped profile leaves the Skills scope control reading "All profiles" while every toggle writes to a different single profile | open |
| 101 | medium | shell-nav-profile | Landscape phones 861-950px wide lose the rail and never gain the compact profile switcher | open |
| 102 | medium | shell-nav-profile | Mobile bottom bar labels completed work as "pending" and hangs the attestation badge on a tab that does not contain it | open |
| 103 | medium | shell-nav-profile | Skills and Capabilities have no desktop entry point outside the profile-hub tab strip — absent from rail, command palette, and keyboard jumps | open |
| 104 | medium | shell-nav-profile | The beforeunload guard is armed for the entire life of the app, including when an adopted Vault can reconstruct everything | open |
| 105 | medium | tools-permissions | An executing tool step is labelled "Approved" with the verified seal; the running state is unreachable | open |
| 106 | medium | tools-permissions | Approval provenance is journaled but never surfaced or validated | open |
| 107 | medium | tools-permissions | Auto Approve claims only bounded metadata is reviewed, but ships scripts, code and URLs to the provider | open |
| 108 | medium | tools-permissions | Auto Approve's per-effect review inference has no usage, receipt or turn record | open |
| 109 | medium | tools-permissions | Full Access permits unbounded network egress while claiming workspace/path boundaries | open |
| 110 | medium | tools-permissions | Human-initiated Git, import and vault approvals leave no audit event and can be vetoed by the model | open |
| 111 | medium | workspace-editor | File rename/create dialogs skip name validation and fail silently on an invalid name | open |
| 112 | medium | workspace-editor | No export path exists for a file, a folder or a repository | open |
| 113 | medium | workspace-editor | On a phone the Workspace and Editor destinations never switch panes after first mount | open |
| 114 | medium | workspace-editor | Virtualised workspace tree exposes only the rendered window: no aria-setsize/aria-posinset and treeitems are not owned children | open |
| 115 | low | accessibility | A step waiting on approval is announced as "Tool step not checked" | open |
| 116 | low | accessibility | Duplicate-basename tabs are disambiguated, but their close buttons are not | open |
| 117 | low | accessibility | Historical turn errors are role="alert", so opening an old conversation fires assertive announcements | open |
| 118 | low | accessibility | Workbench tabs declare role=tab but control no tabpanel | open |
| 119 | low | chat-threads | The conversation surface never reports which skills are pinned to it | open |
| 120 | low | chat-threads | The zero-result empty state claims it searched every conversation in the journal, but the search is profile-scoped | open |
| 121 | low | connections-account | Account's not-connected gate offers Chutes sign-in in builds where sign-in cannot run | open |
| 122 | low | connections-account | Provider inventory model has no identity field, so a provider tab can never show the authenticated account | open |
| 123 | low | design-system-responsive | Capability disclosure summaries stay below the 44px touch minimum on phones while sibling buttons are raised | open |
| 124 | low | design-system-responsive | Terminal, Proof, Memory and management routes are capped at 1160px while only the Editor opts out | open |
| 125 | low | design-system-responsive | The always-ready POSIX shell runtime wears the model glyph and gets a "Run a probe" button that does not probe it | open |
| 126 | low | extension-remote | Capabilities route shows no browser-extension capability, and extensionBridgePromptEntries has no production caller | open |
| 127 | low | git-terminal | Source Control History shows a fixed depth-20 slice with a count that reads as the repository total | open |
| 128 | low | git-terminal | The 250-path truncation banner fires on total changes, not on either lane actually being cut | open |
| 129 | low | git-terminal | Workbench History shows a bare depth-capped count in the same grammar as exact counts, with no bound statement | open |
| 130 | low | memory-sources | A conversation hit threads a matched event ID the host discards, and no event anchoring exists anywhere in chat | open |
| 131 | low | proof-vault | The evidence ledger says raw evidence is withheld and, 155 lines later, that raw values are available in the same panel | open |
| 132 | low | shell-nav-profile | The navigation model declares All Conversations 'global' scope and the command palette prints it | open |
| 133 | low | shell-nav-profile | The rail's roving-tabindex contract collapses whenever the Chat conversation subtree is open — which clicking Chat forces | open |
| 134 | low | shell-nav-profile | `#settings` is a modelled, unit-tested hash that the router silently redirects to Chat | open |
| 135 | low | tests | The mobile-nav overlap assertion in the responsive spec queries a class no element carries | open |
| 136 | low | workspace-editor | A pinned status diff goes stale and its replacement tab is visually identical in the tab strip | open |
| 137 | low | workspace-editor | Binary file sizes are reported as the base64 envelope length, ~33% too large | open |
| 138 | low | workspace-editor | Line numbers vanish silently past 5,000 lines — the exact failure the surface note claims to prevent | open |
| 139 | low | workspace-editor | The code editor is still a plain textarea with no language awareness (WKS-03) | open |

## Detail

### 1. [blocker] adoptLegacyRootWorkspace buries the global encrypted-context routing mirror inside one Profile's namespace, so a published generation is never resolvable after reload

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/vault/context-fabric-port.ts, src/ui/app.tsx, src/workspace/profile-scope.ts, src/vault/context-fabric-port.test.ts, src/workspace/profile-scope.test.ts  
- **Regression risk:** medium

**Why (reviewer):** Every link in the chain reads exactly as claimed. src/vault/coordinator.ts:478,485 and src/vault/local-device.ts:116,144 construct `VaultContextFabricPort(store, key, workspace)` with the *global* `EncryptedObjectWorkspace`, not a Profile port; the UI receives that object verbatim (`contextFabric: ready.contextFabric`, src/ui/app.tsx:4514, 4525, 4716). It writes and reads `/workspace/.airship/context/routing-mirror.v2.json` (src/vault/context-fabric-port.ts:10, 65, 104, 130) at the storage root. `adoptLegacyRootWorkspace` lists `/workspace` on the storage authority and takes everything not under `PROFILE_WORKSPACE_ROOT` (src/workspace/profile-scope.ts:133), copies it into the booting Profile and removes the root copy (:139-143). I confirmed `EncryptedObjectWorkspace.list` is recursive over a flat manifest with a prefix filter (src/vault/encrypted-workspace.ts:91-98), so the mirror is matched. There is no exclusion list — the only filter is `isProfileWorkspacePath` (src/workspace/profile-scope.ts:12-15), and the mirror path is not under `/workspace/.airship/profile-workspaces/v1`. Ordering is as claimed: `openProfileWorkspaceAuthority` runs adoption at src/ui/app.tsx:8190 *before* the caller builds the vault-aware registry that calls `contextFabric.resolveExisting` (src/ui/app.tsx:4501 then :4508; src/tools/airship-tools.ts:74). That path runs on every reload with a durable vault, not just on first adoption: the effect at src/ui/app.tsx:2044-2061 calls `adoptReadyVaultRuntime` -> `adoptDurableRuntime` whenever a ready vault meets a non-`vault+` runtime. The idempotency comment at src/workspace/profile-scope.ts:122-123 ("nothing writes to the storage root once namespaces exist") is therefore false. This is not a re-report of something closed: docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:604-620 records `e2e/vault-auto-adoption.spec.ts:75` as still failing with exactly this symptom ("The publication itself succeeds; the adoption that follows a reload does not resolve it") and offers a *different* hypothesis — a publication-digest mismatch — which it explicitly labels "a hypothesis, not a diagnosis". The scout's diagnosis contradicts and supersedes it.

**Root cause:** The encrypted context fabric is bound to the global storage authority while every other consumer was moved behind `ProfileWorkspacePort`. Its one record then looks indistinguishable from pre-namespace user content to `adoptLegacyRootWorkspace`, whose only classifier is 'is this path under PROFILE_WORKSPACE_ROOT'. A control-plane record owned by the global authority has no way to declare itself as such, and adoption's stated invariant (nothing writes to the root) was invalidated the moment the fabric kept writing there.

**Smallest fix:** Bind the fabric to the active Profile's namespace, and stop adoption from moving a record the global authority owns. (1) Add a non-extracting rebind to `VaultContextFabricPort` — e.g. `scopedTo(workspace: ClientEncryptedWorkspacePort): VaultContextFabricPort` returning `new VaultContextFabricPort(this.store, this.key, workspace)` — because the UI deliberately never holds the store or key (src/vault/context-fabric-port.ts:41-52). (2) In `openProfileWorkspaceAuthority` (src/ui/app.tsx:8176-8226) return `contextFabric: ready.contextFabric.scopedTo(profileWorkspacePort)` and use that at src/ui/app.tsx:4514, :4525, :3005 and :4716 instead of the global one; the mirror then lives under PROFILE_WORKSPACE_ROOT and adoption never sees it. (3) In `adoptLegacyRootWorkspace`, skip `CONTEXT_ROUTING_MIRROR_PATH` so a mirror already at the root is left in place rather than buried in whichever Profile boots first. No segment data is lost in any case — only the pointer — so a stranded pre-fix mirror costs one re-publish.

**Acceptance:** Unit (src/vault/context-fabric-port.test.ts + src/workspace/profile-scope.test.ts): publish a generation through a fabric bound to Profile A's port over a MemoryWorkspace; assert the mirror byte lands under `/workspace/.airship/profile-workspaces/v1/p-A/`; run `adoptLegacyRootWorkspace(storage, 'A')` and then `adoptLegacyRootWorkspace(storage, 'B')`; assert `resolveExisting` for A still returns `mode: "ranged-vault"` and B's namespace contains no routing mirror. Regression guard: assert `adoptLegacyRootWorkspace` returns an empty adopted list when the only root file is `CONTEXT_ROUTING_MIRROR_PATH`. E2E: `e2e/vault-auto-adoption.spec.ts:74` ("encrypted context publication is an explicit Vault action and survives reload") passes, i.e. after `page.reload()` both "Encrypted generation published" and "adopted without uploading new shards" appear.

### 2. [high] A deep link to #sessions/#profiles/#skills/#capabilities/#context leaves the primary nav with zero tab stops

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/rail.tsx, src/ui/rail.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/rail.tsx:141 seeds `const [activeKey, setActiveKey] = useState<string>(view)` and src/ui/rail.tsx:160 only adopts a new view `if (order.includes(view))`, otherwise keeping `current`. `order` is built from `railTraversal(expanded)` (src/ui/rail.tsx:146-157) and RAIL_LAYOUT (src/ui/navigation-model.ts:192-212) contains only chat/workspace(editor,terminal)/memory/proof/vault/access/billing — confirmed by src/ui/navigation-model.test.ts:195. `sessions`, `profiles`, `skills`, `capabilities`, `context` are all NavigationViews (src/ui/navigation-model.ts:5-13) with real hashes (src/ui/navigation-model.ts:93-107), and app.tsx:922 seeds `view` from `readViewHash()` (app.tsx:9388-9390). Every rail button gets `tabIndex: activeKey === key ? 0 : -1` (src/ui/rail.tsx:220), the expander is hard-coded `tabIndex={-1}` (src/ui/rail.tsx:255), and the only other button inside `<nav class="primary-nav">` (src/ui/rail.tsx:478-489) is the recents disclosure, which also uses `itemProps(RECENTS_KEY)` (src/ui/rail.tsx:390). The "All conversations" button (src/ui/rail.tsx:429-434) is inside the disclosure, which is closed by default (`useState(false)`, src/ui/rail.tsx:139). So on first load at those five hashes `nav.primary-nav` has no element with tabIndex 0. One correction to the scout: the rail region is not wholly untabbable — the profile MenuSelect, the `Manage profiles` button (src/ui/rail.tsx:459-469) and `.rail-collapse` (src/ui/rail.tsx:492-498) sit outside the `<nav>` and stay reachable; what is unreachable by Tab is every navigation destination. The rail is rendered unconditionally for all views (app.tsx:6883).

**Root cause:** The roving-tabindex seed treats `view` as if it were always a rail key. `railTraversal` is the authority on which keys the rail actually renders, and 5 of the 14 NavigationViews are not in it, so the seeded `activeKey` names a row that does not exist and no row matches the `tabIndex 0` test. The reconciling effect deliberately keeps `current` when the view is off-rail, which is right for a navigation but wrong for the initial seed, where `current` is itself the off-rail value.

**Smallest fix:** Resolve the roving key through the traversal order in both the initial seed and the reconciler: a helper `rovingKey(view, order, current)` returning `order.includes(view) ? view : order.includes(current) ? current : (order.includes(canonicalParentForView(view)) ? canonicalParentForView(view) : order[0])`, used at src/ui/rail.tsx:141 (via a `useState` initialiser over `railTraversal({workspace: railRowFor(view)?.id === 'workspace'})`) and at src/ui/rail.tsx:160.

**Acceptance:** Rendering `<Rail view=X .../>` for X in {sessions, profiles, skills, capabilities, context, chat, memory, editor} yields exactly one element inside `nav.primary-nav` with `tabIndex === 0`; for `sessions` it is the Chat row; for `context` it is Memory (or the first row); collapsing/expanding Workspace while focus sits on `terminal` never leaves zero tab stops.

### 3. [high] Paper (light) mode is broken for the Research and Developer profiles: inline theme colours outrank the light stylesheet

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/profiles/domain.ts, src/ui/app.tsx, src/ui/css-variable-contract.test.ts  
- **Regression risk:** medium

**Why (reviewer):** Every step of the mechanism is in the code. src/profiles/domain.ts:250-255 diffs against `STYLESHEET_THEME_BASELINE[theme.colorScheme]` — the theme's OWN declared scheme, never the active mode. src/profiles/catalog.ts:199-215 (verdigris) and :216-231 (blue-ledger) are both `colorScheme: "dark"` and every one of the nine roles differs from the dark baseline at src/profiles/domain.ts:207-217, so all nine are returned as non-empty and written inline by src/ui/app.tsx:8255 `root.style.setProperty(property, value)`. src/ui/app.tsx:2629-2632 then runs `applyPreferenceOverrides(preferences)`, which at src/ui/platform-shell.tsx:368 sets `root.dataset.mode = value.mode`. Inline style beats both light blocks (src/ui/platform-shell.css:158-169 and src/ui/tokens.css:175-192), so on Paper the nine surfaces/inks/accents stay dark while everything the theme does NOT own flips light: `--line: rgba(23,26,29,.14)` and `--line-strong` from platform-shell.css:166-167, and `--v-caution #5c4212`, `--v-info #2e516e`, `--v-verified #395e58`, `--v-failed #ae4939`, `--copper #925038`, `--ink-disabled`, `--surface-disabled`, `--line-control` from tokens.css:176-191. THEME_CSS_VARIABLES (src/profiles/domain.ts:64-74) confirms verdict/line tokens are not theme roles. I recomputed the scout's worst case independently: light `--v-caution` #5c4212 (L=0.0622) on verdigris `--surface` #142022 (L=0.0130) gives 1.78:1 against a 4.5:1 floor — the scout's arithmetic is right. The `--line` case is the exact failure the divider test names: src/ui/css-variable-contract.test.ts:148-155 asserts >=1.2:1 and its comment says "divider is darker than its own panel, which is what Paper mode did", yet `resolvedTokens` (:212-217) only merges stylesheet blocks and never applies `themeCssVariables`, and the only theme-inline assertion (:101-108) checks foundry alone. I ran `npx vitest run src/ui/css-variable-contract.test.ts`: 8/8 pass, so the broken combination is genuinely untested. The doc comment at src/profiles/domain.ts:241-247 even admits the fix covers only "the default profile". PPF-03 is still PARTIAL in docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:52 and :275, so this is not a re-report of closed work.

**Root cause:** `themeCssVariables` treats the theme manifest's own `colorScheme` as the cascade it is diffing against, but the cascade actually in force is chosen at runtime by the global `data-mode` preference, which is applied after the theme. A dark-scheme theme therefore pins a full dark palette inline on top of a light-mode stylesheet, and the theme layer has no light expression of any palette to fall back to. The colour contract test never composes a theme with a mode, so the cascade it verifies is not the one the app produces.

**Smallest fix:** Make the theme layer mode-aware and prove it. (a) Give `themeCssVariables` the active colour mode — `themeCssVariables(theme, mode)` diffing against `STYLESHEET_THEME_BASELINE[mode]` — and, for the smallest complete version, have it return all-empty (i.e. hand the palette entirely to the stylesheet) whenever `mode !== theme.colorScheme`, so Paper is a real light instrument on every profile instead of a half-flipped dark one. Call it from src/ui/app.tsx:8255 with `preferences.mode`, and make the effect at :2629-2632 re-run applyTheme after the mode changes. (b) Extend src/ui/css-variable-contract.test.ts to iterate themes x modes: overlay the non-empty entries of `themeCssVariables(theme, mode)` onto `resolvedTokens(mode)` and re-run the existing verdict/ink/line assertions.

**Acceptance:** For every built-in theme (foundry, verdigris, blue-ledger) crossed with every mode (dark, light): with the theme's inline properties overlaid on the mode's resolved stylesheet tokens, `--v-verified`, `--v-caution`, `--v-info`, `--v-failed`, `--copper` and `--ink-faint` each clear 4.5:1 on the effective `--surface`/`--surface-raised`; `--line` and `--line-strong` each clear 1.2:1 on the effective `--ground`; and `--ink-disabled` clears its existing floor on `--surface-disabled`. The suite must fail if `themeCssVariables` is reverted to diffing against `theme.colorScheme`.

### 4. [high] Every fork/edit/retry branch opens with "This build cannot replay a session.fork.context.seeded record"

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/session-message-presentation.ts, src/ui/chat/session-message-presentation.test.ts  
- **Regression risk:** low

**Why (reviewer):** The seed is committed as an initialization event inside createSession (src/sessions/session-fork.ts:120-124 -> src/core/journal.ts:78-91), so a fresh branch journal is exactly [session.created, session.fork.context.seeded] and both are under the 20,000-event presentation bound (src/ui/app.tsx:8391-8401), i.e. nothing filters the seed out. The seed draft carries no turnId/operationId and "session.fork.context.seeded" does not match TURN_SCOPED_PREFIX = /^(?:turn|inference|assistant|tool|local)\./u (src/ui/chat/session-message-presentation.ts:234), so it takes the marker route at :486-488. sessionMarker (:527-590) has cases only for session.renamed, context.summary.updated, session.favorite.changed, profile.favorite-order.moved and profile.active-conversation.selected, then falls through to :584-588 `presentable: false, detail: \`This build cannot replay a ${event.type} record...\``. activateForkedSessionAgainst -> publishAuditedSession sets messages from the presentation because `presentation.rows.length + presentation.markers.length > 0` (src/ui/app.tsx:6540-6543, :6682), the marker message carries no `seed` flag (src/ui/app.tsx:786-798) so seedOnlyTranscript is false (:6737-6738) and the TranscriptIntro is suppressed, leaving TranscriptMarker (src/ui/chat/transcript-intro.tsx:114-128) as the branch's only content. src/core/session-audit.ts:60 already lists the type, so this is purely the renderer being out of date. The e2e branch journey only queries [data-transcript-card] (e2e/conversation-navigation.spec.ts:103, :113-117), so it cannot observe the marker.

**Root cause:** sessionMarker has no case for FORK_CONTEXT_EVENT_TYPE, and its unrecognised-record fallback is user-visible prose. Airship writes the event itself one operation before rendering it.

**Smallest fix:** In src/ui/chat/session-message-presentation.ts, before the :584 fallback, add a case for "session.fork.context.seeded" that validates the payload with canonicalForkContextSeed (src/core/fork-context.ts:105) and returns `presentable: true` with a lineage sentence built from sourceBoundarySequence, messages.length, omittedMessages and omittedImages — e.g. "Continued from the source conversation at event N · X ancestor messages carried, Y omitted (Z images omitted)." Keep the existing provenance line.

**Acceptance:** Unit: presenting a journal of [session.created, session.fork.context.seeded] yields exactly one marker with presentable === true whose detail contains the boundary sequence and the carried/omitted counts, and contains neither "cannot replay" nor the raw event type in the detail sentence. E2E: after Edit & branch, the transcript region contains no text matching /cannot replay/.

### 5. [high] Fork and Edit & branch are rejected on the message that follows a failed, cancelled or denied turn

- **Cluster:** chat-threads  
- **Verdict:** partially-confirmed  
- **Files:** src/sessions/session-fork.ts, src/sessions/session-library.test.ts  
- **Regression risk:** medium

**Why (reviewer):** The mechanism is exactly as described and I confirmed every link. A user row's sourcePoint is the event immediately before its turn.requested (src/ui/chat/session-message-presentation.ts:304). turn.failed/turn.cancelled are appended with `turnId` (src/core/agent.ts:556-562), and local.command.denied carries an operationId (src/core/session-audit.ts:871, :907). isForkBoundary accepts only session.created, turn.completed, local.command.completed, local.command.failed (src/sessions/session-fork.ts:144-146), and the session-scoped escape hatch requires turnId === undefined && operationId === undefined (:165-167), so resolveForkBoundary throws SessionForkConflictError("The requested historical fork point is not an audited quiescent conversation boundary.") (:156-162). branchDisabled only tests `!entry.item.sourcePoint` (src/ui/app.tsx:7050), so the control is enabled and fails after the click with that string interpolated into the notice at :3561-3563. Accepting local.command.failed while rejecting local.command.denied is genuinely inconsistent. I am marking partially-confirmed only because the scope in the body is overstated: the bad boundary is the immediately-preceding event, so it affects the user row of the turn right after the failure (and the assistant row of a failed turn whose predecessor also failed) — not "the rest of that conversation's life"; once a later turn completes, subsequent rows point at a turn.completed again. Separately, the same whitelist makes the no-sourcePoint default in resolveForkBoundary (:150-152) silently reverse-skip a trailing failed turn when forking from All Conversations.

**Root cause:** isForkBoundary enumerates only successful terminals, even though turn.failed / turn.cancelled / local.command.denied are equally quiescent between-turn states and materializeMessages already excludes non-actionable turns from provider context (src/core/agent.ts:894-905).

**Smallest fix:** Extend src/sessions/session-fork.ts:144-146 to `type === "session.created" || type === "turn.completed" || type === "turn.failed" || type === "turn.cancelled" || type === "local.command.completed" || type === "local.command.failed" || type === "local.command.denied"`. No UI change is needed: the prefix audit and the non-actionable-turn filter already do the right thing for those prefixes.

**Acceptance:** Unit: append a completed turn, then a turn that ends in turn.cancelled, then request a fork whose sourcePoint is the turn.cancelled event — the fork succeeds, lineage.sourceHeadSequence equals that sequence, and materializing the fork's events yields only the completed turn's user/assistant pair (the cancelled turn's prompt is absent). Same for turn.failed and local.command.denied. Integration: Edit & branch on the user message sent immediately after pressing Stop creates a branch instead of showing "not an audited quiescent conversation boundary".

### 6. [high] Model auto-naming appends session.renamed concurrently with the in-flight first turn and can fail that turn with a journal conflict

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/core/journal.ts, src/core/journal.test.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/app.tsx:3808 fires `void conversationTitleFromModel(turnRuntime, content, controller.signal).then(async (named) => { ... await applyTitle(named); })` — not awaited — and `applyTitle` (:3790) calls `turnRuntime.journal.renameSession(turnSessionId, ...)`. runTurn is then started at :3879 with `journal: turnRuntime.journal` and the same `turnSessionId`. `EventJournal.renameSession` (src/core/journal.ts:108-115) routes through `append`, which is an unguarded read-modify-CAS: `getSession` at :120, an awaited `sha256` per event at :143, then `backend.append(..., { sequence: session.headSequence, digest: session.headDigest }, ...)` at :157-162. Every backend rejects a stale head with `JournalConflictError` (src/core/memory-journal.ts:44, src/core/indexeddb-journal.ts:95, src/storage/encrypted-object-journal.ts:128). I grepped src/core and src/storage for any serialization (mutex/queue/lock) and found none. The product's own test proves the outcome: src/storage/encrypted-object-journal.test.ts:31-48 'serializes concurrent writers with exactly one session-head winner' asserts one append fulfils and the other rejects with `JournalConflictError`. `runTurn`'s `append` (src/core/agent.ts:156-167) has no conflict retry, so a losing turn append lands in the catch at agent.ts:542 and records `turn.failed`; the naming side swallows its own loss via `.catch(() => undefined)`. Note that `SessionLibrary` already retries this exact error for favourites (src/sessions/library.ts:184, :222), which shows the race class is known and that the rename path was simply not given the same treatment. Two distinct symptoms follow from the one race: the more likely one is the model title being silently discarded, the more damaging one is a failed turn.

**Root cause:** CON-04 introduced a second in-page writer to a session's journal while a turn is streaming into it, and `EventJournal.append` has no per-session serialization — its read-head / await-sha256 / compare-and-set window is interleavable, so whichever writer's CAS lands second throws.

**Smallest fix:** Serialize appends per session inside `EventJournal`: keep a `Map<string, Promise<unknown>>` and chain each `append(sessionId, ...)` onto the previous promise for that `sessionId` (delete the entry when the chain settles). ~10 lines in src/core/journal.ts, closes the whole class for every in-page writer including the silently-dropped title. If a purely local change is preferred, instead hold the resolved model title and apply it after `runTurn` settles in app.tsx rather than inside the unawaited `.then`.

**Acceptance:** A unit test that issues `journal.append(sessionId, [a])` and `journal.renameSession(sessionId, "t")` concurrently on the same `EventJournal` instance resolves both, the session head advances by two events, and neither rejects with `JournalConflictError`; a second test asserts the projected title is `"t"`. Cross-instance concurrency (two `EventJournal`s over one backend) must still reject, so encrypted-object-journal.test.ts:31 continues to pass unchanged.

### 7. [high] Reload in the default posture leaves the URL addressing a dead conversation and prints `Unknown session: <uuid>` under the composer

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/sessions/library.ts, src/ui/chat/session-message-presentation.ts, src/sessions/session-library.test.ts, src/ui/chat/session-message-presentation.test.ts  
- **Regression risk:** medium

**Why (reviewer):** The boot effect always builds page-memory authority — `const storage = new MemoryWorkspace()` (app.tsx:2526) and `new EventJournal(new MemoryJournalBackend())` (app.tsx:2566) — and always creates a fresh session (`createProfileSession`, app.tsx:2597) regardless of `preferences.vaultBackend`, whose default is `local-device` or `google-drive` (platform-shell.tsx:255-261, 327) and which only becomes real storage after adoption. `chatRouteRequest` is seeded from the hash at app.tsx:943-945, and the canonical URL `#chat/<sessionId>` is written at app.tsx:1577-1579. `SessionLibrary.readSnapshot` throws `Unknown session: ${sessionId}` (src/sessions/library.ts:257) — a plain `Error`, so `describeSessionPresentationFault` returns `error.message` verbatim (src/ui/chat/session-message-presentation.ts:174-176). The catch at app.tsx:1556-1566 never clears `chatRouteRequest`, and the canonicalisation effect is gated `if (view !== "chat" || chatRouteRequest || !sessionId) return;` (app.tsx:1572) — so the address bar keeps naming the dead id for the life of the page while a different conversation is open. `busy` and `sessionId` are both in the deps (app.tsx:1570) and `chatRouteOpening.current` is cleared in `finally` (app.tsx:1567-1569), so the lookup is retried and the notice re-raised. One correction: the "Connect its Vault and exact inference provider" sentence is only the non-`Error` arm; the string a user actually sees is `This conversation link is not available in the current runtime: Unknown session: 0198…`.

**Root cause:** The deep-link resolver has one failure arm for two different facts. `inspect` rejecting because the id is absent from this journal (page memory did not survive the reload) is treated identically to a durable session that is temporarily unresolvable, so the code keeps the URL and keeps `chatRouteRequest` set — which is also the flag that suppresses URL canonicalisation, making a transient miss permanent — and leaks the library's internal error text to the composer.

**Smallest fix:** Make absence typed and handle it separately: throw `new SessionMessagePresentationError("unknown-session", ...)` from src/sessions/library.ts:257 (and :262), and in the catch at app.tsx:1556 branch on that code — `setChatRouteRequest(undefined)` so app.tsx:1572-1580 rewrites the hash to the conversation actually open, and set a notice in the product's own words ("That conversation existed only in page memory and did not survive the reload. This is a new conversation."). Every other fault keeps today's retain-the-URL behaviour.

**Acceptance:** Mounting the shell with `location.hash = "#chat/<uuid-not-in-journal>"` against a MemoryJournalBackend ends with `location.hash === chatHash(activeSessionId)`, a composer notice that contains no UUID and no `Unknown session`, and no second notice after the next turn completes; the same mount against a journal that does contain the id resumes it and clears the notice; a session that fails for a genuine replay fault still keeps its URL.

### 8. [high] Retry forks at the post-answer boundary, so the regenerated turn still sees the answer it is replacing

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/session-message-presentation.ts, src/ui/app.tsx, src/sessions/session-library.test.ts, src/ui/chat/session-message-presentation.test.ts  
- **Regression risk:** medium

**Why (reviewer):** Traced the whole path. Retry only renders on assistant rows (src/ui/app.tsx:8970-8977, touch copy at :8996-8998) and calls forkFromMessage(entry.item, "retry") (src/ui/app.tsx:7047). forkFromMessage passes the row's own point through unchanged: `sourcePoint: message.sourcePoint` (src/ui/app.tsx:3521). For a completed turn the assistant row's sourcePoint IS the turn.completed event — src/ui/chat/session-message-presentation.ts:316-322 `lastEvent.type === "turn.completed" || ... ? { sequence: lastEvent.sequence, digest: lastEvent.digest } : { sequence: group.request.sequence - 1, digest: group.request.previousDigest }` — and the live path stamps the identical thing at src/ui/app.tsx:3953-3955. forkSession then slices `sourceEvents.slice(0, boundaryIndex + 1)` (src/sessions/session-fork.ts:48-49) and materializes that prefix into the sealed seed (:80-87, :114-124), so the seed contains [user prompt, assistant answer]. pendingForkRetry then re-sends the same prompt into the branch (src/ui/app.tsx:3525-3531 -> :1702-1715 `void sendMessage(pending.prompt, ...)`). Provider context is therefore prompt -> old answer -> same prompt. The register's checkpoint at docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:258 asserts "Retry branches before the prior answer and regenerates separately" — the code contradicts it, and so do the in-file comment at src/ui/app.tsx:8968-8971 and the notice at :3549.

**Root cause:** The retry action reuses the presentation row's `sourcePoint`, which for an assistant row is deliberately the post-answer terminal (correct for "Fork from here" on an answer, wrong for "regenerate this answer"). No pre-turn boundary is exposed on the assistant row, so retry has nothing else to fork at.

**Smallest fix:** Give the assistant row a second, explicitly named point: in src/ui/chat/session-message-presentation.ts add `turnStartPoint: Object.freeze({ sequence: group.request.sequence - 1, digest: group.request.previousDigest })` to the assistant row push (alongside :317-322), mirror it in the live stamping at src/ui/app.tsx:3946-3956, carry it through transcriptMessagesFromPresentation (src/ui/app.tsx:768-780) and the UiMessage type (:296-297), then in forkFromMessage use `sourcePoint: action === "retry" ? (message.turnStartPoint ?? message.sourcePoint) : message.sourcePoint` at src/ui/app.tsx:3521 and treat a missing turnStartPoint as a fail-closed refusal for retry rather than a silent fallback.

**Acceptance:** Unit (src/sessions/session-library.test.ts style): forking at the pre-turn point of turn N and materializing the fork's events with the verified seed digest yields the ancestor turns up to N-1 and contains neither the turn-N prompt nor the turn-N answer. Unit (session-message-presentation.test.ts): a completed agent turn's assistant row exposes turnStartPoint === {request.sequence - 1, request.previousDigest} while sourcePoint remains the turn.completed point. Integration: after Retry, the new session's seed message list does not contain the regenerated answer's text.

### 9. [high] The attachment fail-closed guards for Edit/Retry are unreachable on any reloaded transcript, so an edited branch silently drops the image

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/message-parts.ts, src/ui/chat/message-parts.test.ts, src/ui/chat/retry-prompt.test.ts  
- **Regression risk:** medium

**Why (reviewer):** Both guards key on a part whose only producer is the live composer. originatingPromptForRow bails on `previous.parts.some((part) => part.kind === "attachment")` (src/ui/chat/retry-prompt.ts:36) and forkFromMessage refuses on the same predicate plus an empty originatingAttachments (src/ui/app.tsx:3492-3498). Attachment parts come from userMessageParts (src/ui/chat/composer-state.ts:31-49), which is used only for the freshly-sent message (src/ui/app.tsx:3856-3876). The durable projection messagePartFactsFromDurableEvents emits exactly one text fact for turn.requested and never an attachment fact (src/ui/chat/message-parts.ts:292-305), despite the images being durably stored on that event (src/core/agent.ts:186-195) as full CanonicalImageInput records with name/mediaType/dataUrl/sizeBytes (src/core/multimodal.ts:41-77). transcriptMessagesFromPresentation never sets originatingAttachments at all (src/ui/app.tsx:768-780). So on a resumed/reloaded transcript the user row is text-only: the guards cannot fire, Edit & branch prefills text and `setAttachments(message.originatingAttachments ?? [])` = [] (src/ui/app.tsx:3542), and because the edit boundary is pre-turn the seed excludes the image too — the resent request loses the image with no notice. Note the fact->part pipeline already supports attachments (src/ui/chat/message-parts.ts:586-605), so only the durable projection is missing.

**Root cause:** Durable-to-presentation projection drops turn.requested.images entirely, so the guards test for a part kind that a resumed transcript can never contain. retry-prompt.test.ts passes only because it hand-builds an attachment part the durable path cannot produce.

**Smallest fix:** In src/ui/chat/message-parts.ts, in the turn.requested branch (:292-305), after pushing the text fact also push one attachment fact per entry of `canonicalImageInputs(payload.images)` — attachmentId derived from eventFactId, name/mediaType/sizeBytes from the durable record, `status: "available"` and a summary naming it as journaled inline image bytes. That single change makes both existing guards fire on resumed rows and restores the visible attachment chips; no guard rewrite is needed.

**Acceptance:** Unit (message-parts): a turn.requested event with two images and includeTurnRequest produces one text part plus two attachment parts carrying the durable name/mediaType/sizeBytes. Unit (retry-prompt): originatingPromptForRow returns undefined for an assistant row whose user row was built from a durable turn.requested carrying images. Integration: after reload, Edit & branch on an image-bearing user turn shows the "original attachment bytes are no longer in this page" notice and creates no branch, instead of creating a text-only one.

### 10. [high] Typing `/` shows only the first 10 commands alphabetically, so `/help`, `/models`, `/sessions`, `/read`, `/write` are never discoverable

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/commands/autocomplete.ts, src/ui/app.tsx, src/commands/commands.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:1415 passes `{ limit: 10 }`. src/commands/autocomplete.ts:52-60: for a bare `/` the query is `""`, every name passes `startsWith("")`, every candidate ties at rank 2, so the order is pure `localeCompare` on `command.name`, then `candidates.slice(0, limit)`. All five `createSlashCommandRegistry` call sites in src/ui/app.tsx (2576, 3079, 4637, 4742, 4879) pass no `exposeTool`, so src/commands/registry.ts:87-89 exposes every tool. I enumerated the registered tool names: workspace-tools (list_files, read_file, write_file, stat_path, search_text, replace_text, move_file, remove_file, text_editor), execution-tool-proxies (8), git-tools (4), network-tools (2), task-tools (2), memory-tools (2), plus search_memory, search_sessions, search_context, inspect_browser_capabilities — ~34 with the 3 built-ins. The alphabetical first ten are exactly the list the scout gives, ending at `git-inspect`; `help`, `models`, `sessions`, and the `read`/`write`/`ls` aliases (src/commands/registry.ts:37-41) all fall outside. The menu at src/ui/app.tsx:7109-7129 maps `slashCompletions` with no count and no overflow row, and `SLASH_MENU_HEADER` (src/ui/chat/composer.tsx:37) is referenced nowhere outside its own module. Mitigation the scout omits: the command palette does list every descriptor unbounded (src/ui/platform-shell.tsx:61-73), and `/h` reaches `/help` — but the composer's own placeholder advertises `"Message Airship — / for commands"` (composer.tsx:29) and `/` then shows zero commands.

**Root cause:** `commandCompletions` has no category weighting: on a tie it sorts alphabetically only, so an alphabetical prefix of the tool namespace crowds out every built-in, and the menu has no affordance telling the user the list was truncated.

**Smallest fix:** In src/commands/autocomplete.ts, add a category term to the comparator before the name tie-break — rank `command.category !== "tool"` ahead of tools (`const rank = (c) => c.category === "tool" ? 1 : 0;`) — and return the untruncated total so the menu can state it. In src/ui/app.tsx:7109 render the already-written `SLASH_MENU_HEADER` plus an `N of M` count as a non-interactive header row.

**Acceptance:** A unit test in src/commands/commands.test.ts asserting `completeSlashCommand("/", registry, { limit: 10 }).map(c => c.label)` contains `/help`, `/models` and `/sessions`; and an e2e assertion that typing `/` into the composer renders a listbox whose accessible content includes `help` and a visible count of the total available commands.

### 11. [high] Account provider tabs can never see a live OpenAI/Anthropic/xAI connection — no producer for providerInventory

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, e2e/account-providers.spec.ts, src/ui/billing-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** `providerInventory?: readonly BillingProviderInventoryEntry[];` is optional at src/ui/billing-view.tsx:135 (type at :47-56). I grepped every `BillingView` reference (src/deferred-capabilities.ts:42, src/ui/app.tsx:468/2196/7463, src/ui/billing-route.tsx — itself referenced by nothing outside its own file) and the only production render site is src/ui/app.tsx:7463-7471, which passes accountReadable/credentialKind/credentialRevision/invocationTelemetry/online/loadSnapshot/onOpenAccess and no inventory. `resolveBillingProviderInventory` (src/ui/billing-view.tsx:95-119) therefore hits `entry?.state ?? "unavailable" as const` at :112-113 for every non-Chutes provider, so `BillingProviderInventoryPanel` prints "Connection state was not supplied to this view." (:545) and `billingProviderDatumLabel(undefined, "unavailable")` returns "Unavailable" for Quota/Usage/Reset (:84-93). App already holds the fact: `connectedInferenceProviderIds` at src/ui/app.tsx:1366-1369, passed only to the Connection route at :7546. The IDs are the same union — `BrowserCloudProviderId = "openai" | "anthropic" | "xai"` (src/inference/fabric.ts:37) versus `BillingProviderId` (src/ui/billing-view.tsx:26). e2e/account-providers.spec.ts:9-13 asserts `"OpenAIUnavailable", "AnthropicUnavailable", "xAIUnavailable"`, and src/ui/billing-view.test.ts:33 only exercises the pure resolver with a synthetic array, so nothing covers the wiring.

**Root cause:** The ACC-04 presentation seam was landed as a pure, optional prop with a defensive `unavailable` default and no production producer. App owns the connection fact (`connectedInferenceProviderIds`) but routes it only to Connection, so Account's fallback — written for 'the host said nothing' — becomes the permanent state and misrepresents a working capability as an absent one.

**Smallest fix:** In src/ui/app.tsx build a memoized `billingProviderInventory` beside `connectedInferenceProviderIds` (:1366-1369) that, only when `inferenceFabric.current` exists, emits one entry per non-Chutes `BILLING_PROVIDERS` id with `state: connectedInferenceProviderIds.includes(id) ? "connected" : "not-connected"` and no telemetry fields, and pass it as `providerInventory` at :7463-7471. Emit nothing before the fabric loads so the existing `unavailable` default still covers 'not observed yet'. Update e2e/account-providers.spec.ts to expect `OpenAINot connected` once the fabric has loaded. Do not invent quota/usage/reset — those stay Not provided/Unavailable by observation.

**Acceptance:** 1) With a page-memory OpenAI key connected through the Connection route, the Account OpenAI tab reads "Connected", its panel does not contain "Connection state was not supplied to this view.", and Quota/Usage/Reset read "Not provided" (never "0"). 2) With the fabric loaded and no cloud provider connected, the three non-Chutes tabs read "Not connected". 3) Before the fabric resolves they still read "Unavailable". 4) Disconnecting a provider flips its Account tab back to "Not connected" on the next render. 5) A unit test asserts app.tsx passes `providerInventory` to `BillingScreen`.

### 12. [high] Chutes connection requires a second explicit "Finish" step, and abandoning the panel discards a completed OAuth exchange

- **Cluster:** connections-account  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/access-view.tsx, src/ui/app.tsx, src/ui/connection-continuity.test.ts, src/ui/access-view.copy.test.ts  
- **Regression risk:** high

**Why (reviewer):** Confirmed the two-step shape: discovery (src/ui/access-view.tsx:365-441) only reads the PUBLIC catalog via `new ModelCatalogClient({ includeManagement: true, timeoutMs: 20_000 })` (:388) and never touches the credential; the credential is first exercised in `activate()` at src/ui/access-view.tsx:461-518 (`await discoveryTransport.verifyModelAccess(model.id, controller.signal)` :474), which is only reachable from `<button class="primary" ... onClick={() => void activate()}>Finish: verify &amp; connect</button>` (:949). `onConnect` -> `connectChutes` is what ends with `navigate("chat")` (src/ui/app.tsx:5973), so no connection and no Chat exists until Finish. The OAuth banner text at :879 says exactly "Choose the session model and finish." The stranding half is also confirmed mechanically: `takePendingOAuthCredential` consumes the ref (src/ui/app.tsx:2480-2484), the bootstrap effect is keyed `[oauthBootstrap?.revision, connection.kind, online]` (src/ui/access-view.tsx:452-457), AccessView is conditionally mounted (`{view === "access" ? ...}` src/ui/app.tsx:7511) so leaving the route unmounts it, `useEffect(() => () => clearEphemeral(), [])` (:305) revokes the candidate transport, and `candidate` is component state that dies with it. PARTIAL on two points the scout overstated: (a) the user is never forced to *pick* a model - `setModelId(selection.model?.id ?? compatibleModels[0]!.id)` (:423) pre-selects the recommendation, and `strictProof` defaults false (:220), so Finish is a single press, not a decision; (b) the exchange is not unrecoverable - `oauthTokens.current` survives and the entry stack still offers `Sign in to Chutes`, so recovery costs a full re-authorization round trip rather than being impossible. Register status: CMP-03/ACC-03 are recorded CONTRADICTED (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:91,165) and explicitly retained at :276-280, so this is still open, not already fixed.

**Root cause:** The only step that actually verifies the credential (`verifyModelAccess`) is bound to a manual button press instead of running automatically against the already-selected default model, and the OAuth credential handoff is a single-use ref plus component-local `candidate` state with no way to re-enter discovery after a remount.

**Smallest fix:** Two small changes. (1) After a successful `discoverCredential`, run the existing `activate()` automatically with the pre-selected `modelId` and default (non-strict) policy so credential verification completes the connection and `connectChutes` navigates to Chat; keep the model/proof-policy controls, but as post-connection edits (the connected summary already renders `ModelPicker` + `selectActiveModel`, src/ui/access-view.tsx:846-856). (2) Make `takePendingOAuthCredential` non-destructive: read `pendingOAuthCredential.current` without clearing, and clear it only on commit inside `connectChutes` and in `startOAuthSignIn`/`releaseChutesAuthority` (src/ui/app.tsx:2458, 5991), so a remount of AccessView re-runs discovery from the still-valid token.

**Acceptance:** With a stubbed OAuth callback and a stubbed catalog + `verifyModelAccess`, the app reaches `connection.kind === "chutes-oauth"` and `view === "chat"` with zero presses after the redirect returns; no "Finish: verify & connect" press is required in the OAuth journey. Unmounting AccessView after the callback and remounting it re-runs discovery (candidate present again) rather than rendering the empty entry stack. A failed `verifyModelAccess` still leaves the user on #connection with the provider's verbatim refusal and no committed connection.

### 13. [high] Chutes sign-out never revokes the OAuth grant; the shipped revocation path has no production caller

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/connection-continuity.test.ts  
- **Regression risk:** low

**Why (reviewer):** `releaseChutesAuthority` (src/ui/app.tsx:5977-6010) is the only sign-out/credential-switch path (`disconnectChutes` at :6012-6018 delegates to it; the refresh-failure branch at :2788 also calls it). It sets `oauthTokens.current = undefined;` at :5990 and calls `releasedTransport?.revokeCredential(...)` at :6002, which is an in-page abort only — src/inference/chutes/transport.ts:192-204 aborts `credentialRevocation` and clears caches, with no network call. `oauthTokens.current` is the full token set including `refreshToken` (assigned at src/ui/app.tsx:2678, rotated at :2780, read at :2760-2761 for refresh), so a live refresh token is discarded without a revocation request. Grepping `revokeChutesToken` across src/, scripts/, e2e/ gives hits only in src/auth/chutes-oauth.ts:257 (the implementation) and src/auth/chutes-credential-broker.ts:4/83/147/230 — and `ChutesCredentialBroker` appears nowhere outside src/auth (other 'CredentialBroker' hits are the unrelated `WorkspaceGitRemoteCredentialBroker` in src/git/workspace-adapter.ts). scripts/local-chutes-oauth-bridge.ts:5 defines `REVOKE_ROUTE = "/__airship/chutes/oauth/revoke"` with no browser caller. The exposure is stated by the code itself at src/auth/chutes-oauth.ts:250-253, and src/auth/chutes-oauth-registration.ts declares `refreshTokenLifetimeDays: 30`.

**Root cause:** Revocation was implemented behind `ChutesCredentialBroker`, but production never mounts the broker — App holds the token set directly in a `useRef` and teardown was written against the transport's in-page `revokeCredential`, whose identical name makes the gap invisible at the call site. Sign-out ends Airship's use of the credential without ending the grant.

**Smallest fix:** In `releaseChutesAuthority` capture `const releasedTokens = oauthTokens.current;` before clearing, then after the synchronous teardown fire one detached best-effort revocation when a token set was held: dynamically `import("../auth/chutes-oauth")` and call `revokeChutesToken` for `{ token: releasedTokens.refreshToken, tokenTypeHint: "refresh_token" }` then `{ token: releasedTokens.accessToken, tokenTypeHint: "access_token" }` with `CHUTES_ACTIVE_REGISTRATION` and its clientId, each `.catch(() => undefined)`. Keep it `void`-ed so teardown stays synchronous and released state is set regardless of outcome; do not report the result as proof the provider session ended (the endpoint returns 200 for unknown tokens — docs/gap-audit/inference.md:125).

**Acceptance:** 1) With a stubbed fetch, `disconnectChutes()` on an OAuth session issues a POST to the revocation endpoint with `token_type_hint=refresh_token` and then one with `token_type_hint=access_token`, both carrying `client_id` and no Authorization header. 2) The connection is cleared to `DISCONNECTED_CHUTES_CONNECTION` and `oauthTokens.current` is undefined even when the revoke rejects, times out, or never settles — teardown must not await it. 3) An api-key session issues no revocation request. 4) A source-contract case in src/ui/connection-continuity.test.ts asserts `releaseChutesAuthority` references `revokeChutesToken`.

### 14. [high] Mobile soft-keyboard compensation for the composer is inert: `bottom` on a statically positioned element

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/routes.css, src/ui/platform-shell.css, e2e/composer-layout.spec.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/platform-shell.css:183 is exactly `:root[data-keyboard-open="true"] .composer-wrap { bottom: var(--visual-viewport-bottom, 0); }`. I grepped every `.composer-wrap` rule in the repo (src/ui/chat.css:1086, :1631, :1639; src/ui/routes.css:2786, :2875, :3011, :3255, :3263, :3273; src/ui/tokens.css:307) and read each one: they declare only padding, border-top, background, backdrop-filter, line-clamp. No rule anywhere sets `position` on `.composer-wrap`, so it is `position: static` and `bottom` is ignored. src/ui/platform-shell.css:182 hides the nav with `visibility: hidden`, which retains layout; `.mobile-nav` is `grid-row: 3` (src/ui/routes.css:2456-2459) inside `.app-shell`'s `grid-template-rows: ... calc(56px + env(safe-area-inset-bottom))` (src/ui/routes.css:2385-2388), and `.fixed-mobile-nav` (src/ui/mobile-navigation.tsx:108) is never given `position: fixed` by any rule — the class only exists as the hook at platform-shell.css:182. index.html:5 has no `interactive-widget`, so the layout viewport and the `100dvh` at routes.css:2377-2381 do not shrink. This is not inference: docs/design-review/journey-complaints.md:14 records an instrumented measurement of exactly this — `computed .composer-wrap is position: static; bottom: 336px — inert`, composer y791-876, keyboard top y596, Send 217-261px below the keyboard line, and `.mobile-nav ... keeps its 56px layout box (y876-932)`. The scout's claim matches the measured behaviour.

**Root cause:** The keyboard compensation was written as a `bottom` offset without ever giving `.composer-wrap` a positioning context, and the nav is hidden with `visibility` rather than being removed from the grid, so neither half of the compensation has any layout effect. Nothing recomputes the transcript's bottom padding or re-runs scroll-to-bottom on a visualViewport resize either, so the transcript does not reflow.

**Smallest fix:** Inside the phone block in src/ui/routes.css (the `@media (max-width: 640px), (max-width: 950px) and (max-height: 500px)` block that already owns `.composer-wrap` at :2786): `.composer-wrap { position: fixed; left: 0; right: 0; bottom: calc(var(--visual-viewport-bottom, 0px) + env(safe-area-inset-bottom)); z-index: 40; }` and give `.transcript` a matching `padding-bottom`. Change src/ui/platform-shell.css:182 from `visibility: hidden` to `display: none` so the 56px track is actually released. Keep src/ui/platform-shell.tsx:643-649 as-is — it already publishes the correct values.

**Acceptance:** In a mobile-chromium spec at 430x932 with `window.visualViewport` instrumented so `data-keyboard-open` is `"true"` and `--visual-viewport-bottom` is 336px: (a) the bounding rects of `[aria-label="Message Airship"]` and the Send button both have `bottom <= window.innerHeight - 336`; (b) `document.querySelector('.mobile-nav').getBoundingClientRect().height === 0`; (c) `getComputedStyle(document.querySelector('.composer-wrap')).position !== 'static'`.

### 15. [high] Every keystroke performs a compare-and-swap lease write; two in flight kill the process and permanently disable the tab

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/terminal/manager.ts, src/terminal/manager.test.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/terminal-view.tsx:383-388 fires `void manager.write(initial.id, data).catch(...)` from `emulator.onData`/`onBinary` with no serialization, so keystroke N+1 starts before N resolves. src/terminal/manager.ts:344 is `await this.renewSessionLease(sessionId);` on every call. `renewSessionLease` (:845-869) is read-then-CAS-write with no tail promise: `const current = await this.workspace.read(path)` (:849) then `await this.workspace.write(path, ..., { expectedRevision: current.revision })` (:856-860). Both MemoryWorkspace and IndexedDbWorkspace are genuinely async (src/workspace/indexeddb.ts:69-83 opens a readwrite transaction and awaits `transactionDone`), and the production encrypted port is far heavier — src/vault/encrypted-workspace.ts:101-140 seals with AES-GCM, derives an opaque object id, does a `putIfAbsent` and a manifest commit per write. So two overlapping renewals both read revision R; the loser gets `WorkspaceConflictError` from `checkRevision` (src/workspace/memory.ts:66-70), and the catch at manager.ts:862-868 calls `this.loseSessionLease(sessionId)` unconditionally — it never re-reads to see whether the winner was itself. `loseSessionLease` (:887-903) sets `session.suppressPersistence = true`, kills the process, and sets status `failed` with detail "Terminal writer lease was lost; the page-local process was stopped...". The damage is worse than the scout said: `suppressPersistence` permanently excludes the session from every later manifest write (`.filter((session) => !session.suppressPersistence)`, :950) and `acquireSessionLease` refuses to restart it (:815-817), so the tab is dead and its transcript/lineage stops being retained until a page reload. The 12s heartbeat at :873-877 supplies a second, unavoidable racer against typing. No existing test covers self-concurrent renewal — manager.test.ts:180 only covers a genuine foreign owner.

**Root cause:** The durable writer lease is treated as a per-input transaction rather than a heartbeat, and renewal is unsynchronized, so a page races itself; on top of that, a CAS conflict is interpreted as foreign takeover without re-reading the lease owner, and that misinterpretation is latched irreversibly via `suppressPersistence`.

**Smallest fix:** Three small edits in src/terminal/manager.ts: (1) serialize/coalesce renewals behind one per-session tail promise so concurrent callers share a single in-flight renewal; (2) in `write()` (:344) stop renewing per call — assert only that `this.sessionLeases.has(sessionId)` and let the 12s timer heartbeat renew; (3) in the `renewSessionLease` catch (:862-868), on `WorkspaceConflictError` re-read the lease and call `loseSessionLease` only when `lease.ownerId !== this.leaseOwnerId`, otherwise adopt the observed revision and continue.

**Acceptance:** With an async workspace whose read/write resolve on later microtasks, issue 20 concurrent `manager.write(id, 'a')` calls against one running session: session status stays `running`, no `failed` detail mentioning the lease appears, `suppressPersistence` stays false (the session still appears in the persisted manifest), and the lease file is written at most once per heartbeat interval rather than 20 times. The existing foreign-writer test (src/terminal/manager.test.ts:180) must still reject the second author.

### 16. [high] Fetch/Push are enabled and explained wrongly for remotes this build can never reach

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/ui/sources-view.tsx, src/ui/sources-view.test.ts, src/git/validation.ts  
- **Regression risk:** low

**Why (reviewer):** Verified every link in the chain. src/git/validation.ts:42 freezes GIT_REMOTE_CONNECT_ORIGINS to []; src/git/validation.ts:50-53 gitRemoteConnectOrigins() prepends the page origin, so in any browser the list is non-empty. src/git/workspace-adapter.ts:1625-1636 remoteFeature returns available:false only when permittedOrigins is empty, so clone/fetch/push are all available:true in a browser (:1687-1689). Snapshot import registers origin as the GitHub URL: src/tools/repository-admission.ts:55 sourceUrl `https://github.com/${owner}/${name}`, stored at src/git/workspace-adapter.ts:571 remotes:[{name:"origin",url:validateRemoteUrl(request.sourceUrl)}]. src/ui/sources-view.tsx:604 opens the Remote boundary whenever `remote` exists and fetch/push are available; :609-610 disable only on `busy || !remote || !capabilities.features.{fetch,push}.available` — never on the selected remote's origin. :612-616 renders the honest CSP reason only in the !available branch, otherwise gitCredentialBoundary(client), which for credentialPersistence "none" returns "Anonymous direct push only. This build has no Git credential broker, so an authenticated remote will refuse the request." (:1145) — the wrong cause. The real refusal is src/git/validation.ts:66-77 assertRemoteOriginPermitted, applied per-URL inside the adapter (:630 fetch, :649 push), i.e. after the click. Also confirmed src/ui/sources-view.tsx:450 prints "A clone-capable adapter is available." in an empty state that contains no clone control (only import and refresh buttons at :445-448). This is NOT a duplicate of the register's WKS-08 entry (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:109), which records the missing GitHub auth; the defect here is that the UI presents the unreachable capability as enabled and misattributes the refusal.

**Root cause:** Remote capability is modelled as one per-build boolean derived from gitRemoteConnectOrigins(), which always contains the page's own origin, while the decision that actually governs a fetch/push is per-remote-URL (assertRemoteOriginPermitted). The UI consumes the build-wide boolean and never compares the selected remote's origin against capabilities.remote.permittedOrigins.

**Smallest fix:** In src/ui/sources-view.tsx derive one value, e.g. `const remoteReachable = remote ? client.capabilities.remote.permittedOrigins.includes(new URL(remote.url).origin) : false;` (guarding URL parse), and use it (a) in the two disabled expressions at :609-610, (b) in the `<details open={...}>` condition at :604, and (c) to choose the paragraph at :612 — when the remote is unreachable render the CSP sentence naming the remote's origin and the permitted origins instead of gitCredentialBoundary(). Replace the :450 empty-state sentence so it never claims a clone adapter is available when no clone control exists; state the permitted-origin fact instead. Export the reachability helper from sources-view (or src/git/validation.ts) so it is unit-testable.

**Acceptance:** 1) Given capabilities.remote.permittedOrigins = ["http://localhost:4173"] and a remote url "https://github.com/o/n", the helper returns false; with url "http://localhost:4173/o/n.git" it returns true. 2) Rendering the Advanced source controls with a GitHub origin remote leaves both the "Fetch direct" and "Push <branch>" buttons with the disabled attribute set, and the Remote boundary details element is not open. 3) The rendered remote-boundary text contains "Content-Security-Policy" and does not contain "Anonymous direct push only" for that remote. 4) The no-repository empty state never renders the literal "A clone-capable adapter is available."

### 17. [high] Starting or switching to a second terminal tab rm -rf's the shared mount under the first tab's live process (and wipes node_modules)

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/terminal/manager.ts, src/terminal/workspace-sync.ts, src/terminal/manager.test.ts  
- **Regression risk:** medium

**Why (reviewer):** I read the whole path. src/terminal/manager.ts:291-293 does `const hadMountedHost = Boolean(this.host && this.baseline); const host = await this.ensureHost(signal); if (hadMountedHost) await this.syncWorkspace();` — unconditional on whether any other session is live. src/terminal/workspace-sync.ts:130-133 (`reconcileTerminalWorkspace`) does `syncTerminalWorkspace(...)` then `await host.fs.rm(TERMINAL_WORKSPACE_MOUNT, { recursive: true, force: true })` then `mountTerminalWorkspace(...)`. There is one `this.host`/`this.baseline` per manager and one manager per WorkspacePort (src/terminal/manager.ts:101-107, 136-139), so all tabs share the mount. `start()` only early-returns for the session being started (`if (session.status === "running" || session.status === "starting") return;`, :280), never for its siblings. Reachability is exactly as claimed: src/ui/terminal-view.tsx:301-302 renders `<TerminalPanel key={active.id} ...>` and :390/:402-405 auto-start (`let autoStartPending = true;` ... `if (autoStartPending) { autoStartPending = false; void manager.start(initial.id, dimensions)...}`), so selecting any not-yet-running tab remounts the panel and fires start. The same rm+remount also fires from processExited (manager.ts:639). One consequence the scout understated and I confirmed in code: the remount is rebuilt only from workspace-visible files, and `node_modules`/`.git` are excluded both from the export (workspace-sync.ts:62) and from the mount (`const EXCLUDED = new Set([".git", ".airship", "node_modules"]);`, workspace-sync.ts:11), so the destroy-and-remount permanently deletes node_modules from under a live process — while execution-tools.ts's own execute_node_project description tells the user to "use Workspace Terminal for a long-running dev server". Writes made by the live process between `host.export` (workspace-sync.ts:60) and the `rm` (:131) are also lost outright. The reconcile at manager.ts:293 passes no sessionId, so it records no audit record and shows no notice — it is silent.

**Root cause:** Reconciliation is implemented as destroy-and-remount of the single shared mount root rather than as a per-path delta, and `start()`/`processExited` invoke it whenever a mount exists, with no check that the mount is quiescent. Nothing fences the other sessions' live jsh processes, and the rebuilt mount cannot restore mount-only state (node_modules) because that state is deliberately excluded from both export and mount.

**Smallest fix:** Gate the reconcile on mount quiescence: at src/terminal/manager.ts:293 and :639, only call `this.syncWorkspace(...)` when no other session is `running`/`starting` (`![...this.sessions.values()].some((other) => other.id !== session.id && (other.status === "running" || other.status === "starting"))`); otherwise skip the incoming remount and run only the outgoing `syncTerminalWorkspace` (which does not delete the mount root), and set a session detail saying the mount was not refreshed because another process is live. The manual Reconcile button can keep the full reconcile since the user chose it — but it should get the same guard or an explicit confirmation.

**Acceptance:** Unit test on BrowserTerminalManager with a fake host that records `fs.rm` calls: start session A (status running), then start session B on the same manager; assert `fs.rm(TERMINAL_WORKSPACE_MOUNT, ...)` was never called while A.status === "running", and that a mount-only path (e.g. `node_modules/x`) present in the fake host's export before B starts is still present after. A second test: with A exited/idle, starting B still performs the full reconcile (rm + remount).

### 18. [high] deactivate_execution_runtime tears down the shared WebContainer without quiescing the terminal, silently discarding unreconciled terminal filesystem work

- **Cluster:** git-terminal  
- **Verdict:** partially-confirmed  
- **Files:** src/tools/execution-tools.ts, src/terminal/manager.ts, src/terminal/manager.test.ts  
- **Regression risk:** medium

**Why (reviewer):** The code facts hold: `invalidateHost` (src/terminal/manager.ts:529-536) calls `this.clearHostBinding()` (which nulls `this.host`/`this.baseline`, :594-600) and `stopLiveSessions("The shared browser runtime was deactivated. Start this terminal to acquire a fresh isolated host.", ...)` with no reconciliation attempt, and the message never says work was discarded. The existing test at src/terminal/manager.test.ts:516-548 pins exactly that behaviour. The agent-side reachability is real: src/tools/execution-tools.ts:304 and :503 both call `await (await nodePack).deactivateNodeWebContainer()`, and `rg quiesceBrowserTerminalWorkspace` shows its only callers are the provider-swap paths in src/ui/app.tsx (3054, 4135, 4427, 4814) — never the runtime-deactivation path. Since jsh never exits on its own, an interactive session's writes sit in the mount unreconciled until the user clicks Reconcile or closes the tab, so there is genuinely user work to lose. Where the scout is wrong is the proposed fix: reconciling inside `invalidateHost` is impossible, because src/execution/node-webcontainer-pack.ts:141-154 calls `activeInstance?.teardown()` first and only publishes `publishLifecycle("inactive", "deactivated")` in the `finally` after `instance = undefined` — by the time the manager hears the event the WebContainer is already dead and `host.export` cannot run. The fix has to be upstream of teardown.

**Root cause:** The WebContainer instance is shared between the agent's execution runtime and the terminal, but the deactivation entry point owns only the runtime half: it tears the instance down with no pre-teardown hook for the terminal's mount, and the lifecycle event that would notify the terminal is published after the instance is gone.

**Smallest fix:** At both src/tools/execution-tools.ts:304 and :503, call `quiesceBrowserTerminalWorkspace(workspace, "The shared browser runtime is being deactivated; terminal work was reconciled first.")` (already exported at src/terminal/manager.ts:114) before `deactivateNodeWebContainer()`, and surface the returned changed paths in the tool result. As a defence in depth, change the `invalidateHost` detail at manager.ts:533 to state that any writes made since the last reconciliation were discarded with the runtime.

**Acceptance:** A test where the terminal has an unreconciled mount file and the `deactivate_execution_runtime` tool is invoked: after the tool returns, the workspace contains that file, and the tool result names the reconciled paths. A second test: when `invalidateHost` fires without a prior quiesce (e.g. an external teardown), the session detail explicitly states that unreconciled terminal writes were dropped.

### 19. [high] Memory graph has no zoom on touch, and its canvas eats vertical page scroll, while the route tells the user to zoom

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/memory-graph/canvas-renderer.tsx, src/ui/memory-view.tsx, src/ui/memory-view.css  
- **Regression risk:** medium

**Why (reviewer):** src/memory-graph/canvas-renderer.tsx:584 registers `wheel` as the only caller of `zoomMemoryGraphViewport` (the sole other call sites are `fitMemoryGraphViewport` at :122/:154/:605). `onPointerDown` (:490-502) writes a single `engine.pointer = { id: event.pointerId, ... }` record and `onPointerMove` (:511-527) only pans, so a second finger overwrites the record and a pinch is interpreted as a pan jump; there is no pointer map and no `touches`/`gesture` handler anywhere in the file. The canvas is `aria-hidden="true"` with no `tabindex` and no key handler (:224-228), and the host div is `role="group"` with no key handler (src/memory-graph/renderer.tsx:82-88). `rg zoom src/ui/memory-view.tsx src/ui/memory-view.css` returns only the prose at src/ui/memory-view.tsx:433 (`<p>Pan, zoom, search, or select a node to inspect relationships and source metadata.</p>`) — there is no +/-/Fit control in the route. `touchAction: "none"` (canvas-renderer.tsx:227) sits on a surface that is 470px tall by default (memory-view.tsx:384 / routes.css:1321) and still 360-390px on a phone (memory-view.css:876-877, routes.css:3185-3186), so a one-finger vertical swipe starting inside it is consumed as a graph pan and the Memory route does not scroll. MEM-01's open gate in docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:128 still names "keyboard/mobile graph controls" as preserve-work, and VIS-05 (:190) is PARTIAL, so nothing here is already closed.

**Root cause:** Zoom was implemented as a single wheel-event affordance rather than as a viewport command with multiple entry points. `zoomMemoryGraphViewport` is a pure function (canvas-renderer.tsx:337) but it is reachable only from `onWheel`, so every non-wheel input class (touch, keyboard, AT) has no path to scale, and the pointer bookkeeping is a single-slot record that cannot represent a two-finger gesture.

**Smallest fix:** 1) In `bindCanvasInteractions`, replace the single `engine.pointer` slot with a `Map<number, CanvasPoint>` of active pointers; when two are down, compute the midpoint and the distance ratio between moves and call the existing `zoomMemoryGraphViewport(engine.viewport, midpoint, ratio, engine.fittedScale * 0.35, engine.fittedScale * 16)` — the same clamps `onWheel` uses (canvas-renderer.tsx:566-571) — and keep the one-pointer branch as pan. 2) Expose `Zoom in` / `Zoom out` / `Fit` buttons in the `.memory-toolbar` (src/ui/memory-view.tsx:374-382) wired through a ref to the same call, which also gives keyboard and AT users the capability. 3) Change the canvas to `touchAction: "pan-y"` so a vertical swipe still scrolls the route now that zoom no longer depends on holding the whole gesture stream. 4) Amend memory-view.tsx:433 so it names the controls that exist.

**Acceptance:** Unit: a synthesized two-pointer sequence over `bindCanvasInteractions` raises `engine.viewport.scale` and leaves the midpoint graph coordinate fixed within 1px; scale stays clamped to [fittedScale*0.35, fittedScale*16]. Unit/DOM: clicking `Zoom in` then `Fit` returns the viewport to `fitMemoryGraphViewport(bounds, w, h)`. E2E (mobile project, 390x844, #context): the graph canvas reports `touch-action: pan-y`, a vertical touch swipe starting inside the canvas increases `main.scrollTop`, and a `Zoom in` button is focusable by keyboard and changes the reported scale.

### 20. [high] Profile memory scope "This conversation" is honoured only by automatic turn context; recall_memory and the Memory profile lane still return sibling-session memories

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/tools/memory-tools.ts, src/tools/federated-memory.ts, src/retrieval/federated-turn-context.ts  
- **Regression risk:** low

**Why (reviewer):** `scopedMemories` is the only scope-aware read and it is a private helper in one module: src/retrieval/federated-turn-context.ts:134-147 filters `(scope !== "session" || record.scope.createdInSessionId === sessionId)`, fed from the manifest at `:48`. The other two readers do not consult `memoryScope` at all. `recall_memory` calls `profileRecords(document.records, profile.profileId)` (src/tools/memory-tools.ts:61) where `profileRecords` is `records.filter((item) => item.scope.kind === "profile" && item.scope.profileId === profileId)` (`:217-219`) — no session predicate — and it reports `scope: "profile"` in metadata (`:148`) regardless of the pinned setting. `searchFederatedMemory`, which powers Memory's "Active profile memory" lane, does the same: `.filter((memory) => memory.scope.kind === "profile" && memory.scope.profileId === profile.profileId)` (src/tools/federated-memory.ts:119-121). A repo-wide `rg memoryScope` outside tests shows no other consumer: every remaining hit is schema/validation/manifest/label plumbing (src/profiles/domain.ts:293, src/core/session-audit.ts:580, src/sessions/domain.ts:582, src/ui/app.tsx:9176-9180). Both readers already hold the session (`context.sessionId`) and the pinned profile, so the data to enforce it is in hand.

**Root cause:** The scope predicate was implemented as a module-private helper inside the turn provider rather than as the single shared gate on every read of `/workspace/.airship/memory.json`. Two of the three readers were written against `profileId` alone and were never revisited when `memoryScope` shipped.

**Smallest fix:** Export the predicate (move `scopedMemories` to a shared module, e.g. beside `MEMORY_PATH` in src/tools/memory-tools.ts, and import it in src/retrieval/federated-turn-context.ts). Replace `profileRecords(...)` at src/tools/memory-tools.ts:61 and the inline filter at src/tools/federated-memory.ts:119-121 with it, passing the pinned `profile.memoryScope` and `context.sessionId` — both already resolved at those call sites. Also report the effective scope in `recall_memory` metadata (src/tools/memory-tools.ts:148) instead of the hardcoded `"profile"`.

**Acceptance:** Given a profile with `memoryScope: "session"` and two memories, one created in session A and one in session B: from session A, (1) `recall_memory` returns only the session-A record and its `total`/`count` exclude the sibling; (2) `search_memory`'s profile group returns only the session-A record; (3) the existing turn-context test at src/retrieval/federated-turn-context.test.ts:82 still passes unchanged.

### 21. [high] The 2,000-entry presentation cap is handed to the index engine as the workspace revision authority, so a workspace above the cap can never validate

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/context-view.tsx, src/ui/memory-view.tsx  
- **Regression risk:** medium

**Why (reviewer):** Traced the whole path myself. src/ui/workspace-refresh.ts:31-36 lists the workspace and filters control-plane paths; src/ui/app.tsx:2911-2914 publishes the full array to `setFiles` but `setWorkspaceFiles(entries.slice(0, 2_000))`. That truncated state is the only thing passed as `files` (src/ui/app.tsx:7362), memory-view forwards it verbatim as `entries={files}` (src/ui/memory-view.tsx:454), and ContextView's only use of `entries` for the engine is `void runtime.updateWorkspace(entries)` (src/ui/context-view.tsx:84). The engine treats that array as authority: `normalizeSnapshot` builds `key` from it (src/indexing/client-context-engine.ts:587-607) and `assertWorkspaceSnapshot` re-lists the live workspace and throws `ClientContextStaleSnapshotError` on any key difference (src/indexing/client-context-engine.ts:539-543), which `setFailure` publishes as phase `error` (`:433`, `:546-554`) and context-view renders as the error code with state word "Closed" (src/ui/context-view.tsx:279-281, `:607-613`). `materializeCandidates` has a second, independent guard: `if (indexedCandidates.length !== entries.length) throw` (src/indexing/client-context-engine.ts:636-638), and `discover()` enumerates the live listing (src/indexing/incremental-indexer.ts:70-71), so the counts also cannot agree. MAX_SNAPSHOT_ENTRIES is 250_000 (src/indexing/client-context-engine.ts:20), so the 2,000 cap is not defending an engine bound. Reachability is real: every other engine caller passes the untruncated live listing (`this.engine.updateWorkspace(await this.workspace.list("/workspace"))`, src/retrieval/client-context-runtime.ts:78 and :224), and the import tool admits up to 10,000 files (src/tools/repository-import.ts:66, src/tools/network-tools.ts:86). Two callers therefore publish two different keys for the same workspace, and above 2,000 files the ContextView key is permanently wrong. No test pins the cap (grep for `slice` / `2_000` in src/ui/*.test.ts and e2e/*.spec.ts returns nothing).

**Root cause:** One piece of state serves two incompatible roles. `workspaceFiles` is bounded as a presentation input, but the same array is the revision snapshot the engine validates against the live listing. The cap is applied at the publish seam (app.tsx:2914) instead of inside the consumer that needs bounding, and the graph consumer already bounds itself independently (`files.slice(0, options.maxFiles)` with `maxFiles: 2_000` and a reported truncation count, src/memory-graph/derive.ts:25, :294-295).

**Smallest fix:** Stop truncating at the publish seam: `setWorkspaceFiles([...entries])` at src/ui/app.tsx:2914. Graph derivation already caps at 2,000 and reports `stats.truncated` (src/memory-graph/derive.ts:294-295), so nothing loses its bound and the Index summary count at src/ui/memory-view.tsx:450 becomes the true source count. If a bound at the seam is still wanted, ContextView must stop taking `entries` as engine authority and call the runtime's own listing path (`runtime.refreshNow()` / `scheduleRefresh()`), which every other caller already uses.

**Acceptance:** With a workspace of 2,001 non-control-plane files: (1) the engine reaches phase `ready` and `CONTEXT_SNAPSHOT_STALE` is never published; (2) the Index disclosure's `workspace source` count equals the true entry count, not 2,000; (3) a unit test drives `updateWorkspace` with the exact array the app publishes plus a workspace of the same size and asserts no `ClientContextStaleSnapshotError`.

### 22. [high] Past 256 KiB of output the terminal clears and rewrites the entire buffer on every chunk

- **Cluster:** performance  
- **Verdict:** confirmed  
- **Files:** src/terminal/manager.ts, src/terminal/contracts.ts, src/ui/terminal-view.tsx, src/ui/terminal-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/terminal/manager.ts:676 is `session.bufferedOutput = `${session.bufferedOutput}${chunk}`.slice(-MAX_OUTPUT_CHARS);` with `MAX_OUTPUT_CHARS = 256 * 1_024` (:31). The view's delta is derived by prefix match against the previous full buffer: src/ui/terminal-view.tsx:348-352 — `if (next.bufferedOutput.startsWith(renderedOutput.current)) emulator.write(next.bufferedOutput.slice(renderedOutput.current.length)); else { emulator.clear(); emulator.write(next.bufferedOutput); }` with `renderedOutput.current = next.bufferedOutput;` on every update (and on mount at :380-381). Once the cap is reached, next = old.slice(chunk.length) + chunk, which never starts with old, so the else branch runs for every subsequent PTY chunk: a 262,144-character write into xterm plus `emulator.clear()`, which discards the 5,000-line scrollback configured at :371 and resets scroll position. The manager emits per chunk (`this.emitSession(session)` at :678, called from `pumpOutput` :615 per reader read).

**Root cause:** The manager publishes a sliding tail window as its only output surface, while the view assumes an append-only buffer and reconstructs the delta by prefix matching. That invariant holds only below the cap, and there is no fallback other than full re-render.

**Smallest fix:** Publish the appended text instead of inferring it: add a monotonically increasing `outputSequence` (incremented in `appendOutput`) plus the appended chunk to the session snapshot, and in src/ui/terminal-view.tsx:348-352 write only that chunk when the sequence advanced by one, falling back to clear+write only when the sequence is discontinuous (subscribe/remount/reconstruction). xterm's own 5,000-line scrollback then owns history.

**Acceptance:** With a session whose `bufferedOutput` is already at the 256 KiB cap, delivering a 10-character PTY chunk results in exactly one `emulator.write` whose argument is those 10 characters and zero `emulator.clear()` calls; delivering 100 such chunks writes 1,000 characters total, not 26 MB. Initial mount and a reconstructed session still perform exactly one full write.

### 23. [high] "Switch to ephemeral · keep a page copy" is undone a frame later: the Local Device auto-open effect re-adopts the Vault the user just released

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** medium

**Why (reviewer):** Traced the whole loop. `disconnectVaultSafely` (src/ui/app.tsx:4950-4974) calls `releaseVaultAuthority` and then only `setVaultSetupOpen(preferences.vaultBackend !== "ephemeral")` at :4966 — there is no `setPreferences` anywhere in its body, so `preferences.vaultBackend` stays `"local-device"`. Inside `adoptEphemeralRuntime` the storageId becomes `memory://airship-page` (src/ui/app.tsx:4828-4829), `setGitClient(nextGitClient)` runs at :4876, and the local-device handle/status are cleared at :4899-4903. The auto-open effect's guards (src/ui/app.tsx:1992-2002) are then all false — provider is still `local-device`, runtime/catalog/activeProfile/gitClient are set, and `runtime.current.storageId.startsWith("vault+local-device://")` is now false. Its dep list is `[preferences.vaultBackend, catalog, activeProfile, gitClient, vaultProviderSwitching]` (src/ui/app.tsx:2040); the re-runs triggered *during* the disconnect are blocked by `vaultProviderSwitchingRef.current`, but the `finally` at :4971-4972 clears the ref and then sets the state dep false, guaranteeing one more run with the ref already reset. It reopens the enrolled key and calls `activateLocalDeviceWorkspace`. Contrast with the correct path: `changeVaultProvider("ephemeral")` commits the preference (src/ui/app.tsx:4921 `commitPreference`), so the effect's first guard holds. One correction to the scout: only the ephemeral direction unconditionally mints a session (`${profile.name} · ephemeral`, src/ui/app.tsx:4869); the re-adoption prefers `resumableSession` from `latestCompatibleProfileSession` (src/ui/app.tsx:4535-4537, 4620-4625) and creates `${profile.name} · encrypted vault` only when none resumes — so it is one guaranteed throwaway conversation per round trip, not always two.

**Root cause:** `disconnectVaultSafely` changes runtime authority without changing the preference that the Local Device auto-open effect treats as the standing instruction to adopt. The product has no representation of "the user explicitly detached" — only the derived storageId, which the disconnect itself invalidates — so the effect reads the post-disconnect state as "local-device selected but not yet open".

**Smallest fix:** Make the disconnect commit the same preference the equivalent provider switch does: in src/ui/app.tsx:4950-4974 replace the bare `releaseVaultAuthority(...)` call with `transitionVaultProvider({ current: preferences.vaultBackend, next: "ephemeral", … })` (it already handles the release, the fail-closed check and `commitPreference`), and set the status/setup-open lines from the `ephemeral` arm. That reuses the tested path in src/ui/vault-provider-transition.ts and needs no new detach flag.

**Acceptance:** After `disconnectVaultSafely()` resolves from an adopted Local Device Vault: `preferences.vaultBackend === "ephemeral"`; the Local Device auto-open effect does not run again (assert `openLocalDeviceWorkspaceKey`/`activateLocalDeviceWorkspace` are called zero further times after the disconnect settles, including after `vaultProviderSwitching` flips false); `runtime.current.storageId === "memory://airship-page"` remains stable across the next render; and exactly one new session is created for the transition.

### 24. [high] Google Drive (and local-lab in a production build) stays selectable in a build that cannot open it, and choosing it detaches the adopted Vault first

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/vault-view.tsx, src/ui/platform-shell.tsx, src/ui/app.tsx, src/ui/menu-select.tsx  
- **Regression risk:** medium

**Why (reviewer):** Read every cited site. src/ui/menu-select.tsx:9 declares `disabled?: boolean` and it is honoured in `choose` (src/ui/menu-select.tsx:95-97 `const option = options[index]; if (!option || option.disabled) return;`), in `openAt` via `nearestEnabledOption` (src/ui/menu-select.tsx:60), on the option element (`disabled={option.disabled}`) and in `onPointerMove`. The Vault route's option map at src/ui/vault-view.tsx:334-341 sets only `label` and a `description` suffix `— unavailable in this build`; it never sets `disabled`. The Preferences Durability row at src/ui/platform-shell.tsx:445-457 maps `VAULT_BACKENDS` with no filter and no marker at all — `PreferencesDialog` (src/ui/platform-shell.tsx:379-396) is not even passed a client ID, so it cannot know. `changeVaultProvider` (src/ui/app.tsx:4914-4948) checks only `vaultProviderSwitchingRef.current`, `next === preferences.vaultBackend` and `inferenceRouteChanging`, then calls `transitionVaultProvider`, whose first act is `releaseVaultAuthority` → `adoptEphemeralRuntime()` (src/ui/vault-provider-transition.ts:20-22, 27-29). The destination panel is `Google Drive is not available in this build` (src/ui/google-drive-setup.tsx:151-153). Two things the scout missed that strengthen it: (a) the route already computes `driveUnavailable` and swaps the primary action (src/ui/vault-view.tsx:274-276), so the fact is in hand at the exact component that renders the selector; (b) `local-lab` has the identical shape in a production build — `export const LocalLabSetup = import.meta.env.DEV ? LocalLabSetupForm : ProductionLabBoundary` (src/ui/local-lab-setup.tsx:547) renders `Loopback S3 is development-only` / `Unavailable` / `No production credential path` (src/ui/local-lab-setup.tsx:531-537), and the auto-connect bails on any non-loopback origin (src/ui/app.tsx:1951-1953). So a shipped build has two unopenable rungs and marks neither as disabled. VLT-04 is still open in docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:154 and :626, so this is not a re-report.

**Root cause:** Provider availability is computed as display text, not as a selectability fact. `googleDriveConfiguredInBuild()` feeds only a description suffix in src/ui/vault-view.tsx, Preferences never receives the fact at all, and `changeVaultProvider`/`transitionVaultProvider` have no feasibility precondition — release of the current authority happens before anything asks whether the target can be opened.

**Smallest fix:** Add one exported predicate, e.g. `vaultBackendOpenable(backend, { googleClientId, dev }): boolean` beside `availableVaultBackend` in src/ui/platform-shell.tsx (google-drive → `isDeployableGoogleOAuthClientId`, local-lab → `import.meta.env.DEV`, others → true). Use it in three places: (1) src/ui/vault-view.tsx:334-341 add `disabled: !vaultBackendOpenable(profile.id, …)` to each option; (2) src/ui/platform-shell.tsx — pass `googleClientId` into `PreferencesDialog` and give the Durability row the same disabled flag (PreferenceSelect's tuple options need a fourth element or a switch to `MenuSelectOption[]`); (3) src/ui/app.tsx:4914, return early with `setRuntimeStatus("<Provider> cannot be opened by this build; the current Vault was left attached")` before `transitionVaultProvider` when the target is not openable.

**Acceptance:** With `VITE_GOOGLE_CLIENT_ID` unset: the Vault provider MenuSelect renders the Google Drive option with `disabled` (pointer click and Enter on it leave `provider` unchanged and fire no `onProviderChange`); the Preferences Durability row does the same; and a unit test on `changeVaultProvider`'s guard asserts that calling it with an unopenable target neither invokes `adoptEphemeralRuntime`/`disconnectAuthority` nor commits the preference — the adopted Local Device runtime keeps a `vault+local-device://` storageId. In a production (non-DEV) build the same three assertions hold for `local-lab`.

### 25. [high] Proof for a non-active conversation shows and exports the ACTIVE conversation's endpoint evidence and receipts

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** Read every hop. src/ui/app.tsx:1329-1340 gates `activeAttestationPresentation` on `attestationPresentation.sessionId === sessionId` (the ACTIVE session) and derives `attestationRecords` from it. src/ui/app.tsx:1846-1850 builds `attestationReceipts` from `messages` + active `sessionId`. src/ui/app.tsx:1769 computes `proofTargetId = effectiveProofSelection?.sessionId ?? sessionId`, and src/ui/app.tsx:7478 passes `sessionId={proofTargetId}` while src/ui/app.tsx:7494-7495 pass `endpointRecords={attestationRecords}` / `receipts={attestationReceipts}` and src/ui/app.tsx:7508 passes `endpointEvidenceRecords={attestationRecords}` — all active-session data. src/ui/app.tsx:6686-6693 `openSessionProof(targetSessionId)` only calls `setProofSelection` + `navigate`; it never activates the session, and src/ui/sessions-view.tsx:616 / :756 render that Proof button for any listed session (`onOpenProof={... => onOpenProof(detail.session.id)}`), active or not. The authority effect at src/ui/app.tsx:1300-1310 explicitly AUTHORIZES a non-active session in the same Profile, so `proofTargetId` legitimately becomes B. One mitigation the scout missed: `proofReceipt` IS scoped — src/ui/proof-route.ts:79-88 filters on `receipt.sessionId === selection.sessionId` over `inPageReceipts` (src/ui/app.tsx:1463-1466, the active transcript), so for session B `receipt` is undefined. That makes the export WORSE, not better: in src/ui/proof-view.tsx:118-121 the `receipt ? filter : endpointEvidenceRecords` ternary takes the else branch, so `relevantEvidence` is ALL of conversation A's records, while src/ui/proof-view.tsx:126-129 writes `scope: { sessionId: sessionId ?? null }` = B. The export button is reachable because src/ui/proof-view.tsx:309 renders on `endpointEvidenceRecords.length > 0` alone. No test covers this (`grep proofTargetId|endpointEvidenceRecords src/ui/*.test.ts e2e/*.spec.ts` returns nothing).

**Root cause:** The Proof route carries two identities and enforces only one. The receipt input is resolved against `proofTargetId` (proof-route.ts), but the evidence inputs (`attestationRecords`, `attestationReceipts`) are derived against the ACTIVE `sessionId` and handed to the route unfiltered. `openSessionProof` is allowed to point the route at a non-active session, so the two identities diverge with nothing reconciling them.

**Smallest fix:** In src/ui/app.tsx, before the `<ProofScreen>` mount, derive route-scoped inputs from the same identity the route uses: `const proofScoped = proofTargetId === sessionId; const proofEndpointRecords = proofScoped ? attestationRecords : EMPTY_RECORDS; const proofLedgerReceipts = proofScoped ? attestationReceipts : EMPTY_RECEIPTS;` and pass those three places (7494, 7495, 7508) instead of the active-session collections. Also gate `acquisitionNotice` / `onRefresh` on `proofScoped`, and add one sentence to the ledger for the unscoped case — evidence for a conversation that is not active is not loaded in this page runtime. `endpointEvidenceRecords` going empty makes src/ui/proof-view.tsx:118-121's else branch return `[]`, which fixes the export without touching proof-view.

**Acceptance:** With conversation A active and holding >=1 endpoint-evidence record and >=1 receipt, opening Proof for conversation B from the session library (without resuming B) renders zero endpoint records and zero receipts in the Attestation evidence ledger and states that B's evidence is not loaded in this runtime. `exportVerificationBundle()` from that route emits `scope.sessionId === B` with `endpointEvidence: []` — never a record whose `identity.sessionId` is A. Resuming B and returning to Proof restores B's own records.

### 26. [high] Proof route never receives `acquisitionFailure`, so its hero verdict silently drops the "evidence not pulled" fact the chat chip shows

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/proof-inspector.tsx  
- **Regression risk:** low

**Why (reviewer):** `grep -rn acquisitionFailure src/ e2e/` returns exactly six production hits, all inside src/ui/proof-view.tsx (40, 59, 167) and src/ui/turn-evidence.ts (90, 99, 105) — plus tests only. The single mount site, src/ui/app.tsx:7473-7509, has no `acquisitionFailure` prop, though `attestationFailure` is in scope at src/ui/app.tsx:1339 and is passed to the per-message chip at src/ui/app.tsx:7045 and to the ledger notice at src/ui/app.tsx:7501. Consequence read from src/ui/turn-evidence.ts:99-107: `modifier` is only populated from `input.acquisitionFailure`, so `verdict.modifier` is permanently undefined on this route and src/ui/proof-view.tsx:238 never renders — `.proof-verdict__modifier` (src/ui/proof-view.css:119) is dead. And the no-receipt branch (turn-evidence.ts:104-107) can never reach `evidence-blocked`, so the hero prints TURN_EVIDENCE_COPY["no-evidence"] = "No evidence" / "Evidence is recorded when a turn completes." (src/ui/trust-language.ts:194) while the chip for the same turn prints TRUST_LABEL_MESSAGE_NO_EVIDENCE = "No evidence · not pulled" (src/ui/trust-language.ts:91, 195). One correction to the scout: src/ui/proof-inspector.tsx:47-51 also omits `acquisitionFailure` from its `turnEvidenceVerdict` call, so the same drop happens on the inspector's bottom line — the fix must cover both callers or the route will still hold two phrasings.

**Root cause:** The reducer's acquisition-failure input was specified and unit-tested but never wired at the composition root. `attestationFailure` is consumed by every other trust surface in app.tsx and skipped only where ProofScreen and ProofInspector are constructed.

**Smallest fix:** In src/ui/app.tsx pass `acquisitionFailure={proofTargetId === sessionId ? attestationFailure?.label : undefined}` on the `<ProofScreen>` at 7473 (the session gate matters for the same reason as the previous finding), and thread the same string into `<ProofInspector>` at 7489 so src/ui/proof-inspector.tsx:47-51 can add it to its `turnEvidenceVerdict` input. `attestationFailure.label` is already `attestationFailureLabel(code)`'s verbatim string (src/ui/app.tsx:5619, 8755), which is the contract the prop doc at src/ui/proof-view.tsx:53-58 states.

**Acceptance:** With an acquisition failure published for the active session, the Proof route's `.proof-verdict__modifier` renders that exact label; the inspector's `.proof-bottom-line` and the message chip carry the same string for the same turn. With an acquisition failure and no receipt, the hero chip reads TRUST_LABEL_MESSAGE_NO_EVIDENCE (`evidence-blocked`), not "Evidence is recorded when a turn completes." With no failure, the hero is byte-identical to today.

### 27. [high] The S3/MinIO rung's comparison row promises cross-device reach and "your bucket" durability that no shippable configuration provides

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/vault-view.tsx, src/ui/vault-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** Every cited line is exact. src/ui/vault-view.tsx:97-108 is `id: "local-lab", title: "S3-compatible / MinIO", description: "Advanced provider or local development lab"` with `survives: "Yes · encrypted in your bucket"`, `reach: "Yes"`, `supply: "Endpoint and keys"`, `lose: "Deleting the bucket"`, under the caption `Every provider answers the same six questions, so the columns can be read across.` (src/ui/vault-view.tsx:347). I checked the producers: `rg createLocalLabConfigureRequest|vault.configure\(` finds exactly two non-test callers — src/ui/app.tsx:1958-1970 (guarded by `isLoopbackAirshipLocation`, src/ui/app.tsx:1951) and src/ui/local-lab-setup.tsx:187-201 — and both go through `createLocalLabConfigureRequest`, which hard-codes `mode: "local-development"` (src/vault/local-lab.ts:90) with `credentialSource.kind: "local-development"`; `validateVaultS3Configuration` then rejects any non-loopback host (src/vault/config.ts:107-109). Stronger than the scout said: in a production build the form does not exist at all — `export const LocalLabSetup = import.meta.env.DEV ? LocalLabSetupForm : ProductionLabBoundary` (src/ui/local-lab-setup.tsx:547) renders `Loopback S3 is development-only` / `No production credential path` (:531-537). One scout imprecision, not load-bearing: `strict-production` also appears in src/vault/config.test.ts:92, src/vault/coordinator.test.ts:542 and docs/VAULT_COMPOSITION.md:59 — but nowhere in any UI or producer, so no reachable path emits it. The honest sentence is indeed buried two `<details>` deep (src/ui/vault-view.tsx:100 rendered at :375-386 inside `vault-provider-notes` inside `vault-provider-compare`).

**Root cause:** `PROVIDER_PROFILES` describes the S3 adapter's theoretical capability rather than the one mode this build can construct. The matrix rows are authored as static prose with no reference to `VaultMode`, so the only mode the product can produce (`local-development`, loopback-only, dev-build-only) is never what the comparison answers with.

**Smallest fix:** Edit the `local-lab` entry in src/ui/vault-view.tsx:96-109 to describe the shipped mode: `description: "Loopback development lab"`, `survives: "Yes · encrypted in your loopback lab"`, `reach: "No · loopback only"`, `supply: "A loopback endpoint and disposable keys"`, `lose: "Deleting the lab bucket"`, and hoist the `On a loopback lab endpoint nothing is cloud-synchronized` clause into `note`'s first sentence. Copy-only; no behaviour change. (If claim 1's `vaultBackendOpenable` lands, this rung is also marked unavailable outside a DEV build, which covers the rest.)

**Acceptance:** A unit test in src/ui/vault-view.test.ts asserts `PROVIDER_PROFILES` entry `local-lab` has `facts.reach` starting with `"No"` and that no fact string for `local-lab` contains the unqualified words `your bucket`; and asserts that the only provider whose `facts.reach` is `"Yes"` is `google-drive`. A grep-style assertion that the local-lab `note` names the loopback restriction in its first sentence.

### 28. [high] A failed profile switch leaves the old profile's UI and conversation running on the new profile's workspace, tools and Git client, with no error shown

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** medium

**Why (reviewer):** The ordering is exactly as claimed. src/ui/app.tsx:3075-3079 commits `runtime.current = switched.runtime`, `setGitClient(switched.git)` and the rebuilt slash/tool registry. Only afterwards, inside `if (restoredExisting)`, come four throws: :3087-3091 (`fresh.compatibility?.action !== "resume"`), :3094-3096 (audit not verified), :3097-3099 (head changed), and `publishAuditedSession` itself, which throws on a presentation fault at :6538. `publishProfileId(nextId)` is only reached at :3101. The `finally` at :3113-3116 clears the transition overlay and the navigation flag but does not restore `runtime.current`, and there is no catch. I verified the callers: :6867 and :6900 are `void changeProfile(nextId)`, and :7381/:7399 pass an async lambda that the views invoke as `void onActivate(...)` / `void onApply(...)` (src/ui/app.tsx:9204, :9274). `rg unhandledrejection src/ e2e/` returns nothing, and `ViewErrorBoundary` (used at :6905) only catches render errors, so the rejection is silent and `runtimeStatus` stays at 'Switching profile cockpit' (:3035). The trigger path is real: `resolveResumableProfileConversation` (src/sessions/profile-cockpit.ts:167-193) filters on `resumableProfileManifestMatches` only — the mismatch list at :241-257 is manifest fields exclusively, no history status — while `decideSessionResume` rejects on `assessment.status === "incomplete"` or any warning reason (src/sessions/domain.ts:876-877), and `status` is 'incomplete' whenever `issues.length > 0` (:758-762), which includes TURN_INCOMPLETE (:743), SESSION_UPDATE_TIME_MISMATCH (:754) and warning-level WORKSPACE_MISMATCH/POSTURE_MISMATCH (:860-868). One correction to the scout: the journal is shared across profiles (`journal: active.journal`, src/ui/app.tsx:2996), so events do not go into a second journal; what diverges is `workspace`, `workspaceId`, `tools` and `git` (:3008-3012), i.e. profile A's still-open conversation would run tools against profile B's `/…/p-<profileId>` subtree (src/workspace/profile-scope.ts:52) while the rail and every scope label still read A. Also worth folding into the fix: the terminal quiesce at :3053-3056 has already killed the outgoing profile's live terminals before any of this, so a failed switch also loses them.

**Root cause:** The switch is a multi-step commit with no transaction boundary: authority (runtime/git/tool registry) is published at :3075-3079 while identity (`publishProfileId`) is published at :3101, and the validation that can reject the switch sits between the two. Because the whole function is fire-and-forget at every call site with no catch and no global rejection handler, the failure is invisible as well as inconsistent.

**Smallest fix:** Move the restore validation before the authority commit and add a rollback. Perform `library.inspect` / `loadAuditedSessionSnapshot` / the head comparison against `switched.runtime` while `runtime.current` is still `active` (they only need `activeRuntime`, not the committed pointer); commit `runtime.current`/`setGitClient`/`setSlashRegistry` and `publishProfileId` adjacently only once the target session is known good. Wrap the body in `try { … } catch (error) { runtime.current = active; setGitClient(previousGit); setSlashRegistry(previousRegistry); setRuntimeStatus(`Profile switch failed: ${message}`); }` so the outgoing cockpit survives and the user is told. For the fork-required case specifically, fall back to `createProfileSession` (the path already at :3069) instead of throwing.

**Acceptance:** Given profile B whose most recent manifest-compatible conversation has an unterminated turn (TURN_INCOMPLETE): switching A→B either (a) starts a fresh conversation on B and publishes B as the active profile, or (b) fails, leaves `runtime.current`, the Git client, the slash/tool registry and `profileId` all on A, and sets a user-visible error status naming the reason. In no outcome may `profileId` and `runtime.current.profileId` disagree after the promise settles, and no call site may leave the rejection unhandled.

### 29. [high] Previewing a theme in the Profiles editor silently overwrites the user's global display preferences and never restores them

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:9160 is exactly as quoted: `onClick={() => { setDraft({ ...draft, themeId: theme.themeId }); setPreviewThemeId(theme.themeId); applyTheme(theme); }}`. `applyTheme` (src/ui/app.tsx:8251-8264) writes `dataset.density`, `dataset.corners`, `dataset.typeScale`, `dataset.bodyFont`, `dataset.mode` and `style.colorScheme` from the manifest — the same six things `applyPreferenceOverrides` owns at src/ui/platform-shell.tsx:367-373. I grepped every call site: `applyPreferenceOverrides` is called from exactly one place in the product, src/ui/app.tsx:2632, in an effect keyed `[activeTheme, preferences]` (:2633), and neither dep changes during a preview, so nothing reasserts the preferences. Cancel preview (src/ui/app.tsx:9205) and the unmount cleanup (src/ui/app.tsx:9054-9059) both call `applyTheme(...)` again, which restores theme-valued attributes, not preference-valued ones. Concretely, a user on Paper with Type scale = Extra large who previews Blue Ledger gets `data-mode="dark"`, `data-type-scale="compact"` (--type-scale 0.94, src/ui/tokens.css:256-258) and `data-density="compact"` (root font-size 15px vs comfortable's 17px, src/ui/tokens.css:260,274) and stays there after cancelling, while PreferencesDialog still shows Extra large (src/ui/platform-shell.tsx:434). Two things the scout did not catch make it worse. First, the cleanup at :9054-9059 lists `previewThemeId` in its dependency array, so it is not an unmount-only cleanup: clicking a SECOND theme tears down the effect with the stale `previewThemeId`, running `applyTheme(selected.theme)` AFTER the click handler already ran `applyTheme(theme)` — so previewing a second theme instantly reverts the surface to the profile's saved theme while the button keeps `aria-pressed` and "Previewing — not saved" is still displayed. Second, the cleanup restores `selected.theme` (the profile being EDITED), so previewing while a non-active profile is selected repaints the whole app in that other profile's theme, as claimed.

**Root cause:** Preview is implemented by mutating the same global `<html>` attributes that the preference layer owns, with no snapshot/restore and no notion of layering. `applyTheme` is a whole-instrument commit, not a scoped preview, and the single point where preferences are reasserted is an effect keyed on state that a preview deliberately does not touch. The cleanup effect compounds it by keying on `previewThemeId` so it fires as an undo on every preview change.

**Smallest fix:** Make every path that calls `applyTheme` outside the main effect also reassert preferences, and make the undo unmount-only. (1) Introduce `applyThemeWithPreferences(theme, preferences)` that calls `applyTheme` then `applyPreferenceOverrides(preferences)`, and use it at src/ui/app.tsx:9160, :9057 and :9205 (thread `preferences` into ProfileManagerView). (2) Change the cleanup effect at :9054-9059 to `useEffect(() => () => {...}, [])` with the preview theme id read from a ref, so switching preview targets no longer runs the undo. (3) Restore the ACTIVE profile's theme rather than `selected.theme` on cleanup.

**Acceptance:** With preferences {mode: light, typeScale: x-large, density: comfortable, corners: subtle, bodyFont: system-serif}: (a) after clicking a theme in the theme library, `document.documentElement.dataset` still reads mode=light, typeScale=x-large, density=comfortable, corners=subtle, bodyFont=system-serif, while the nine theme colour properties are the previewed theme's; (b) clicking a second theme leaves the second theme's colours applied, not the saved profile's; (c) Cancel preview and unmounting the route both restore the ACTIVE profile's theme colours with all five preference attributes unchanged.

### 30. [high] A stopped turn's tool strip says "Working" forever, in the page and after reload

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/message-parts-view.tsx, src/ui/chat/message-parts-view.css, src/ui/chat/message-parts-view.test.ts  
- **Regression risk:** medium

**Why (reviewer):** Traced the whole path. `src/core/agent.ts:157-162` — `const durable = await options.journal.append(options.sessionId, drafts, useTurnSignal ? options.signal : undefined)` with `useTurnSignal = true` by default; `src/core/journal.ts:117-119` — `async append(...) { if (!drafts.length) return []; signal?.throwIfAborted();`. In the tool phase both the success append (`src/core/agent.ts:468-486`, `type: "tool.resulted"`) and the failure append (`src/core/agent.ts:491-500`, `type: "tool.failed"`) use that default, so after abort neither can be written; the AbortError from the second append escapes the tool loop. `src/core/agent.ts:414-415` also re-checks `throwIfAborted(options.signal)` at the top of each iteration, so later calls in the same batch stay at `tool.requested`. Only the terminal event is written signal-free (`src/core/agent.ts:558-564`, `], false)`). On the presentation side `src/ui/chat/message-parts-view.tsx:294-295` maps `call?.status === "approved"` to outcome `approved` and everything else to `queued`, and `:170` — `const active = operations.some((operation) => operation.outcome === "running" || operation.outcome === "queued" || operation.outcome === "approved")` — makes both active, so `:191` returns `Working · N steps`, `:416-417` renders `<Seal state="checking" ... acting />` and `:443-444` renders the header with `role="status"`. Nothing settles it: `src/ui/chat/turn-recovery.ts:9-19` only does `next.push(error, footer)`, and reload rebuilds identical parts through `src/ui/chat/session-message-presentation.ts:664-666`. I also checked this is presentation-only and not history corruption — `src/core/agent.ts:897-905` drops cancelled/failed turns from provider history via `nonActionableTurns`, so the next turn is unaffected.

**Root cause:** The tool-phase settling appends are governed by the turn's AbortSignal, so a stop deliberately prevents the durable record that would settle each tool call; and the presentation layer derives 'active' purely from per-operation status with no knowledge of whether the turn itself reached a terminal disposition, so `approved`/`requested` are read as in-flight forever.

**Smallest fix:** Make the strip terminal-aware rather than trying to write more journal events under an aborted signal. `MessagePartsView` already receives the terminal facts as parts: when the parts list contains an error part whose `code` is `turn.cancelled`/`turn.failed` (or a footer), map every unsettled operation (`requested`/`approved`) to a new terminal outcome (e.g. `abandoned`: word "Stopped", clause "stopped", sentence "Tool step stopped before it completed", seal `attention`) in `pairedOutcome`/`OUTCOME_COPY`, and exclude it from the `active` predicate in `operationStripState`. That fixes both the live page and the reload, because both build parts from the same facts.

**Acceptance:** Given durable events turn.requested → assistant.completed(toolCalls) → tool.requested ×2 → tool.approved(call-1) → turn.cancelled, `messagePartsFromDurableEvents` + `operationStripState` returns `active: false`, headline does not contain "Working", no operation carries the `checking` seal or `acting`, and both rows report a stopped/abandoned outcome. The same assertion holds for the in-page path after `recoverPartialTurn` runs over those parts. A rendering test asserts no element with `role="status"` survives inside a strip whose turn is terminal.

### 31. [high] Ask First write-consequence panel misdescribes what is being approved

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/ui/approval-presentation.ts, src/ui/approval-dock.tsx, src/ui/approval-presentation.test.ts  
- **Regression risk:** low

**Why (reviewer):** I read src/ui/approval-presentation.ts:14-31 and confirmed the facts are derived by guessing key names off the raw argument object, never from the tool identity. `disposition` is `expectedRevision === undefined || null ? "Create" : "Replace"` (approval-presentation.ts:26) and the dock renders it verbatim as the 'Change' row (src/ui/approval-dock.tsx:80). Checked every registered write tool: `remove_file` is `{path, expectedRevision?}` with `additionalProperties: false` (src/tools/workspace-tools.ts:367-381) so a delete renders target=<path>, 'Change: Create', 'New size: Not supplied'. `replace_text` carries `path/oldText/newText` (src/tools/workspace-tools.ts:269-283) — `oldText`/`newText` match none of the helper's keys, so an in-place replacement also renders 'Create' with no sizes whenever the model omits the optional `expectedRevision`. `write_file` is `{path, content, expectedRevision?}` (src/tools/workspace-tools.ts:117-129) and src/workspace/memory.ts:66 (`if (expectedRevision === undefined) return;`) proves an omitted revision is an unchecked overwrite, yet the panel says 'Create'. `text_editor`'s only top-level property is `edits` (src/tools/workspace-tools.ts:394-412), `move_file` is `sourcePath/destinationPath` (:322-331), `execute_shell` is `script/workspaceRoot/args/env/writeBack/timeoutMs` with `effect: "write"` (src/tools/execution-tools.ts:567-593), `git_change` (src/tools/git-tools.ts:67-72) and `execute_workspace_program` (src/tools/execution-tools.ts:103-115) likewise — all return `undefined`, so approval-dock.tsx:78 omits the whole 'Write consequence' section and only the collapsed raw-JSON `<details>` (:85-88) remains. I grepped the whole repo: `oldContent`/`previousContent`/`newContent` appear only in src/ui/approval-presentation.ts:18-19 and src/ui/approval-presentation.test.ts:6, so the 'Bounded old → new preview' branch is unreachable in production. I ran `npx vitest run src/ui/approval-presentation.test.ts` — 2 passed — confirming the only disposition coverage asserts a `{path, expectedRevision, oldContent, content}` shape that `write_file`'s `additionalProperties: false` schema forbids.

**Root cause:** `writeApprovalFacts` is a schema-blind key-name heuristic that never sees `current.toolName`. Disposition is inferred from the presence of an optional concurrency token (`expectedRevision`) rather than from the tool's declared semantics, so absence of an optimistic-lock hint is rendered as 'Create' for deletes, replacements and unchecked overwrites alike; every write tool whose arguments do not happen to use the key `path`/`content` falls off the panel entirely.

**Smallest fix:** Pass `current.toolName` into `writeApprovalFacts` and replace the key-guessing with an explicit per-tool consequence mapping for the registered write tools: `remove_file` -> Delete, `move_file` -> Move (source -> destination), `replace_text` -> Replace in existing file (report oldText/newText byte delta), `write_file` -> 'Create or overwrite' when `expectedRevision` is absent and 'Replace revision <r>' when present, `text_editor` -> enumerate the N edit paths and their create/replace kind, `execute_shell`/`execute_workspace_program`/`git_change` -> name the root/writeBack/target scope. For any unmapped write tool return a marker that makes approval-dock.tsx render an explicit 'Consequence not derivable — read the raw arguments' row instead of silently omitting the section. Then fix src/ui/approval-presentation.test.ts to feed only schema-legal argument shapes.

**Acceptance:** 1) `writeApprovalFacts("remove_file", { path: "/workspace/src/index.ts" })` yields disposition 'Delete' and the dock never prints 'Create' for it. 2) `writeApprovalFacts("write_file", { path: "a.md", content: "x" })` yields a disposition that does not assert creation (e.g. 'Create or overwrite'). 3) `writeApprovalFacts("replace_text", { path, oldText, newText })` yields disposition 'Replace' with a non-undefined byte delta. 4) `writeApprovalFacts("text_editor", { edits: [3 items] })` enumerates all three target paths. 5) A test iterates every `definition.effect === "write"` tool in the production bundle and asserts each produces either a mapped consequence or the explicit not-derivable marker — never a wrong disposition. 6) Every argument fixture in approval-presentation.test.ts passes `ToolRegistry.validateArguments` for the named tool.

### 32. [high] Changing the conversation's approval policy silently rewrites the profile default

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:7229-7238 labels the control `ariaLabel="Conversation approval policy"` and src/ui/app.tsx:6392 tells the user the change applies 'in this new pinned conversation. The previous conversation remains unchanged'. But src/ui/app.tsx:6366-6375 builds `createProfileRevision({ ...profile, parentRevision: profile.revision, approvalMode: nextMode, ... })` and returns `replaceProfile(current, revisedProfile)`; src/ui/app.tsx:8231-8238 shows `replaceProfile` maps the catalog's single entry for that `profileId` onto the new revision. I traced the consequence: `createConversation` (src/ui/app.tsx:3133) passes `activeProfile` — the catalog entry — into `createProfileSession`, and `createProfileSessionManifest` pins `approvalMode: pin.approvalMode` into the manifest (src/ui/app.tsx:7678). The same catalog entry feeds every other `createProfileSession` call site (:2601, :3069, :4620, :4869, :5908, :6092, :6181) and the Profiles editor draft (src/ui/app.tsx:9181-9185). So one Full Access selection for one risky refactor becomes the starting mode of every subsequent conversation on that profile, and nothing in the confirmation says so. I also checked whether a session-scoped alternative is free: src/sessions/domain.ts:1010 (`pinned.profileRevision !== active.profileRevision`) means a session pinned to a revision that is not the catalog's active one would be judged incompatible on resume, so 'just don't replace the catalog entry' is not a drop-in.

**Root cause:** Conversation-scoped approval mode has no representation of its own. The only place a mode can live is `ProfileRevision.approvalMode`, and session pins are validated against the catalog's *active* revision (src/sessions/domain.ts:1010), so the implementation is forced to promote the new revision to the profile default via `replaceProfile` — while the label and confirmation copy still describe conversation scope.

**Smallest fix:** Name the real blast radius at the two places that misstate it: change the confirmation at src/ui/app.tsx:6392 to say the profile's future conversations will also start in that mode (e.g. '... and <profile name> will start new conversations in <mode> until you change it again'), and change the control's `ariaLabel`/surrounding copy at src/ui/app.tsx:7229-7231 from 'Conversation approval policy' to something that admits the profile default moves. If genuine per-conversation scope is wanted instead, that is the larger change: add an explicit session-level `approvalMode` override to the manifest and teach src/sessions/domain.ts:1010 to accept a pinned non-active revision — do not ship that as the 'small' fix.

**Acceptance:** 1) A test drives `changeActiveApprovalMode("full-access")` then asserts the welcome/confirmation string mentions that new conversations in this profile will start in Full Access. 2) A test asserts that after the change, `catalog.profiles.find(p => p.profileId === active).approvalMode === "full-access"` AND that the user-visible copy asserting this is present — i.e. copy and catalog state agree. 3) The composer control's accessible name no longer claims conversation-only scope while mutating the profile.

### 33. [high] No path to add, import, create, or update a skill — and an adopted Vault permanently freezes the shipped skill set

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/profiles/catalog.ts, src/profiles/persistence.ts, src/vault/runtime-adoption.ts, src/ui/app.tsx  
- **Regression risk:** high

**Why (reviewer):** Verified both halves. (a) `createSkillRevision` has exactly two non-test call sites: the six literal drafts in `createBuiltInProfileCatalog` (src/profiles/catalog.ts:41-86) and digest re-validation (src/profiles/persistence.ts:235). `SkillsManagerView` renders only `catalog.skills.map(...)` with a global switch or per-profile MenuSelect (src/ui/app.tsx:9277-9290) — no create/import/edit/archive control. `rg -ni skill src/tools/*.ts` (excluding tests) returns nothing, so there is no agent-facing skill tool either. (b) `createBuiltInProfileCatalog` is called from exactly one production site, the page bootstrap at src/ui/app.tsx:2520; the adoption path takes the Vault catalog wholesale (`targetCatalog = targetAuthoritative ? await ready.profiles.load() : undefined`, src/ui/app.tsx:4436-4438) and otherwise `resolveExistingCatalog` returns `disposition: "adopted-existing"` on any digest difference when the source is bootstrap (src/vault/runtime-adoption.ts:161-163). `validateProfileCatalog` rebuilds only persisted members (src/profiles/persistence.ts:283) and even rejects unknown skill IDs referenced by profiles (:255-257). A restored local-device Vault always takes the target-authoritative branch (src/ui/app.tsx:4057, `reason === "restored" ? "target-authoritative"`), so on every reload after adoption the persisted catalog wins and a newly shipped built-in skill can never appear. Note: the register already files CAP-02 as MISSING (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:60); the Vault-freeze consequence is the part it does not record.

**Root cause:** The skill set is a build-time constant with no reconciliation step against persisted state: `ProfileCatalog` is only ever mutated through `mutateProfileCatalog` for policy fields (globalSkills, skillModes, profiles), and there is no code path that unions `createBuiltInProfileCatalog().skills` into a loaded/adopted catalog, nor any authoring API to add a `SkillRevision`.

**Smallest fix:** Add a pure reconciliation function in src/profiles/catalog.ts, e.g. `reconcileBuiltInSkills(persisted: ProfileCatalog, builtIn: ProfileCatalog): ProfileCatalog`, that unions built-in skills by `skillId` (adding missing ones, upgrading a built-in whose digest changed while retaining the old revision if any profile pins it), never removes unknown/user skills, and leaves `globalSkills`/`skillModes` untouched (absent entries already default to off/inherit at src/profiles/domain.ts:334-336). Call it on the two catalog-adoption entry points — `migrateProfileCatalogState`'s `resolveExistingCatalog` result and the `targetCatalog` branch at src/ui/app.tsx:4436 — and persist the reconciled catalog as a normal generation bump so the digest/etag chain stays valid. The full CAP-02 import/create/archive ceremony remains a separate build.

**Acceptance:** Unit test (src/profiles/persistence.test.ts or a new catalog test): build a catalog, drop the `delivery-loop` skill and any profile references to it to simulate an older release, reconcile against `createBuiltInProfileCatalog()`, and assert (1) the result contains all six built-in skillIds, (2) every pre-existing profile `revision` string and every `globalSkills` entry is byte-identical, (3) a synthetic non-built-in skill in the persisted catalog survives, and (4) `validateProfileCatalog(JSON.parse(JSON.stringify(result)))` succeeds. Integration: after `adoptDurableRuntimeExclusive` with a Vault catalog missing a built-in skill, `#skills` lists all six cards.

### 34. [high] Reopening the file you just closed leaves the editor pane empty

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, e2e/workspace-workbench.spec.ts  
- **Regression risk:** medium

**Why (reviewer):** Read the whole chain. src/ui/workspace-view.tsx:285-296 loads buffers in an effect whose deps are `[selected?.path, selected?.revision]` (primitives). closeTab at src/ui/workspace-view.tsx:688-692 deletes `buffers[filePath]` unconditionally for file documents and never notifies App. src/ui/app.tsx:4177-4191 `openFile` re-reads the file and calls `setSelectedFileSelection(Object.freeze({ profileId, file }))` — a fresh object, but `file.path` and `file.revision` are unchanged because nothing was written, so both deps compare equal and the effect does not re-run. src/ui/workspace-view.tsx:158-165 confirms `selected` passes through `WorkbenchProfileSelectionFence.resolve`, which returns the same object in the non-switch path, so no other identity change exists. Render at src/ui/workspace-view.tsx:1288 is `buffer && verdict ? … : <div class="workbench-empty">` with `buffer = buffers[activeDocument.path]` (src/ui/workspace-view.tsx:419), so the tab is present and aria-selected while the pane shows the "Open a file from Explorer" placeholder. The recovery effect at src/ui/workspace-view.tsx:330-337 does fire (activeId changes when the tab is re-opened) but only calls `onOpen(desired.path)` again, which republishes the same path/revision and cannot unblock the dep comparison. e2e/workspace-workbench.spec.ts:126-130 closes tabs and asserts they are gone; no journey re-opens a just-closed path.

**Root cause:** Two sources of truth for "this file is loaded" that are compared by different keys: App owns the durable selection and re-publishes a new object per open, while WorkspaceView keys its buffer-load effect on the selection's (path, revision) value. closeTab discards the buffer without invalidating either the App selection or the (path, revision) key, so the very next open of the same file is indistinguishable from a no-op.

**Smallest fix:** Key the buffer-load effect on selection identity rather than its value: change src/ui/workspace-view.tsx:296 from `}, [selected?.path, selected?.revision]);` to `}, [selected]);`. App publishes a fresh frozen `file` object on every `openFile` call (src/ui/app.tsx:4190), so identity changes exactly once per open request and never on unrelated re-renders. The existing `if (prior && prior.draft !== prior.content) return current;` guard at src/ui/workspace-view.tsx:288 already makes the effect body safe to re-run against a dirty buffer.

**Acceptance:** Unit/browser: open /workspace, click README.md (textarea 'Edit README.md' visible), click its tab close button, then click README.md in the tree again — the tab is aria-selected AND `getByRole('textbox', { name: 'Edit README.md' })` is visible with the file's content, and `.workbench-empty` is absent. Second assertion: with a dirty draft in file A, republishing the same selection must not overwrite A's draft (draft survives).

### 35. [high] Workspace Explorer context menu never receives focus, so Shift+F10 opens a role="menu" the keyboard cannot enter

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, e2e/workspace-workbench.spec.ts  
- **Regression risk:** medium

**Why (reviewer):** Read the whole path. src/ui/workspace-view.tsx:1119-1124 binds `event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")` and only calls `setContext(clampedContext(...))`. The one effect keyed on `context` (src/ui/workspace-view.tsx:353-360) registers a window `pointerdown` dismiss and an Escape `keydown` and nothing else. `grep -n "\.focus("` over the file returns exactly four sites — :391 (reveal), :412 (dialog), :1047 (`closeDialog` restore), :1092 (`focusTreeIndex`) — none of which touch `.workbench-context`. The menu is rendered last in the component at :1405, after `<main class="workbench-editor">`, and its items have no keydown handler; its final child is `<p class="workbench-context__hint">` (:1429), a non-menuitem inside role="menu". So after Shift+F10 focus stays on the tree row: arrows keep walking the tree while a stale-positioned menu floats, and reaching an item requires Tab through every `.tree-overflow` button (all default tabIndex 0, src/ui/workspace-view.tsx:1230), the splitter and the document pane. The repo already knows the contract in two places: `closeDialog` restores the opener (:1043-1048) and src/ui/popover.tsx:107-120 traps Tab and returns focus on Escape. The e2e journeys mask it because every one of them opens with the keyboard and then *clicks* the item: e2e/workspace-workbench.spec.ts:24-25, :227-228, :292-293, :313-314, :327-328.

**Root cause:** The context menu was built as a positioned popup rather than as a menu widget: `context` is pure position state with no opener ref, no focus-on-open, no roving tabindex and no arrow/Home/End handler. The dialog and Popover in the same codebase implement the missing half; the menu was never given it.

**Smallest fix:** In src/ui/workspace-view.tsx add a `contextOpener = useRef<HTMLElement>()` set wherever `setContext` is called (row keydown :1123, onContextMenu :1226, overflow button :1230), plus a `contextBox = useRef<HTMLDivElement>()`. Extend the effect at :353-360 to focus the first `[role="menuitem"]` inside `contextBox` on open and to call `contextOpener.current?.focus()` when Escape or an outside pointerdown dismisses. Add `onKeyDown` on the `.workbench-context` div at :1405 handling ArrowDown/ArrowUp/Home/End across its `[role="menuitem"]` children with tabIndex 0 on the focused item and -1 on the rest, and move the hint text out of the menu (render it as a sibling, or give the `<p>` `role="presentation"`).

**Acceptance:** 1) Focusing a tree row and pressing Shift+F10 leaves `document.activeElement` matching `.workbench-context [role="menuitem"]:first-of-type`. 2) ArrowDown/ArrowUp cycle menu items, Home/End jump to first/last. 3) Escape closes the menu and returns focus to the originating tree row (`[data-workspace-tree-index]`). 4) A keyboard-only journey in e2e/workspace-workbench.spec.ts completes Rename via Shift+F10 + arrows + Enter with no `.click()`. 5) `role="menu"` has no non-menuitem element children.

### 36. [medium] All six global skill switches share the accessible name "Global default"

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:9286 renders, for `scope === "global"`, `<button class={...} role="switch" aria-checked={globalEnabled} type="button" onClick={...}><span /> Global default</button>` — no `aria-label`, `aria-labelledby`, or `aria-describedby`, so the computed name is 'Global default' for every one of `catalog.skills` (six entries, src/profiles/catalog.ts:41-86). The distinguishing text is the unassociated `<h2>{skill.name}</h2>` in the card header (src/ui/app.tsx:9283). The per-profile branch on the very same line does it correctly: `ariaLabel={`${profile.name} mode for ${skill.name}`}`. `rg "Global default"` matches only that source line, so no test pins these names.

**Root cause:** The global branch of the skill control renders a text-only switch whose label describes the scope rather than the subject; the accessible name was never parameterised by `skill.name` the way the sibling per-profile branch was.

**Smallest fix:** On src/ui/app.tsx:9286 add `aria-label={`Global default for ${skill.name}`}` to the switch (keeping the visible 'Global default' text).

**Acceptance:** A11y test over `#skills` in global scope: `getAllByRole("switch")` returns one control per catalog skill and the set of accessible names has the same cardinality as the set of skills (no duplicates), with each name containing its card's `<h2>` text.

### 37. [medium] Composer queue controls and the attachment-remove button are 30px/28px on phone while every sibling control is 44px

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/routes.css, e2e/composer-layout.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/chat.css:1443-1453 is `.composer-queue__item button, .queue-button { min-height: 30px; padding: 4px 8px; ... }` and src/ui/chat.css:1650 is `.composer-attachments button { ... min-width: 1.75rem; min-height: 1.75rem; ... }` (28px at the 16px root). I grepped `queue-button|composer-queue|composer-attachments` across every file in src/ui/*.css: the only hits are in chat.css — routes.css has none, so there is no phone or coarse-pointer override. The only `@media (pointer: coarse)` block in routes.css is at :3535 and covers `.tabs__*` only. These selectors cover the "Send now"/"Edit"/"×" controls at src/ui/app.tsx:7141-7143, the "Queue" button at :7243, and the attachment remove control at :7150 (the sole means of undoing an attachment). Siblings in the same strip are explicitly raised: `.composer-attach { min-height: 44px; min-width: 44px }` (routes.css:2835-2839), `.composer-approval-select .menu-select-trigger { min-height: 44px }` (:2841-2843), `.icon-button, .send-button { width: 44px; height: 44px }` (:3017-3020).

**Root cause:** The phone touch-floor pass enumerated the composer footer's controls by name and the queue block and attachment chips — which mount conditionally and so were absent from the captured screens — were never added to that list.

**Smallest fix:** Add to the existing `@media (max-width: 640px), (max-width: 950px) and (max-height: 500px)` block in src/ui/routes.css, next to `.composer-attach` at :2835: `.composer-queue__item button, .queue-button { min-height: 44px; padding-inline: 12px; }` and `.composer-attachments button { min-width: 44px; min-height: 44px; }`.

**Acceptance:** In a mobile-chromium spec with one queued message and one pending attachment, every button inside `.composer-queue` and `.composer-attachments` reports `getBoundingClientRect().height >= 44` and `width >= 44` at 430x932, 360x800 and 932x430.

### 38. [medium] Explorer context menu is opened by keyboard but is not keyboard-reachable in order

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, e2e/workspace-workbench.spec.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/workspace-view.tsx:1120-1123 handles `ContextMenu` / Shift+F10 by calling `setContext(clampedContext(...))` and nothing else — no focus move. The menu at src/ui/workspace-view.tsx:1405 is `<div class="workbench-context" role="menu" style={{left,top}} onPointerDown={…}>` with no `aria-label`, no `onKeyDown`, no autofocus, and its children are plain `role="menuitem"` buttons with no roving tabindex. DOM order confirms the stranding: `<main class="workbench-editor">` opens at :1270 and closes at :1398, the notice block is :1400-1404, and the menu is :1405 — after both. Tab order is worse than claimed because every rendered row's `.tree-overflow` button (:1230) is tabbable (no tabIndex), unlike the rows themselves which use roving tabindex (:1216). Escape does dismiss via the window listener at src/ui/workspace-view.tsx:352-356 and focus stays on the row, so only the forward path is broken. e2e/workspace-workbench.spec.ts:23-25 presses Shift+F10 then `.click()`s the item, never exercising keyboard traversal.

**Root cause:** The menu was implemented as a positioned overlay with menu roles but without the focus-management half of the menu pattern; keyboard invocation was added on top of a pointer-only interaction model.

**Smallest fix:** In src/ui/workspace-view.tsx:1405 add `aria-label={`Actions for ${workspaceBaseName(context.path)}`}`, a `ref`, and an `onKeyDown` implementing ArrowDown/ArrowUp/Home/End across `[role=menuitem]` children plus Escape → `setContext(undefined)` and refocus the originating row (`treeRowElement`), and focus the first item in a `requestAnimationFrame` when `context` becomes defined — the same shape already used for the dialog at src/ui/workspace-view.tsx:1429-1434 and for the source-tools sheet at src/ui/editor-view.tsx:94-97.

**Acceptance:** Focus a tree row, press Shift+F10: `document.activeElement` is the first `[role=menuitem]`; ArrowDown/ArrowUp cycle items; Escape closes the menu and returns focus to the originating treeitem; the menu element has a non-empty accessible name. Existing pointer-driven journeys still pass.

### 39. [medium] Sessions search field has no focus indicator: outline:0 with no compensating :focus-within

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/sessions-view.css  
- **Regression risk:** low

**Why (reviewer):** src/ui/sessions-view.css:121-128 is exactly `.session-library-search input { width:100%; min-width:0; padding:0; border:0; outline:0; background:transparent; }`. The global ring is src/ui/tokens.css:368-374 `input:focus-visible { outline: 2px solid var(--brass-bright); outline-offset: 2px; }` — same (0,1,1) specificity, so source order decides. tokens.css is imported by the always-loaded barrel src/ui/styles.css:14-15, while sessions-view.css is imported from the lazy route module at src/ui/sessions-view.tsx:15, so it lands later and `outline: 0` wins. `grep -rn session-library-search src` returns only :73, :121, :1212, :1242, :1314, :1368 — none is a focus rule, and I read all six: the wrapper at :73-82 has a static border and no `:focus-within` in any breakpoint. This is a deviation from the file's own siblings: src/ui/memory-view.css:43-53 uses the identical `border:0; outline:0` input and compensates at :37-41 (`.memory-query > div:focus-within { border-color; outline: 2px ... }`), as does src/ui/context-view.css:377-382.

**Root cause:** The borderless-input-in-a-bordered-shell pattern requires the ring to be moved to the wrapper. Memory and Context did that; Sessions copied only the `outline: 0` half, and because the compensating rule lives in a different sheet there is nothing to catch the omission.

**Smallest fix:** Add to src/ui/sessions-view.css next to :121 — `.session-library-search:focus-within { border-color: var(--accent-bright); outline: 2px solid color-mix(in srgb, var(--accent-bright) 24%, transparent); outline-offset: 2px; }` — mirroring src/ui/memory-view.css:37-41.

**Acceptance:** 1) Focusing the Sessions filter input renders a visible ring on `.session-library-search` (assertable as a non-`none` computed outline-style/box-shadow on the label, or via the existing CSS-contract test style). 2) A source-level rule asserting every `outline: 0` on an input is paired with a `:focus-within` or `:focus-visible` rule in the same sheet.

### 40. [medium] Three hand-rolled tablists ignore the roving-tabindex/arrow-key contract that tabs.tsx declares itself the single owner of

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/terminal-view.tsx, src/ui/access-view.tsx, src/ui/connect/connect-surface.tsx  
- **Regression risk:** medium

**Why (reviewer):** src/ui/tabs.tsx:7-45 does declare itself 'the one tab strip', explicitly names 'Connect methods' and 'Terminal sessions' as its cases, and promises 'roving tabindex with ←/→/Home/End, per the tablist pattern' at :40. Terminal is the worst case and matches the claim exactly: src/ui/terminal-view.tsx:276 `<div class="terminal-tabs" role="tablist" aria-label="Terminal tabs">` with `role="tab"` buttons at :290 and no tabIndex; `grep -n "tabpanel|aria-controls|tabIndex|onKeyDown" src/ui/terminal-view.tsx` returns a single hit, :286, which is the rename input's Enter/Escape handler — no tabpanel, no aria-controls, no arrows, and every tab plus every `.terminal-tab__rename` button is a separate tab stop. The Chutes switch at src/ui/access-view.tsx:954-976 is the same shape with two tabs and no aria-controls (`grep -n tabpanel src/ui/access-view.tsx` returns only a prose comment at :710). connect-surface is better than filed: src/ui/connect/connect-surface.tsx:272 and :282 do set aria-controls, and :289 and :298 are real `role="tabpanel"` elements — it is missing only roving tabIndex and arrow keys. src/ui/billing-view.tsx:488-524 is indeed the one correct hand-roll (tabIndex={active ? 0 : -1} at :519, arrows/Home/End at :498-505, aria-controls at :516).

**Root cause:** `Tabs` is documented as mandatory but nothing enforces it, and the ARIA roles were applied as styling-adjacent markup rather than as an adopted widget contract, so three surfaces got the roles without the behaviour role=tab obliges.

**Smallest fix:** Terminal is the load-bearing one: replace src/ui/terminal-view.tsx:276-297 with `<Tabs variant="document" label="Terminal tabs" ... />` per the usage block at src/ui/tabs.tsx:21-30 (rename stays as the strip's per-item action) and give the panel at :300 `role="tabpanel"` with the id the strip's `panelId` produces. For the two two-button switches, either adopt `Tabs` or add `tabIndex={selected ? 0 : -1}` plus an ArrowLeft/ArrowRight/Home/End `onKeyDown` on the container, and add the missing `aria-controls`/`role="tabpanel"` pair in src/ui/access-view.tsx (connect-surface already has the panels).

**Acceptance:** 1) In each tablist exactly one `role="tab"` has tabIndex 0 and the rest -1. 2) ArrowLeft/ArrowRight move selection and focus, Home/End jump to ends. 3) Every `role="tab"` has aria-controls resolving to an element with `role="tabpanel"`. 4) A source test asserts no `role="tablist"` outside src/ui/tabs.tsx lacks an onKeyDown.

### 41. [medium] Virtualized Explorer tree reports wrong item positions to screen readers

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, e2e/workspace-workbench.spec.ts  
- **Regression risk:** low

**Why (reviewer):** `rg -n 'aria-setsize|aria-posinset' src e2e` returns nothing. src/ui/workspace-view.tsx:1206 declares `role="tree"`, :1208 renders only `visible.slice(rowWindow.start, rowWindow.end)`, and the row button at :1210-1212 carries `role="treeitem"` with `aria-level` and `aria-expanded` but no position attributes, so assistive tech derives position from the rendered subset (rowWindow width, ~20 rows) rather than `visible.length`. Structure also confirmed: `role="tree"` > `<div style=height>` > `<div style=absolute>` > `<div class="tree-row-wrap">` > `button[role=treeitem]` (src/ui/workspace-view.tsx:1207-1208), and a non-treeitem `<button class="tree-overflow">` sits inside the tree at :1230. `aria-level` itself is correct (rendered rows start at depth 1 — src/workspace/tree.ts:32,50).

**Root cause:** Virtualization moved the row set out of the DOM without replacing the implicit DOM-derived position/size semantics with explicit ones, and the virtualization scaffolding divs were inserted between the tree and its required owned treeitems.

**Smallest fix:** In src/ui/workspace-view.tsx:1210-1212 add `aria-posinset={rowWindow.start + offset + 1}` and `aria-setsize={visible.length}` (both values already in scope at the map callback), and put `role="presentation"` on the two virtualization wrapper divs at :1207 and on `.tree-row-wrap` at :1208 so the treeitems stay owned by the tree. Give `.tree-overflow` (:1230) `role="presentation"`-safe placement or move it inside the treeitem's accessible content rather than beside it.

**Acceptance:** With N visible tree nodes and a windowed render, every rendered `[role=treeitem]` has `aria-setsize="N"` and `aria-posinset` equal to its index in the full visible list + 1; scrolling changes posinset but never setsize. No element between `[role=tree]` and `[role=treeitem]` has an implicit generic role.

### 42. [medium] aria-label on role=generic containers is dropped, and for three controls it is the only accessible text

- **Cluster:** accessibility  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/access-view.tsx, src/ui/billing-view.tsx, src/ui/profile-theme-swatch.tsx  
- **Regression risk:** low

**Why (reviewer):** All three cited sites exist verbatim: src/ui/billing-view.tsx:645 (`<span class="runway-track" aria-label={...}><span style={{width}} /></span>`, and src/ui/routes.css:1708-1728 confirms the inner span is a pure CSS bar with no text), src/ui/access-view.tsx:1316 (`CapabilityMark` renders a bare `<span class="capability-mark" aria-label={available ? "Available" : "Unavailable"}>{available ? "✓" : "—"}</span>`), consumed three times per row at src/ui/access-view.tsx:1195-1197, and src/ui/profile-theme-swatch.tsx:5 (span of styled `<i>`). aria-label is prohibited on role=generic in ARIA 1.2, so all three labels are dropped. But the claim's severity is overstated for two of the three: the runway meter's numbers are already in adjacent text (src/ui/billing-view.tsx:644 `${formatUsd(usage)} ... of ${formatUsd(cap)} covered` and :646 remaining/reset), and the theme swatch sits immediately beside `<strong>{theme.name}</strong><small>{theme.description}</small>` (src/ui/app.tsx:9162-9163). Only the capability matrix genuinely loses information: each `<td>` announces a bare `✓` or `—` glyph with no word. There is no axe/a11y linter in the repo (`grep -n axe package.json` is empty), so nothing catches the class.

**Root cause:** A styled-span idiom was labelled as if it were an interactive or img element. No shared primitive or lint rule exists for 'graphic that carries state', so each author reached for aria-label on the nearest wrapper, and ARIA's generic-role prohibition silently discards it.

**Smallest fix:** Give the one information-carrying case a name-permitting role: change src/ui/profile-theme-swatch.tsx:5 and src/ui/billing-view.tsx:645 to `aria-hidden="true"` (both are redundant decoration), and change src/ui/access-view.tsx:1316 to `<span class=... role="img" aria-label={available ? "Available" : "Unavailable"}><span aria-hidden="true">{available ? "✓" : "—"}</span></span>`. The `.sr-only` helper at src/ui/routes.css:2177 (always-loaded barrel) is the alternative carrier if role="img" conflicts with `.capability-mark` styling in src/ui/access-view.css:780-790.

**Acceptance:** 1) A unit render of the Chutes capability matrix exposes accessible names 'Available'/'Unavailable' for every cell mark, not '✓'/'—'. 2) No element whose computed role is generic carries aria-label — assertable as a source-level test over src/ui/*.tsx for `aria-label` on `<span`/`<div` without a `role=`. 3) The runway bar and theme swatch are aria-hidden and the surrounding text still names usage and theme.

### 43. [medium] A stopped turn reports the stop three times, once headed with the raw event type turn.cancelled

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/message-parts-view.tsx, src/ui/chat/turn-recovery.ts, src/ui/chat/turn-recovery.test.ts  
- **Regression risk:** low

**Why (reviewer):** `src/ui/chat/message-parts.ts:388-400` builds the error fact with `code: event.type` for both `turn.failed` and `turn.cancelled`, and `src/ui/chat/message-parts-view.tsx:571-577` renders `<strong>{part.code ?? "Turn stopped safely"}</strong>` — so the bold heading is the literal string `turn.cancelled` (body: the DOMException message "Stopped by user" from `src/ui/app.tsx:4027`). That fact reaches `message.parts` before the catch runs: `src/core/agent.ts:558-564` appends the terminal event signal-free and `:165` calls `notifySignal(..., { type: "durable", events: durable })`, which `src/ui/app.tsx:3898-3903` folds via `facts.reduce(reduceMessagePartFact, message.parts ?? [])`. The catch at `:3993-3999` then calls `recoverPartialTurn(message.parts ?? [], "", pending, cancelled)`, and `src/ui/chat/turn-recovery.ts:15-18` pushes both an `ErrorPart` and a `FooterPart` carrying the identical summary "Stopped — partial response kept." (plus `retryable: true`, which renders "Retry is available." at `message-parts-view.tsx:576`). Three stacked notices; the first headed with a journal event type.

**Root cause:** Two independent stop reporters — the durable-fact reducer and the client-side recovery helper — both write into the same parts list with no de-duplication, and the error renderer treats the machine-readable `code` field as display copy.

**Smallest fix:** Two small edits. (1) In `MessagePartView`'s error branch, map `code` through a label table (`turn.cancelled` → "Turn stopped", `turn.failed` → "Turn failed") rather than printing it, keeping the raw code as a `title`/`data-code`. (2) In `recoverPartialTurn`, skip pushing the error part when the incoming parts already contain an error part whose `code` is `turn.cancelled`/`turn.failed`, and keep only the footer.

**Acceptance:** For parts containing a durable `turn.cancelled` error fact, `recoverPartialTurn(parts, "", "", true)` adds exactly one part (the footer) and the result contains exactly one `kind: "error"` part. No rendered heading in the transcript equals a journal event type — a rendering test asserts the heading is "Turn stopped" for `code === "turn.cancelled"`.

### 44. [medium] All Conversations loses its only Sort control between 861px and 1180px, and a non-default sort cannot be cleared

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/sessions-view.css, src/ui/sessions-view.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/sessions-view.css:1161-1163 sets `.session-library-sort-menu { display: none; }` inside `@media (max-width: 1180px)`, and the only restore is at :1220-1222 inside `@media (max-width: 860px)`. `rg sort src/ui/sessions-view.tsx` shows exactly one control (:409 `className="session-filter-menu session-library-sort-menu"`, ariaLabel "Sort sessions" at :411) — no column-header sort, no palette entry, no duplicate. `.session-library-filter-toggle` is `display: none` by default (sessions-view.css:107-109) and only `inline-flex` under `@media (max-width: 640px)` (:1275), so between 861px and 1180px there is no disclosure to fold it into either. The `sort` state (:92) persists across resizes and is a query input (:147, :166), so a title-sorted list survives into the band with nothing on screen explaining or reverting the order: `filterActive` at :308 excludes `sort`, so no `Clear` renders, and `clearFilters()` (:265-270) does not reset it. Two sub-claims of the scout are wrong and I discount them: `activeFilterCount` (:311) DOES count a non-default sort, and at <=640px the 860px rule re-sets `display: block` on the sort menu so the disclosure does reveal it. The 861-1180 hole stands.

**Root cause:** The 1180px rule sheds the sort menu to relieve the six-track toolbar grid (`grid-template-columns` at sessions-view.css:1158) but no surviving home was created for it at that width; the 860px block only recovers it as a side effect of switching the toolbar to `flex-wrap: wrap`. Separately, `sort` was modelled as layout state rather than as one of the filters, so it is excluded from both `filterActive` and `clearFilters`.

**Smallest fix:** Delete the `.session-library-sort-menu { display: none; }` rule at sessions-view.css:1161-1163 (and the now-redundant restore at :1220-1222), and let the toolbar wrap at 1180px the way it already does at 860px (`flex-wrap: wrap`). In sessions-view.tsx, include sort in both `filterActive` (:308 -> `Boolean(search || providerId || model || sort !== "updated-desc")`) and `clearFilters` (:265-270 -> `setSort("updated-desc")`).

**Acceptance:** E2E at 900x900, 1024x900 and 1180x900 on #sessions: `getByRole("button", { name: "Sort sessions" })` is visible and the toolbar reports no horizontal overflow. Choosing `Title A-Z` renders a `Clear` button at every width; pressing it returns the sort control's value to `Recently active` and re-issues the query.

### 45. [medium] All Conversations provider/model filter facets are built before the profile filter, leaking the other profile's inventory

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/sessions/domain.ts, src/sessions/session-library.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/sessions/domain.ts:916-921 builds `facets` from `summaries` (every summarized record) and only at :922-930 does `filtered` apply `query.profileId`. `SessionLibrary.list` (src/sessions/library.ts:96-115) passes `await this.journal.listSessions()` — one journal instance shared by every profile, since `runtimeForProfile` reuses `journal: active.journal` (src/ui/app.tsx:2996). SessionsView always queries `profileId: scopeProfileId` (src/ui/sessions-view.tsx:147) yet renders `page.facets.providers` / `page.facets.models` verbatim into the two MenuSelects (src/ui/sessions-view.tsx:397, :405). So the rows are scoped and the facet menus are not. The CON-01 acceptance gate in docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:73 is marked 'DONE THIS PASS' and reads 'no row, count, facet, preview, or command result leaks' — the word 'facet' is in the gate, so this is a closed directive contradicted by code. The only facet assertion in the suite (src/sessions/session-library.test.ts:44, `expect(newest.facets).toEqual({ providers: ["chutes", "demo"], ... })`) is on an unfiltered query, so nothing covers profile scoping. I downgrade the scout's 'high/security': the leaked values are provider ids and model ids, not rows or content, and selecting a foreign facet returns zero rows because the profile predicate still applies.

**Root cause:** `querySessionRecords` treats the profile predicate as just another user-selected filter and folds it into the same pass as provider/model/search, but profile is a scope boundary, not a filter — facets must be derived from the post-scope, pre-filter set. Deriving them from the raw `summaries` array is the defect.

**Smallest fix:** In src/sessions/domain.ts, split the single `filter` into two: first `const scoped = summaries.filter(profilePredicate)` using the existing `query.profileId` / `"unbound"` logic, then compute `facets` from `scoped`, then apply provider/model/search to `scoped` to get `filtered`. Facets stay stable across provider/model/search changes (current behaviour) while never crossing the profile boundary.

**Acceptance:** Given records for profile-a (provider `chutes`, model `model-a`) and profile-b (provider `demo`, model `model-b`), `querySessionRecords(records, { profileId: "profile-a" }).facets` equals `{ providers: ["chutes"], models: ["model-a"], profiles: ["profile-a"] }`; with `profileId: "unbound"` facets contain only unprofiled records' values; with no `profileId` the existing unscoped assertion at session-library.test.ts:44 still passes; changing `providerId`/`model`/`search` does not shrink the facet lists.

### 46. [medium] Bounded fork context silently drops ancestor turns and images; the counts the library returns have no consumer

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/sessions-view.tsx, src/ui/chat/session-message-presentation.ts  
- **Regression risk:** low

**Why (reviewer):** boundWholeTurns walks turn groups newest-first and sets `stopped = true` on either the 256-message or the ~764 KB bound (src/core/fork-context.ts:190-201), and strips images from the newest turn when nothing else fits (:205-215); it reports omittedMessages/omittedImages (:216-222). forkSession surfaces them as contextMessageCount/omittedContextMessages/omittedContextImages (src/sessions/session-fork.ts:136-139), typed at src/sessions/library.ts:60-64. A repo-wide grep for those four identifiers returns hits only in src/sessions/session-fork.ts, src/sessions/library.ts and src/sessions/session-library.test.ts — zero readers in src/ui, e2e or docs. Meanwhile the user is told unconditionally "True fork created with audited context through this answer." (src/ui/app.tsx:3554-3556) and All Conversations announces only "Source history was not rewritten." (src/ui/sessions-view.tsx:241). The register itself leaves this open: docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:258 states "any omitted ancestor range must remain explicit" as a remaining condition, so this is an acknowledged gap, not a closed item.

**Root cause:** The bound is computed and sealed but never plumbed into any user-facing surface; the composer notice is a fixed string that asserts completeness the seed does not guarantee.

**Smallest fix:** Thread the numbers the library already returns into the two places that speak: in src/ui/app.tsx forkFromMessage use `result.contextMessageCount` / `result.omittedContextMessages` / `result.omittedContextImages` to build the notice at :3549-3557 (e.g. "… carrying N ancestor messages; M earlier messages and K images were outside the bounded seed."), and do the same for setAnnouncement in src/ui/sessions-view.tsx:241. The transcript-side statement comes free once the fork-seed marker of finding 2 renders the same counts.

**Acceptance:** Given a source whose materialized context exceeds MAX_FORK_CONTEXT_MESSAGES, the fork notice text contains both the carried count and the omitted count, and contains no unqualified claim of complete context; given a fully-carried fork, the notice states the carried count and "none omitted". Assertable by unit-testing the notice-building helper against a SessionForkResult fixture.

### 47. [medium] Every branch becomes a peer row in Recent, so edit/retry floods the conversation list and no alternates appear at the fork point

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/sessions-view.tsx, src/ui/rail.tsx  
- **Regression risk:** low

**Why (reviewer):** Each branch mints an ordinary session titled `${source.title} · ${action}` (src/ui/app.tsx:3519), and because the title is taken from the current source, retrying inside a retry branch yields "Foo · retry · retry". loadRecentConversations sorts all non-favorite sessions by updatedAt and takes `.slice(0, Math.max(0, 10 - favoriteItems.length))` (src/ui/app.tsx:840-844) with no lineage awareness, and the rail renders exactly two flat groups, "Favorites" and "Recent" (src/ui/rail.tsx:430-432) — no nesting, no roll-up, no derived-branch filter. Lineage is child-to-parent only: the card shows "↳ from <parent>" and a jump button (src/ui/sessions-view.tsx:513, :519-524), the detail panel links the parent (:739-749), and the session bar exposes a parent link (src/ui/app.tsx:6930-6933). I found no reverse index of children anywhere in src/, so from the source conversation there is no way to enumerate or switch between alternates at the fork point. The delivery gate at docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:382 requires "lineage remains navigable without flooding recents" and the checkpoint at :258 does not claim it closed.

**Root cause:** Branching produces peer sessions in a flat, recency-only shortcut; lineage exists in the manifest but is only ever traversed upward, never used to group the rail or to index a session's descendants.

**Smallest fix:** Two small, independent steps: (1) in loadRecentConversations (src/ui/app.tsx:840-844) collapse rows sharing a lineage root — keep the most recently updated member per root against the ten-row budget and mark the row with its branch count; (2) build the reverse index that already-listed data supports — in sessions-view.tsx, where titleById is derived (near :442), also derive childrenBySourceId from item.sourceSessionId and render an "Alternates (N)" list in the detail panel beside the existing lineage line (:739-749).

**Acceptance:** With one source plus three retry branches and eight unrelated conversations, the rail's Recent group shows at most one row for that lineage and none of the eight unrelated conversations is displaced. Opening the source in All Conversations lists its three branches with their fork-point sequences and each entry selects that branch.

### 48. [medium] Mobile message-action disclosure loses its expanded state and declares a menu it does not implement

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, e2e/message-hover.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:8993-9002 is exactly as filed: `<details class="message-actions-touch"><summary role="button" aria-label="Message actions">•••</summary><div role="menu" aria-label="Message actions">` with four `role="menuitem"` buttons. Overriding summary's native disclosure mapping with role="button" drops the expanded/collapsed state, and no `aria-expanded` is supplied to replace it. The menu half is unambiguous: there is no arrow-key handler, no roving tabindex and no Escape handler anywhere in the details subtree (native `<details>` does not close on Escape), so an AT that switches to application mode for role="menu" offers keys that do nothing. The 'only path on touch' premise also checks out: src/ui/chat.css:1035-1036 sets `.message-actions { display: none; }` and `.message-actions-touch { ... display: block; }` inside `@media (hover: none), (max-width: 640px)`, and `.message-actions-touch { display: none; }` at :1033 is the desktop default. This is the same missing-menu-pattern defect as the workspace context menu at src/ui/workspace-view.tsx:1405.

**Root cause:** role="menu"/role="menuitem" were used as a naming/grouping device on a native disclosure rather than as a widget contract, and role="button" was added to suppress the disclosure triangle — a presentation fix applied via a role override.

**Smallest fix:** In src/ui/app.tsx:8994-9001 drop `role="button"` from the summary (the marker is already hidden by `list-style: none` and the `::-webkit-details-marker` rule at src/ui/chat.css:1049-1050, so the role override buys nothing) and drop `role="menu"`/`role="menuitem"`, replacing them with `<div class=... aria-label="Message actions">` holding plain buttons — or, if the menu semantics are wanted, add focus-on-open, roving tabindex, Up/Down/Home/End and Escape-closes-and-restores-focus, reusing src/ui/popover.tsx:107-120.

**Acceptance:** 1) The touch trigger exposes an expanded state that flips when opened (aria-expanded or the native details mapping). 2) Either no element in that subtree has role="menu"/"menuitem", or opening moves focus into the first item, arrows cycle, and Escape closes and returns focus to the trigger. 3) e2e/message-hover.spec.ts asserts all four actions (Copy, Retry, Edit & branch, Fork) remain reachable in the mobile project after the change.

### 49. [medium] Renaming a conversation from All Conversations leaves the Chat title and the rail recents showing the old name

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/sessions-view.tsx, src/ui/app.tsx, e2e/conversation-navigation.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/sessions-view.tsx:249-262 `renameSelected` calls `library.rename` (src/sessions/library.ts:150-153 → `journal.renameSession`, durable) then only `setRefresh((value) => value + 1)` — component-local state. `SessionsViewProps` (src/ui/sessions-view.tsx:37-50) declares `revision`, `onResume`, `onForked`, `onOpenProof` and no rename callback, and the host's mount at src/ui/app.tsx:7287-7300 passes none. The Chat header reads `title={activeSessionRecord?.title ?? activeProfile.name}` (src/ui/app.tsx:6922). I enumerated every `setActiveSessionRecord` call site — app.tsx:1868 (activateSession), :2433 (title-bar rename), :3409 (slash path), :3792 (auto-title), :4016 (post-turn reload) — none is reachable from the sessions route. Both recents loaders depend on the host's `sessionRevision` (src/ui/app.tsx:1613 rail, :1533 palette), which SessionsView never bumps. The opposite direction is covered by e2e/conversation-navigation.spec.ts:25-42, so the asymmetry is real.

**Root cause:** The rename result is owned entirely by SessionsView's local `refresh` counter; the host holds the only copies that Chat and the rail read (`activeSessionRecord`, `sessionRevision`) and is never told a durable rename happened.

**Smallest fix:** Add `onRenamed?: (record: SessionRecord) => void` to `SessionsViewProps`, call it with `renamed` inside `renameSelected`, and wire it in app.tsx to `setActiveSessionRecord((current) => current?.id === renamed.id ? renamed : current)` plus `setSessionRevision((value) => value + 1)`.

**Acceptance:** E2E: with conversation X active, open All conversations, rename X to 'Renamed from library', navigate back to Chat — `.session-bar__title` reads 'Renamed from library' and the rail's 'Profile conversations' group contains it, with no intervening turn, favourite toggle or resume.

### 50. [medium] The All Conversations fork surface and SESSION_LIBRARY.md still describe forks as context-free

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/sessions-view.tsx, docs/SESSION_LIBRARY.md  
- **Regression risk:** low

**Why (reviewer):** Quoted strings verified verbatim. src/ui/sessions-view.tsx:848 reads "Fork = new identity · empty transcript · source untouched. The new manifest records the source head as immutable lineage.", the primary button is "Create clean fork" (:866) and the only adjacent note is about runtime pins (:865). Nothing on that panel mentions the seeded ancestor context. docs/SESSION_LIBRARY.md:78 states "The source transcript is not copied, summarized, or rewritten. The returned `historyCopied: false` field and the UI state this explicitly. A future protocol can resolve ancestor transcripts for conversational branching…" — while src/sessions/session-fork.ts:114-124 already seals and commits exactly that seed and always returns `contextSeeded: true` with a message count (:136-137, src/sessions/library.ts:60-64). This panel's fork path passes no sourcePoint (src/ui/sessions-view.tsx:229-236), so resolveForkBoundary defaults to the newest boundary (src/sessions/session-fork.ts:150-152) and the branch inherits the whole bounded history — the opposite of "empty transcript".

**Root cause:** The copy and the doc were written for the pre-seed contract and were never updated when the fork-context seed shipped; `historyCopied: false` (true of the journal) is being read as "the model starts from nothing".

**Smallest fix:** Rewrite the two strings and the doc paragraph: src/ui/sessions-view.tsx:848 -> "Fork = new identity · source untouched. The branch inherits a bounded, digest-sealed copy of the ancestor context and records the source head as immutable lineage."; the button at :866 -> "Create fork"; and replace docs/SESSION_LIBRARY.md:78 with the shipped contract, naming FORK_CONTEXT_EVENT_TYPE, historyCopied: false vs contextSeeded: true, and the MAX_FORK_CONTEXT_MESSAGES / MAX_FORK_CONTEXT_BYTES bounds.

**Acceptance:** The fork panel contains no "empty transcript" or "clean fork" wording and does state that bounded ancestor context is inherited; docs/SESSION_LIBRARY.md describes the seed event and its bounds rather than describing branching as future work. Assertable by a string check in the sessions-view test and a docs grep in the release gate.

### 51. [medium] The conversation-naming inference is a second unaudited provider call: its receipt and usage events are discarded

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/core/contracts.ts, src/ui/app.test.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/app.tsx:8462-8470 calls `runtime.transport.stream` directly with `sessionId: `naming-${randomUuid()}``, and the consume loop at :8473-8477 only reads `text-delta` and breaks on `completed` — `usage` and `completed.receipt` are never touched, and nothing is appended to `runtime.journal`. Compare the audited path: src/core/agent.ts:381-382 appends `{ type: "inference.usage", turnId, operationId: requestId, payload: usage }` for every usage event, and :509-534 finalizes the provider receipt and journals it plus `turn.completed` with its `receiptId`. src/inference/chutes/transport.ts:1293-1295 mints the receipt against `sessionId: args.request.sessionId`, i.e. the synthetic `naming-…` id, so even the discarded receipt is bound to a session that does not exist. The CON-04 acceptance gate (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:76) says the naming call 'is audited/cancellable'; it is cancellable (the turn's `controller.signal` is passed) and it is not audited. Net effect: every new conversation makes one extra billed, quota-consuming, attestation-producing request that appears in no journal, no Proof view and no token counter.

**Root cause:** The naming call bypasses the single audited inference path (`runTurn` → journal append of `inference.usage` and the finalized receipt) by calling `transport.stream` directly, and it fabricates a throwaway session id so nothing it produces can be bound back to the conversation it names.

**Smallest fix:** Pass the real `turnSessionId` (plus a fresh `turnId`/`operationId`) into `conversationTitleFromModel`, and in its consume loop collect `usage` and `completed.receipt`; on success append two events to `runtime.journal` for that session — `{ type: "inference.usage", operationId, payload: usage }` and a `conversation.named` event carrying `{ title, receiptId, receipt }` — under the same per-session serialization the previous finding adds. If the product decides not to audit it, the alternative smallest fix is to state in Proof and in docs/CANON.md §10.3 that naming issues one additional unreceipted request per conversation.

**Acceptance:** After the first message of a new conversation with a naming response, `journal.readEvents(sessionId)` contains an `inference.usage` event and a naming event whose `receipt.sessionId === sessionId`, and the Proof route lists that receipt; when the naming call fails or is aborted, no naming events are appended and the heuristic title stands.

### 52. [medium] The session bar still shows a bare unlabelled event count next to another bare number; the unit exists only on hover

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/session-bar.tsx, src/ui/chat/session-status-chip.tsx, src/ui/chat.css  
- **Regression risk:** low

**Why (reviewer):** src/ui/chat/session-bar.tsx:232-235 renders `<span class="journal-chip__glyph" aria-hidden="true">⌗</span><span class="journal-chip__count">{journal.eventCount}</span><small class="journal-chip__id">#{shortId}</small>`. The unit words live only in `title` (:229, "page-journal event(s)") and `aria-label` (:230, built from `steps` at :205, "N recorded steps") — neither reaches a touch user. src/ui/chat/session-status-chip.tsx:154 renders `<small class="session-status-chip__count">{facts.length}</small>`, a second bare integer immediately to its left. src/ui/chat.css:162-168 gives both counts only colour/size/tabular-nums — no generated content. src/ui/chat.css:290-307 clips `.journal-chip__id` on scroll at a fine pointer, leaving `⌗ 257`. I also grepped src/ui/chat/**: no token figure is rendered anywhere in Chat. CMP-08 is still listed as open in docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:96 and in the open-items list at :277, so this is not a re-report of something closed. Note the code comment at :226-228 shows the bare-number rendering was a deliberate P11 choice; the disagreement is with CMP-08's gate, which requires the unit to be visible, not merely accessible.

**Root cause:** The chip's unit is carried by attributes (title/aria-label) rather than by rendered text, on the assumption that a glyph plus a tooltip is a label; CMP-08's gate explicitly rejects that for the one number sitting beside a model name.

**Smallest fix:** Render the unit in src/ui/chat/session-bar.tsx:234 — `<span class="journal-chip__count">{journal.eventCount} <span class="journal-chip__unit">events</span></span>` — and let the existing scrolled-state rule in src/ui/chat.css:298-307 clip `.journal-chip__unit` alongside `.journal-chip__id` if width demands it. Do the same for `session-status-chip__count` (e.g. `{facts.length} claims`).

**Acceptance:** The session bar's visible text (textContent, not attributes) for the journal chip matches /\d+\s+events?/ at desktop width, and no two adjacent chips in `.session-bar` render text that is a bare integer.

### 53. [medium] Toggling one per-profile skill mode strands that profile's current conversation: the next switch back opens an empty one

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/sessions/profile-cockpit.ts  
- **Regression risk:** medium

**Why (reviewer):** `setProfileSkill` mints a new `ProfileRevision` via `createProfileRevision({...profile, parentRevision, skillModes: {...}})` (src/ui/app.tsx:6458-6470), which changes both `revision` and, through `composeSystemPrompt`/`skillSetDigest` (src/profiles/domain.ts:328-357), the pin. `profileBindingsMatch` requires exact equality of `profileRevision` (src/sessions/profile-cockpit.ts:267) and `skillSetDigest` (:270), and `resolveResumableProfileConversation` filters both the durable pointer and every listed session through it (src/sessions/profile-cockpit.ts:176-192). `changeProfile` therefore gets `undefined` from `compatibleProfileSession` and falls through to `nextSession ??= await createProfileSession(...)` (src/ui/app.tsx:3068), emitting '<name> had no compatible conversation, so Airship started one.' (src/ui/app.tsx:3107). The route copy asserts the opposite emphasis — 'Existing conversations remain pinned.' (src/ui/app.tsx:9270), 'Running conversations keep their pinned prompt and skill-set digests.' (src/ui/app.tsx:9294), and the status 'Profile skill policy revised; existing sessions remain pinned' (src/ui/app.tsx:6471). I confirmed the old conversation is not destroyed: src/sessions/library.ts has no profileRevision comparison, so it is still resumable from All Conversations — data loss does not occur, which supports medium rather than higher. The same detachment follows any profile save, so the defect is generic to revision-minting, not skill-specific.

**Root cause:** Cockpit resume identity is the profile *revision* string, while every behavioral edit (including a skill toggle) mints a new revision; nothing re-points the profile's durable active-conversation pointer or tells the operator the pointer has just been orphaned.

**Smallest fix:** Give `setProfileSkill` the same explicit ceremony `changeActiveApprovalMode` already uses (src/ui/app.tsx:6364-6401): after committing the revision, when the edited profile is the active one, create the conversation pinned to the new revision and say so ('Skill policy changed in this new pinned conversation. The previous conversation remains addressable from its URL and conversation history.'); when it is not the active profile, replace the misleading status at src/ui/app.tsx:6471 with one that states the profile's next switch starts a new conversation and the current one stays in All Conversations, and align the route copy at src/ui/app.tsx:9270/:9294.

**Acceptance:** Unit test over profile-cockpit: build manifest M1 for profile P at revision R1, mint R2 by changing one `skillModes` entry, and assert `profileManifestResumeMismatches(M1, M2)` contains 'profile-binding' — then assert the app-level contract that after `setProfileSkill` on the active profile a new session exists whose `manifest.profile.profileRevision === R2` and whose welcome text names the previous conversation as retained; and that the pre-existing session is still returned by the session library as `action === "resume"`.

### 54. [medium] An attachment-only message can never be sent, with no feedback explaining why

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:7251-7256 is `disabled={!input.trim() || !sessionId || composerOfflineBlocked || modelSwitching || vaultProviderSwitching || localDeviceBusy}` — `attachments` is not consulted. src/ui/app.tsx:3630-3643 is `let content = (retryPrompt ?? input).trim(); if (!content || ... ) return;` — a bare `return` with no `setComposerNotice`, unlike every other refusal in the same function (:3654, :3710, :3716, :3727-3731). The attachment chip at :7149-7150 renders `encrypted vision ready` while Send stays dead, and the disabled button's `aria-label` is the unqualified `"Send message"` with `title` undefined outside the offline/demo branches (:7257-7263). Confirmed exactly as filed. One nuance the scout did not surface: a second `if (!content) return;` sits after slash planning at :3687, so admitting empty-text turns is a two-site change, not one.

**Root cause:** Send admission is keyed solely on trimmed text in both the disabled predicate and the imperative guard; the attachment list is a parallel piece of composer state that no admission path reads, and the guard's early `return` is silent by construction.

**Smallest fix:** Lowest-risk complete fix: keep the text requirement but make the refusal speak — change the disabled predicate's first term to `(!input.trim() && !attachments.length)` only if empty-text turns are admitted end to end; otherwise leave `disabled` as-is, add `title={attachments.length && !input.trim() ? "Add a message to send with this attachment." : ...}` at :7260, and in sendMessage replace the silent bail with `if (!content) { if (attachments.length) setComposerNotice("Add a message to send with this attachment."); return; }`. If image-only turns are to be admitted, both :3631 and :3687 must fall through when `outgoingAttachments.length > 0`.

**Acceptance:** With one image attached and an empty textarea, pressing Enter must produce a visible `.composer-notice` (role="status") explaining the refusal, and the disabled Send button must carry a non-empty `title` naming the same reason — or, if image-only turns are admitted, the turn must be sent with the attachment part present in `userMessageParts`.

### 55. [medium] Attachments beyond the 8-file cap are dropped silently and the notice reports "0 images are ready"

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:3447-3466 reads exactly as filed: `const rejected = filesToAdd.length - images.length;` counts only non-image MIME types; `const remaining = Math.max(0, 8 - attachments.length);` then `images.slice(0, remaining)` discards the overflow with nothing counting it; the `rejected > 0` branch returns early only for MIME rejections; the final `setComposerNotice` interpolates `next.length`, so with 8 already pending the literal string is `"0 images are ready for inline encrypted vision inference."`. `composerAttachments` (src/ui/chat/composer-state.ts:17-18) also slices to `COMPOSER_ATTACHMENT_LIMIT` and the setter re-slices to 8 at :3456, so the bound is enforced three times and reported zero times. The same function is the paste (:7167-7169) and drop (:7171-7175) handler.

**Root cause:** `addComposerFiles` treats "not added because of the cap" as a non-event: only the MIME rejection is counted, and the success sentence is derived from the admitted count rather than from the requested count, so a fully-rejected add is phrased as a success.

**Smallest fix:** In src/ui/app.tsx:3449-3451 add `const overflow = images.length - Math.min(images.length, remaining);`, fold it into the notice (`${rejected} non-image ... ; ${overflow} beyond the ${COMPOSER_ATTACHMENT_LIMIT}-attachment limit were not added`), and guard the success sentence with `next.length > 0`. Import `COMPOSER_ATTACHMENT_LIMIT` from ./chat/composer-state instead of the literal `8` at :3450 and :3456.

**Acceptance:** Adding 4 images when 6 are already pending sets a notice naming both the limit and the 2 files not added; adding any image when 8 are pending never produces a notice containing "0 image" or the word "ready"; the pending count never exceeds COMPOSER_ATTACHMENT_LIMIT.

### 56. [medium] Chat and Connection use different model controls with different capability vocabularies

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/model-control.tsx, src/ui/model-picker.tsx, src/ui/chat/session-bar.tsx, src/ui/model-picker.test.ts  
- **Regression risk:** medium

**Why (reviewer):** Connection renders the rich picker: `<ModelPicker value={modelId} models={candidate.models} onSelect={setModelId} disabled={busy} attachFacts ...>` (src/ui/access-view.tsx:929-936), which has search (model-picker.tsx:227), five facets with counts (:228-240), six sorts (:31-38, :243), paging at PAGE_SIZE 30 (:25, :185, :285), logo/price/context/availability/trust-readiness per row (:246-281) and the provenance caveat (:286). Chat renders `<ModelControl ...>` (src/ui/app.tsx:6943-6976) whose model list is only `sortModels(availableModels, "popularity").map(...{ id, label: compactModelLabel(model.id), detail: compactModelCapabilityDetail(model) })` (:6962-6966); `compactModelCapabilityDetail` (src/ui/app.tsx:8420-8431) emits only Vision, Tools, req/h or invocations, and % load - no confidential-compute, availability, context, price or trust readiness. `ModelControl` is a bare `MenuSelect` (src/ui/model-control.tsx:63-68); `MenuSelect` has no search field and no typeahead at all (src/ui/menu-select.tsx:113-152 handles only Arrow/Home/End/Enter/Escape/Tab), and its desktop popover is capped `max-width:min(340px,...)` / `max-height:min(420px,70dvh,...)` (src/ui/menu-select.css:9-10). The cloud/local fabric is a third control with a third vocabulary: `<MenuSelect ariaLabel={`${entry.provider.label} model for a new pinned conversation`} ... description: modelOptionDescription(model)}` (src/ui/provider-connections-view.tsx:297-311), where `modelOptionDescription` yields `${evidence} · ${availability} · ${capabilities}` (:473-485). There is even a fourth, `ProviderModelControl` (src/ui/provider-model-control.tsx:28), which no production module imports (only src/ui/provider-fabric-panel.test.ts:16). I downgrade severity to medium: the Chat menu does work and is keyboard-navigable, and the mobile bottom-sheet rule (src/ui/menu-select.css:47) applies; what is missing is search/facets/sort over a 40-model catalog and one shared vocabulary. Register: CMP-04 is PARTIAL and retained (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:92, :276-280).

**Root cause:** Chat never receives model objects rich enough for the shared picker: `ModelControl` accepts a flattened `{id,label,detail}` projection while `ModelPicker` takes `AirshipModel[]`, so the two surfaces each grew their own capability formatter (`compactModelCapabilityDetail` vs `capabilityLabels`/`catalogTokens`/`modelFacts`).

**Smallest fix:** For the Chutes route, render `<ModelPicker models={availableModels} value={connection.model} onSelect={(id) => void switchChutesModel(id)} disabled={busy || modelSwitching} />` inside the Chat session-bar slot instead of `ModelControl` (App already holds `availableModels: AirshipModel[]`), keeping `ModelControl` only for external-provider routes that have no `AirshipModel`; and export `capabilityLabels`/`catalogTokens` from src/ui/model-picker.tsx as the single vocabulary the external-provider path formats with, deleting `compactModelCapabilityDetail`.

**Acceptance:** Opening the Chat model control on a Chutes connection exposes a search input, the same five facet chips with counts, and the same six sort options as the Connection picker, and typing a substring narrows the list. Every capability token rendered in Chat is drawn from the same function as Connection (one vocabulary; a test asserts no second formatter exists). Choosing a model still starts a new pinned conversation via `switchChutesModel`. `ProviderModelControl` is either wired in or removed so no unreferenced fourth control remains.

### 57. [medium] Skills are invisible to the slash registry: no skill can be discovered or listed from the composer

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/commands/types.ts, src/commands/registry.ts, src/ui/app.tsx, src/commands/commands.test.ts  
- **Regression risk:** medium

**Why (reviewer):** Every production construction is `createSlashCommandRegistry({ tools })` — src/ui/app.tsx:2576, :3079, :4637, :4742, :4879 — and the registry body iterates only `options.tools.definitions()` (src/commands/registry.ts:87). `SlashCommandCategory` is `"tool" | "session" | "model" | "system"` (src/commands/types.ts:3), `source` admits only `{kind:"tool"}` / `{kind:"builtin"}` (src/commands/types.ts:35-37), and `registerBuiltins` registers help/sessions/models only (src/commands/registry.ts:130-166) — no `/skills`. The palette reuses the same descriptors (src/ui/app.tsx:1421). I am downgrading severity from the scout's `high`: skills are ambient prompt modules composed into the pinned system prompt (src/profiles/domain.ts:332-364), so nothing is broken at runtime and no surface claims slash invocation — src/ui/capabilities-view.tsx:81 explicitly separates 'tool schemas and Skills'. The defect is discoverability, not a broken capability.

**Root cause:** `SlashRegistryOptions` exposes one channel (the tool registry). Skills are prompt-composition artifacts with no descriptor, category, or invocation type, so they cannot enter the registry that both the composer completion and the command palette read.

**Smallest fix:** Add a `system`-category builtin `/skills` in `registerBuiltins` (src/commands/registry.ts) plus a `SlashBuiltinAction` variant `{ type: "skills.list" }` in src/commands/types.ts, and handle it in the app's builtin dispatcher by printing the *pinned* set from the active session manifest (`manifest.profile.resolvedSkills` / `skillSetDigest`, already carried at src/ui/app.tsx:7673-7674) with each skill's name, source (global vs profile override) and short digest. No new registry channel is required for listing; full per-skill invocation is the larger CAP-03 build.

**Acceptance:** src/commands/commands.test.ts: `registry.resolve("skills")` is defined with `category === "system"` and `source.kind === "builtin"`; `registry.parse("skills", [])` yields `{ kind: "builtin", action: { type: "skills.list" } }`; `/help` output includes the command. UI-level: the rendered listing names each resolved skill and its source, and its digest matches `manifest.profile.skillSetDigest` of the open conversation, not the current catalog.

### 58. [medium] Stop does not stop the conversation: the next queued message dispatches immediately

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** medium

**Why (reviewer):** `src/ui/app.tsx:4025-4028` — `function stopTurn() { if (activePrompt.current) setInput(activePrompt.current); activeTurn.current?.abort(new DOMException("Stopped by user", "AbortError")); }` — touches nothing but the controller and the composer. The finally at `:4005-4015` clears `activeTurn.current = undefined` and calls `release: () => { if (releasesComposer) setBusy(false); }` on the cancellation path exactly as on success. The dispatch effect at `:1728-1745` guards only on `!sessionId || busy || queuedDispatch.current || messageQueue.length === 0 || inferenceRouteChanging.current || sessionNavigationChanging.current` and is keyed `[busy, messageQueue, sessionId]`, so it re-fires on the busy transition and calls `sendMessage(next.prompt, next.attachments, ...)`. `sendMessage`'s own admission guard (`:3631-3642`) checks `busy || activeTurn.current`, both already cleared. And because the queued dispatch passes `retryPrompt`, `:3847-3851` — `if (retryPrompt === undefined) { setInput(""); ... }` — leaves the just-restored stopped prompt sitting in the composer while a different prompt runs. I found no stop flag anywhere: `stopTurn` is referenced only at `:7244`.

**Root cause:** `busy` is the only signal the queue-dispatch effect consumes, and the turn teardown collapses 'the turn finished' and 'the user stopped the turn' into the same `setBusy(false)`. There is no user-stop latch that the queue effect can observe.

**Smallest fix:** Add a `stopRequested` ref/state set by `stopTurn` and cleared by any explicit send (composer submit, `sendQueuedMessageNow`, `editQueuedMessage`). Add `|| stopRequested` to the guard in the effect at `src/ui/app.tsx:1729-1737`, and surface the paused state in the existing queue chip at `:7130-7136` so the user can resume.

**Acceptance:** With one turn in flight and two items in `messageQueue`, invoking `stopTurn()` leaves `messageQueue.length === 2` and issues no new `runTurn` after `busy` goes false; the composer still holds the stopped prompt; the queue chip reports the queue as paused; and an explicit user send afterwards resumes normal automatic dispatch.

### 59. [medium] The catalog-enrichment retry button is gated on an unreachable state, so a failed management read has no recovery

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/ui/access-view.tsx, src/ui/access-view.copy.test.ts  
- **Regression risk:** low

**Why (reviewer):** The button is gated on `candidate.managementState === "disabled"` (src/ui/access-view.tsx:910) and `enrichCatalog()` (:562-604) has no other caller - I grepped `enrichCatalog` across src and e2e and the only hits are the definition, that onClick, and a source-slicing index in src/ui/connection-continuity.test.ts:8. `sources.management` is `"disabled"` only when `includeManagement` is false: `management: !this.options.includeManagement ? "disabled" : managementResult && "issue" in managementResult ? "failed" : "fresh"` (src/models/client-runtime.ts:287-291). Both production constructions pass `includeManagement: true` (src/ui/access-view.tsx:388, :572) and the option itself defaults to true (src/models/client-runtime.ts:621), so `"disabled"` is unreachable in the app and the control is dead code. The consequence the scout describes is also real: without the management catalog `chute` is undefined, so `const availability: ModelAvailability = chute?.hot === true ? "hot" : chute?.hot === false ? "cold" : "unknown"` (src/models/parser.ts:307-308) collapses every model to `unknown` and `provenance.availability` becomes `"unavailable"` (:351), which the picker renders as the Hot facet counting 0 (model-picker.tsx:300, :311-319) and Availability "unknown" with the caption "live status unavailable" (:74-77).

**Root cause:** The retry gate tests the wrong member of the `ModelSourceState` union - it names the never-attempted state (`disabled`) instead of the state that a retry is for (`failed`).

**Smallest fix:** Change the gate at src/ui/access-view.tsx:910 to `candidate.managementState !== "fresh"` (which covers both `failed` and any future `disabled` build), leaving `enrichCatalog()` untouched; the surrounding provenance line at :909 already distinguishes fresh vs partial.

**Acceptance:** A candidate whose snapshot has `sources.management === "failed"` renders the "Load live availability metadata" control (enabled when online and not busy); a candidate with `"fresh"` does not. Pressing it re-loads and, on success, flips `managementState` to `"fresh"`, hides the control, and the picker's Hot facet count becomes non-zero for a hot model. On a second failure the panel keeps the prior model list and shows the mapped failure sentence rather than emptying the candidate.

### 60. [medium] The composer's credential-posture chip and Enter-contract legend are built, styled and unit-tested but never rendered

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, e2e/composer-layout.spec.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/chat/composer.tsx exports `composerPosture` (:141), `ComposerPostureChip` (:157), `composerKeyhints` (:194), `ComposerKeyhintLegend` (:201) and `SLASH_MENU_HEADER` (:37). src/ui/app.tsx:209-214 imports only `composerGrowthCap`, `composerPlaceholder`, `COMPOSER_NARROW_PLACEHOLDER_QUERY`, `COMPOSER_PLACEHOLDER_TITLE`. A repo-wide grep for `composerPosture|ComposerPostureChip|ComposerKeyhintLegend|composerKeyhints|SLASH_MENU_HEADER|useNarrowComposer` outside composer.tsx returns hits only in src/ui/chat/composer.test.ts. The class names `composer-posture*`, `composer-keyhint*` and `composer-primary-cluster` appear only in src/ui/chat.css:1258-1335, src/ui/chat.css:1373, src/ui/routes.css:2824-2833 and in composer.tsx itself — never in any .tsx that app.tsx mounts. app.tsx:7223-7227 renders the posture as the bare caption `<span><Icon name="lock" .../> {inferenceConnected ? ... : "local demo · page memory"}</span>` instead, so the full sentences at composer.tsx:110-129 (including "The provider credential is held in this tab's page memory only...") are unreachable, and the Enter/Shift+Enter/Enter-queues contract implemented at app.tsx:7201-7216 is stated nowhere. The CSS comment at routes.css:2812-2815 even describes the chip as shipped. One thing the scout missed: e2e/composer-layout.spec.ts asserts `.composer-tools > span` is visible as "credential posture", so that test pins the caption the chip would replace and must move with the fix.

**Root cause:** The composer decomposition landed as a module plus CSS plus tests but the call site in app.tsx was never switched over, so the module is a parallel implementation with green tests and no mount point.

**Smallest fix:** Replace the caption at src/ui/app.tsx:7223-7227 with `<ComposerPostureChip claim={composerPosture({ online, offlineReason: OFFLINE_INLINE_REASON, inferenceConnected, authMethod: activeInferenceBinding?.authMethod })} />` and add `<ComposerKeyhintLegend busy={busy} />` to the `.composer-footer`, extending the import at :209-214. Update the `.composer-tools > span` assertions in e2e/composer-layout.spec.ts to target `.composer-posture`. If the chip is not wanted, delete composer.tsx:37, :92-213, the CSS at chat.css:1258-1335/routes.css:2824-2833 and the corresponding tests.

**Acceptance:** A composer test asserts that `.composer-posture` is present and its accessible name contains the posture sentence for each of the four `ComposerPostureKind` values, and that the phone breakpoint gives it `min-height >= 44`; `rg 'ComposerPostureChip|ComposerKeyhintLegend' src --glob '!*composer.tsx'` returns at least one non-test hit.

### 61. [medium] The composer's scroll-fade selectors can never match, so a scrolled draft still renders a half-sliced top line

- **Cluster:** composer-models  
- **Verdict:** confirmed  
- **Files:** src/ui/chat.css, e2e/composer-layout.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:1496-1503 writes `inputRow.dataset.scrolled` where `inputRow` is the `.composer-input-row`. src/ui/chat.css:1218-1229 declares all four mask rules as `.composer-input-row[data-scrolled="…"] .composer textarea`, i.e. requiring a `.composer` descendant of `.composer-input-row`. The real nesting is the inverse: `<div class={`composer${busy ? " busy" : ""}`}>` at src/ui/app.tsx:7106 contains `<div class="composer-input-row">` at :7152 which contains the `<textarea>` at :7153. `.composer` never appears inside `.composer-input-row`, so all three mask-image declarations are dead. src/ui/app.tsx:1491 sets `element.style.overflowY = natural > maximum ? "auto" : "hidden"`, so the scroll state the rules were written for does occur. The rule's own comment (chat.css:1215-1217) calls the unfaded slice "the single most confusing pixel in the surface".

**Root cause:** The selector encodes the wrong ancestor relationship — `.composer` is the outer element, not an inner one — and no test asserts the computed `mask-image`, so the dead rule is invisible to the suite.

**Smallest fix:** In src/ui/chat.css:1218-1229 drop the `.composer` step from all four selectors: `.composer-input-row[data-scrolled="top"] textarea`, `[data-scrolled="both"] textarea`, `[data-scrolled="bottom"] textarea`.

**Acceptance:** After filling the textarea past the growth cap and setting `scrollTop > 0`, `.composer-input-row` carries `data-scrolled` and `getComputedStyle(textarea).maskImage` is not `none`; clearing the draft removes both.

### 62. [medium] The model-sort dropdown can be clipped by the picker popover's own overflow:hidden

- **Cluster:** composer-models  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/model-picker.css, src/ui/model-picker.test.ts  
- **Regression risk:** low

**Why (reviewer):** The CSS mechanism is exactly as described and I confirmed every cited line: the sort control is `<MenuSelect ariaLabel="Sort models" placement="down" ...>` (src/ui/model-picker.tsx:243) inside `.model-picker-status` inside `.model-picker-header` (:219-245), the header sits inside `.model-picker-popover`, and `.model-picker[data-open="true"] .model-picker-popover { overflow:hidden; }` (src/ui/model-picker.css:35). `.menu-select-popover` is `position:absolute` with `.menu-select { position:relative }` as its containing block (src/ui/menu-select.css:1, :9-10), so the whole sort list is inside the clip region, and nothing overrides it - I grepped every `.menu-select-popover` rule (chat.css:1522, platform-shell.css:110/194, vault-view.css:174, provider-fabric-panel.css:417, routes.css:2867) and none targets the picker. `fitBelow()` measures against the visual viewport, not the clipping ancestor (src/ui/menu-select.tsx:81-87), so the menu cannot self-limit to the clip box. What I could NOT confirm is the scout's implied universality: `.model-picker-popover` has `max-height:min(650px,70dvh)` and no min-height (model-picker.css:34), and with a full catalog on a normal desktop viewport the popover is ~600px while the ~290px sort list starting ~150px below the popover top ends around 440px - inside the clip box. The defect is real but conditional on a SHORT popover: a search/facet that leaves only a few rows, or the `@media (min-width:900px)` in-flow variant `max-height:min(520px,60dvh)` (src/ui/access-view.css:439-445, which indeed does not override `overflow`) on a shorter window. The ≤640px sheet escape is genuine (menu-select.css:47, model-picker.css:82-84). Register: CMP-07 is REPORTED and retained (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:95).

**Root cause:** The popover uses `overflow:hidden` on the outer flex container for corner clipping even though only `.model-picker-list` needs to scroll, which turns the popover into a clip ancestor for an absolutely positioned child menu whose height logic only knows about the viewport.

**Smallest fix:** Move the clipping off the outer box: drop `.model-picker[data-open="true"] .model-picker-popover { overflow:hidden; }` (set `overflow:visible`) and give `.model-picker-list` the bottom corner radius it needs (it already has `overflow:auto`, src/ui/model-picker.css:47), so the sort listbox can overlay outside the popover; the footer already paints an opaque `--surface-raised` background so nothing bleeds past the rounded edge.

**Acceptance:** With the picker open at a desktop width and a query that leaves 2-3 results (short popover), the opened Sort listbox's bounding rect is fully inside the viewport and no option's rect is outside the picker popover's rect while remaining hidden - every one of the six sort options is hit-testable at its own centre. Repeat at ≥900px inside the Connection candidate panel where the popover is `position:static`. The ≤640px sheet behaviour is unchanged.

### 63. [medium] "Charged this UTC month" sums a single unpaginated usage page and cannot detect truncation

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/billing/client.ts, src/billing/honesty.ts, src/ui/billing-view.tsx, src/billing/client.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/billing/client.ts:134-138 builds exactly one usage request — `usageUrl.searchParams.set("page", "0"); usageUrl.searchParams.set("limit", String(USAGE_PAGE_LIMIT));` with `USAGE_PAGE_LIMIT = 1_000` at :10 — issued once inside the four-way `Promise.all` at :138-152 with no follow-up. `normalizeUsage` (:331-359) reads only `firstPresent(record, ["items", "entries", "data"])` and never inspects a total/page/has_more field; its only guard is `if (items.length > USAGE_PAGE_LIMIT) throw` at :337-339, so exactly 1,000 rows is accepted as a complete range. The sum is then presented as money: `label="Charged this UTC month"` (src/ui/billing-view.tsx:335-340) with caption `${formatCompact(usageState.value.totalRequests)} charged requests in this range`, and src/billing/honesty.ts:60-68 marks it `status: "verified"` with "Usage totals were computed from the records returned for the requested UTC range." The bounded-read grammar already exists at billing-view.tsx:440 ("Showing the N most recent of M buckets"). Impact needs a month exceeding 1,000 rows (entries are per-bucket, per-`chuteId`), so it is real but bounded.

**Root cause:** The client treats one page as the range. `page`/`limit` are sent but there is no paging loop and no saturation check, and `normalizeUsage` discards any paging metadata — so 'the records returned' and 'the records in the range' are conflated exactly where the value is promoted to `verified`.

**Smallest fix:** Detect saturation without adding a paging loop: in `normalizeUsage`, when `items.length === USAGE_PAGE_LIMIT`, carry a `truncated: true` flag on `ChutesUsageSummary`; have `usageDatum` in src/billing/honesty.ts name the bound in its detail, and have billing-view.tsx suffix the "Charged this UTC month"/"Tokens this UTC month" captions with the same bounded-read sentence the ledger footer uses. Paging to completion is the fuller fix; the flag is the smallest one that stops the figure claiming completeness.

**Acceptance:** 1) A usage response containing exactly 1,000 entries produces a summary marked truncated, and the "Charged this UTC month" caption states the total is a bounded partial read. 2) A response with fewer than 1,000 entries is unmarked and its caption is unchanged. 3) `totalCost`/`totalRequests` arithmetic is unchanged in both cases. 4) More than 1,000 entries still raises `invalid-payload`.

### 64. [medium] A rejected credential still reads "Connected · Verified" on Account; a total read failure is called "Partial"

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/ui/billing-view.tsx, src/ui/billing-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** The header chip is `trigger={<Seal state={observed?.stale ? "stale" : "verified"} density="chip" label={observed?.stale ? "Stale reading" : "Connected"} />}` at src/ui/billing-view.tsx:224, with `observed = snapshot ? observationState(snapshot.fetchedAt, 5 * 60_000) : undefined` at :196 — and src/ui/request-state.ts:61-66 derives `stale` purely from `now - Date.parse(observedAt)`, labelling anything recent "Verified · <time>". `fetchedAt` is stamped unconditionally at src/billing/client.ts:126/181 regardless of which sources failed, and the popover body asserts "User-scoped credential connected" at billing-view.tsx:227. `snapshot.complete` is computed at src/billing/client.ts:198 (`complete: issues.length === 0`) and I grepped the view: it is never read. The banner at billing-view.tsx:301-306 is `role="status"` with `<strong>Partial account snapshot</strong>` for any non-empty `issues`, including all four. `issue.status` is captured in `httpIssue` (src/billing/client.ts:542-552) and consulted nowhere in billing-view.tsx or src/billing/honesty.ts, so HTTP 401 and HTTP 503 read identically. No test in src/ or e2e/ asserts the string "Partial account snapshot", so the copy is not locked.

**Root cause:** Freshness is used as a proxy for acceptance. The header chip binds to snapshot age (`fetchedAt`), which the client stamps even when every source was refused, and the alert grammar has only one degraded rung ("Partial") with no state for 'zero sources succeeded' and no use of the `status` the client already parsed to separate an authorization refusal from a transient fault.

**Smallest fix:** In billing-view.tsx derive an acceptance state before the chip: treat all-four-issues (or `!snapshot.complete` with no source values present) as refused, and `issues.some((i) => i.status === 401 || i.status === 403)` as credential-rejected. When either holds, render `Seal state="none"` labelled "Credential not accepted" instead of "Connected", and switch the banner to `role="alert"` with `<strong>Account read refused</strong>` plus the existing `onOpenAccess` control. Keep "Partial account snapshot" only when at least one source returned a value.

**Acceptance:** 1) A snapshot whose four sources all return HTTP 401 renders no "Connected"/"Verified" seal and does not render "Partial account snapshot"; it names the credential as not accepted and exposes the Connection action. 2) A snapshot with one failed and three successful sources still renders "Partial account snapshot" and keeps the connected chip. 3) A 503 on one source is not described as a credential problem. 4) The chip's stale/verified split stays age-driven when at least one source succeeded.

### 65. [medium] Account usage ledger deletes its per-day Tokens column on phone with no disclosure

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/ui/routes.css, src/ui/billing-view.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/routes.css:2999-3008, inside the mobile-shell block (`@media (max-width: 640px), (max-width: 950px) and (max-height: 500px)` at :2376), narrows the ledger to three tracks and then sets `.usage-ledger-head span:nth-child(3), .usage-ledger-row span:nth-child(3) { display: none; }`. The third cell is the per-bucket token total: header `<span>Tokens</span>` at src/ui/billing-view.tsx:423 and the value `<span>{formatCompact(entry.inputTokens + entry.outputTokens)}</span>` at :435. There is no phone alternative in the route — no horizontal scroll on `.usage-ledger`, no expand, no per-row disclosure; the only surviving token fact is the month-wide `Tokens this UTC month` metric at :341-344. So the per-day breakdown, which is the ledger's reason to exist, has no phone path. I discount one sub-claim: the spans carry no `role="cell"`/`role="columnheader"` (billing-view.tsx:422-436 declares only `role="table"`/`role="row"`), so the column was never a proper accessible cell to begin with — the loss is a data loss, not specifically an ARIA regression.

**Root cause:** The narrow layout was resolved by deleting a column instead of restacking it; the row is a fixed grid with one span per fact, so the only lever the stylesheet had at 390px was `display: none`.

**Smallest fix:** Replace the `display: none` at routes.css:3005-3008 with a stacked cell: keep the four-value row but let the Tokens span move to its own sub-line — `.usage-ledger-row span:nth-child(3) { grid-column: 1 / -1; font-size: var(--fs-micro); color: var(--ink-muted); }` with a `Tokens ` prefix (or a `::before`), mirroring the stacking pattern already used at src/ui/vault-view.css:507-527. While there, add `role="columnheader"`/`role="cell"` to the spans in billing-view.tsx:423-436 so the declared `role="table"` is actually populated.

**Acceptance:** E2E at 390x844 on #billing with seeded usage: for each of the ten rendered ledger rows the token total is present in the accessibility tree and has a non-zero bounding box; `.usage-ledger` reports no horizontal overflow; the desktop four-column layout at >=1024px is unchanged.

### 66. [medium] Chutes sign-out never revokes the OAuth grant at the IdP; `revokeChutesToken` and the whole `ChutesCredentialBroker` are unreachable from production

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/auth/chutes-credential-broker.ts, src/ui/connectivity-ui.test.ts  
- **Regression risk:** low

**Why (reviewer):** `rg -n "revokeChutesToken" src/ e2e/` returns only its definition (src/auth/chutes-oauth.ts:257), its own test, and `ChutesCredentialBroker` (src/auth/chutes-credential-broker.ts:4, 83, 130, 147, and the call at :230). `rg -n "chutes-credential-broker|ChutesCredentialBroker" src/ e2e/ scripts/ -g '!src/auth/chutes-credential-broker*'` returns nothing at all — the broker is constructed only in its own test file. Production holds tokens in `oauthTokens.current` (src/ui/app.tsx:2780) and sign-out runs `disconnectChutes` -> `releaseChutesAuthority` (src/ui/app.tsx:6013-6019, :5977-6011), which clears refs and calls `releasedTransport?.revokeCredential(...)`; I read that method (src/inference/chutes/transport.ts:192-203) and it only aborts a controller and clears in-memory caches — no network call. So the doc comment at src/auth/chutes-oauth.ts:252-256 ("sign-out asks the published revocation endpoint to drop it too") describes behaviour that does not exist on any reachable path. Two calibrations against the scout: the user-facing copy does not over-claim — `clearConnection` says only "Clearing the active connection" (src/ui/access-view.tsx:616-619) — and ACC-01 is already registered as PARTIAL with "refresh/revocation ... journeys pass" in its acceptance column (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:163), so the directive is open, though this precise diagnosis (a fully written, fully tested, fully unreachable broker) is not recorded anywhere. Defence-in-depth gap plus a false in-code claim, not `high`.

**Root cause:** Two parallel credential lifecycles were built and only one was wired. `ChutesCredentialBroker` is the designed owner of token custody, rotation and RFC 7009 sign-out revocation; app.tsx grew its own inline ref-plus-refresh path instead and never adopted the broker, leaving revocation — and the retired-refresh-token replay defence at `#retiredRefreshTokenDigests` — attached to an object nothing constructs.

**Smallest fix:** Do not adopt the whole broker for this. In `releaseChutesAuthority` (src/ui/app.tsx:5977-6011), capture `oauthTokens.current` before clearing it and fire a detached best-effort `revokeChutesToken({ token: refreshToken, tokenTypeHint: "refresh_token", clientId, registration })` (then the access token), with `.catch(() => undefined)` — the function already reports transport failure as a result rather than throwing (src/auth/chutes-oauth.ts:254-256, and `ChutesTokenRevocationResult` at :242-246). Sign-out must not await or block on it, and per that same doc comment an `accepted` result must not be promoted to "the provider session is gone". Separately, either wire `ChutesCredentialBroker` or delete it; a fully tested module no production path can reach is a standing claim that revocation is handled.

**Acceptance:** Unit (a focused test around `releaseChutesAuthority`, or an extracted `releaseChutesCredential` helper): with an injected fetch/revoke double, disconnecting while an OAuth-derived `crt_` refresh token is held issues exactly one refresh-token revocation and one access-token revocation; a rejected or unreachable revocation still completes sign-out and still clears `oauthTokens.current`, `chutesTransport.current` and the connection state; disconnecting an API-key connection issues no revocation. Plus a static check that either `ChutesCredentialBroker` has a production import or the module is gone.

### 67. [medium] The Chutes sign-in notice is never cleared, so a connected user is told to "finish the connection"

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/access-view.tsx, src/ui/access-view.copy.test.ts  
- **Regression risk:** low

**Why (reviewer):** `setOauthCallbackStatus({ kind: "verified", message: ... "oauth:complete-local"/"oauth:complete-public" })` fires on a successful exchange (src/ui/app.tsx:2682-2687). I grepped every `setOauthCallbackStatus` call: 2459 (startOAuthSignIn), 2647/2663/2682/2692 (callback effect), 2785/2791 (refresh rotation), 6017 (disconnectChutes). The only two clears are 2459 and 6017; `connectChutes` (src/ui/app.tsx:5837-5975, ending `navigate("chat")` at :5973) never clears it, and the value lives in App state so it survives the AccessView unmount. AccessView renders it unconditionally above the three-way branch: `{oauthNotice ? <p class={`oauth-boundary-status ${oauthNotice.tone}`} ...>{oauthNoticeMessage}</p> : null}` at src/ui/access-view.tsx:831, immediately before `{isChutesConnected(connection) ? (` at :832 - and src/ui/access-view.copy.test.ts:201 asserts that exact ordering, so the fix must keep the position and change the lifetime. The message resolves to "Chutes sign-in complete with S256 PKCE. Choose a model, then finish the connection." (src/ui/access-view.tsx:1303-1305). Combined with claim 1's abandon path, the same sentence renders while no model chooser exists, because the candidate died with the unmount.

**Root cause:** `oauthCallbackStatus` models an in-flight exchange but has no terminal transition: commitment (`connectChutes`) and candidate discard are both states in which the message becomes false, and neither writes to it.

**Smallest fix:** Call `setOauthCallbackStatus(undefined)` in `connectChutes` at the point the connection is committed (next to `setConnection(connectionMetadata)`, src/ui/app.tsx:5971), and in AccessView suppress the completion tone when it cannot be true - render `oauthNotice` only when `!isChutesConnected(connection)` and, for the `oauth:complete-*` messages, only while `candidate` exists.

**Acceptance:** After a successful connect, returning to #connection renders the "Chutes connection / Connected" summary with no text containing "finish the connection". Navigating away from #connection with a live candidate and back renders neither the completion notice nor a model chooser-less "Choose a model" instruction. Error and in-flight tones still render above the branch (the existing ordering assertion in src/ui/access-view.copy.test.ts:201 stays green).

### 68. [medium] A theme's typography and layout can never take effect once the profile is active, so the preview shows a difference applying cannot produce

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/platform-shell.tsx, src/profiles/domain.ts, src/profiles/catalog.ts, src/ui/profile-theme-swatch.tsx, src/ui/tokens.css  
- **Regression risk:** medium

**Why (reviewer):** src/ui/app.tsx:2629-2632 applies the theme and then `applyPreferenceOverrides(preferences)` in the same synchronous effect body; the latter (src/ui/platform-shell.tsx:368-372) rewrites all five attributes `applyTheme` just set (src/ui/app.tsx:8257-8261). So `ThemeManifest.typography` and `.layout`, declared as part of the contract at src/profiles/domain.ts:82-89, are dead for any active profile. Blue Ledger is the only built-in that differs (`scale: "compact"`, `density: "compact"`, `corners: "square"` at src/profiles/catalog.ts:229-230) and those differences render only during preview. The two vocabularies are real: `ThemeTypeScale = "compact" | "standard" | "large"` (src/profiles/domain.ts:37) vs `typeScale: "default" | "large" | "x-large"` (src/ui/platform-shell.tsx:221), and src/ui/tokens.css:248-258 defines only large/x-large/compact, so both "standard" and "default" fall through to `--type-scale: 1`. The swatch is colours only — src/ui/profile-theme-swatch.tsx:4 builds six chips from ground/surface/ink/accent plus two verdict vars — and the editor at src/ui/app.tsx:9140-9198 exposes Name, Role, System instructions, Interface theme and Profile boundaries with no typography/density/corners/body-font/tool-step field, which is what PPF-02's acceptance gate asks for (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:51). The register line for PPF-02 says theme typography/layout are 'applied at src/ui/app.tsx' — that is the contradiction.

**Root cause:** The theme manifest declares four presentation fields the render pipeline unconditionally discards, because the preference layer is applied last and writes all five attributes unconditionally rather than only the ones the user has actually set away from default. On top of that, the theme and preference type-scale enums are different vocabularies sharing one DOM attribute, so 'standard' silently means nothing.

**Smallest fix:** Make the preference layer an override only where the user chose one, and unify the vocabulary. In `applyPreferenceOverrides`, take the theme-derived values as the base and write a preference attribute only when it differs from that layer's default (i.e. skip `typeScale` when it is 'default', skip density/corners/bodyFont when they equal the theme's) — or, if the product decision is that preferences always win, delete `typography`/`layout` from ThemeManifest (src/profiles/domain.ts:82-89) and from the three drafts in src/profiles/catalog.ts and stop writing them in `applyTheme`. Either way, rename `ThemeTypeScale`'s 'standard' to 'default' so one attribute has one vocabulary, and add the applied typography/density to `ProfileThemeSwatch`'s label so the preview names what activation produces.

**Acceptance:** A unit test that applies the blue-ledger theme followed by default preferences and asserts the resulting `<html>` dataset is the SAME as what the theme library preview produced for that theme (or, under the delete-fields variant, that ThemeManifest has no typography/layout keys and `applyTheme` writes no data-density/data-corners/data-type-scale/data-body-font). Plus: every value that can appear in `data-type-scale` from either writer resolves to a `--type-scale` block that exists in tokens.css.

### 69. [medium] Light-mode users get a full-screen dark boot flash; the boot screen renders off the density/type ramp

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/main.tsx, index.html, src/ui/platform-shell.test.ts  
- **Regression risk:** low

**Why (reviewer):** `applyPreferenceOverrides` is the only writer of `data-mode`/`data-type-scale`/`data-density`/`data-corners`/`data-body-font`/`style.colorScheme` (src/ui/platform-shell.tsx:367-377), and a repo-wide grep shows exactly one production call site: src/ui/app.tsx:2632, inside `useEffect(() => { if (!activeTheme) return; ... }, [activeTheme, preferences])` (app.tsx:2627-2634). `activeTheme` derives from `activeProfile` (app.tsx:1325), which only exists after the async boot at app.tsx:2516-2612 (built-in catalog, `loadBrowserGit()`, fabric import, three workspace writes, `WorkspaceGitAdapter.open`, tool registry, commands import). Until then app.tsx:6711 renders `<BootScreen>`, whose CSS is `color: var(--ink); background: var(--ground)` (src/ui/routes.css:645-653) with `--ground` resolving to the dark `:root` default because `:root[data-mode="light"]` (src/ui/platform-shell.css:157-169) is attribute-gated. src/main.tsx applies nothing before `render`. index.html:6-7 hard-codes `theme-color: #101417` and `color-scheme: dark`. The preference is available synchronously at first render via `useState(loadPreferenceOverrides)` (app.tsx:930, platform-shell.tsx:332-339). Density root font-size (15px/17px, src/ui/tokens.css:259-275) is likewise unset during boot, so the boot screen types at the browser's 16px.

**Root cause:** Presentation preferences are applied through the profile-theme effect rather than as their own layer. Coupling a synchronous localStorage value to the end of a multi-await runtime boot means the document has no mode/density attributes during the entire boot window.

**Smallest fix:** Split the two concerns: keep `applyTheme(activeTheme)` gated on `activeTheme`, and add an ungated `useEffect(() => { applyPreferenceOverrides(preferences); savePreferenceOverrides(preferences); }, [preferences])` (or call `applyPreferenceOverrides(loadPreferenceOverrides())` in src/main.tsx before `render`). Drive `theme-color`/`color-scheme` from the same call instead of the hard-coded meta tags in index.html.

**Acceptance:** With `localStorage['airship.display-preferences.v1']` set to `{mode:"light", density:"compact"}`, `document.documentElement.dataset.mode === "light"` and `dataset.density === "compact"` on the frame that renders `BootScreen` (i.e. before `catalog`/`activeTheme` resolve), and the computed background of `.boot-screen` is the light `--ground`; a profile theme applied later still wins over nothing except the preference layer, which remains last.

### 70. [medium] Session bar transposes its safe-area insets on phone

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/routes.css  
- **Regression risk:** low

**Why (reviewer):** src/ui/routes.css:2670 (inside the mobile-shell block opened at :2376) is `padding: var(--sp-1) max(var(--sp-3), env(safe-area-inset-left)) var(--sp-1) max(var(--sp-3), env(safe-area-inset-right));`. In the four-value shorthand the order is top/right/bottom/left, so the right edge is padded by `inset-left` and the left edge by `inset-right`. Every neighbouring rule gets the order right: `.transcript` at :2735-2740 uses `max(11px, env(safe-area-inset-right))` then `max(11px, env(safe-area-inset-left))`, `.composer-wrap` at :2786-2792 likewise, and the landscape override of this very selector at :3222-3225 is correct. `index.html:5` sets `viewport-fit=cover`, so non-zero insets do reach CSS. The landscape block that corrects it is gated `@media (min-width: 641px) and (max-width: 950px) and (max-height: 500px)` (:3202), so a <=640px-wide landscape phone (e.g. 568x320) hits the transposed rule with real asymmetric insets, as does any Android portrait display cutout on a side edge.

**Root cause:** A physical-side shorthand was hand-ordered and the two `env()` terms were swapped; nothing in the build or tests reads padding against the inset side, so the transposition is invisible on any device that reports symmetric (usually zero) horizontal insets.

**Smallest fix:** Swap the two `env()` terms at routes.css:2670 so it reads `padding: var(--sp-1) max(var(--sp-3), env(safe-area-inset-right)) var(--sp-1) max(var(--sp-3), env(safe-area-inset-left));` — or, matching platform-shell.css:186, express it as `padding-inline-start: max(var(--sp-3), env(safe-area-inset-left)); padding-inline-end: max(var(--sp-3), env(safe-area-inset-right));`.

**Acceptance:** E2E with an injected inset (e.g. a test-only `:root { --test-inset-right: 44px }` shim or a device descriptor with a cutout): `.session-bar` computed `padding-right` >= the reported `env(safe-area-inset-right)` and `padding-left` >= `env(safe-area-inset-left)`, and the left edge of the first chip and the right edge of the last chip both sit inside the safe area. A grep/lint assertion that no rule pairs `padding-right` with `inset-left`.

### 71. [medium] Soft-keyboard avoidance is inert: `bottom` is applied to a statically positioned composer, and the hidden nav still occupies its 56px grid track

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/routes.css, src/ui/platform-shell.css, e2e/responsive-breakpoints.spec.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/platform-shell.tsx:637-648 measures `obscured = innerHeight - viewport.height - viewport.offsetTop`, writes `--visual-viewport-bottom` and sets `root.dataset.keyboardOpen`. The consumer is src/ui/platform-shell.css:183 `:root[data-keyboard-open="true"] .composer-wrap { bottom: var(--visual-viewport-bottom, 0); }`. I enumerated every `.composer-wrap` rule in the barrel — src/ui/chat.css:1086 (padding/border-top/background/backdrop-filter), src/ui/tokens.css:307 (padding-block), src/ui/routes.css:2786, :3011, :3273 (padding, then backdrop/background only), :3255 (padding) — none declares `position`, so the box is static and `bottom` is ignored per CSS positioning. The companion rule at platform-shell.css:182 hides `.fixed-mobile-nav` with `visibility: hidden`, and that element (src/ui/mobile-navigation.tsx:108 `class="mobile-nav fixed-mobile-nav"`) is grid row 3 (routes.css:2459) of a fixed track `calc(56px + env(safe-area-inset-bottom))` (routes.css:2385-2388), which `visibility` cannot collapse. Nothing tests this: the only keyboard-adjacent test is a pure arithmetic one (src/ui/chat/composer.test.ts:33-39 on `composerGrowthCap`), and headless Chromium never raises a soft keyboard, so `data-keyboard-open` stays "false" in e2e.

**Root cause:** The offset was written as an inset without the positioning scheme that gives insets meaning; `.composer-wrap` is a normal-flow child. And the nav was suppressed with `visibility` while its space is owned by an explicit `grid-template-rows` track on `.app-shell`, so suppressing the element cannot reclaim the band.

**Smallest fix:** In the mobile-shell block (routes.css:2376+) add `.composer-wrap { position: relative; }` so the existing `bottom` offset in platform-shell.css:183 takes effect, and add `:root[data-keyboard-open="true"] .app-shell { grid-template-rows: calc(52px + env(safe-area-inset-top)) minmax(0, 1fr) 0; }` so the withdrawn nav's track collapses instead of leaving a 56px dead band under the lifted composer.

**Acceptance:** E2E (mobile project, 390x844, #chat) with the visual viewport simulated by setting `document.documentElement.dataset.keyboardOpen = "true"` and `--visual-viewport-bottom: 300px`: the composer's `getBoundingClientRect().bottom` is within 1px of `innerHeight - 300`, the `.mobile-nav` track measures 0 height, and no gap larger than 1px exists between the composer bottom and the simulated keyboard top. With `data-keyboard-open="false"` the resting geometry is byte-identical to today's.

### 72. [medium] The answer/narration typographic hierarchy never renders: .markdown overrides both rules

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/chat.css, src/ui/chat/streaming-slot.tsx  
- **Regression risk:** low

**Why (reviewer):** `src/ui/chat/message-parts-view.tsx:534` — `return <div class={answer ? "message-part text text--answer" : "message-part text"}><MarkdownView source={part.content} /></div>;` — and `src/ui/chat/markdown.tsx:125-129` roots the view at `<div class={`markdown ...`}>`. `src/ui/chat/message-parts-view.css:1` sets `color: var(--ink)` and the `font:` shorthand (which resets font-size to `var(--fs-body)`) directly on `.markdown`. A direct declaration on the child always beats an inherited value regardless of specificity, so `.message-parts .message-part.text { color: var(--ink-muted); font-size: var(--fs-meta); }` (`src/ui/chat.css:767-773`) and `.message-parts .message-part.text--answer { color: var(--ink); font-size: var(--fs-body); }` (`:776-779`) never reach the rendered prose. I grepped every `.markdown` selector across `src/ui/*.css` and `src/ui/chat/*.css`: nothing sets `color: inherit` or `font-size: inherit`, and no descendant selector re-scopes it under `.message-part.text`. Both variants therefore render `--ink` at `--fs-body`, making `answerPartId` (`message-parts-view.tsx:520-524`) visually inert.

**Root cause:** The narration/answer distinction is expressed as inheritable properties on the wrapper, while the only element that actually carries text re-declares those same properties on itself.

**Smallest fix:** Add `.message-parts .message-part.text > .markdown { color: inherit; font-size: inherit; line-height: inherit; }` in `src/ui/chat.css` (after the two existing rules) so the wrapper's intent reaches the prose. `MarkdownView`/`IncrementalMarkdownView` are used only inside chat message parts, so the blast radius is the transcript. Note one required companion change: `src/ui/chat/streaming-slot.tsx:64` renders `class="message-part text streaming"` without `text--answer` (unlike `message-parts-view.tsx:34`), so the live streaming answer would drop to narration weight unless it also gets `text--answer`.

**Acceptance:** Computed style of the rendered prose inside an interstitial text part is `--ink-muted` at `--fs-meta`; the same query on the answer part is `--ink` at `--fs-body`; the two differ. The streaming slot's prose matches the answer, not the narration.

### 73. [medium] The Firefox extension re-registers a fresh blocking webRequest listener on every capability re-observation and never removes the previous one

- **Cluster:** extension-remote  
- **Verdict:** partially-confirmed  
- **Files:** extension/src/user-agent.ts, extension/src/user-agent.test.ts  
- **Regression risk:** low

**Why (reviewer):** The leak is real and the read-back really is self-satisfying. `observeCapabilities` calls `installUserAgentOverride(api)` unconditionally (extension/src/background.ts:47-55), and `resolveCapabilities` re-runs it whenever the 30 s memo has expired (:36, :59-65). The Firefox manifest grants `webRequest`/`webRequestBlocking` and no `declarativeNetRequest` (extension/src/manifest.ts:99, with the comment at :96-98 confirming the DNR branch is expected to be unavailable there), so control reaches extension/src/user-agent.ts:216-232, which builds a *new* closure each call, calls `addListener`, and then verifies with `hasListener` on that same just-added closure — which is necessarily true and can never observe the duplicate. There is no `removeListener` anywhere in the file. My correction to the claim is the cadence: this is not 'every 30 seconds for the life of the event page'. `resolveCapabilities` is demand-driven — it is only called from `runHello` and `runFetch` (extension/src/relay.ts:163, :174) — so listeners accumulate one per relayed request that arrives more than 30 s after the last observation, not on a timer. The consequence is also narrower than a correctness bug: each duplicate applies the identical header rewrite, so the request still comes out right; what grows is a chain of blocking listeners each awakening on every relayed provider request.

**Root cause:** `installUserAgentOverride` is written as an idempotent describe-the-desired-state call — which it genuinely is for declarativeNetRequest, where `updateSessionRules` passes `removeRuleIds` for the same IDs it adds (extension/src/user-agent.ts:203-206) — but the webRequest branch is additive and has no equivalent removal. The function keeps no reference to what it installed, so it cannot tell a first install from a re-observation.

**Smallest fix:** Give the webRequest branch the same replace-not-append shape the DNR branch already has: hold the installed listener in module scope alongside the destination set it was built for, and on re-entry either return `live` immediately when the destinations are unchanged, or call `webRequest.onBeforeSendHeaders.removeListener(previous)` before adding the new one. Then perform the `hasListener` read-back against the retained reference so it remains an observation rather than a tautology.

**Acceptance:** Unit (extension/src/user-agent.test.ts) with a fake `webRequest` recording add/remove calls: calling `installUserAgentOverride` three times with the same destinations leaves exactly one attached listener and still returns `live`; calling it with a different destination set removes the prior listener before adding the replacement; a host whose `addListener` attaches nothing (so `hasListener` is false) still returns `unavailable`. Integration (extension/src/interop.test.ts or relay.test.ts): driving two relayed fetches across a simulated capability-TTL expiry results in one attached listener, not two.

### 74. [medium] Unavailable capabilities offer no remediation, and a host-blocked runtime is described as unadvertised by the release

- **Cluster:** extension-remote  
- **Verdict:** confirmed  
- **Files:** src/ui/capabilities-view.tsx, src/capabilities/browser-runtime.ts, src/execution/runtime-registry.ts  
- **Regression risk:** low

**Why (reviewer):** Every code fact checks out. src/capabilities/browser-runtime.ts:14 is exactly `export type BrowserProbeEvidence = "probe-passed" | "api-exposed" | "not-observed" | "probe-failed";` — no disabled / permission-needed / app-not-wired value. src/ui/capabilities-view.tsx:176-181 `probePresentation` returns `["none", "Unavailable"]` for everything that is not probe-passed/api-exposed/failed, and `DeviceCard` (:158-167) renders only header + Seal + optional children + `<p>{observation.detail}</p>` — no button, link or action element. The runtime-wording half is the sharper, newer defect: capabilities-view.tsx:188 renders `<span class="capability-runtime__boundary">No activation path is advertised by this release.</span>` whenever `runtimeAction` returns undefined, and `runtimeAction` (:196) returns undefined for `state === "unavailable"`. node-webcontainer's declared state is `installable` (src/execution/runtime-registry.ts:131 OPTIONAL_CAPABILITIES, state at the id-"node-webcontainer" entry), and `resolveOptionalState` downgrades it to `unavailable` for host conditions at :274 (`HTTPS or a loopback secure context is required.`) and :277 (`This page is not cross-origin isolated.`). Reachable in production: vite.config.ts:183-184 and public/_headers:3-4 send `Cross-Origin-Embedder-Policy: credentialless`, which any host that drops the headers, or any engine without credentialless support, will fail — and the code has a dedicated branch for exactly that. So the visible top-level sentence contradicts the truthful `detail` string, which is collapsed inside the "Technical boundary" disclosure. Note the register already records CAP-05 as PARTIAL (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:63) with this same gate, so the vocabulary/remediation half is a known-open gap; the contradictory sentence is the new, concrete part.

**Root cause:** Two distinct causes bundled by the scout. (a) `BrowserProbeEvidence` models only how strong the observation was, never why the capability is absent, so the presentation layer has nothing to branch on and collapses four different worlds into one word. (b) `runtimeAction` conflates "no action available" with "no path exists": it returns undefined for the whole `unavailable` state, and the fallback copy asserts a claim about the *release* when the actual blocker recorded in `capability.detail` is about the *host*.

**Smallest fix:** For (b) — the smallest complete fix — stop asserting a release-level claim from a state-level absence: replace the single boundary string at capabilities-view.tsx:188 with the runtime's own `detail` (already the authoritative reason) plus, when `detail` names a host condition, a one-line remediation. For (a), extend `BrowserProbeEvidence` with `"permission-needed"` and `"disabled"` and have `probePresentation` label them distinctly; give `DeviceCard` an optional `action` slot that re-probes after the user acts.

**Acceptance:** 1) With `globalThis.crossOriginIsolated = false`, a capabilities render test asserts the node-webcontainer card does NOT contain the string "No activation path is advertised by this release." and DOES surface "This page is not cross-origin isolated." at the top level (not only inside the collapsed `<details>`). 2) The wasix runtime, whose declared state is genuinely `unavailable` in OPTIONAL_CAPABILITIES, still reads as unadvertised. 3) A probe observation carrying `evidence: "permission-needed"` renders a label other than "Unavailable" and renders exactly one action control. 4) Activating that control calls the re-probe function once.

### 75. [medium] Profile handoff deletes only the terminal mount, so anything the previous Profile's shell wrote elsewhere in the shared WebContainer survives into the next Profile

- **Cluster:** git-terminal  
- **Verdict:** partially-confirmed  
- **Files:** docs/VOICE_REVIEW_BACKLOG_2026-07-28.md, src/ui/terminal-view.tsx, src/terminal/manager.test.ts  
- **Regression risk:** low

**Why (reviewer):** The mechanics are exactly as described. `activateNodeWebContainerHost` returns a page-global singleton (`if (instance) return instance;`, src/execution/node-webcontainer-pack.ts:93-94). Managers are per-`WorkspacePort` (src/terminal/manager.ts:97-107) and profile authorities are cached per Profile, so each Profile gets its own manager over the same container. `changeProfile` quiesces the outgoing manager (src/ui/app.tsx:3054 -> `quiesceBrowserTerminalWorkspace` -> `quiesce` at src/terminal/manager.ts:477-480 -> `releaseAuthorityWithinLock`), and the only filesystem teardown there is `host.fs.rm(TERMINAL_WORKSPACE_MOUNT, ...)` (src/terminal/manager.ts:555) where `TERMINAL_WORKSPACE_MOUNT = "airship-workspace"` (src/terminal/contracts.ts:73). The shell is a plain `jsh` whose only confinement is its starting `cwd` inside the mount (src/terminal/manager.ts:295-299, `hostCwd` at :1132-1134), so `cd /` and a write to `/home`, `/tmp` or a package cache persists across the handoff. Where I part company with the scout is severity and the 'contradiction' framing: the checkpoint that claims 'terminal host is genuinely its own' (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:484) also states plainly, six bullets later at :500-501, 'Each namespace gets its own terminal manager but the page has one WebContainer to give out.' The shared container is disclosed, not concealed. A Profile is one human's working context inside one browser tab, not a cross-principal security boundary, and the residue requires that human's own shell to write outside the mount. So: real isolation gap and a genuine internal doc contradiction, not a security hole, and not `high`.

**Root cause:** Profile isolation is enforced at the mount point rather than at the container root. `releaseAuthorityWithinLock` unmounts the workspace projection because that is the only part of the container the manager knows it owns; the shell's reachable filesystem is the whole WebContainer, which no manager owns and nothing scopes per Profile.

**Smallest fix:** Do not attempt per-Profile containers (WebContainer allows one boot per page and `activateNodeWebContainerHost` fences a second boot, src/execution/node-webcontainer-pack.ts:99-101). Instead make the disclosure accurate and the boundary explicit: (a) reconcile docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:484 with :500 so 'terminal host is genuinely its own' reads as 'its own mount and session set inside one page-shared runtime'; and (b) state the same fact where a user can act on it — the Terminal route already names the runtime as WebContainer `jsh` (src/ui/terminal-view.tsx), so add one sentence that the container filesystem outside the workspace mount is page-shared and not Profile-private. If a stronger boundary is wanted later it is a `teardown()`-and-reboot on handoff, which is a separate lane with a multi-second cost per switch.

**Acceptance:** Unit (src/terminal/manager.test.ts): a quiesce with a fake host records `fs.rm` for `airship-workspace` only, and the test asserts in its name/comment that container paths outside the mount are deliberately retained — so the next change to this line is a decision, not an accident. Docs: the checkpoint's Blocker 3 section states the shared-container fact in the same paragraph that claims terminal ownership. UI: the Terminal route exposes a string naming the container filesystem outside the workspace mount as page-shared.

### 76. [medium] Reconcile is disabled for a failed terminal whose mount is still reconcilable

- **Cluster:** git-terminal  
- **Verdict:** partially-confirmed  
- **Files:** src/terminal/manager.ts, src/ui/terminal-view.tsx, src/ui/terminal-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** The gating is exactly as quoted: src/ui/terminal-view.tsx:237 and :248 both use `disabled={syncing || !sessions.some(({ status }) => status === "running" || status === "exited")}`. And a `failed` session really can leave a reconcilable mount: `outputFailed` (src/terminal/manager.ts:648-673), the `start()` catch (:320-337) when the failure came after mount (e.g. `host.spawn` threw), and `loseSessionLease` (:887-903) all set `failed` without calling `syncWorkspace` and without clearing `this.host`/`this.baseline`. So the button is greyed out while `syncWorkspace()` would in fact do useful work. Where the claim overreaches: the user is not stranded. `restart()` (wired at terminal-view.tsx:461) goes `restart -> start()` and start reconciles at manager.ts:291-293, and `close()` reconciles at :418 before closing. So two other visible controls rescue the files; the defect is a misleading affordance and an inconsistent predicate, not lost work. (Note `restart-required` sessions genuinely have no host — `stopLiveSessions` is only reached from `invalidateHost` and `releaseAuthorityWithinLock`, both of which clear the binding — so including that status would be wrong.)

**Root cause:** The button's enable predicate is a session-status proxy for a manager-side fact ("a mount with a baseline exists and this manager holds host authority") that the manager already knows exactly but does not expose.

**Smallest fix:** Expose a `canReconcile()` accessor on BrowserTerminalManager returning `activeHostManager === this && Boolean(this.host && this.baseline)`, and use it for the `disabled` expression at src/ui/terminal-view.tsx:237 and :248 instead of the status scan. `syncWorkspace()` already no-ops safely when the guard at manager.ts:440 fails, so the change cannot make reconcile do anything unsafe.

**Acceptance:** A terminal whose only session is in `failed` state while the manager still holds a mounted host renders an enabled Reconcile control, and clicking it reports the reconciled path count; with no mounted host (fresh load, or after runtime deactivation) the control is disabled.

### 77. [medium] Terminal "New here" renders as an empty 44px box on every phone and in the workspace dock

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/ui/terminal-view.css, e2e/workspace-terminal.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/terminal-view.css:114-115, inside `@media(max-width:760px)` (opened at :98), reads `.terminal-panel__bar button span{display:none}` and `.terminal-panel__bar button{min-width:44px;min-height:44px}`. The New-here control's entire visible content is two spans: src/ui/terminal-view.tsx:460 `<span aria-hidden="true">＋</span> <span>New here</span>` — both match the shed rule, leaving only the whitespace text node between them, so a 44x44 button paints with nothing in it. The siblings survive incidentally: Interrupt has the bare text node `⌃C ` (:459), Close has `× ` (:462), and Restart's glyph is `<Icon name="branch">`, which renders an `<svg>` not a `<span>` (src/ui/icons.tsx:62), plus the untagged word `Restart` (:461). The same bar is reused by the dock (`.terminal-route--dock .terminal-panel` at terminal-view.css:93 and the dock rules at :120-124), so both surfaces are affected. The accessible name survives (`aria-label="New terminal at current directory"`, exercised at e2e/workspace-terminal.spec.ts:49), which is exactly why no test caught the blank paint.

**Root cause:** A label-shedding rule was written against a structural selector (`button span`) rather than against the labels it meant to shed, so a control whose glyph happens to be wrapped in a span loses its glyph as well as its word.

**Smallest fix:** Narrow the rule at terminal-view.css:114 to `.terminal-panel__bar button span:not([aria-hidden="true"]){display:none}`. That keeps the `＋` (already aria-hidden, so no double-announcement) and still sheds `Interrupt`, `New here` and `Close`.

**Acceptance:** E2E at 390x844 on #terminal (and the workspace dock): every button in `.terminal-panel__bar` reports non-empty rendered content — a visible child with a non-zero box or non-whitespace text — and each measures >=44x44. The button named `New terminal at current directory` in particular shows a visible glyph. At >=761px all four labels remain visible.

### 78. [medium] Terminal bridge remaps `git restore --worktree` to `--source=HEAD`, discarding staged content

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/git/terminal-commands.ts, src/git/terminal-commands.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/git/terminal-commands.ts:485 `const fromHead = takeFlag(words, "--source=HEAD") || takeFlag(words, "--worktree");` and :495 `source: fromHead ? "head" : "stage"`. takeFlag (:680-685) removes the token, so `--worktree` is consumed as a source switch. In real Git `--worktree` names the restore destination and is the default, leaving the source as the index. The adapter then does genuinely different work per source: src/git/workspace-adapter.ts:899-911 checks out from the current branch with `force: true` for "head", versus writing the index plane back for "stage" (:912-916), so `git restore --worktree f.txt` overwrites the file with HEAD bytes and destroys staged content. Help text at :781 lists only `git restore [--source=HEAD] <paths…>`, so the flag is undocumented, and `grep restore src/git/terminal-commands.test.ts` shows only the bare `git restore README.md` case at :159 — no flag coverage. Related wrinkle in the same dispatch: src/git/terminal-commands.ts:79-83 routes on `words[0] === "--staged"` only, so `git restore --worktree --staged f.txt` takes the restore path and `--staged` is then treated as a path. Mitigation that keeps this below high: the approval descriptor does disclose the source — src/git/operations.ts:238 "Discard worktree changes in N path(s) from HEAD/the index" — so a user who reads the prompt can catch it before approval.

**Root cause:** Flag parsing treats `--worktree` as a synonym of `--source=HEAD` instead of as a destination selector, conflating Git's source axis with its destination axis on the one command whose purpose is destroying uncommitted work.

**Smallest fix:** In src/git/terminal-commands.ts:485 drop the `|| takeFlag(words, "--worktree")` disjunct and consume the flag separately as a no-op destination (`takeFlag(words, "--worktree");` on its own line) so the source stays "stage"; add `[--worktree]` to the help line at :781. If `--staged` appears anywhere but position 0 alongside `--worktree`, throw the existing unsupported-flag style error rather than treating it as a path.

**Acceptance:** 1) `git restore --worktree f.txt` produces a restore operation with `source: "stage"` and paths ["f.txt"]. 2) `git restore --source=HEAD f.txt` still produces `source: "head"`. 3) `git restore f.txt` (no flags) still produces `source: "stage"`. 4) A file staged with content B and modified in the worktree to C, after `git restore --worktree f.txt`, holds B (not the HEAD content A).

### 79. [medium] Terminal metadata persistence failures are swallowed while the footer keeps claiming the lineage is retained

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/terminal/manager.ts, src/ui/terminal-view.tsx, src/terminal/manager.test.ts, src/ui/terminal-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** Every persist goes through `queuePersist()`, and src/terminal/manager.ts:758 is `this.persistenceTail = this.persistenceTail.then(() => this.persist(), () => this.persist());` — the rejection handler is another persist, nothing is awaited, and no listener/notice/session detail carries the outcome. `persist()` has four real throw sites: the 2 MiB budget errors at :783 and :795, `WorkspaceConflictError("Terminal metadata kept changing; no terminal lineage was overwritten.")` at :807 after `MAX_METADATA_CAS_ATTEMPTS = 6`, and non-conflict errors rethrown at :804; `mergeStoredManifests`/`mergeStoredSession` add the tombstone limit (:995), the retention-boundary error (:1005) and the divergent-writer `WorkspaceConflictError` (:1029). Meanwhile src/ui/terminal-view.tsx:91 returns `${scope} tab metadata, bounded transcript, input history, and lineage are retained through the active encrypted workspace...` purely from `durability.state`, and it is set into the footer once at :167 from the declared tier — never from an observed write. Related, same root cause: `releaseAuthorityWithinLock` does `await this.persistenceTail;` at :563 inside a `finally`, so a persist rejection there throws out of the finally and masks the real teardown failure.

**Root cause:** Persistence is fire-and-forget with an error handler that discards the error, and the durability claim shown to the user is computed from the declared durability tier rather than from observed successful writes — so the two can never disagree even when persistence has stopped working.

**Smallest fix:** In src/terminal/manager.ts, record the last persist failure (`this.persistenceFailure = error` in a catch inside `queuePersist`'s handler, cleared on the next success) and expose it via a small subscription or on the session snapshot; in src/ui/terminal-view.tsx, when it is set, replace the retention sentence in the footer with the failure reason and drive the seal to `attention`. Also await/handle `this.persistenceTail` outside the `finally` at :563 so it cannot mask the teardown error.

**Acceptance:** With a workspace whose `write` always rejects, after one `create()` plus one output append the terminal footer no longer contains "are retained through the active encrypted workspace", names the persistence failure, and the seal is in the attention state; once writes succeed again the retention sentence returns. No unhandled promise rejection is emitted in either case.

### 80. [medium] Workbench Source Control never clears the commit message, so the next commit silently reuses it

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workspace-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/workspace-view.tsx:240 declares `const [commitMessage, setCommitMessage] = useState("")`. mutateSource (:1016-1026) runs stage/unstage/commit then `await refreshSourceControl()` and never touches commitMessage; transact (:997-1007) only sets busy/notice. The commit box at :1677 is gated on `worktree?.status.some((entry) => entry.index)`, so after a successful commit the staged lane empties and the box (with its retained text) unmounts; staging any path remounts it pre-filled with the previous subject and the primary button already enabled because `disabled={!commitMessage.trim()}`. The sibling surface does clear: src/ui/sources-view.tsx:274-279 `if (await runMutation({kind:"commit",...}, "Commit created locally. Nothing was pushed.")) setCommitMessage("");`. Confirmed the coverage gap too: `grep -rn "Commit staged" e2e/ src/` matches only src/ui/workspace-view.tsx:1677 and src/git/operations.ts:210 — no test. The message is also never cleared when selectRepository/selectWorktree changes, so one repository's draft subject follows the user to another.

**Root cause:** The workbench commit path funnels through a generic mutateSource/transact pair that has no per-operation success hook, so the commit-specific post-condition (clear the composed message) has no place to live; sources-view has that hook via runMutation's boolean return.

**Smallest fix:** In src/ui/workspace-view.tsx mutateSource, inside the transact callback, change the commit branch to `else if (operation.kind === "commit") { await git.commit(operation.request); setCommitMessage(""); }` before `await refreshSourceControl()`. A throw from git.commit skips the clear, matching sources-view. Optionally also `setCommitMessage("")` in the repository/worktree selection handlers.

**Acceptance:** 1) With a fake git client whose commit resolves, typing a message and clicking "Commit staged" leaves the textarea value "" (assert after re-staging a path so the box remounts). 2) With a fake git client whose commit rejects, the textarea still holds the typed message and an error notice is shown. 3) No second commit request is ever issued with a message equal to the previous commit's message without an intervening input event.

### 81. [medium] Hidden graph nodes have no Hidden list and no Restore control; the only way back is an undocumented side effect of the "Most connected" launcher

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/ui/memory-view.tsx, src/ui/memory-controls.tsx  
- **Regression risk:** low

**Why (reviewer):** "Hide from view" is write-only: `setHiddenMemoryNodeIds((current) => new Set(current).add(selectedNode.id)); setSelectedNodeId(undefined)` (src/ui/memory-view.tsx:403). The renderer then drops the node from both painting and hit-testing, so it cannot be clicked back: src/memory-graph/canvas-renderer.tsx:645 filters `!hiddenNodeIds.has(node.id)` and `:490` returns `undefined` for a hit on a hidden ID. `rg -i restore` across src/ui/memory-view.tsx and src/ui/memory-controls.tsx returns only `restoredPresentation` (presentation state, src/ui/memory-view.tsx:132-147) — there is no Restore-one, Restore-all, or hidden-node list. The only report is the non-interactive `role="status"` boundary line "… {hiddenMemoryNodeIds.size} hidden · rev …" (src/ui/memory-view.tsx:369-371). Un-hide happens only inside `selectMemoryNode` (`:233-241`), reachable from the graph-match buttons (`:378`), a neighbour button (`:394`), or the "Most connected" launcher (`:427`). `revealGraphMatches` deletes hidden *kinds* only (`:248-254`). The `mostConnectedNodes` contradiction is real — `.filter((node) => !hiddenKinds.has(node.kind))` with no node-ID filter (src/ui/memory-view.tsx:916) against a doc comment that says "offering to select a node the canvas is not drawing would select something the user cannot see" (`:907-909`) — but note this is the only reliable escape hatch today, so it must not be 'fixed' alone. MEM-06 is still open in the register (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:133, and it is absent from the 2026-07-29 closed list at :576-583).

**Root cause:** `hiddenMemoryNodeIds` was added as a one-way presentation filter with no inverse affordance; the count was surfaced in a status string rather than in a control, so the state is reported but not operable.

**Smallest fix:** In the boundary block (src/ui/memory-view.tsx:369-371), when `hiddenMemoryNodeIds.size > 0` render a disclosure listing each hidden node by `graph.getNode(id)?.label` with a Restore button calling `selectMemoryNode(id)` (which already un-hides), plus a Restore all button doing `setHiddenMemoryNodeIds(new Set())`. Once that exists, add `&& !hiddenNodeIds.has(node.id)` to `mostConnectedNodes` (src/ui/memory-view.tsx:916) so it matches its own comment — the two changes must land together.

**Acceptance:** After hiding a node: (1) a visible control reads "1 hidden" and lists that node's label; (2) pressing Restore removes it from `hiddenMemoryNodeIds` and the canvas draws and hit-tests it again; (3) Restore all empties the set; (4) `mostConnectedNodes` never returns a node whose ID is hidden.

### 82. [medium] Opening a Memory result whose path no longer resolves announces "Opened …" while the previously open document stays on screen

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** `openMemorySource` awaits `openFile(target.path)` and then announces success on the mere absence of a throw: src/ui/app.tsx:4199-4203. `openFile` returns `void` and cannot signal a miss (src/ui/app.tsx:4177-4191): `readWorkspaceFileBounded` returns `undefined` for an absent path (src/ui/app.tsx:8372-8374), and both ports agree — `MemoryWorkspace.readBounded` returns `undefined` when `!file` (src/workspace/memory.ts:18-22) and the encrypted port returns `undefined` when no manifest entry matches (src/vault/encrypted-workspace.ts:74-80). `openFile` then calls `setSelectedFileSelection(file ? ... : undefined)` (`:4190`), and the workbench ignores an undefined selection outright: `if (!selected) return;` (src/ui/workspace-view.tsx:285-286), so the prior buffer stays active. `openFile` also returns silently on supersession/profile change (`:4184-4189`), which produces the same false success. The register's own MEM-03 gate names this case — "Unit/E2E cover file and profile-memory source, absent/deleted path, mobile navigation, and exact editor path" (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:130) — but the absent-path half has no test: src/ui/memory-view.test.ts:120-121 only asserts the wiring strings, and e2e/conversation-navigation.spec.ts:336-342 covers the happy path. Scope note: `kind: "memory"` targets always resolve (`/workspace/.airship/memory.json` exists whenever a record exists, src/ui/memory-view.tsx:95, :720), so the defect is specific to `kind: "file"` paths deleted between listing and click.

**Root cause:** `openFile` reports its outcome only through state, not to its caller, so `openMemorySource` treats "did not throw" as "opened". Absence is a legitimate, non-exceptional result of the read path and there is no branch for it.

**Smallest fix:** Make `openFile` return the resolved file or an outcome discriminant (`"opened" | "missing" | "superseded"`) at src/ui/app.tsx:4177-4191, and in `openMemorySource` (`:4199-4203`) only announce `Opened ${target.path} from Memory` on `"opened"`; on `"missing"` set a failure status naming the path, e.g. "That Memory source is no longer in the workspace: ${path}", and on `"superseded"` stay silent. No other `openFile` caller needs to change since the return value is additive.

**Acceptance:** Clicking "Open in editor" on a workspace hit whose path has been removed: (1) the runtime status is a failure message containing the exact path and never the word "Opened"; (2) the editor's previously open document is unchanged, or explicitly reported as unchanged; (3) the happy path at e2e/conversation-navigation.spec.ts:342 still opens the exact file.

### 83. [medium] Profile memory scope "Shared workspace" cannot change any retrieved record — it is identical to "This profile" on every path

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/profiles/domain.ts, src/profiles/catalog.ts, src/ui/profiles-governance.ts  
- **Regression risk:** medium

**Why (reviewer):** The option is offered at src/ui/app.tsx:9179 and labelled "Shared workspace" at src/ui/profiles-governance.ts:47, with the description "Choose how far this profile's memory reaches." (`:112`). The only scope-reading code narrows for `session` and nothing else: `record.scope.profileId === profileId && (scope !== "session" || ...)` (src/retrieval/federated-turn-context.ts:139-146), so `workspace` and `profile` produce byte-identical filters. Writes always stamp the writing profile: `scope: Object.freeze({ kind: "profile", profileId: profile.profileId, profileRevision, createdInSessionId })` (src/tools/memory-tools.ts:120-127), and no read anywhere crosses profile IDs (src/tools/memory-tools.ts:217-219, src/tools/federated-memory.ts:119-121). The only observable effect of selecting it is the audited string in the sealed selection lineage (src/retrieval/federated-turn-context.ts:105). The register itself records the gap: MEM-05's gate says "cross-profile edges require an explicit shared-workspace policy" and the checkpoint at docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:266 says "explicit cross-Profile shared-workspace policy remain". Note the seeded catalog already pins a profile to it: src/profiles/catalog.ts:136 sets `memoryScope: profile.profileId === "research" ? "workspace" : "profile"`, so a shipped profile advertises a boundary that does nothing.

**Root cause:** The three-value enum was defined and validated across the manifest, audit, and UI (src/profiles/domain.ts:293, src/core/session-audit.ts:580, src/sessions/domain.ts:582) before the widening policy it names existed. Memory records are per-workspace by file location but per-profile by scope stamp, and no read was ever written for the widened case.

**Smallest fix:** Do not widen silently — that would be a silo hole. Smallest honest fix: remove the `workspace` option from the editor (src/ui/app.tsx:9179), normalize the value to `profile` in `oneOf(profile.memoryScope ?? "profile", ...)` (src/profiles/domain.ts:293) so pinned manifests and the seeded research profile (src/profiles/catalog.ts:136) migrate, and keep the enum in the schema for forward compatibility. If widening is wanted instead, it is a deliberate policy change requiring the scope predicate to drop the `profileId` equality only when the reading profile is `workspace`-scoped, plus explicit disclosure in the editor and the Memory profile-lane provenance.

**Acceptance:** Either (a) the Memory priority control offers exactly two values, an existing profile stored as `workspace` loads as `profile`, and no manifest/audit validator rejects the migrated value; or (b) with two profiles sharing a workspace and both set to `workspace`, `recall_memory` and the profile lane return the other profile's records, the profile lane's provenance names the widened scope, and a `profile`-scoped profile still sees only its own.

### 84. [medium] Semantic embedding mode never activates from the capability probe; it stays on hash vectors until a user finds a button inside a collapsed disclosure

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/indexing/semantic-browser-provider.ts, src/retrieval/client-context-runtime.ts, src/ui/context-view.tsx  
- **Regression risk:** medium

**Why (reviewer):** `readEmbeddingMode()` returns `"bootstrap"` unless localStorage already holds the literal `"semantic"` (src/indexing/semantic-browser-provider.ts:20-29), and that is the constructor default for `SwitchableEmbeddingProvider` (`:111-119`), which `createDefaultEmbeddingProvider` instantiates (src/retrieval/client-context-runtime.ts:238-242). So a first run always ranks with `HashEmbeddingProvider`. The capability verdict exists — `preferredSemanticBackend` is computed at src/capabilities/browser-runtime.ts:278-289 — but `rg preferredSemanticBackend` shows it is only ever *displayed* or passed as a backend hint once semantic mode is already chosen (src/indexing/semantic-browser-provider.ts:71, src/ui/capabilities-view.tsx:140, src/tools/browser-capabilities.ts:31, src/tools/live-environment.ts:184); nothing calls `setMode`/`setEmbeddingMode` from it. `rg setEmbeddingMode` outside tests yields exactly two non-test sites: the runtime method (src/retrieval/client-context-runtime.ts:71) and the manual button at src/ui/context-view.tsx:219-220, which sits inside the Index disclosure that is collapsed on the Memory route (src/ui/memory-view.tsx:143-148: `initialTab === "index" ? true : restoredPresentation?.indexExpanded ?? false`). Partial-confirm note on the framing: the surface is honest about the degraded mode rather than misrepresenting it — the button title and the disclosure text say hash vectors "are deterministic test/bootstrap signals, not semantic understanding" (src/ui/context-view.tsx:270-271). This is MEM-04, which the register explicitly still lists as open (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:131, :625), so it is a confirmed known gap rather than a new regression.

**Root cause:** Mode selection reads one input — a persisted user preference — and has no branch for 'no preference recorded'. The capability probe already produces the verdict needed for that branch, but the two subsystems were never joined.

**Smallest fix:** Make the absent-preference case capability-driven rather than a hardcoded `"bootstrap"`: have `readEmbeddingMode()` return the stored value only when one exists, and have `ClientContextRuntime` (src/retrieval/client-context-runtime.ts:55-78), on first refresh with no stored preference, await `getBrowserCapabilityRegistry().refresh()` and call `switchable.setMode("semantic")` when `preferredSemanticBackend` is available and the policy class is not `constrained`, falling back to bootstrap on any probe or worker failure and publishing the resulting posture (already surfaced via `getSemanticState()`/`posture`). Keep the manual buttons as the explicit override.

**Acceptance:** With no stored preference and a probe reporting a usable semantic backend: (1) the first generation reports `posture: "local-semantic"` without any user interaction; (2) with a probe reporting `constrained` or a worker that fails to start, the generation completes on bootstrap and the Index disclosure states the degrade; (3) an explicit user selection still wins over the probe on the next load.

### 85. [medium] The indexer's 21-suffix allow-list marks most source languages `unsupported`, so a C/C++/Ruby/Shell repository indexes to zero chunks

- **Cluster:** memory-sources  
- **Verdict:** confirmed  
- **Files:** src/indexing/incremental-indexer.ts  
- **Regression risk:** medium

**Why (reviewer):** `INDEXABLE_EXTENSIONS` holds exactly 21 suffixes (src/indexing/incremental-indexer.ts:14-36) and `contentTypeFor` returns `undefined` for anything not ending in one of them (`:214-220`). `discover()` turns that into `status: "unsupported", reason: "No client extractor is registered for this file type."` (`:72-75`), `indexCandidate` short-circuits on that status (`:137`), and the engine removes every non-`indexed` candidate from the index (src/indexing/client-context-engine.ts:487-489). So .c/.cc/.h/.hpp/.cs/.rb/.php/.swift/.kt/.scala/.sh/.sql/.vue/.svelte/.scss/.less and every extension-less file (Dockerfile, Makefile, LICENSE, .gitignore) produce nothing. Crucially, the honest guard the fix needs already exists one layer down and is applied at read time on real content: `isWorkspaceBinaryEnvelope(file.content)` marks opaque bytes `unsupported` (src/indexing/incremental-indexer.ts:141-145), and `maxFileBytes` already bounds size before read (`:76-78`). The extension list is therefore doing work the content guard does better. Partial mitigation, which the claim understates: the Index disclosure does surface the exclusion numerically — `${indexed} indexed · ${excluded} excluded` (src/ui/context-view.tsx:615-620) — so it is undercounted, not silently zeroed. MEM-04 is listed as still open in the register (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:625).

**Root cause:** `contentTypeFor` is an extension allow-list used as a text/binary decision. The real text/binary decision is already made later on actual content, so the allow-list's only remaining job is labelling the content type — but it is wired as an admission gate.

**Smallest fix:** In `discover()` (src/indexing/incremental-indexer.ts:71-75), default an unknown extension to `"text/plain"` and let it proceed; keep `INDEXABLE_EXTENSIONS` purely for the labelled content type. The existing `isWorkspaceBinaryEnvelope` check at `:141-145` and the `maxFileBytes` check at `:76-78` remain the real guards, so binary and oversized files still land in `unsupported`/`too-large` with their existing reasons.

**Acceptance:** A workspace containing `main.cpp`, `app.rb`, `deploy.sh`, and `Dockerfile` with UTF-8 text: (1) all four reach `status: "indexed"` with chunks and become searchable; (2) a file whose content is a binary envelope still reports `unsupported` with the opaque-bytes reason; (3) a file over `maxFileBytes` still reports `too-large`; (4) existing extension-labelled content types are unchanged for the 21 known suffixes.

### 86. [medium] Capabilities renders a one-shot snapshot labelled "probe current" and never subscribes to the registry that re-probes on device changes

- **Cluster:** performance  
- **Verdict:** confirmed  
- **Files:** src/ui/capabilities-view.tsx, src/ui/app.tsx, src/capabilities/browser-runtime.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/capabilities-view.tsx:53 is `useEffect(() => { void refresh(); }, []);` — mount only; the sole other trigger is the Refresh button (:64). :46 stamps `${ready}/${total} runtimes ready · probe current` and :68 passes `detail="Live in-page runtime state."`. `grep -n observedAt src/ui/capabilities-view.tsx` returns nothing, so the observation time is never shown, unlike src/ui/billing-view.tsx:589 `<p class="billing-provider-observed"><span>Inventory observed</span><strong>{observedAt}</strong></p>`. Meanwhile `BrowserCapabilityRegistry.start()` (src/capabilities/browser-runtime.ts:424-439) binds pageshow/online/offline/visibilitychange/connection-change/battery chargingchange+levelchange and calls `refresh(true)` on each (:456-462), notifying `this.listeners` (:406-408). `subscribe()` at :415 has zero production callers — the only registry calls in src/ are `refresh()`/`snapshot()` at src/main.tsx:12, src/ui/app.tsx:4229 and :7631, src/tools/live-environment.ts:46, src/tools/browser-capabilities.ts:13, src/retrieval/client-context-runtime.ts:247, src/indexing/semantic-browser-provider.ts:64. Two mitigations the scout omitted: `inspectBrowserCapabilities` uses `refresh(true)` (app.tsx:4228-4230), so the snapshot IS forced-fresh at mount and on click, and CAP-04's row is still open in the register (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:62, retained at :276). The defect is the stale-after-mount panel plus a label that asserts currency it cannot know.

**Root cause:** CapabilitiesView takes `inspectBrowser(): Promise<report>` — a pull-only prop — so the component copies the registry's report into private state and has no channel to be told the registry re-probed. The registry's publish side (`subscribe`) was built for this and left unconnected, so the route's copy diverges from the canonical generation the agent reads.

**Smallest fix:** Add an optional `subscribeBrowser?(listener: (report) => () => void)` prop wired in app.tsx to `getBrowserCapabilityRegistry().subscribe(...)`, use it in place of the mount-only effect (its contract already delivers the cached report immediately or triggers a refresh), and replace the `· probe current` suffix with the rendered `report.observedAt` using billing-view's "observed" vocabulary.

**Acceptance:** 1) A component test that renders CapabilitiesView with a fake subscribe channel, pushes a second report with a different `observedAt` and a changed `webgpu.state`, and asserts the card updates without a Refresh click. 2) The summary line no longer contains the literal "probe current" and does contain a formatted `report.observedAt`. 3) Unmounting calls the returned unsubscribe (assert the listener set is empty). 4) A registry test asserting `subscribe` has at least one production caller is unnecessary; instead assert via the component test that a lifecycle-driven `refresh(true)` reaches the DOM.

### 87. [medium] Every durable event in a turn re-reads and decrypts the entire journal twice to refresh the recents shortcut

- **Cluster:** performance  
- **Verdict:** confirmed  
- **Files:** src/sessions/library.ts, src/ui/app.tsx, src/sessions/session-library.test.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/app.tsx:3893 `setSessionRevision((value) => value + signal.events.length)` fires inside the turn's durable branch, and `sessionRevision` is a dependency of both recents effects (src/ui/app.tsx:1613 rail, :1533 palette). `loadRecentConversations` (src/ui/app.tsx:813-816) does `Promise.all([library.list(...), library.favorites(...)])`. `SessionLibrary.list` (src/sessions/library.ts:104-113) issues `this.journal.readEvents(record.id, 0, signal)` for every session purely to find the last non-favourite event's `recordedAt`; the abort check sits after each read resolves, so an aborted effect still issues the whole fan-out. `library.favorites` → `resolveProfileFavoriteOrder` (src/sessions/favorite-order.ts:56-59) reads every event of every session in the profile. Under a Vault each of those is a segment fetch plus AES decrypt (src/storage/encrypted-object-journal.ts:95-109). A third cost the claim missed: the preview cache is keyed on `item.updatedAt` (src/ui/app.tsx:872-873), which changes on every durable batch for the active session, so each pass also re-runs `library.inspect` on it. `applyTitle` adds two more bumps per new conversation (app.tsx:3794).

**Root cause:** Two things compound: the recents shortcut is invalidated per durable event rather than per turn boundary, and `SessionLibrary.list` derives its display activity timestamp with an unbounded `readEvents(id, 0)` per session instead of a bounded tail read or stored field.

**Smallest fix:** Two small changes. (1) Bound the activity scan: in src/sessions/library.ts read `readEvents(record.id, Math.max(0, record.headSequence - 8), signal)` and fall back to `record.updatedAt` when no non-preference event is in the tail — the reversed scan already only wants the newest one. (2) Coalesce the refresh: derive a debounced value from `sessionRevision` (trailing ~250ms) and depend the two recents effects on that instead of the raw counter.

**Acceptance:** A unit test with N sessions of M events asserts `SessionLibrary.list` issues at most one bounded `readEvents` per session with `afterSequence > 0` when `headSequence > 8`, and that the derived `updatedAt` still ignores `session.favorite.changed` and the profile favourite-order event (existing library test unchanged). A component test asserts a burst of ten `sessionRevision` increments within the debounce window produces exactly one `library.list` call.

### 88. [medium] No global live resource/utilisation indicator exists; only static device capacity is reported

- **Cluster:** performance  
- **Verdict:** confirmed  
- **Files:** src/capabilities/browser-runtime.ts, src/ui/platform-shell.tsx, src/ui/capabilities-view.tsx, src/execution/runtime-registry.ts  
- **Regression risk:** medium

**Why (reviewer):** Read src/capabilities/browser-runtime.ts:41-62 — `BrowserSignalReport` carries `logicalProcessors`, `deviceMemoryGiB`, `online`, `battery`, `connection`, and `thermal: { state: "unavailable" }` and nothing else; there is no usage/sample field anywhere in the report type. probeSignals (:507-521) reads `nav.hardwareConcurrency` and `nav.deviceMemory` once, both of which are static capacity. src/ui/capabilities-view.tsx:96-97 renders exactly `${report.signals.logicalProcessors} logical cores` and `${report.signals.deviceMemoryGiB} GiB estimate`. src/tools/live-environment.ts:178 explicitly disclaims the scheduling numbers: "ceilings are policy inputs, not resource-use measurements", and browser-runtime.ts:70-71 says maxWorkerConcurrency "must never be rendered or reported as a count of running workers". Repo-wide grep for `measureUserAgentSpecificMemory|performance.memory|usedJSHeapSize|utilisation|utilization` over src/ returns only src/models/telemetry.ts and model-picker/app rendering of *Chutes provider* load (src/ui/model-picker.tsx:351-355, src/ui/app.tsx:8428-8429) — provider-side, not this browser. The only real local resource measurement in the product is `navigator.storage.estimate()` in src/storage/local-device-object-store.ts:1523, surfaced solely on the Vault route (src/ui/vault-view.tsx:704-707) for the local-device tier. Nothing samples CPU, memory, GPU or task/runtime load, and no shell-level surface exists. The register row (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:66) still says MISSING and the 2026-07-29 checkpoint does not close it. Severity lowered from high to medium: this is a missing capability, and the code is scrupulously honest about not measuring — it misrepresents nothing.

**Root cause:** The capability model is a one-shot *capacity* probe by design: `BrowserSignalReport` has no time-series or sample shape, and `AdaptiveSchedulingPolicy` is a derived policy the codebase deliberately forbids rendering as utilisation. No component owns the things the app actually could count (in-flight execution runs, indexing lanes, embedding batches, download budget), so there is nothing for a global indicator to subscribe to.

**Smallest fix:** Add a small `RuntimeLoadMonitor` in src/capabilities/ that counts only what Airship itself owns and can therefore state truthfully: in-flight `ClientExecutionRuntime.execute` calls by runtime id, active indexing lanes from src/retrieval/client-context-runtime.ts, and active embedding batches; plus optional measured values where the realm exposes them (`performance.measureUserAgentSpecificMemory()`, `navigator.storage.estimate()`), each with an explicit `"not-measurable"` state rather than an invented number. Publish it through the same `subscribe()` shape as BrowserCapabilityRegistry, render a compact indicator in the shell status area (src/ui/platform-shell.tsx) with current/peak per runtime and the throttling decision that scheduling took, and expand it on #capabilities. Do not synthesise a CPU percentage.

**Acceptance:** 1) A unit test drives two concurrent `execute` calls on distinct runtimes and asserts the monitor reports current=2, peak>=2, and returns to 0 after both settle. 2) With `performance.measureUserAgentSpecificMemory` absent from the host, the monitor reports memory as `not-measurable` and the indicator renders an explicit "Not measurable in this browser" string, never a number. 3) The indicator is present in the DOM on at least two non-#capabilities routes (assert via a shell test), and its value changes when a task starts. 4) No surface prints `maxWorkerConcurrency` as a running-worker count (grep assertion, matching the existing invariant comment at browser-runtime.ts:70-71).

### 89. [medium] OPFS sync-access-handle probe can never fire in production, so Capabilities permanently understates OPFS

- **Cluster:** performance  
- **Verdict:** confirmed  
- **Files:** src/capabilities/browser-runtime.ts, src/capabilities/browser-runtime.test.ts, src/ui/capabilities-view.tsx  
- **Regression risk:** low

**Why (reviewer):** src/capabilities/browser-runtime.ts:663-665 computes `syncAccessHandle` from `host.exposedInterfaces.has("FileSystemSyncAccessHandle") || host.exposedInterfaces.has("FileSystemFileHandle.createSyncAccessHandle")`. The only production host builder is `createProbeHost` (:472, the sole caller from `probeBrowserRuntimeCapabilities` at :188-191), and it sets `exposedInterfaces: new Set(["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder", "ImageDecoder", "WebTransport"].filter((name) => typeof globalRecord[name] === "function"))` (:483-484). Neither queried name is in that list, so both branches are dead outside tests. Worse, even adding them to the list would only half-work: the filter tests `typeof globalThis[name] === "function"`, and `FileSystemSyncAccessHandle` is a Worker-only global (never present on the window realm the probe runs in), while `"FileSystemFileHandle.createSyncAccessHandle"` is a dotted pseudo-name that is not a global at all. Overrides can only come from the `overrides` parameter spread at :503, and no production caller passes any (src/tools/browser-capabilities.ts:13 and src/tools/live-environment.ts:46 both call `registry.refresh(true)`). Result: a fixed `"not-observed"` in every real browser, printed as "Root availability only" (src/ui/capabilities-view.tsx:121) and fed to the model each turn as `sync-access-handle=not-observed` (src/tools/live-environment.ts:167) — while the app's own OPFS cache does obtain sync handles in the same origin (src/storage/client-ciphertext-cache.ts:938-939, asserted in e2e/opfs-ciphertext-cache.spec.ts:44). The only place the name is ever set is the unit test at src/capabilities/browser-runtime.test.ts:45.

**Root cause:** `exposedInterfaces` is a fixed constructor-name allowlist that answers only "is this global a function", but the sync-access capability lives on `FileSystemFileHandle.prototype.createSyncAccessHandle` (a prototype method, window-visible) or on a Worker-only global. The probe was written against a host abstraction that cannot express either fact, so the check compiles, passes its injected-name unit test, and is unreachable in production.

**Smallest fix:** Stop routing this through `exposedInterfaces`. Add an explicit host field, e.g. `hasSyncAccessHandleInterface: boolean`, set in `createProbeHost` as `typeof FileSystemFileHandle !== "undefined" && typeof FileSystemFileHandle.prototype?.createSyncAccessHandle === "function"`, and read it at browser-runtime.ts:663. If that is judged too weak an observation, delete `OpfsObservation.syncAccessHandle` and its two consumers instead — a permanently negative field that contradicts the app's own storage backend is worse than no field.

**Acceptance:** 1) A test that stubs a realm exposing `FileSystemFileHandle.prototype.createSyncAccessHandle` and calls `probeBrowserRuntimeCapabilities()` with NO overrides asserts `report.opfs.syncAccessHandle === "api-exposed"`. 2) A test with the prototype method absent asserts `"not-observed"`. 3) A grep/unit assertion that no probe decision keys off the dotted pseudo-name `"FileSystemFileHandle.createSyncAccessHandle"`. 4) The existing e2e assertion `result.firstCapability.syncAccessHandle === "active"` (e2e/opfs-ciphertext-cache.spec.ts:44) and the Capabilities OPFS card no longer disagree in the same Chromium run.

### 90. [medium] "Expired" is a rendered claim state that neither Proof legend defines; the ledger legend teaches "Stale observation" and the summary tab counts expiry as "Failed"

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/trust-language.ts, src/ui/turn-evidence.ts, src/ui/proof-view.tsx  
- **Regression risk:** medium

**Why (reviewer):** Both halves verified, and the tile half is broader than the scout said. src/ui/attestations-view.tsx:71-77 (EVIDENCE_STATE_MEANINGS) ends with `label: "Stale observation"`, rendered as the legend at attestations-view.tsx:257-264 under the subtitle "Every state is claim-scoped". But src/ui/attestations-view.tsx:560-562 is `function statusLabel(state) { return proofStatusLabel(state); }` and src/ui/trust-language.ts:40 returns "Expired" — so "Expired" prints in the record-count row (attestations-view.tsx:450), on every `<StatusMark>` seal label (attestations-view.tsx:523-532, used at 316/365/407), AND in the inspector title's `<strong class={dimension.state}>{statusLabel(...)}` at attestations-view.tsx:478 and 495. "Stale observation" appears only in `attestationRecordReading` (attestations-view.tsx:96-105), a record-level sentence. Second half: src/ui/turn-evidence.ts:56-66 `turnEvidenceCounts` has no `expired` branch — the trailing `else failed += 1;` absorbs it — and src/ui/proof-view.tsx:256 renders that number under `Failed` with `A claim was checked or declared and did not hold.` Expiry is reachable in the claim stack: src/ui/claim-stack-model.ts:270 `if (state === "expired") return "expired";` and :278, fed by real provider states (src/attestation/provider-types.ts:9, src/attestation/provider-client.ts:1362, src/attestation/verifiers.ts:215). src/ui/claim-stack-facts.ts:131-135 CLAIM_STATE_LEGEND has three entries and no expired/stale row, confirming the summary tab has no vocabulary for it.

**Root cause:** `ProofStatus` carries five members but the two Proof surfaces each collapse the fifth in a different direction: the ledger's label function emits an undefined word ("Expired"), and the summary tab's counter has no bucket for it so the `else` clause silently reclassifies it as a failed check. One enum, two lossy projections, neither matching the legend the same screen prints.

**Smallest fix:** Two edits. (1) src/ui/trust-language.ts:40 — return the legend's own word: `if (value === "expired") return "Stale observation";` so every tile, seal label, count row and inspector title in attestations-view speaks the word the legend defines. (2) src/ui/turn-evidence.ts — add `expired` to `TurnEvidenceCounts` and count it separately instead of via the `else`, keep the fail-closed gate as `counts.failed > 0 || counts.expired > 0 || attestedFieldsDisagree` (TURN_EVIDENCE_COPY.failed already reads "Verification failed or expired", src/ui/trust-language.ts:198, so the hero is unchanged), and render a distinct `data-status="expired"` row in src/ui/proof-view.tsx beside the failed row with the ledger's meaning sentence.

**Acceptance:** No Proof surface renders the string "Expired"; a claim/record in state `expired` prints "Stale observation" wherever a state word appears. A claim stack containing one expired and zero failed claims yields `counts.expired === 1, counts.failed === 0` and the Proof summary tab renders a "Stale observation: 1" row, never "Failed: 1"; the hero verdict for that stack still fails closed with the existing `TURN_EVIDENCE_COPY.failed` copy.

### 91. [medium] Aged endpoint evidence is never reacquired automatically — "Evidence refresh due" is left as routine user work

- **Cluster:** proof-vault  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** medium

**Why (reviewer):** Every cited code fact holds. `grep -n enqueueAutomaticReceiptEvidence src/ui/app.tsx` yields exactly one call site, src/ui/app.tsx:3965, inside `if (turnTransport.id === "chutes-e2ee-v1")` at turn completion. The cold probe at src/ui/app.tsx:2282-2290 has the literal early return `if (attestationRecords.length > 0) return;`. The interval at src/ui/app.tsx:2082-2087 only calls `setAttestationNow`, and `isDisplayFreshAttestation` (src/ui/app.tsx:8803-8805) is a pure read of `record.acquisition.cacheFreshUntil`, so crossing the boundary changes labels only — src/ui/app.tsx:8577-8582 flips to `label: "Evidence refresh due"` and src/ui/proof-inspector.tsx:57-61 to "Receipt evidence refresh due" / "Endpoint comparison expired". `grep cacheFreshUntil|stale|expire src/attestation/evidence-acquisition-queue.ts` returns nothing, so the queue has no freshness re-enqueue. Downgraded to partially-confirmed on framing, not facts: any subsequent protected turn does enqueue fresh evidence (app.tsx:3965), so this is a between-turns idle-window state rather than an unconditional chore; and docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:140 and :267 already record PRF-02 as PARTIAL with exactly this scope open, so it is a known-open register item rather than a regression.

**Root cause:** Acquisition is event-driven off turn completion only. The display-freshness boundary is a pure render-time predicate over `acquisition.cacheFreshUntil` with no scheduler subscribed to it, so no code path can observe expiry and re-enqueue.

**Smallest fix:** Extend the existing 30s tick at src/ui/app.tsx:2082-2087: when `online && chutesConnected && attestationClient.current` and the record matching `lastReceipt` has just failed `isDisplayFreshAttestation`, call `enqueueAutomaticReceiptEvidence(lastReceipt, sessionId, profileId)` once per record (dedupe on `record.recordId` in a ref, and rely on the queue's existing dedupe/retry) rather than adding a second scheduler.

**Acceptance:** With a connected chutes session whose newest record's `cacheFreshUntil` has passed, a background acquisition task appears in the queue snapshot without user input, and the session-bar attestation axis leaves the `stale` / "Evidence refresh due" state once it succeeds. No enqueue occurs while offline, disconnected, or when the record is still display-fresh, and no enqueue fires more than once per record per freshness lapse.

### 92. [medium] Evidence-ledger selection is dropped on deep link and on the message-chip path, so the ledger silently shows the newest record instead

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/attestations-view.tsx  
- **Regression risk:** medium

**Why (reviewer):** Both halves check out, though the chip half is narrower than claimed. src/ui/attestations-view.tsx:145-146 is verbatim `const requestedId = selectedRecordId ?? localRecordId; const selected = records.find((record) => record.id === requestedId) ?? records[0];`, and src/ui/attestations-model.ts:155 sorts newest-first, so the fallback is the newest record — not a null state. `selectedRecordId` reaches it only from `selectedAttestationRecordId` = `activeAttestationPresentation?.selectedRecordId` (src/ui/app.tsx:1340, 7496). DEEP LINK: `grep -n selectEndpointEvidenceRecord src/ui/app.tsx` shows exactly two references (2441 and the 7497 prop). Nothing maps `effectiveProofSelection.receiptId` into the presentation, and src/ui/proof-view.tsx:205 renders `evidenceLedger` as an opaque prebuilt node, so `requestedReceiptId` (app.tsx:7479) reaches only the summary tab. Reloading `#proof?session=X&receipt=R&section=attestations` therefore selects R on Receipt & journal and records[0] on Attestation evidence, unconditionally. CHIP: src/ui/app.tsx:2439-2442 calls `selectEndpointEvidenceRecord(attestationRecordIdForReceipt(receipt))` (id format `receipt:<receiptId>` matches attestations-model.ts:308), but src/ui/app.tsx:5122-5133 no-ops when `!current` — `attestationPresentation` is undefined until `projectEndpointEvidencePresentation` or `publishAttestationFailureForFence` runs, and both require an activated credential-backed evidence authority. Correction to the scout: `describeMessageAttestation` returns undefined unless `isChutesReceiptProvider(receipt.provider)` (src/ui/app.tsx:8698), so the chip does not exist on local-model turns; the reachable chip case is a chutes session whose evidence authority is not bound (disconnected reload with journal-hydrated receipts). It also silently defeats the retention logic in src/ui/attestation-history.ts:20-56, whose own comment says it exists "so a message deep link cannot select another record by accident".

**Root cause:** Record selection is stored only inside `attestationPresentation`, a structure owned by the endpoint-evidence acquisition subsystem, while the two navigation paths that name a record (URL hash and message chip) are route/transcript concerns that can fire before or entirely without that subsystem. There is no route-level selection input to the ledger.

**Smallest fix:** Make the route's own selection authoritative. In src/ui/app.tsx compute `const ledgerSelectedRecordId = selectedAttestationRecordId ?? (effectiveProofSelection?.receiptId ? \`receipt:${effectiveProofSelection.receiptId}\` : undefined)` and pass it as `selectedRecordId` at 7496. Then in src/ui/attestations-view.tsx:145-146, when `requestedId` is set but absent from `records`, render an explicit "the named record is not present in this page runtime" state instead of falling through to `records[0]`.

**Acceptance:** Reloading `#proof?session=S&receipt=R&section=attestations` selects the record whose id is `receipt:R` in the ledger; both Proof tabs name the same receipt. Clicking a non-newest message's attestation chip with `attestationPresentation === undefined` opens the ledger on that receipt. When the requested id resolves to no record, the ledger renders the not-present notice and does not auto-select `records[0]`.

### 93. [medium] Preferences' Durability row can never state adoption: the one call site omits `vaultAdopted`

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/platform-shell.test.ts  
- **Regression risk:** low

**Why (reviewer):** `PreferencesDialog` takes `vaultAdopted` (src/ui/platform-shell.tsx:379, documented at :385-391) and derives `const adoption: DurabilityAdoption = value.vaultBackend === "ephemeral" || vaultAdopted === undefined ? undefined : vaultAdopted ? "connected" : "not-connected"` (platform-shell.tsx:412-414). Grep gives exactly one render site, src/ui/app.tsx:7576-7587, which passes `open`, `value`, `onChange`, `onClose`, `vaultProviderSwitching` and `profileApproval` and no `vaultAdopted`. So `adoption` is always `undefined`: `durabilityOptionLabel` returns the bare destination (platform-shell.tsx:465-471) and `durabilityRowNote` always returns the `"Vault states what is attached."` arm (platform-shell.tsx:478-484). The connected/not-connected arms are exercised only by src/ui/platform-shell.test.ts:149-162. `vaultRuntimeAdopted` is computed at app.tsx:1797 from the same `vaultSnapshot`/`runtime.storageId` the `#vault` route uses (app.tsx:1785-1797).

**Root cause:** The component was given an honest three-state contract and a safe default, but the host was never wired to supply the state, so the safe default is the only reachable state. The unit test asserts the component in isolation, so nothing fails when the prop is dropped at the single integration point.

**Smallest fix:** Pass `vaultAdopted={vaultRuntimeAdopted}` at src/ui/app.tsx:7583 (alongside `vaultProviderSwitching`). The mid-switch case is already handled: non-selected backends render `"not connected"` via platform-shell.tsx:453.

**Acceptance:** With a `local-device` selection and an adopted vault (`runtime.storageId` starting `vault+local-device://`), the Durability trigger reads `This device · connected` and the note reads `... Vault holds it, and can detach it.`; with the same selection unadopted it reads `This device · not connected` and `... Nothing is attached yet — set it up in Vault.`; with `ephemeral` selected it still reads `Page memory only` with no adoption suffix. A test should assert the prop is supplied at the render site, not just that the pure helpers work.

### 94. [medium] Terminal audit records still never reach the session journal or Proof/Memory (TRM-06)

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/terminal/manager.ts, src/terminal/contracts.ts, src/ui/app.tsx, src/core/journal.ts, src/terminal/manager.test.ts  
- **Regression risk:** medium

**Why (reviewer):** `rg 'TerminalAuditRecord|getBrowserTerminalManager' src --glob '!src/terminal/**'` returns only src/ui/terminal-view.tsx:8 and :123; the only other cross-boundary import is `quiesceBrowserTerminalWorkspace` in src/ui/app.tsx (3054, 4135, 4427, 4814), which is lifecycle, not lineage. The record type is complete and bounded (src/terminal/contracts.ts:29-43, `kind: "interactive-input" | "process-start" | "process-exit" | "workspace-reconcile"`, with writerId/sequence/processEpoch/exitCode/changedPaths), and its sole consumer is the `<summary>Audit lineage · {session.audit.length}</summary>` popover at src/ui/terminal-view.tsx:481-498. `rg terminal src/core/journal.ts` returns zero hits; every `terminal` hit in src/core/session-audit.ts is turn/tool terminal-state vocabulary (e.g. `turn.terminal = "completed"` at :1325), not the shell. So nothing binds a shell command to a workspace generation or Git head in the production journal. This is confirmed but not new: docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:265 already records TRM-06/PRF-07 as PARTIAL with the exact residual "Terminal records are not appended to the production session journal or traversable through Proof/Memory" — it is an open directive, not a regression.

**Root cause:** Terminal lineage was implemented as a self-contained bounded record set inside the terminal manager with no emitter into the journal event stream; there is no seam between BrowserTerminalManager and the session-audit/journal layer at all.

**Smallest fix:** Give BrowserTerminalManager an optional `onAuditRecord(record, session)` sink injected from src/ui/app.tsx where the journal is already in scope, called from `appendAudit` (src/terminal/manager.ts:682-697), and append one journal event per record carrying sessionId, profileId, processEpoch, writerId and (for workspace-reconcile) changedPaths. Keep it optional so the manager stays usable without a journal, and reuse the existing bounded/redaction limits so no PTY secret text is emitted beyond the already-bounded `command` field.

**Acceptance:** Starting a terminal, submitting one line, and reconciling produces three journal entries in the production session journal bound to the terminal session id, profile id and process epoch, with the reconcile entry carrying the changed workspace paths; those entries are reachable from the Proof view for that session; and the journal is unchanged when no sink is supplied.

### 95. [medium] The Durability row offers destinations the running deployment cannot reach; the availability predicate gates loading but never the option list

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/platform-shell.tsx, src/ui/platform-shell.test.ts  
- **Regression risk:** low

**Why (reviewer):** `VAULT_BACKENDS` is `Object.keys(DURABILITY)` — all four (src/ui/platform-shell.tsx:293) — and the Durability select maps every one of them into options with no availability filter and no per-option disabled flag (src/ui/platform-shell.tsx:445-457). `availableVaultBackend` (src/ui/platform-shell.tsx:243-253) is referenced only from `resolveDefaultVaultBackend` and `loadPreferenceOverrides` (:356), i.e. only when reading persisted state, and it returns `local-lab` unconditionally — it has no loopback test. Choosing "Local MinIO lab" off loopback hits `if (!isLoopbackAirshipLocation(window.location))` and returns after only setting a runtime status string, leaving the runtime on page memory (src/ui/app.tsx:1949-1954), while the Preferences row keeps reading "Local MinIO lab". Choosing "Google Drive" without `VITE_GOOGLE_CLIENT_ID` persists a value that `availableVaultBackend` discards on the next load (src/ui/platform-shell.tsx:356), so the selection silently reverts. VLT-04's acceptance is explicit — "unavailable providers are disabled/greyed rather than selectable" (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:154) — and it is listed as still open at :626. The affordance already exists and is simply unused here: `MenuSelect` honours a per-option `disabled`, skipping it in pointer, Home/End and arrow navigation (src/ui/menu-select.tsx:96, 137-139, 168-188).

**Root cause:** Availability is modelled as a validation step on persisted input rather than as a property of a destination. The option list is derived from the presentation table `DURABILITY`, which describes what each destination *is*, not whether this deployment can reach it, so nothing in the render path ever consults `availableVaultBackend` — and that predicate does not know about loopback at all.

**Smallest fix:** Make availability one predicate used in both places. Extend `availableVaultBackend` to take the location and return undefined for `local-lab` when `isLoopbackAirshipLocation` is false (reusing the check already at src/ui/app.tsx:1951), then widen `PreferenceSelect`'s option tuple with an optional fourth `disabled` member and pass it straight through to `MenuSelect` (src/ui/platform-shell.tsx:496-497). Render every backend, marking the unreachable ones disabled with the reason as their description — greyed and explained beats absent, which would silently rewrite the row on a deployment change.

**Acceptance:** Unit (src/ui/platform-shell.test.ts): with no Google client ID and a non-loopback location, the Durability options for `google-drive` and `local-lab` carry `disabled: true` and a reason string, while `local-device` and `ephemeral` do not; on a loopback location `local-lab` is enabled; with a deployable client ID `google-drive` is enabled. Interaction: clicking a disabled option does not call `onChange` (src/ui/menu-select.tsx:96), and arrow/Home/End navigation skips it. E2E: `e2e/vault-auto-adoption.spec.ts:68` still selects "Local MinIO lab" successfully on the loopback lab origin.

### 96. [medium] The Vault route's adoption-failure line is unreachable: no caller passes `adoptionNotice`

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/vault-view.tsx  
- **Regression risk:** low

**Why (reviewer):** `rg -n adoptionNotice src/ e2e/` returns exactly three hits, all in src/ui/vault-view.tsx (the prop declaration at :20 with its doc comment at :12-19, the destructure at :139, and the render at :321 `{!runtimeAdopted && adoptionNotice ? <p class="vault-view__warning" role="alert">{adoptionNotice}</p> : null}`). The only mount is src/ui/app.tsx:7405-7428, which passes `snapshot`, `runtimeAdopted`, `contextMode`, `contextPublishing`, `contextPublicationMessage`, `provider`, `localDeviceStatus`, `providerSwitching`, `onProviderChange`, `onOpenSetup`, `onProbe`, `onCancelProbe`, `onReauthorize`, `reauthorizing`, `onPublishContext`, `onDisconnect` — and not `adoptionNotice`. The failure sentences do exist and go only to `runtimeStatus`: `Local vault adoption failed: ${error.message}` (src/ui/app.tsx:2056-2059) and the quarantine sentence at :4677-4681, both surfaced solely by the single-line `title`-truncated topbar at src/ui/app.tsx:6869. One refinement to the scout's framing: the alert row lives inside the `snapshot.phase === "ready"` outcomes list (src/ui/vault-view.tsx:303-323), so even if wired it would only ever cover the google-drive/local-lab adoption path — Local Device failures land in `localDeviceError` (src/ui/app.tsx:2020-2024), which the route already renders separately at src/ui/app.tsx:7440. So this is a real dead branch, but a narrower one than "the Vault route never states why adoption failed".

**Root cause:** The prop was designed and rendered but never connected to a state in app.tsx; there is no state holding "the last adoption failure sentence" — the reason is written straight into `runtimeStatus`, a single mixed-purpose string that the Vault route deliberately does not read.

**Smallest fix:** Add a `const [vaultAdoptionNotice, setVaultAdoptionNotice] = useState<string>()` in src/ui/app.tsx, set it in the cloud/lab adoption `.catch` at :2056-2059 (and clear it on success and in `changeVaultProvider`), and pass `adoptionNotice={vaultAdoptionNotice}` at the mount (src/ui/app.tsx:7405-7428). If that is not wanted, delete the prop, the destructure and the `<p role="alert">` row instead — but do not leave a documented surface no state can reach.

**Acceptance:** A unit/component test renders `VaultView` with `snapshot.phase === "ready"`, `runtimeAdopted={false}` and an `adoptionNotice`, and asserts the `role="alert"` paragraph contains that exact sentence; plus an assertion in the app wiring that a rejected `adoptReadyVaultRuntime` sets the state that is passed to `adoptionNotice`, so the Vault route shows the runtime's own message rather than only the generic "still page-memory until adoption completes" line. Alternatively, `rg adoptionNotice src/` returns zero hits after removal.

### 97. [medium] Vault route decides Drive availability with a weaker predicate than the preference sanitiser, so a malformed client ID reads as available

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/vault-view.tsx, src/ui/google-drive-setup.tsx, src/ui/vault-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** Both predicates read exactly as cited and they genuinely disagree. src/ui/vault-view.tsx:131-133 is `return ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? "").length > 0;`, while `isDeployableGoogleOAuthClientId` (src/storage/google-drive-configuration.ts:8-13) requires `/^[A-Za-z0-9._-]{12,256}\.apps\.googleusercontent\.com$/u` and a ≤512 length bound. The sanitiser side uses the strict one: src/ui/platform-shell.tsx:247-248 and :356 (`vaultBackend: availableVaultBackend(value.vaultBackend, googleClientId) ?? availableDefault`), so a stored `google-drive` preference is silently rewritten on the next load. src/ui/google-drive-setup.tsx:38 uses the same weak truthiness, and its effect at :53-64 constructs `new capabilities.GoogleIdentityServicesAuthorizer(clientId, provider)`, which throws `Google OAuth client ID is invalid.` (src/storage/google-drive-auth.ts:112-114); the rejection is caught at :62-64 into the generic `Google sign-in could not be prepared…` while `prepared` stays false, leaving the button permanently reading `Preparing Google sign-in…` and `disabled` (src/ui/google-drive-setup.tsx:216). The doc comment at src/ui/vault-view.tsx:127-130 claiming it reads "the one provider-availability fact this build actually computes" is true of the variable and false of the predicate, as claimed. Scope note: this only bites a misconfigured deployment (non-empty, non-canonical client ID), which is why medium is right.

**Root cause:** Two implementations of one fact. `isDeployableGoogleOAuthClientId` is the product's availability predicate but src/ui/vault-view.tsx and src/ui/google-drive-setup.tsx each re-derive availability from raw env truthiness instead of importing it.

**Smallest fix:** Import `isDeployableGoogleOAuthClientId` from src/storage/google-drive-configuration.ts in both files: replace the body of `googleDriveConfiguredInBuild()` (src/ui/vault-view.tsx:131-133) with `return isDeployableGoogleOAuthClientId(import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined);`, and at src/ui/google-drive-setup.tsx:38 keep `clientId` for the authorizer but gate every `clientId ? …` render branch and the effect on a `const available = isDeployableGoogleOAuthClientId(clientId)` derived once. The module is already a plain function with no side effects, so no bundle-split concern.

**Acceptance:** With `VITE_GOOGLE_CLIENT_ID="not-a-client-id"`: `googleDriveConfiguredInBuild()` returns false; the Vault provider option for `google-drive` carries the `— unavailable in this build` description and the `Unavailable in this build` column marker; the setup panel heading is `Google Drive is not available in this build`; and `resolveDefaultVaultBackend("google-drive", "not-a-client-id")` returns `"local-device"` — i.e. one unit test asserts route text and preference sanitiser agree for the same value across the empty, malformed and canonical cases.

### 98. [medium] "Apply in a new session" on the Skills route silently switches the active Profile to the preview target and swallows every failure

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** In global scope `scopedProfileId = selectedProfileId` from the 'Preview resolution for' menu (src/ui/app.tsx:9244, :9272), and the button applies exactly that profile: `onClick={() => void onApply(profile.profileId)}` (src/ui/app.tsx:9274) wired to `onApply={async (id) => { await changeProfile(id, true); navigate("chat"); }}` (src/ui/app.tsx:7399). `changeProfile` is a full cockpit switch — it aborts the active turn, quiesces the outgoing profile's terminals, rebuilds tools/Git authority and publishes a new profile id (src/ui/app.tsx:3020-3115) — and it throws at src/ui/app.tsx:3024 when `inferenceRouteChanging`/`sessionNavigationChanging` is set. The `void` discards that rejection; `rg unhandledrejection src` returns nothing, so nothing is shown, while `updateGlobal`/`updateProfileSkill` in the same component both funnel errors into the `role="status"` region (src/ui/app.tsx:9248-9265, :9293). Correction to the scout: the identical swallow exists on the Profiles route (`onClick={() => void onActivate(selected.profileId)}`, src/ui/app.tsx:9204), so the fix should cover both; only the unannounced profile *change* is Skills-specific, since the Skills menu is labelled 'Preview resolution for' rather than as a selection of the profile to activate.

**Root cause:** A profile-mutating navigation action is invoked as a fire-and-forget `void` promise from a component that otherwise routes all outcomes through local status state, and the Skills route reuses the Profiles route's 'Apply in a new session' label for a control whose subject is a preview selector rather than an explicitly selected profile.

**Smallest fix:** In `SkillsManagerView`, replace the inline `void onApply(...)` with a local `async function apply()` that `try { await onApply(profile.profileId); } catch (error) { setStatus(...) }` exactly like `updateGlobal` (src/ui/app.tsx:9248-9256), and change the button text to name the target, e.g. `Apply {profile.name} in a new conversation`. Apply the same try/catch at src/ui/app.tsx:9204.

**Acceptance:** With `changeProfile` stubbed to reject, clicking the Skills route's apply button leaves the route on `#skills` and renders the rejection message inside the component's `role="status"` element; the button's accessible name contains the name of the profile that will become active.

### 99. [medium] "Apply in a new session" resumes the profile's existing conversation instead of creating one

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** Both buttons are literally labelled 'Apply in a new session' — src/ui/app.tsx:9204 (profile editor, `void onActivate(selected.profileId)`) and :9274 (Skills toolbar, `void onApply(profile.profileId)`) — and both handlers are `async (id) => { await changeProfile(id, true); navigate("chat"); }` at :7381 and :7399. `changeProfile` resolves an existing conversation first (`compatibleProfileSession` at :3062-3068, which delegates to `resolveResumableProfileConversation`, src/sessions/profile-cockpit.ts:167) and only falls through to `createProfileSession` when none matches (:3069). On the restore path the status literally reads `${profile.name} cockpit restored` (:3100). The route description at :9119 says 'applying one forks a pinned session', which is false in both readings: the restore path resumes and the fallback path creates — neither forks. This is the labelling residue of PIA-04, whose implementation is recorded at docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:255 ('restores an existing compatible conversation rather than manufacturing one') while the PIA-04 gate itself says 'New conversation remains the only ordinary creation gesture' (:40). So the behaviour is right and the copy is wrong — but only the copy is a defect, and a user pressing this button to get a clean slate gets the opposite.

**Root cause:** The two Apply controls and the Profiles route description still describe the pre-PIA-04 behaviour (`changeProfile` used to always create). The strings were never updated when the resume-the-cockpit semantics landed, so the UI promises creation and the code performs restoration.

**Smallest fix:** Retitle both buttons to describe the actual action — e.g. 'Switch to this profile' (src/ui/app.tsx:9204, :9274) — and replace the RouteBar description at :9119 with 'Manage agent personas, instructions, and interface themes. Saves create content-addressed revisions; switching restores that profile's most recent compatible conversation.' Leave creation with New conversation.

**Acceptance:** Neither Apply control's accessible name contains 'new session'; the Profiles route description contains no claim that applying forks or creates a session. A journey that opens Profiles, selects a profile with an existing compatible conversation, and activates it lands on that existing conversation with the 'cockpit restored' status, and the control's label is consistent with that outcome.

### 100. [medium] Archiving the scoped profile leaves the Skills scope control reading "All profiles" while every toggle writes to a different single profile

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/menu-select.tsx  
- **Regression risk:** low

**Why (reviewer):** `profileHubScope` is shell state (src/ui/app.tsx:940) written only at src/ui/app.tsx:2330 (`openProfileManager`) and by the 'Skill scope' MenuSelect (src/ui/app.tsx:7373); `rg setProfileHubScope` returns exactly those two writers. `deleteProfile` (src/ui/app.tsx:6438-6448) archives via `archiveProfileRevision` and never touches it, while `ProfileManagerView` does repair its own selection (src/ui/app.tsx:9048-9049). With a stale scope, `MenuSelect` resolves the unknown value through `Math.max(0, options.findIndex(...))` (src/ui/menu-select.tsx:38) and renders `options[0]` — which is `{ value: "global", label: "All profiles" }` (src/ui/app.tsx:7373). Meanwhile `SkillsManagerView` computes `scopedProfileId = scope` (not 'global'), falls back to `profiles[0]!` (src/ui/app.tsx:9245), and every control calls `onSetProfile(profile.profileId, ...)` (src/ui/app.tsx:9260) → `setProfileSkill` mints a revision of that fallback profile (src/ui/app.tsx:6458-6471). The trigger therefore names 'All profiles' while the writes are per-profile. The card body does print the fallback profile's name next to the select, which limits but does not remove the mismatch, and the PIA-05 gate is explicitly 'the active profile/global skill scope is visible before mutation' (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:41).

**Root cause:** `profileHubScope` is an unvalidated free-floating string never reconciled against `managedProfiles(catalog)`; the shared `MenuSelect` silently coerces an unrepresented value to option 0 instead of surfacing it, so an archived scope reads as the semantically opposite option.

**Smallest fix:** Add one effect beside the profile-hub state in src/ui/app.tsx: when `profileHubScope !== "global" && !managedProfiles(catalog).some(p => p.profileId === profileHubScope)`, call `setProfileHubScope("global")`. (Secondary hardening, optional: have `MenuSelect` render the raw `value` or an explicit unset state when `findIndex` returns -1, rather than option 0.)

**Acceptance:** Component/e2e test: open `#skills`, set 'Applies to' to a non-active profile P, archive P from the Profiles tab, return to Skills — the 'Skill scope' trigger reads 'All profiles' AND each skill card renders the `role="switch"` 'Global default' control (not an inherit/on/off select); toggling one calls `setGlobalSkill`, and `catalog.profiles` gains no new revision for any profile.

### 101. [medium] Landscape phones 861-950px wide lose the rail and never gain the compact profile switcher

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/menu-select.css, src/ui/shell.css, src/ui/routes.css, e2e/responsive-breakpoints.spec.ts  
- **Regression risk:** low

**Why (reviewer):** The mobile-shell query is `@media (max-width: 640px), (max-width: 950px) and (max-height: 500px)` (src/ui/routes.css:2376), and it hides the rail at :2414-2419 (`.edition, .brand-name, .runtime-line, .sidebar { display: none; }`). The topbar substitute is `.compact-profile-menu`, declared `display:none` at src/ui/menu-select.css:31 and revealed only by `@media (max-width:860px) { .compact-profile-menu { display:block; } }` at :39 — a width-only query with no landscape clause; I grepped every stylesheet for the class and those are the only two rules. So at 932x430 and 896x414 both the rail and the switcher are `display:none`. The repo's own spec proves the rail is gone at exactly that viewport: e2e/responsive-breakpoints.spec.ts:107 iterates `{ width: 932, height: 430 }` and :114 asserts `getByRole("navigation", { name: "Primary" })` is hidden. The landscape block at routes.css:3202-3269 restores the session-bar rename action and brand padding but touches no profile control. The only remaining path is More -> Profiles -> Activate (src/ui/app.tsx:7381 `onActivate`), three taps deep, and MOBILE_MORE_ENTRIES (src/ui/navigation-model.ts:275) confirms Profiles is a More route. PIA-01 is not recorded as closed for this viewport.

**Root cause:** Two different definitions of "phone" coexist: routes.css withdraws the rail on the shell query (width<=640 OR width<=950 with height<=500) while menu-select.css reveals the replacement on a plain `max-width:860px`. The bands overlap for portrait but not for 861-950px landscape, so the reveal condition is not the complement of the withdrawal condition.

**Smallest fix:** Change src/ui/menu-select.css:39 to `@media (max-width:860px), (max-width:950px) and (max-height:500px) { .compact-profile-menu { display:block; } }` so the switcher appears wherever the rail is withdrawn. While there, delete or retarget the dead `.compact-profile-select` rules (src/ui/shell.css:516-530, src/ui/routes.css:2329-2331, :2447-2450) that no element carries, so the cascade cannot be misread as intentionally hiding this control on phones.

**Acceptance:** E2E (mobile project) at 932x430 and 896x414 on #chat: `getByRole("navigation", { name: "Primary" })` is hidden AND a control named `Agent profile` is visible with a >=44px hit box; opening it lists the managed profiles and selecting one changes the active profile without navigating away. Portrait 390x844 keeps the same control visible (no regression).

### 102. [medium] Mobile bottom bar labels completed work as "pending" and hangs the attestation badge on a tab that does not contain it

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/mobile-navigation.tsx, src/ui/app.tsx, src/ui/navigation-model.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/app.tsx:7566-7567 passes `proofPending={Boolean(lastReceipt)}` and `attestationPending={attestationRecords.length + (attestationFailure ? 1 : 0)}`; `attestationRecords` is the acquired endpoint-evidence list (app.tsx:1338 `activeAttestationPresentation?.records`), i.e. completed acquisitions, and it is consumed elsewhere as evidence, not as a queue (:7494, :7508). src/ui/mobile-navigation.tsx:270-273 formats every count as `${count} pending ${noun}${...}`, and :120 passes the noun `"completed turn"`, producing the self-contradictory "3 pending completed turns". The attestation count is attached to the More tab (:113-118 `control.id === "more" ? attestationNoticeCount`), but src/ui/navigation-model.ts:270-282 (MOBILE_MORE_ENTRIES) contains no `proof` route — proof maps to the `trust` control (MOBILE_CONTROL_BY_VIEW at :288), so the per-entry guard at mobile-navigation.tsx:227 `entry.view === "proof" ? attestationNoticeCount : 0` can never be non-zero and the badge points at a sheet with no matching destination. Desktop states the same facts differently: src/ui/rail.tsx:247 labels the chat badge `${unreadTurnCount} completed turn(s)` with no "pending", and :249 draws a neutral `nav-proof-dot` for `hasReceipt` with no number.

**Root cause:** One generic `pendingLabel()` was applied to three different quantities, two of which are completed-work counts rather than queues, and the badge routing was keyed to the tab that owns most secondary routes (`more`) instead of the tab that actually owns the Proof destination (`trust`, per MOBILE_CONTROL_BY_VIEW).

**Smallest fix:** In src/ui/mobile-navigation.tsx: (a) label the chat badge with the rail's exact string, `${count} completed turn${count === 1 ? "" : "s"}`, not `pendingLabel`; (b) move the attestation count off `more` — either fold it into the `trust` control (which is where `proof` lives) or drop it, and delete the dead `entry.view === "proof"` branch at :227; (c) render Proof presence as the same neutral dot the rail draws rather than a "1 pending proof item" numeric badge for `Boolean(lastReceipt)`.

**Acceptance:** Unit (mobile-navigation): with one receipt and five attestation records, no badge label contains the word "pending" for completed-work counts; the chat badge label equals the rail's label for the same `unreadTurnCount`; no numeric badge is attached to a control whose destinations (MOBILE_MORE_ENTRIES / MOBILE_CONTROL_BY_VIEW) do not include the badged view. A test asserting every badged control's target route set is non-empty.

### 103. [medium] Skills and Capabilities have no desktop entry point outside the profile-hub tab strip — absent from rail, command palette, and keyboard jumps

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/navigation-model.ts, src/ui/navigation-model.test.ts, src/ui/platform-shell.test.ts, e2e/route-adversarial-audit.spec.ts  
- **Regression risk:** low

**Why (reviewer):** `CANONICAL_DESTINATIONS` files `destination("profiles", "Profiles", "Agent", "profile")` with no nested array (src/ui/navigation-model.ts:121), and `RAIL_LAYOUT` lists chat/workspace(editor,terminal)/memory/proof + vault/access/billing (src/ui/navigation-model.ts:190-211) — neither skills nor capabilities. `buildPaletteEntries` iterates only `CANONICAL_DESTINATIONS` and their `nested` (src/ui/platform-shell.tsx:36-52) and `filterPaletteEntries` is a plain substring match over label/description/group/keywords (src/ui/platform-shell.tsx:709-716), so 'skills' matches no entry and the palette shows 'No matching destination or command.' (src/ui/platform-shell.tsx:163). `NAVIGATION_JUMPS` has no key for either (src/ui/platform-shell.tsx:186-188). Mobile does carry both (src/ui/navigation-model.ts:270-282, `moreRoute("skills", ...)`), so desktop and mobile disagree, contradicting docs/CANON.md:288 and the CANON surface table at :297-298. Note src/ui/navigation-model.test.ts:56 currently *asserts* `expect(profiles?.nested).toEqual([])`, so the omission is codified.

**Root cause:** `skills` and `capabilities` exist in `NavigationView`/`VIEW_HASHES` and are already legal `NestedDestinationId`s (src/ui/navigation-model.ts:20), but were never added to `CANONICAL_DESTINATIONS`, which is the single table the rail, the palette and the jump chords all derive from.

**Smallest fix:** Add two nested entries under the profiles destination: `destination("profiles", "Profiles", "Agent", "profile", [nestedDestination("skills", "Skills", "profile"), nestedDestination("capabilities", "Capabilities", "profile")])` (src/ui/navigation-model.ts:121). Palette entries come free from the existing nested loop; `RAIL_LAYOUT` is unaffected because `profiles` is not a rail row. Update the codified assertion at src/ui/navigation-model.test.ts:56. Optionally add a `k`/`y` chord to `NAVIGATION_JUMPS`.

**Acceptance:** `buildPaletteEntries({...})` contains entries with ids `view:skills` and `view:capabilities` whose `run()` navigates to those views; `filterPaletteEntries(entries, "skills")` returns at least one entry labelled 'Skills'; navigation-model test asserts `profiles.nested` contains both with hashes `#skills` and `#capabilities`; e2e/route-adversarial-audit.spec.ts:34-35 can drop `deepLinkOnly: true` for both rows.

### 104. [medium] The beforeunload guard is armed for the entire life of the app, including when an adopted Vault can reconstruct everything

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/platform-shell.tsx, src/ui/platform-shell.test.ts  
- **Regression risk:** medium

**Why (reviewer):** src/ui/app.tsx:1243 is literally `useBeforeUnloadGuard(busy || Boolean(sessionId));`. `sessionId` is set by `activateSession` during boot (app.tsx:2595-2601), so the predicate is true from the moment the shell mounts, on an untouched empty conversation. The hook itself unconditionally cancels the unload (src/ui/platform-shell.tsx:628-635: `event.preventDefault(); event.returnValue = "";`). Nothing in the predicate consults durability: `vaultRuntimeAdopted` exists at app.tsx:1797 and `eventCount` is tracked (app.tsx:2603), and neither is used. The product's own `Reload Airship` button calls `pwaUpdate.reload` (app.tsx:7589), which ends in `window.location.reload()` (platform-shell.tsx:701) and therefore raises the same browser dialog. Note the guard only fires after sticky activation, which the scout states correctly. Compare the workbench's guard at app.tsx:9039, `useBeforeUnloadGuard(dirty || busy)`, which is the shape this one should have.

**Root cause:** The guard's predicate is session *existence*, not unsaved or unreconstructable work. PIA-08's gate (docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:44) asks for protection derived from live ephemeral work; the app substitutes the cheapest always-true proxy, which makes the dialog unconditional and trains it to be dismissed.

**Smallest fix:** Replace app.tsx:1243 with a derived predicate: `useBeforeUnloadGuard(busy || (!vaultRuntimeAdopted && eventCount > 0))`, and suppress it for the app's own reload by setting a ref in the `onReload` handler at app.tsx:7589 that the predicate reads (or lift the guard's `active` to false before calling `pwaUpdate.reload()`).

**Acceptance:** A pure predicate (extracted so it is unit-testable) returns false for {idle, eventCount 0}, false for {idle, eventCount 12, vaultRuntimeAdopted true}, true for {idle, eventCount 12, vaultRuntimeAdopted false}, true for {busy}; and pressing `Reload Airship` does not leave a `beforeunload` listener registered.

### 105. [medium] An executing tool step is labelled "Approved" with the verified seal; the running state is unreachable

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/message-parts-view.tsx, src/ui/chat/message-parts-view.css, src/ui/chat/message-parts-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** `src/core/agent.ts:452-462` appends `type: "tool.approved"` then emits only a transient signal — `notifySignal(options.onSignal, { type: "status", turnId, status: `running ${call.name}` })` — before `await options.tools.executeApproved(...)`. `src/ui/chat/message-parts.ts:355-364` is the only producer of a `tool-status` fact and it hardcodes `status: "approved"`; I grepped every `"running"` literal in `src/` and the only chat-side occurrences are the consumers (`message-parts-view.tsx:73,170,241,293,468`, `message-parts.ts:57`) — no producer. `src/ui/app.tsx:3908-3916` handles the `status` signal with `setRuntimeStatus(signal.status)` and `{ ...message, status: humanStatus(signal.status) }` only; the `tool-output` handler (`:3920-3933`) writes `liveToolOutput`, never a status fact. So `pairedOutcome`'s `if (call?.status === "running") return "running"` (`message-parts-view.tsx:293`) is dead, and for the entire execution the row renders `OUTCOME_COPY.approved` = `{ word: "Approved", ... seal: "verified" }` (`:245`) with `acting={operation.outcome === "running"}` false (`:468`), coloured identically to a completed step by `src/ui/chat/message-parts-view.css:73` (`.op[data-outcome="ran"] .op__outcome, .op[data-outcome="approved"] .op__outcome { color: var(--v-verified); }`).

**Root cause:** Execution start is only ever a transient message-level AgentSignal; there is no durable event nor any UI reducer that turns `tool.approved` into an executing tool-status, so the vocabulary's `running` row is unreachable and `approved` is doing double duty as both 'permission granted' and 'currently executing' while wearing the settled-positive seal.

**Smallest fix:** Reuse the same terminal-awareness added for the stopped-strip fix: in `pairedOutcome`, when the turn is not terminal, map `call.status === "approved"` with no result to `running` (the `OUTCOME_COPY.running` row and `--state-acting` CSS already exist); when the turn is terminal, map it to the abandoned outcome. Then remove `approved` from the `--v-verified` selector in `message-parts-view.css:73` so no unsettled step shares the completed colour.

**Acceptance:** With events tool.requested → tool.approved and no result and no turn terminal, the paired operation's outcome is `running`, its rendered word is not "Approved", its seal state is `checking`, and `acting` is true. With tool.resulted added, the outcome is `ran` with the `verified` seal. No CSS rule gives an unsettled outcome `var(--v-verified)`.

### 106. [medium] Approval provenance is journaled but never surfaced or validated

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/core/session-audit.ts, src/ui/chat/session-message-presentation.ts, src/core/session-audit.test.ts  
- **Regression risk:** medium

**Why (reviewer):** `tool.approved`/`tool.denied` carry `approval: provenance ?? null` (src/core/agent.ts:446-459) and so do `local.command.approved`/`local.command.denied` (src/ui/app.tsx:3364, :3370). I verified the provenance actually reaches those events in production — `SwitchableApprovalPolicy.takeProvenance` does forward to the delegate (src/approvals/switchable-policy.ts:36-40) — so this is a real payload, not dead weight. Then I grepped the four provenance `source` literals across the repo: outside src/approvals/ they appear only at src/core/contracts.ts:268 (the type) and src/core/agent-tool-safety.test.ts:104 (one test). No transcript, proof or inspector surface reads `payload.approval`. In src/core/session-audit.ts:1261-1286 the `tool.approved`/`tool.denied` branch validates `payload.callId`, `payload.name`, duplication and (for denials) `payload.content` — `payload.approval` is never inspected, so an approved effectful call with `approval: null` or with a `mode` that disagrees with `manifest.profile.approvalMode` audits clean. One detail of the scout's write-up is wrong and I am not carrying it: the registry's pre-policy short-circuits (src/tools/registry.ts:104-115) return `"deny"`, so they produce `tool.denied` with a null approval, not an approved call. The validation gap stands on its own.

**Root cause:** Provenance was added as a payload field without a corresponding reader on either side of the contract: the audit reducer's per-event required-field table does not include it, and no presentation model projects it onto the tool row.

**Smallest fix:** Two additions. (a) In src/core/session-audit.ts:1261-1286, require `payload.approval` to be a plain record with a known `source` and a `mode` equal to the session manifest's `profile.approvalMode` on `tool.approved` (and on `local.command.approved`), adding a `TOOL_APPROVAL_PROVENANCE_INVALID` protocol issue otherwise. (b) In src/ui/chat/session-message-presentation.ts, carry the provenance `source`/`mode` onto the tool row so the transcript can label it ('You approved', 'Model review', 'Full Access').

**Acceptance:** 1) A journal containing `tool.approved` with `approval: null` produces a `TOOL_APPROVAL_PROVENANCE_INVALID` protocol issue. 2) A journal whose `tool.approved.approval.mode` differs from the manifest's pinned `approvalMode` produces the same issue. 3) A well-formed provenance record still audits `verified`. 4) A presentation test asserts a completed turn's tool row exposes the authority label distinguishing human approval from model review from Full Access.

### 107. [medium] Auto Approve claims only bounded metadata is reviewed, but ships scripts, code and URLs to the provider

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/ui/platform-shell.tsx, src/approvals/model-reviewer.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/approvals/model-reviewer.ts:8 is exactly `const PRIVATE_PAYLOAD_KEY = /(?:content|body|payload|data|bytes|old[_-]?text|new[_-]?text|patch|message)/iu;` and :25 applies it as `withholdPrivatePayloads(redactForDisplay(options.argumentsValue))`. `script` (execute_shell, src/tools/execution-tools.ts:582), `code`, `url` (fetch_url, src/tools/network-tools.ts:25), `query` and `paths` match none of those alternatives, so those values are streamed to the provider truncated at 512 chars by src/approvals/broker.ts:166. Meanwhile src/ui/app.tsx:3361 tells the user on denial that 'the separate safety review received only bounded metadata with private payload fields withheld.' I confirmed reachability by a user action rather than only by the model: src/commands/registry.ts:88-126 turns every `options.tools.definitions()` entry into a slash command, and both production call sites build the registry with no `exposeTool` filter (`createSlashCommandRegistry({ tools })` at src/ui/app.tsx:2576, :3079, :4637), so `/execute-shell script="..."` is directly reachable and its script body goes to the provider.

**Root cause:** The withhold predicate is a regex over generic payload-ish key names rather than a decision about which fields constitute the action body; the user-facing denial copy then asserts a stronger privacy property ('only bounded metadata') than the predicate delivers. Note the reviewer genuinely needs the script/url/code to judge safety at all, so widening the withhold list would blind the review — the copy is the wrong half.

**Smallest fix:** Correct the assertion rather than the redaction: change src/ui/app.tsx:3361 to state that the safety review received the proposed action's parameters (including any script, code or URL) with file-content payloads withheld and values bounded. Make the same statement in `approvalModeDescription("auto-approve")` (src/ui/platform-shell.tsx:480) so the mode picker and the denial agree.

**Acceptance:** 1) A test asserts the Auto Approve local-command denial string does not contain 'only bounded metadata' and does state that the action's parameters are sent to the review model. 2) A test asserts `withholdPrivatePayloads({ script, url, content })` withholds `content` and preserves `script`/`url`, pinning the intended (documented) behaviour. 3) `approvalModeDescription("auto-approve")` names the provider round-trip.

### 108. [medium] Auto Approve's per-effect review inference has no usage, receipt or turn record

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/approvals/model-reviewer.ts, src/approvals/modes.ts, src/ui/app.tsx, src/core/session-audit.ts  
- **Regression risk:** medium

**Why (reviewer):** src/approvals/model-reviewer.ts:30-39 opens a full `options.transport.stream({... turnId: `${turnId}:approval-review` ...})` for each adjudicated effectful call, and the module imports nothing from the journal. The App seam that wires it (src/ui/app.tsx:1069-1086) passes only `transport`, `model`, `tool`, `argumentsValue`, `context` — no journal handle. I grepped every producer of `inference.usage`: the only one is src/core/agent.ts:382 inside `runTurn`. src/core/session-audit.ts:54-80 `KNOWN_EVENT_TYPES` has no approval-review type, and src/core/session-audit.ts:656-662 flags any unlisted type as `EVENT_TYPE_UNKNOWN`, so today there is nowhere for such a record to live. I also confirmed the fix is mechanically available: the transport's event union includes `{ type: "usage"; inputTokens?; outputTokens? }` (src/core/contracts.ts:219), and the reviewer's loop at :40-51 handles only `tool-call`/`text-delta`/`completed` — it drops `usage` on the floor. So in Auto Approve a ten-tool turn issues eleven provider requests while the session's event count and token accounting describe one.

**Root cause:** The safety reviewer was built as a pure function over a transport with no journal seam, and the audit contract's closed event vocabulary has no slot for a non-turn inference, so its cost is structurally unrecordable rather than merely unrecorded.

**Smallest fix:** Capture the dropped `usage` event in src/approvals/model-reviewer.ts (add `inputTokens`/`outputTokens` to `SafetyReviewResult`), give the App's `safetyReview` seam (src/ui/app.tsx:1071-1085) an append callback, and journal one `inference.usage` event keyed to `operationId: context.operationId` (the call being adjudicated) with `turnId: context.turnId`. `inference.usage` is already in `KNOWN_EVENT_TYPES`, so no new event type or reducer branch is needed — verify src/core/session-audit.ts:1165 tolerates a usage event whose operationId is a tool call ID, and relax it there if not.

**Acceptance:** 1) An Auto Approve turn with N effectful tool calls appends N safety-review usage records in addition to the turn's own, and the session's reported token totals include them. 2) `auditSession` reports `verified` for such a journal. 3) A test asserts `reviewToolActionWithModel` returns the token counts emitted by the transport's `usage` event. 4) The billing/usage surface's total for the session equals the sum of all `inference.usage` events including review inferences.

### 109. [medium] Full Access permits unbounded network egress while claiming workspace/path boundaries

- **Cluster:** tools-permissions  
- **Verdict:** partially-confirmed  
- **Files:** src/approvals/modes.ts, src/ui/platform-shell.tsx, src/ui/app.tsx, src/approvals/modes.test.ts  
- **Regression risk:** low

**Why (reviewer):** Every code fact checks out. src/approvals/modes.ts:37-47 auto-allows all `read` effects in every mode; :51-58 short-circuits Full Access for every remaining effect with provenance `source: "bounded-browser-sandbox"`, `reason: "Allowed by Full Access inside the existing browser capability and path boundaries."` — no per-effect ceiling. `fetch_url` is `effect: "network"` (src/tools/network-tools.ts:17-31), is registered unconditionally in the production bundle (src/tools/tool-bundle.ts:40), and `safeHttpUrl` (src/tools/network-tools.ts:200-213) rejects only non-HTTPS-non-loopback schemes and embedded credentials — I grepped for any host allowlist and there is none. src/ui/app.tsx:7236 describes Full Access as 'Allow effects inside the bounded browser workspace without prompting' and src/ui/platform-shell.tsx:481 as bounded by 'path confinement, and network boundaries'. So the exfiltration path (read_file auto-allowed, then fetch_url with the bytes in the query string, no prompt) is real. I mark this partially-confirmed because the scout's *expected* behaviour — that Full Access should still prompt for `network` — contradicts the mode's stated purpose and is a design opinion, not a defect; what is objectively wrong is the description and the journaled provenance reason, which assert path/network confinement that the code does not implement.

**Root cause:** The word 'boundaries' in the Full Access copy and in the journaled provenance reason is inherited from the workspace tools' real path confinement and applied wholesale to the `network` effect class, which has no confinement at all beyond HTTPS-only. The mode's provenance string is a hard-coded constant that does not vary by effect.

**Smallest fix:** Make the Full Access copy and provenance effect-aware. In src/approvals/modes.ts:51-58 build the reason from `tool.effect` so a network/identity allow reads e.g. 'Allowed by Full Access; this effect sends data to a remote origin and is not path-confined.' In src/ui/platform-shell.tsx:481 and src/ui/app.tsx:7236, drop 'network boundaries' and state that network-effect tools may contact any HTTPS origin without prompting.

**Acceptance:** 1) A test asserts `createApprovalModePolicy({mode:"full-access"})` records a provenance reason for `effect: "network"` that differs from the `effect: "write"` reason and does not contain 'path boundaries'. 2) A copy test asserts `approvalModeDescription("full-access")` does not claim network confinement. 3) src/approvals/modes.test.ts:38-50 is extended to assert the per-effect reason text, not just the source.

### 110. [medium] Human-initiated Git, import and vault approvals leave no audit event and can be vetoed by the model

- **Cluster:** tools-permissions  
- **Verdict:** confirmed  
- **Files:** src/ui/app.tsx, src/core/session-audit.ts, src/approvals/modes.ts  
- **Regression risk:** medium

**Why (reviewer):** I read all three. `reviewGitOperation` (src/ui/app.tsx:4249-4269), `reviewSourceImport` (:4271-4296) and `probeVault` (:4300-4330) each synthesize an ad-hoc `ToolDefinition` and call `approvalPolicy.review(...)` directly — none goes through `ToolRegistry.review`, none calls `approvalProvenance`, and none appends a journal event; the only `append` helper in app.tsx is function-local to the local-command path (src/ui/app.tsx:3319). By contrast agent tool calls (src/core/agent.ts:446-459) and local slash commands (src/ui/app.tsx:3364, :3370) both journal an approved/denied event with provenance, so user-initiated stage/commit/GitHub-import/vault-probe decisions are the only effectful approvals with no durable record. The model-veto half is also real: because these hit the same mode policy, in Auto Approve src/approvals/modes.ts:91-100 returns `"deny"` on an `unsafe` verdict with no broker fallback, and the user's own click surfaces only as 'Source-control operation denied; nothing changed.' (src/ui/workspace-view.tsx:1017-1019). The `new AbortController()` in each is genuinely never aborted, so with the broker's 5-minute `DEFAULT_DECISION_TIMEOUT_MS` (src/approvals/broker.ts:44) a prompt raised by a click outlives navigation away from the view — real but the least important of the three.

**Root cause:** Two separate approval paths exist: the registry path (validated, ticketed, journaled with provenance) and a direct `approvalPolicy.review` path used by UI-initiated effects. The direct path was never given the journaling half, and it inherits the model-review branch that only makes sense for model-proposed actions — Auto Approve's premise is 'review what the model wants to do', but here the proposer is the human.

**Smallest fix:** Add one shared helper in src/ui/app.tsx, e.g. `reviewHumanIntent(definition, args, context)`, used by all three call sites, that (a) treats `activeApprovalMode === "auto-approve"` as `ask-first` for human-initiated intents — prompt the broker instead of the model — or at minimum falls back to the broker on an `unsafe` verdict, (b) appends a journal event carrying `approvalProvenance(approvalPolicy, context)` to the active session, and (c) aborts its `AbortController` in a `finally`. Journaling needs one new event type registered in `KNOWN_EVENT_TYPES` (src/core/session-audit.ts:54-80) with a reducer branch, otherwise src/core/session-audit.ts:656-662 will flag it `EVENT_TYPE_UNKNOWN`.

**Acceptance:** 1) Approving and denying a stage/commit, a GitHub import and a vault probe each append exactly one journal event carrying a provenance record, and `auditSession` still reports `verified`. 2) In Auto Approve, a human-initiated Git commit whose model verdict is `unsafe` still reaches the human via the approval dock rather than being denied outright. 3) After the decision resolves (or the caller navigates away) the controller passed to `review` is aborted, and no pending broker request survives. 4) A test asserts the three call sites route through the shared helper, so a future fourth surface cannot skip the journal.

### 111. [medium] File rename/create dialogs skip name validation and fail silently on an invalid name

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workbench-model.ts, src/ui/workbench-model.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/workspace-view.tsx:435 computes `dialogNameError` only for `create-folder` and `rename-folder`; src/ui/workspace-view.tsx:1489 disables confirm on `Boolean(dialogNameError) || !dialogValue.trim()`, so `create`/`rename` are enabled for any non-blank string. In `runDialog`, src/ui/workspace-view.tsx:959 calls `normalizeWorkspacePath(`${dialog.path}/${dialogValue.trim()}`)` BEFORE `await transact("Creating file", …)` at :960, and the `rename` branch at :974 reaches `moveFile`, whose `normalizeWorkspacePath` at src/ui/workspace-view.tsx:852 also precedes `await transact("Moving file", …)` at :853. src/workspace/contracts.ts:41-47 throws for `..`, `.`, backslashes, control characters. The throw therefore escapes `transact`'s try/catch (src/ui/workspace-view.tsx:993-996), rejects the promise, skips `closeDialog()` at src/ui/workspace-view.tsx:987, and both call sites discard it: `onClick={() => void runDialog()}` (:1489) and `onKeyDown` Enter (:1478). Result: modal open, no notice, no state change. src/ui/workbench-model.ts:325 names this exact failure mode as the thing `workspaceNameError` exists to prevent.

**Root cause:** Path normalization is performed outside the only error-reporting boundary the dialog has (`transact`), and the pre-submit validator is wired to two of the four name-taking dialog kinds, so the remaining two have neither pre-validation nor post-failure reporting.

**Smallest fix:** Two lines of containment: (1) move the `normalizeWorkspacePath` calls at src/ui/workspace-view.tsx:959 and :852 inside their `transact` callbacks so any throw becomes an error notice; (2) extend src/ui/workspace-view.tsx:435 to cover `rename` with `workspaceNameError` and `create` with a path-shaped variant (same checks minus the `/` rule, since the create field is documented as "Path relative to this folder" at :1470). Optionally also guard `runDialog`'s `create`/`rename` branches with an early `return` on that error, mirroring :964 and :967.

**Acceptance:** Type `..` into New file and press Enter: an error message is rendered beside the field (role=alert) and the confirm button is disabled; no unhandled rejection. Type a name containing `\` into Rename and confirm: either the button is disabled with a stated reason, or a `.workbench-notice.error` appears and the dialog closes/stays in a stated state — never a silent no-op. Existing valid create with slashes (`notes/2026/plan.md`) still succeeds.

### 112. [medium] No export path exists for a file, a folder or a repository

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workspace-view.test.ts, src/ui/proof-view.tsx, src/ui/attestations-view.tsx  
- **Regression risk:** low

**Why (reviewer):** Checked each surface. The Explorer context menu (src/ui/workspace-view.tsx:1405-1430) contains Open preview/Expand-Collapse, Open and keep, Open terminal here, New file, Rename, Move, Delete, New folder, Rename folder, Delete folder — no download or export item. The file editor strip (:1347-1373) has Reveal in Explorer, Keep open, Wrap, Save only; the diff strip (:1564-1585) has Reveal only. src/git/workspace-adapter.ts:279-284 exportCheckpoint throws GitDomainError("workspace-git-is-authoritative", …) and `grep -rn exportCheckpoint src/` shows no UI caller, so there is no repository-level export. src/ui/sources-view.tsx:1079 renders "History / Not imported". The download primitive does exist and is used elsewhere: src/ui/proof-view.tsx:96-103 (createObjectURL + anchor.download) and src/ui/attestations-view.tsx:654-660, plus src/ui/local-device-vault-setup.tsx:388-403 — so this is missing surface, not a platform limit. Caveat for the parent: this is a duplicate of an already-registered open requirement, docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:110 (WKS-09, "MISSING"), still listed as outstanding at :277 and :624 — it is unfixed, not new information.

**Root cause:** WKS-09 was never built: the workbench exposes only in-place mutation verbs, and the Git adapter deliberately refuses semantic checkpoint export, leaving no bytes-out path at any granularity.

**Smallest fix:** Land the single-file rung first, since it reuses an existing primitive: extract the anchor/objectURL helper already duplicated in src/ui/proof-view.tsx:96-103 and src/ui/attestations-view.tsx:654-660 into one module, then add a "Download" item to the Explorer file context menu (src/ui/workspace-view.tsx:1414-1418) that reads the bounded buffer via WorkspacePort and downloads it under a sanitized basename. Folder-as-archive and history-preserving repository export are separate builds and should not be claimed by this change; until they exist, no UI copy should imply them.

**Acceptance:** 1) Right-clicking a file in Explorer offers a Download item; activating it calls the download helper exactly once with the file's exact bytes and a filename derived from the basename with path separators and control characters stripped. 2) A binary or truncated buffer either downloads the full bytes or is refused with an explicit reason — never silently downloads a truncated preview. 3) The item is absent for folders until folder archiving exists, and no string in the workbench claims a repository export while exportCheckpoint still throws.

### 113. [medium] On a phone the Workspace and Editor destinations never switch panes after first mount

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, e2e/workspace-workbench.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/workspace-view.tsx:208 `const [mobilePane, setMobilePane] = useState<WorkbenchPane>(opensPane);` is the only consumer of `opensPane` (rg over the file shows uses at :152, :180, :208 only) — no syncing effect, unlike `opensActivity` which has one at src/ui/workspace-view.tsx:339-345. src/ui/workbench-model.ts:57 sets `opensPane: route === "editor" ? "editor" : "navigation"` and src/ui/workbench-model.ts:39 promises "Workspace opens the file tree; Editor opens the file you last had open." Remount does not happen across the two hashes: src/ui/app.tsx:7315 keys EditorScreen on `runtime.current.workspaceId`, and src/ui/workspace-view.tsx:164-165 keys ProfileScopedWorkspaceView on `workspaceWorkbenchScope(workspaceIdentity, profileId)` — neither contains the route. EditorView tracks the hash in state (src/ui/editor-view.tsx:60-72) and passes `opensPane={identity.opensPane}` (src/ui/editor-view.tsx:143), so the prop changes and is ignored. src/ui/workspace-view.css:607 makes the panes mutually exclusive only inside `@media (max-width: 760px)`, so desktop is unaffected. Both destinations are real navigation targets (src/ui/navigation-model.ts:116-118, :272).

**Root cause:** `opensPane` is treated as a mount-time default for a component that is deliberately never remounted across the two routes it discriminates, so the route→pane mapping is applied exactly once in the component's lifetime.

**Smallest fix:** Add the sibling of the existing `opensActivity` effect next to src/ui/workspace-view.tsx:339: `useEffect(() => { setMobilePane(opensPane); }, [opensPane]);`, guarded the same way the tab-retention effect guards (`if (opensPane === "editor" && documentsRef.current.tabs.length === 0) return;`) so arriving at #editor with nothing open does not strand the user on a disabled pane (the mobile switch already disables 'Editor' at tabs.length === 0, src/ui/workspace-view.tsx:1152).

**Acceptance:** Mobile project (≤760px): open #workspace, open a file, navigate to #editor — `.workbench-editor` has class `mobile-active` and the textarea is visible; navigate back to #workspace — `.workbench-activity` has `mobile-active` and the tree is visible. Arriving at #editor with zero open tabs still shows the tree, not an empty editor pane.

### 114. [medium] Virtualised workspace tree exposes only the rendered window: no aria-setsize/aria-posinset and treeitems are not owned children

- **Cluster:** workspace-editor  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workspace-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** The virtualisation half is real: src/ui/workspace-view.tsx:1206 declares `role="tree" aria-label="Workspace files"`, :1208 renders only `visible.slice(rowWindow.start, rowWindow.end)`, and `workspaceFileWindow` (:1894) bounds the window to viewport + overscan. `grep -rn "aria-setsize|aria-posinset" src/` returns nothing repo-wide, and the treeitem attribute list at :1211-1213 carries aria-level/aria-expanded/aria-selected only. So AT computes position and count from the rendered window and misreports both on any workspace larger than a screenful. The ownership half is weaker than filed: the two positioning `<div>`s and `.tree-row-wrap` are generic and are traversed by both AT and axe, so they are not in themselves a violation. The genuine ownership defect in the same markup is different — each `.tree-row-wrap` also contains `<button class="tree-overflow" ...>•••</button>` (src/ui/workspace-view.tsx:1230), a focusable non-treeitem descendant of role="tree" with a default tabIndex of 0, which both breaks aria-required-children and defeats the roving tabindex the treeitems implement at :1219.

**Root cause:** Virtualisation was added to the tree as a pure rendering optimisation; the ARIA contract that a windowed collection must restate its true size (aria-setsize/aria-posinset) was never carried across. Separately the per-row overflow affordance was added as a plain button inside the tree rather than as part of the treeitem or outside the tree's subtree.

**Smallest fix:** At src/ui/workspace-view.tsx:1211-1213 add `aria-setsize={visible.length}` and `aria-posinset={rowWindow.start + offset + 1}` to the treeitem button. Give `.tree-overflow` (:1230) `tabIndex={-1}` and `role="none"`/`aria-hidden` (its action is already reachable via ContextMenu/Shift+F10 on the row) or move it out of the tree subtree.

**Acceptance:** 1) With a fixture of N files where the window renders fewer than N rows, every rendered treeitem has aria-setsize=N and aria-posinset equal to its 1-based index in `visible`, verifiable in src/ui/workspace-view.test.ts using `workspaceFileWindow`. 2) The tree contains no focusable element that is not role="treeitem": Tab from the focused row leaves the tree in one press.

### 115. [low] A step waiting on approval is announced as "Tool step not checked"

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/message-parts-view.tsx, src/ui/chat/message-parts-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** `src/ui/chat/message-parts-view.tsx:244` — `queued: { word: "Queued", clause: "queued", sentence: "Tool step not checked", seal: "none" }` — and `:277` assigns `statusSentence: OUTCOME_COPY[outcome].sentence`. `:462-470` uses that sentence twice: as the row `title` and as `label={operation.statusSentence}` on the `Seal`; `src/ui/seal.tsx:81` computes `accessibleLabel` from `label` and the `dot` density keeps it in the accessible name (the visible word at `:470` is `aria-hidden="true"`). So the only thing a screen reader hears for a step awaiting approval is "Tool step not checked". The state is real and reachable: `src/core/agent.ts:395-412` appends `tool.requested` before `options.tools.review(...)` at `:428`, the durable signal folds it into parts immediately, and `pairedOutcome` (`:289-295`) returns `queued` for a call with no status. "Not checked" is verbatim the proof vocabulary's `none` label — `src/ui/seal.tsx:17` — which means an unverified proof, not a pending human decision.

**Root cause:** The queued outcome borrows the seal vocabulary's unverified-proof sentence instead of naming its own state, and the seal's accessible label is sourced from that same string.

**Smallest fix:** Change `OUTCOME_COPY.queued.sentence` to a state sentence, e.g. "Tool step queued — waiting for your approval". If a queued-but-not-yet-reviewed step should read differently from one blocked on the approval dialog, that is a second outcome; the one-line copy change is the complete fix for the misnaming.

**Acceptance:** `pairedOperation` for a call with no status returns a `statusSentence` that does not contain "not checked" and does name queued/awaiting-approval; the seal's accessible label for that row matches it; the `none` seal's own `SEAL_LABELS` entry is unchanged.

### 116. [low] Duplicate-basename tabs are disambiguated, but their close buttons are not

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, e2e/workspace-workbench.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/workspace-view.tsx:448-461: `const name = workspaceBaseName(document.path)` then `closeLabel: `Close ${name}``, while the tab itself gets `detail` (relative path) and `hint: tabQualifiers[document.path]` (:455-456) which `tabAccessibleName` (src/ui/tabs.tsx:169-176) folds into the tab's name. src/ui/tabs.tsx:342 uses `aria-label={item.closeLabel ?? `Close ${item.detail ?? item.label}`}` — so the explicit `closeLabel` actively *replaces* a default that would already have been unique (it uses `detail`, the relative path). Two open `index.ts` files therefore produce two buttons whose accessible name is exactly "Close index.ts". src/ui/workbench-model.ts:64 documents this as the precise problem `workbenchTabQualifiers` exists to solve.

**Root cause:** The disambiguation model was applied to the tab's accessible name only; the sibling close control kept a hand-written label built from the basename, overriding a default that was already unambiguous.

**Smallest fix:** At src/ui/workspace-view.tsx:461 include the qualifier already computed one line above: `closeLabel: `Close ${tabQualifiers[document.path] ? `${tabQualifiers[document.path]}/${name}` : name}``. This keeps the label unchanged for unique basenames, so existing selectors such as e2e/workspace-workbench.spec.ts:54 (`Close architecture.md`) keep passing.

**Acceptance:** With /workspace/a/index.ts and /workspace/b/index.ts both open, `getByRole('button', { name: /^Close / })` yields two distinct accessible names; with only one index.ts open the label remains `Close index.ts`.

### 117. [low] Historical turn errors are role="alert", so opening an old conversation fires assertive announcements

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/message-parts-view.tsx, src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** `src/ui/chat/message-parts-view.tsx:573` — `<div class="message-part part-error" role="alert">` — is unconditional; `MessagePartView` receives no liveness input at all. Restored transcripts carry exactly those parts: `src/ui/app.tsx:768-781` (`transcriptMessagesFromPresentation`) maps `parts: row.parts` straight from the audited presentation, whose assistant parts come from `messagePartsFromDurableEvents` (`src/ui/chat/session-message-presentation.ts:664-666`), and `src/ui/app.tsx:8914-8916` renders them through the same `<MessagePartsView parts={message.parts} />`. So every historical failed or cancelled turn is inserted into an already-loaded document as an assertive live region. Confirmed as a code fact; the exact announcement volume is screen-reader dependent, which is why I keep this low.

**Root cause:** `role="alert"` is baked into the error part renderer instead of being a property of the turn that is currently happening, and restored history reuses the identical part renderer.

**Smallest fix:** Thread a `live` boolean from `MessagePartsView` (already knows `streaming`; the caller knows `message.status !== undefined`) down to the error branch and emit `role="alert"` only when live, otherwise no role. History rows already carry `message.history`, so `src/ui/app.tsx:8914` can pass `live={message.history === undefined}`.

**Acceptance:** Rendering a restored transcript containing a failed and a cancelled turn produces zero elements with `role="alert"`; rendering the same error part inside a live in-flight message produces exactly one.

### 118. [low] Workbench tabs declare role=tab but control no tabpanel

- **Cluster:** accessibility  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx  
- **Regression risk:** low

**Why (reviewer):** All three `Tabs` call sites in the workbench omit `panelId`: src/ui/workspace-view.tsx:1146-1156 (`workbench-mobile-switch`), :1160-1168 (`workbench-mode-tabs`), :1271-1279 (`editor-tabs`). src/ui/tabs.tsx:312 emits `aria-controls={panelId?.(item.id)}`, so nothing is emitted. `rg 'role="tabpanel"' src/ui/workspace-view.tsx` returns nothing, while src/ui/proof-view.tsx:202-206, src/ui/sources-view.tsx:475/490/754/761 and src/ui/billing-view.tsx:250/562 all pass `panelId` and render matching `role="tabpanel"` regions. The switched regions are `<aside class="workbench-activity">` (:1159) and `<main class="workbench-editor">` (:1270).

**Root cause:** The shared Tabs component makes the panel association optional, and the workbench — the one surface whose panels are separate landmark elements rather than a stack of sibling divs — never opted in.

**Smallest fix:** Pass `panelId` at all three call sites and add matching `id` + `role="tabpanel"` to the switched regions. Put the role on inner containers, not on `<aside class="workbench-activity">`/`<main class="workbench-editor">` themselves, because `role="tabpanel"` would delete the complementary/main landmarks those elements provide.

**Acceptance:** Each workbench tab exposes `aria-controls` pointing at an element with `role="tabpanel"` whose `aria-labelledby` is that tab's id; the document still exposes exactly one `main` landmark and the workspace `complementary` landmark inside the workbench route.

### 119. [low] The conversation surface never reports which skills are pinned to it

- **Cluster:** chat-threads  
- **Verdict:** confirmed  
- **Files:** src/ui/chat/session-bar.tsx, src/ui/app.tsx  
- **Regression risk:** low

**Why (reviewer):** `rg -ni skill src/ui/chat/` matches only src/ui/chat/session-message-presentation.test.ts:635-636 — no production chat file mentions skills. The session bar's chip row is model + status + journal + rename + new (src/ui/chat/session-bar.tsx:145-160) with no skill affordance. The data is already pinned and available: `resolvedSkills` and `skillSetDigest` are written into the manifest at src/ui/app.tsx:7673-7674 and computed at src/profiles/domain.ts:347-357. Combined with the absent slash channel (claim 2), the only place a skill set is shown is `#skills`, which resolves against the *current* catalog/profile revision rather than the open conversation's pin. Low severity is right — this is an information gap, not a malfunction.

**Root cause:** The pinned `SessionProfileBinding.resolvedSkills` is carried through the manifest for compatibility checking only; no chat-surface component consumes it, so the conversation cannot state its own instruction set.

**Smallest fix:** Add a compact chip beside the model chip in src/ui/chat/session-bar.tsx fed from `activeSessionRecord.manifest.profile` — e.g. 'N skills' with a title/popover listing `resolvedSkills` names (resolved from `catalog.skills` by `skillId`+`digest`, the lookup already present at src/ui/app.tsx:7651) and the short `skillSetDigest`.

**Acceptance:** With a session pinned to a skill set of N skills, the session bar exposes a control whose accessible name reports N and whose expanded content lists exactly the pinned skill names; after toggling a skill in `#skills` without starting a new conversation, the chip still reports the *pinned* set and digest, not the new catalog resolution.

### 120. [low] The zero-result empty state claims it searched every conversation in the journal, but the search is profile-scoped

- **Cluster:** chat-threads  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/sessions-presentation.ts, src/ui/sessions-presentation.test.ts  
- **Regression risk:** low

**Why (reviewer):** The main assertion holds exactly: src/ui/sessions-presentation.ts:295 is ``const lines: string[] = [`Searched every conversation in this journal by ${SESSION_SEARCH_SCOPE}.`]``, while the read that produced the zero result always carries `profileId: scopeProfileId` (src/ui/sessions-view.tsx:147). The same screen contradicts the sentence two elements above with its 'Profile · <name>' chip (sessions-view.tsx:361) and in the route description (:341). `loadedTotal` is also taken from a profile-scoped read (sessions-view.tsx:151), so 'N conversations at the last unfiltered read' is correct while the sentence above it is not. The wording is pinned by src/ui/sessions-presentation.test.ts:185. I do not confirm the placeholder half of the claim: 'Search titles, models and profiles' (sessions-presentation.ts:252) is not false — `querySessionRecords` does compare `item.profileId` (src/sessions/domain.ts:930), and typing the active profile id legitimately matches every row; the term is degenerate within a single profile, not inaccurate.

**Root cause:** The empty-state copy was written against `querySessionRecords`'s field list (which is journal-wide) rather than against the query the route actually issues (which is profile-scoped), so the sentence describes the matcher instead of the search.

**Smallest fix:** Change the first line in `sessionEmptyState` to name the scope it searched — e.g. `Searched this profile's conversations by ${SESSION_SEARCH_SCOPE}.` — and update the pinned expectation in sessions-presentation.test.ts:185. Leave the placeholder as is.

**Acceptance:** `sessionEmptyState({ filtered: true, query: "plan.md" }).lines[0]` no longer contains the words 'every conversation in this journal' and does name the profile scope; the `loadedTotal` line, the `SESSION_SEARCH_SCOPE_NOTE` line and `offersClear` behaviour are unchanged.

### 121. [low] Account's not-connected gate offers Chutes sign-in in builds where sign-in cannot run

- **Cluster:** connections-account  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/billing-view.tsx, src/ui/access-view.copy.test.ts  
- **Regression risk:** low

**Why (reviewer):** The code facts hold: src/ui/billing-view.tsx:276 renders "Connect with scoped Chutes sign-in or a direct API-key session." and :278 renders an unconditional `Connect Chutes` button calling `onOpenAccess`, which is `() => navigate("access")` at src/ui/app.tsx:7470; BillingView receives no readiness fact. src/ui/access-view.tsx:680-682 computes `chutesSignInAvailable` from the registration plus the local-handler probe, :967 labels the OAuth tab "Unavailable in this build", and :701 defaults `activeChutesMethod` to `api-key` when sign-in is unavailable. But the claim's failure model overstates: the control is labelled "Connect Chutes", not a sign-in promise, and the destination self-corrects — it auto-selects the API-key panel and never surfaces the developer-facing error described at access-view.tsx:1082-1087. The residual defect is only that one prose sentence on Account names a route this build may not have; the journey still completes.

**Root cause:** The Account gate's copy duplicates a Connection-route fact (which credential methods exist) that Account has no input for, so the sentence can drift from the only surface that computes it.

**Smallest fix:** Make the sentence method-agnostic — e.g. "Connect a Chutes credential to read account telemetry. The credential remains held only in page memory." — and let the Connection route name the available methods. That removes the drift without threading a readiness prop into Account.

**Acceptance:** 1) The Account not-connected gate contains no method-specific promise (no "sign-in"/"OAuth" wording) while still stating the page-memory credential contract verbatim. 2) "Connect Chutes" still navigates to `#access`. 3) On a build where `chutesSignInAvailable` is false, the sequence Account gate → Connect Chutes → Connection produces no sentence naming a method the build cannot run.

### 122. [low] Provider inventory model has no identity field, so a provider tab can never show the authenticated account

- **Cluster:** connections-account  
- **Verdict:** confirmed  
- **Files:** src/ui/billing-view.tsx, src/ui/billing-view.test.ts, e2e/account-providers.spec.ts  
- **Regression risk:** low

**Why (reviewer):** `BillingProviderInventoryEntry` at src/ui/billing-view.tsx:47-56 carries exactly `providerId, state, connectionDetail?, quota?, usage?, reset?, accountLink?, observedAt?` — no identity member — and `BillingProviderInventoryPanel` renders `ProviderInventoryDatum` for Quota, Usage and Reset, then Account management and Inventory observed (:574-589). Chutes by contrast renders a dedicated identity section with Username and User ID at :308-314, backed by `chutesAccountIdentityPresentation` (:73-82). ACC-04's target text at docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:166 names "authenticated identity, quota, reset windows, usage, and account links", and the checkpoint at :269 records the remaining ACC-04 boundary as the absence of real non-Chutes observations, not a deliberate omission of the field — so the seam models four of five requested facts and drops the fifth.

**Root cause:** The seam was modelled from the telemetry fields (quota/usage/reset/link) rather than from ACC-04's field list, so identity has no `BillingProviderObservation` slot. The result is unavailable-by-omission — a host that did observe an identity has nowhere to put it — instead of the unavailable-by-observation grammar the rest of the panel uses.

**Smallest fix:** Add `identity?: BillingProviderObservation;` to `BillingProviderInventoryEntry` (src/ui/billing-view.tsx:47-56), carry it through the spread in `resolveBillingProviderInventory` (:105-117), and render `<ProviderInventoryDatum label="Authenticated identity" observation={inventory.identity} connectionState={inventory.state} />` as the first row of `billing-provider-data` (:575). No producer change is needed: `billingProviderDatumLabel` already yields "Not provided" when connected and "Unavailable" otherwise.

**Acceptance:** 1) A connected provider entry with no identity observation renders an "Authenticated identity" row reading "Not provided"; an unavailable entry reads "Unavailable". 2) An entry supplying `{status: "observed", value: "…"}` renders that bounded value. 3) The inventory type still contains no credential/token/secret/endpoint member (the assertion at src/ui/billing-view.test.ts:81 keeps passing). 4) The per-panel "Unavailable" count assertion in e2e/account-providers.spec.ts is updated for the new row.

### 123. [low] Capability disclosure summaries stay below the 44px touch minimum on phones while sibling buttons are raised

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/capabilities-view.css, e2e/route-adversarial-audit.spec.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/capabilities-view.css:56 is `.capability-runtime__details > summary { min-height: 36px; padding: .6rem 0 0; … font-size: var(--fs-caption); … }` with no override anywhere below — 36px is unconditionally under 44px at every width. :28 `.capability-device-card details summary { padding-top: .45rem; … font-size: var(--fs-micro); }` has no min-height at all. The scout missed a third: :39 `.capability-policy-row details summary { … font-size: var(--fs-caption); font-weight: 650; }`, the "Browser primitives" disclosure, also has none. The `@media (max-width: 760px)` block opens at :68 and deliberately raises the buttons — :69 `.capabilities-refresh { min-width: 44px; min-height: 44px; }`, :81 `.capability-runtime > button { min-height: 44px; }`, :83 `.capability-extension button { min-height: 44px; }` — and touches no `summary`. No `@media (pointer: coarse)` block exists in capabilities-view.css (the file has none; other route CSS files do). These summaries hold "Technical boundary" (isolation/persistence), "Adapter facts" (WebGPU limits/vendor) and "Browser primitives", i.e. the advanced detail VIS-05 requires to stay reachable on a phone. e2e/route-adversarial-audit.spec.ts visits #capabilities (:34) but asserts only gutter offsets, heading typography and runtime errors (:188-211) — no touch-target measurement; the repo's 44px assertions live in composer-layout, connect-inference, message-hover, responsive-breakpoints and workspace-source-controls specs, none on #capabilities. VIS-05's 2026-07-29 closure (backlog:582) covers only the file-tree action lane.

**Root cause:** The route's mobile block enumerates controls by selector and only `button` selectors were enumerated; `<summary>` is an interactive control that no shared token or global rule sizes, so each route must remember it individually and this one did not.

**Smallest fix:** Inside the existing `@media (max-width: 760px)` block in src/ui/capabilities-view.css, add one rule covering all three: `.capability-runtime__details > summary, .capability-device-card details summary, .capability-policy-row details summary { min-height: 44px; display: flex; align-items: center; }`. Better still, hoist it to a shared `@media (pointer: coarse) { summary { min-height: 44px } }` in src/ui/styles.css so no future route repeats the omission.

**Acceptance:** 1) A phone-viewport (390x844) Playwright assertion on #capabilities that every `summary` bounding-box height is >= 44. 2) The same sweep asserts every `button` on the route is >= 44, so the check is control-type-agnostic rather than button-specific. 3) Opening each disclosure at that viewport still reveals its content without horizontal overflow (reuse the existing overflow assertion in e2e/route-adversarial-audit.spec.ts).

### 124. [low] Terminal, Proof, Memory and management routes are capped at 1160px while only the Editor opts out

- **Cluster:** design-system-responsive  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/routes.css, src/ui/terminal-view.tsx, src/ui/attestations-view.tsx  
- **Regression risk:** medium

**Why (reviewer):** The CSS facts are exactly as claimed: `.route-layout > :not(.trust-hub-tabs) { width: min(1160px, 100%); margin-inline: auto; }` (src/ui/routes.css:31-34) is the only width rule for non-chat route children, and the sole exemption is `.main:has(> .editor-route) > .editor-route { width: 100%; max-width: none; margin: 0; }` (src/ui/editor-view.css:18-22). `.main` itself sets no max-width (src/ui/shell.css:1276-1284), the only other `.route-layout` block is the mobile gutter override (routes.css:2887-2892), and `TerminalScreen` is rendered as a direct child of that `<main class="main route-layout">` (app.tsx:6906-6913, 7343-7355) with `.terminal-route{...width:100%...}` (src/ui/terminal-view.css:4) — i.e. 100% of the capped box. What I reject is the misrepresentation half of the claim: docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:270 says terminal/Proof "now have compact/full-width structures" and explicitly marks VIS-02 **PARTIAL**, and :187 still lists it as PARTIAL/REPORTED — nothing there claims the routes escape the measure cap, so there is no contradiction to report. I also could not measure rendered widths (no browser runs permitted), so the "~240px of void" figure is arithmetic, not observation.

**Root cause:** There is one global measure cap for every route child and a single per-route exemption implemented ad hoc in the Editor's own sheet. There is no way for a route to declare itself a work surface rather than prose, so every dense grid inherits the prose measure by default.

**Smallest fix:** Introduce an opt-out attribute rather than more `:has()` one-offs: add `.route-layout > [data-route-measure="wide"] { width: 100%; max-width: none; }` after routes.css:34, and set `data-route-measure="wide"` on the terminal route root (src/ui/terminal-view.tsx) and any Proof grid that VIS-02 names, leaving prose routes on the 1160px default.

**Acceptance:** At a 1920px viewport the terminal route element's client width is greater than 1160px and within the route gutters of the `<main>` width, while a prose route (e.g. Vault) stays at 1160px; at 1280px both are unchanged from today; the mobile block at routes.css:2887 is unaffected.

### 125. [low] The always-ready POSIX shell runtime wears the model glyph and gets a "Run a probe" button that does not probe it

- **Cluster:** design-system-responsive  
- **Verdict:** confirmed  
- **Files:** src/ui/capabilities-view.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/capabilities-view.tsx:187 is exactly `<Icon name={runtime.id === "node-webcontainer" ? "terminal" : "model"} />`, so airship-sh — and javascript-worker, python-pyodide, wasi-preview1 and wasix — all render the model glyph. That glyph is the product's inference-model mark everywhere else: src/ui/model-control.tsx:51,:60, src/ui/provider-model-control.tsx:68,:109, src/ui/provider-fabric-panel.tsx:184,:402, src/ui/provider-connections-view.tsx:381, src/ui/mobile-navigation.tsx:219. src/execution/shell/adapter.ts:21-30 confirms `AIRSHIP_SH_CAPABILITY` is `id: "airship-sh"`, `label: POSIX sh · airship-sh …`, `state: "ready"`, `shell: "airship-sh"`, `commandInterface: "posix-sh-script"`. capabilities-view.tsx:202-208: the `probes` map has keys only for javascript-worker, wasi-preview1, python-pyodide and node-webcontainer, so airship-sh falls to `probes[runtime.id] ?? "/inspect-execution-runtimes"` while still being labelled "Run a probe". A real probe command does exist: the tool is `execute_shell` (src/tools/execution-tools.ts:568, proxied at src/tools/execution-tool-proxies.ts:102) and src/commands/registry.ts:91 derives slash names via `definition.name.replaceAll("_", "-")`, so `/execute-shell` is a live command. VIS-03 remains open in the register (backlog:188, retained at :279).

**Root cause:** Both defects come from the same shortcut: the card special-cases node-webcontainer by id instead of deriving presentation from the capability record it already has. `ExecutionCapability` carries `shell` and `commandInterface` (src/execution/runtime-registry.ts:44-49), which name exactly what the icon and the probe command should follow, and neither is read.

**Smallest fix:** Derive both from the record instead of from an id ternary: pick the terminal glyph when `runtime.shell !== "none"` (covers airship-sh, wasix-bash and webcontainer-jsh, leaves javascript-worker/python on the model glyph or a language glyph), and add an `"airship-sh"` entry to the `probes` map pointing at `/execute-shell --json '{"script":"echo $((6 * 7))"}'`. Both are single-expression edits in src/ui/capabilities-view.tsx.

**Acceptance:** 1) A render test asserts the airship-sh card's icon is the terminal mark, not the model mark, and that node-webcontainer is unchanged. 2) Clicking the airship-sh action calls `onCommand` with a string beginning `/execute-shell`, and the button label "Run a probe" is only ever paired with a command that names the runtime it sits on (assert per-runtime, mapping over the full capability list). 3) No runtime whose `shell !== "none"` renders the model glyph.

### 126. [low] Capabilities route shows no browser-extension capability, and extensionBridgePromptEntries has no production caller

- **Cluster:** extension-remote  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/capabilities-view.tsx, src/ui/app.tsx, src/capabilities/extension-bridge.ts, src/capabilities/extension-bridge.test.ts  
- **Regression risk:** low

**Why (reviewer):** The code facts are correct but the stated consequence is largely mitigated. Confirmed: src/ui/capabilities-view.tsx never imports src/capabilities/extension-bridge — the only "extension"-named node on the route is `<section class="capability-extension panel">` at :80-82 whose heading is "Tools and Skills", i.e. slash tools and Skills, not the browser extension. Confirmed: `extensionBridgePromptEntries` (src/capabilities/extension-bridge.ts:137) is referenced only by src/capabilities/extension-bridge.test.ts:4,:63,:71 — a full grep across src/ finds no production caller — and the session manifest at src/ui/app.tsx:7637 passes `browserCapabilities: browserCapabilityPromptEntries(browserReport)` with no extension counterpart. Confirmed: `probeExtensionBridge` consumers are src/ui/access-view.tsx:194 and src/ui/app.tsx:1194 only. REJECTED sub-claim: the implication that the agent is therefore unaware of the extension. src/ui/app.tsx:1192-1222 builds `liveEnvironmentSource`, which probes the bridge and emits `extension: liveExtensionEntries(extension)` plus an explicit limitation string when the bridge is absent, and that source is wired into every runtime construction (app.tsx:2571, :2998, :4513, :4715, :4848). So the extension IS in the agent's per-turn live environment; only the immutable session *pin* omits it, and `extensionBridgePromptEntries` is genuinely dead code superseded by the live-environment path. Severity lowered to low accordingly. The scout's directive mapping to EXT-01 is also loose: EXT-01 (backlog:174) is about the relay being a narrow reviewed path, not about route placement.

**Root cause:** The extension observation was built to the browser-probe shape but its consumers were chosen per-surface (Connection lane, per-turn live environment) rather than through one shared capability panel; `extensionBridgePromptEntries` is a leftover from the earlier session-pin design that the live-environment supplement replaced, and nothing removed it.

**Smallest fix:** Two independent one-line-scale changes. (1) Delete `extensionBridgePromptEntries` and its test block — it is superseded by `liveExtensionEntries` and keeping an untested-in-production prompt path invites divergence. (2) Render the extension on Capabilities by passing the existing `ExtensionBridgeObservation` (the one access-view already holds) into `CapabilitiesView` and reusing `DeviceCard`, which already accepts the state/evidence/detail shape unchanged.

**Acceptance:** 1) A grep assertion that `extensionBridgePromptEntries` no longer exists, or that it has at least one non-test caller. 2) A CapabilitiesView render test with an `available` extension observation asserts a card titled with the extension appears and reports installed/companion cache/compute; with a `silent` observation it reports unavailable plus one remediation line. 3) The Connection lane and the Capabilities card assert equal `detail` strings from one probe call, proving a shared observation rather than two probes.

### 127. [low] Source Control History shows a fixed depth-20 slice with a count that reads as the repository total

- **Cluster:** git-terminal  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/workspace-view.tsx  
- **Regression risk:** low

**Why (reviewer):** The code facts hold: src/ui/workspace-view.tsx:510 `git.log({ …, depth: 20 })` is the only history read, and src/ui/workspace-view.tsx:1679 renders `<header><strong>History</strong><span>{history.length}</span></header>` with no bound statement, no paging control, and no local-vs-origin labelling; the sibling status list does disclose its bound at src/ui/workspace-view.tsx:1676 ("Showing the first 250 staged and unstaged paths…"). But the WKS-06 shortfall itself is already recorded and accepted in the register: docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:260 states "History is still a commit-level list rather than the requested collapsible commit→changed-files tree with bounded paging." The genuinely new, unrecorded part is only the ambiguous count beside the word History.

**Root cause:** The history pane reuses a fixed-depth read as if it were a complete list, and prints the slice length in the position where every other group in this rail prints a total, with no disclosure sentence of the kind the status group already carries.

**Smallest fix:** Two lines, independent of the deferred WKS-06 work: at src/ui/workspace-view.tsx:1679 render the count as bounded (`{history.length === WORKBENCH_HISTORY_DEPTH ? `${history.length}+` : history.length}`) and add the same style of boundary note the status group uses at :1676 — e.g. `Showing the most recent 20 commits on this worktree.` — extracting the literal `20` at :510 into a named constant used by both.

**Acceptance:** With a repository of >20 commits, the History header does not present a bare `20` as a total (either a `20+` affordance or an adjacent sentence naming the bound is present), and that sentence names the tracked worktree rather than implying origin.

### 128. [low] The 250-path truncation banner fires on total changes, not on either lane actually being cut

- **Cluster:** git-terminal  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workspace-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/workspace-view.tsx:1662-1664: `const staged = (worktree?.status.filter((entry) => entry.index) ?? []).slice(0, 250);`, `const unstaged = (worktree?.status.filter((entry) => entry.worktree) ?? []).slice(0, 250);`, `const truncated = (worktree?.status.length ?? 0) > 250;`. The banner at :1676 asserts "Showing the first 250 staged and unstaged paths. Open Advanced source controls for the complete, virtualized worktree." Since each lane is a filtered subset, status.length > 250 does not imply either lane exceeded 250: 200 index-only plus 100 worktree-only entries gives status.length 300, staged 200, unstaged 100, nothing clipped, banner shown. Only false positives are possible (a lane can never exceed status.length), so the failure mode is sending the user to another surface for changes already fully listed.

**Root cause:** The truncation predicate is computed from the unfiltered status length rather than from the pre-slice length of each lane it describes; the slice bound and the predicate share no expression.

**Smallest fix:** In src/ui/workspace-view.tsx:1662-1664 compute the lanes before slicing and derive the flag from them, e.g. `const stagedAll = worktree?.status.filter((e) => e.index) ?? []; const unstagedAll = worktree?.status.filter((e) => e.worktree) ?? []; const staged = stagedAll.slice(0, SCM_LANE_LIMIT); const unstaged = unstagedAll.slice(0, SCM_LANE_LIMIT); const truncated = stagedAll.length > SCM_LANE_LIMIT || unstagedAll.length > SCM_LANE_LIMIT;` with a named SCM_LANE_LIMIT, and word the banner at :1676 to name the clipped lane(s) and their real totals.

**Acceptance:** 1) With 200 index-only and 100 worktree-only entries (status.length 300), the truncation banner is not rendered. 2) With 260 index-only entries, the banner is rendered and names the staged lane. 3) With 260 worktree-only entries, the banner names the changes lane. 4) The limit literal appears once in the module and is used by both the slice and the predicate.

### 129. [low] Workbench History shows a bare depth-capped count in the same grammar as exact counts, with no bound statement

- **Cluster:** git-terminal  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workspace-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** The count facts check out: src/ui/workspace-view.tsx:510 `depth: 20`, and the rail header at :1678 renders `<header><strong>History</strong><span>{history.length}</span></header>` — byte-identical grammar to the exact lane counts in ScmGroup (:1701 `<header><strong>{title}</strong><span>{entries.length}</span></header>`), so a capped 20 is presented exactly like a true count of staged/changed paths. The advanced sheet is honest by contrast: src/ui/sources-view.tsx:54 `const HISTORY_DEPTH = 50;` and :762 "Bounded to the {HISTORY_DEPTH} most recent." There is a historyMessage slot (:1694) but it is empty unless the adapter supplies a message, so the bound is normally unstated. The rest of the claim is a restatement of an already-registered open directive rather than a defect: docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:107 records WKS-06 as PARTIAL and :260 explicitly says "History is still a commit-level list rather than the requested collapsible commit→changed-files tree with bounded paging". So collapsibility, per-commit file expansion, paging and local-vs-origin labelling are known-open scope, not new findings.

**Root cause:** The read bound (depth 20) lives only at the call site and is never surfaced to the presentation layer, so the rail renders a capped list length in the visual idiom reserved for exact counts.

**Smallest fix:** Hoist the depth to a named constant in src/ui/workspace-view.tsx (e.g. `const WORKBENCH_HISTORY_DEPTH = 20;` used at :510) and render the bound in the History section: keep `<span>{history.length}</span>` but append a caption such as `<small>Bounded to the {WORKBENCH_HISTORY_DEPTH} most recent.</small>` inside the header at :1678, shown whenever `history.length >= WORKBENCH_HISTORY_DEPTH`.

**Acceptance:** 1) When git.log returns WORKBENCH_HISTORY_DEPTH commits, the History header renders text containing "most recent" naming the same constant passed as `depth` to git.log. 2) When it returns fewer, the bound caption is absent. 3) The literal 20 appears exactly once in the module (the constant), so the request depth and the displayed bound cannot drift.

### 130. [low] A conversation hit threads a matched event ID the host discards, and no event anchoring exists anywhere in chat

- **Cluster:** memory-sources  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/memory-view.tsx, src/ui/app.tsx, src/ui/chat-route.ts  
- **Regression risk:** low

**Why (reviewer):** The dead-payload half is exactly right. The lane binds `target: { kind: "message", sessionId, eventId }` (src/ui/memory-view.tsx:675) and the host drops the event: `if (target.kind === "message") { navigate("chat", chatHash(target.sessionId)); return; }` (src/ui/app.tsx:4194-4197). `chatHash` encodes only the session ID and explicitly documents that the URL 'never carries message content' (src/ui/chat-route.ts:1-14), and `rg eventId src/ui/app.tsx` returns a single unrelated hit (`:791`, a marker id) — there is no anchor, scroll target, or highlight mechanism for a journal event anywhere in the chat viewport. Where I part company with the scout is the misrepresentation framing: the button's own label is `"Open this conversation"` (src/ui/memory-view.tsx:675), not 'open this message', so the affordance keeps the promise it makes. The `eventId` is still displayed as provenance on the hit (`:681`), so the user is not left without an identifier. That makes this an unused capability and a missing affordance, not a broken or dishonest one — polish rather than a functional defect.

**Root cause:** `MemorySourceTarget`'s `message` variant was typed with an `eventId` (src/ui/memory-view.tsx:48) in anticipation of an event anchor that the chat route never gained; the host handler was written to the routing capability that actually exists.

**Smallest fix:** Either honour it or stop carrying it. To honour: extend `chatHash` with an optional event fragment and have the chat viewport scroll the matching journal event into view and flash it, then pass `target.eventId` through at src/ui/app.tsx:4194-4197. To drop it: remove `eventId` from the `message` variant (src/ui/memory-view.tsx:48) and from the target construction (`:675`), keeping the provenance row that already prints it. The drop is the smaller change and leaves no dead data.

**Acceptance:** If honoured: opening a conversation hit matched deep in a long thread scrolls that exact journal event into view and marks it, and the session ID still round-trips through `chatSessionIdFromHash`. If dropped: `MemorySourceTarget` carries no field the host cannot act on, and the hit still shows the event ID as provenance.

### 131. [low] The evidence ledger says raw evidence is withheld and, 155 lines later, that raw values are available in the same panel

- **Cluster:** proof-vault  
- **Verdict:** confirmed  
- **Files:** src/ui/attestations-view.tsx  
- **Regression risk:** low

**Why (reviewer):** Both strings are in the one `AttestationsView` render tree: src/ui/attestations-view.tsx:260 `<small>Raw evidence withheld by design</small>` in the "How to read evidence states" header, and src/ui/attestations-view.tsx:415 `… normalized fact{...} · raw values remain available here</small></summary>` on the "Commitments & measurements" disclosure. The second is false as written: attestations-view.tsx:416 renders `FactGrid` over `selected.bindings` and `selected.evidenceFacts`, which src/ui/attestations-model.ts:268-273 and :325-330 build purely from `digestFact` / `propertyFact` / `identityFact` — digests, formats and instance ids. No quote, certificate or GPU bytes reach presentation state. The genuinely raw path is the bundle at src/ui/proof-view.tsx:309 (`includeRawEvidence: true` at proof-view.tsx:132), on the other tab, and neither sentence names it.

**Root cause:** Two independently authored copy strings describing the same privacy boundary, in one component, with no shared constant; the disclosure's summary was written about the record store's contents rather than about what the grid actually renders.

**Smallest fix:** In src/ui/attestations-view.tsx:415 replace `raw values remain available here` with wording that matches what renders (e.g. `digests and measurement metadata only`), and extend the header at attestations-view.tsx:260 to point at the real raw path — `Raw evidence withheld here; export the raw verification bundle from Receipt & journal`.

**Acceptance:** The Attestation evidence panel contains no two statements that disagree about whether raw evidence is present; the "Commitments & measurements" summary does not claim raw values, and the withheld-by-design line names the raw verification bundle as the place raw material is reachable.

### 132. [low] The navigation model declares All Conversations 'global' scope and the command palette prints it

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/navigation-model.ts, src/ui/navigation-model.test.ts, src/ui/platform-shell.test.ts  
- **Regression risk:** low

**Why (reviewer):** src/ui/navigation-model.ts:113-115 is `destination("chat", "Chat", "Work", "session", [ nestedDestination("sessions", "All conversations", "global") ])`, and `NavigationScope` at :22 offers `"profile"` as a first-class value, so 'global' is a choice, not a vocabulary gap. `buildPaletteEntries` (src/ui/platform-shell.tsx:45-52) renders every nested destination as `description: `${destination.label} · ${scopeLabel(nested.scope)}`` with `scopeLabel` at :718 producing 'Global scope' — ⌘K shows 'All conversations — Chat · Global scope'. Because the palette filter matches on `entry.description` (platform-shell.tsx:712-715), typing 'global' actively surfaces All conversations. The route is profile-scoped in fact: src/ui/sessions-view.tsx:147 always sends `profileId: scopeProfileId`, :361 prints a 'Profile · <name>' chip, and :341 says continuation 'stay[s] inside the active profile'. docs/CANON.md:258 defines the term against this: 'global scope never merges profile-local conversations, files, terminal history, Memory, indexes, or Proof.' One correction to the claim: the rail does not print this — RAIL_LAYOUT (src/ui/navigation-model.ts:196-202) nests only `editor` and `terminal` under Workspace and files `sessions` nowhere, pinned by navigation-model.test.ts:175. The palette is the only affected surface.

**Root cause:** The nested destination's scope tag was set to the parent-agnostic default 'global' rather than to the scope the route enforces; the palette derives its description mechanically from that one tag, so a wrong tag becomes wrong user-facing copy.

**Smallest fix:** Change `nestedDestination("sessions", "All conversations", "global")` to `"profile"` at src/ui/navigation-model.ts:114.

**Acceptance:** `CANONICAL_DESTINATIONS` chat.nested[0].scope === 'profile'; `buildPaletteEntries(...)` entry `view:sessions` has description 'Chat · Profile scope'; a palette query of 'global' does not return All conversations; the rail row assertions in navigation-model.test.ts remain unchanged.

### 133. [low] The rail's roving-tabindex contract collapses whenever the Chat conversation subtree is open — which clicking Chat forces

- **Cluster:** shell-nav-profile  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/rail.tsx, src/ui/rail.test.ts, e2e/conversation-navigation.spec.ts  
- **Regression risk:** medium

**Why (reviewer):** Every cited fact checks out. src/ui/rail.tsx:183-190 states the 'one composite widget, not twenty tab stops' contract; `order` (:142-155) is destinations plus RECENTS_KEY only; `onNavKeyDown` bails on anything without `data-rail-key` (:192-193); `itemProps` (:217-227) is applied to destination rows (:241-244) and the recents trigger (:404) but to none of the subtree controls — the thread button (:341-350), the two reorder buttons (:364-375), the star toggle (:378-384), the header 'New conversation' (:428) and 'All conversations' (:434-438) all render without tabIndex, so all are natively tabbable. `visible = [...favorites, ...recent]` with `recent` capped at RAIL_RECENT_LIMIT = 10 (:296) but favourites uncapped (:295), so the stop count is unbounded, not 20-45. Clicking Chat does force the disclosure open (:241). Where I part company with the scout: the container is `role="group"` (:411-413), not a tree or listbox, and a group of plain buttons reachable by Tab is a conforming pattern — WCAG focus order is satisfied, and the group already handles Escape with focus return to the trigger (:414-419). The force-open behaviour is the PIA-06 directive's own requirement ('Activating Chat reveals its inline subtree', docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:42), not a defect. So this is a self-consistency and friction problem against the file's stated design, not an accessibility violation.

**Root cause:** The roving order is derived from `railTraversal(expanded)`, a destination-only model; the conversation subtree was added later as free-form markup inside a `role="group"` and was never given keys in that model, so the composite-widget promise in the header comment is scoped narrower than the widget it now describes.

**Smallest fix:** Either narrow the promise or extend the order. Smallest correct version of the latter: give the thread button in `conversationRow` `{...itemProps(`conversation:${session.id}`)}` and include those keys in the `order` memo (src/ui/rail.tsx:142-155) when `recentsOpen`, then set tabIndex -1 on the per-row star/reorder buttons so a row is one stop whose secondary actions are reached with ArrowRight (the pattern `onNavKeyDown` already implements for nested destinations at :200-214).

**Acceptance:** 1) With the disclosure open, Tab from outside the rail lands once and Tab again leaves the rail. 2) ArrowDown from Chat reaches the recents trigger then walks conversation rows in visible order; ArrowUp returns. 3) Alt+ArrowUp/Alt+ArrowDown favourite reordering (src/ui/rail.tsx:348-354) still works from the row stop. 4) e2e/conversation-navigation.spec.ts asserts the rail's tab-stop count is constant whether the disclosure is open or closed.

### 134. [low] `#settings` is a modelled, unit-tested hash that the router silently redirects to Chat

- **Cluster:** shell-nav-profile  
- **Verdict:** confirmed  
- **Files:** src/ui/navigation-model.ts, src/ui/navigation-model.test.ts  
- **Regression risk:** low

**Why (reviewer):** `SETTINGS_OVERLAY_ENTRY` declares `hash: "#settings"` (src/ui/navigation-model.ts:262-268) and the test pins it (src/ui/navigation-model.test.ts:147-153). `navigationViewFromHash` has aliases for `connection`, `account`, `access`, `billing`, `sources` and `attestations` but none for `settings`, ending at `return navigationViews.has(candidate as NavigationView) ? candidate as NavigationView : "chat"` (navigation-model.ts:336-342); `navigationViews` comes from `VIEW_HASHES` (navigation-model.ts:93-110), which has no `settings` key. `readViewHash()` (app.tsx:9388-9391) is the only hash reader for `view` (app.tsx:922, 2704), and grepping `settings` in app.tsx finds no route or overlay handling — the only consumers of the entry are the palette (platform-shell.tsx:54-61, which uses `.id` and `args.openPreferences`) and the mobile More sheet (mobile-navigation.tsx:127, 211, which branch on `entry.kind === "overlay"`). So loading or sharing `#settings` lands on Chat with the dialog closed and no signal.

**Root cause:** `NavigationOverlayEntry` carries an optional `hash` field that no router owns. Overlays are not addresses in this app, so the model advertises a URL contract the shell has never implemented.

**Smallest fix:** Drop `hash` from `SETTINGS_OVERLAY_ENTRY` (navigation-model.ts:262-268) and from the `NavigationOverlayEntry` type if it has no other user, and amend navigation-model.test.ts:147-153 accordingly. (The larger alternative — teaching `readViewHash`/the hashchange handler at app.tsx:2704-2733 to open Preferences and restore the prior route — is only worth it if `#settings` is meant to be shareable.)

**Acceptance:** A model test asserts that every entry in `MOBILE_MORE_ENTRIES` with a `hash` round-trips: `navigationViewFromHash(entry.hash)` equals the entry's view; overlay entries expose no `hash`. No production string `#settings` remains.

### 135. [low] The mobile-nav overlap assertion in the responsive spec queries a class no element carries

- **Cluster:** tests  
- **Verdict:** partially-confirmed  
- **Files:** e2e/responsive-breakpoints.spec.ts, src/ui/shell.css, src/ui/routes.css  
- **Regression risk:** low

**Why (reviewer):** e2e/responsive-breakpoints.spec.ts:448 does `document.querySelector<HTMLElement>(".mobile-navigation")`, and grepping all of src for `mobile-navigation` returns only the module import at src/ui/app.tsx:140 — the element is `class="mobile-nav fixed-mobile-nav"` (src/ui/mobile-navigation.tsx:108) and every stylesheet selects `.mobile-nav`. So `mobileBox` (:457) is always undefined and the guard at :477 never fires: that part of the claim is exactly right. The scout's proposed fix is incomplete, which is why this is only partially confirmed: the test's widths are `[768, 820, 1024]` at height 900 (:11) and `.mobile-nav` is `display: none` by default (src/ui/routes.css:2169-2171), only becoming a grid at <=640px or landscape-short (:2376, :2456-2460). Correcting the selector alone leaves the assertion just as vacuous. The related dead-CSS observation is confirmed: `.compact-profile-select` exists in src/ui/shell.css:516, :530 and src/ui/routes.css:2329, :2447 and is carried by no element.

**Root cause:** The assertion was written against a guessed class name and made conditional on that lookup succeeding, so the guard silently absorbed its own failure; and it was placed in a test whose viewport list never reaches a width where the mobile nav renders.

**Smallest fix:** Change the selector at e2e/responsive-breakpoints.spec.ts:448 to `.mobile-nav`, and make the check unconditional at a width where the nav does render — either add a phone width to the `widths` tuple at :11 or assert the geometry inside the existing phone test (:100-130). Separately, delete the `.compact-profile-select` rules at src/ui/shell.css:516-536 and src/ui/routes.css:2329-2331, :2447-2450 (see the profile-switcher finding, which retargets the live class).

**Acceptance:** The spec's mobile-nav geometry check executes at least once per run (fail the test if the element is absent at a phone width rather than skipping), asserts the nav's top is below the main content top and does not overlap the composer's box, and passes at 390x844. A grep assertion that no test selector or CSS rule references `.mobile-navigation` or `.compact-profile-select`.

### 136. [low] A pinned status diff goes stale and its replacement tab is visually identical in the tab strip

- **Cluster:** workspace-editor  
- **Verdict:** partially-confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workspace-view.test.ts  
- **Regression risk:** low

**Why (reviewer):** The mechanism is real. src/ui/workbench-model.ts:122-125 encodes the whole identity (including worktreeVersion, :90-99) into the tab ID, and src/ui/workspace-view.tsx:1704-1711 builds each status-diff document with `worktreeVersion: worktree.version`, so reopening the same path after any worktree change yields a different ID and openDiffDocument (:586-591) adds it as a second tab with no dedup by path/scope. src/ui/workspace-view.tsx:627 `if (diffsRef.current[id]?.loading || (diffsRef.current[id] && !diffsRef.current[id]?.error)) return;` means the older buffer never re-reads. Tab identity at :465-483 gives both tabs the same label (basename), the same detail (`${path} · ${scope} diff`) and the same hint ("Working diff"/"Staged diff"), and :439 restricts workbenchTabQualifiers to file documents, so the strip cannot tell them apart. Where the claim overstates: the diff surface itself is not silent about which snapshot it is — src/ui/workspace-view.tsx:1558 renders `${scope} · snapshot ${document.worktreeVersion.slice(0,12)}` and the seal detail at :1544 reads "Verified against worktree version <version>", so the two tabs differ once opened, and the seal is scoped to the version it claims. Also the duplicate requires the first tab to have been pinned ("Open and keep"/double-click); a second preview replaces the preview slot rather than adding a tab. Net: ambiguous tab strip and a never-refreshing pinned diff are confirmed; "silently" is not.

**Root cause:** Version is part of document identity but not part of tab presentation, and there is no supersession rule: nothing compares an open status diff's worktreeVersion against the live worktree version after refreshSourceControl.

**Smallest fix:** In the documentTabs mapping (src/ui/workspace-view.tsx:465-483), for `document.source === "status"` compare `document.worktreeVersion` with the current `worktree?.version`; when they differ set `hint` to a superseded qualifier (e.g. `Working diff · snapshot ${document.worktreeVersion.slice(0,8)}`), `state: "attention"` and `stateLabel: "Superseded"`. No reload logic, no ID change.

**Acceptance:** 1) With one pinned status diff for path P at version V1 and the live worktree at V2, the tab for that document exposes state "attention" and a hint containing the snapshot qualifier. 2) Opening P again at V2 produces a second tab whose hint differs from the first tab's hint. 3) A status diff whose worktreeVersion equals the live version keeps its current hint and no attention state.

### 137. [low] Binary file sizes are reported as the base64 envelope length, ~33% too large

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/workspace/memory.ts, src/workspace/indexeddb.ts, src/vault/encrypted-workspace.ts, src/git/encrypted-workspace-adapter.ts  
- **Regression risk:** medium

**Why (reviewer):** src/workspace/memory.ts:50 and src/workspace/indexeddb.ts:80 both set `size: new TextEncoder().encode(content).byteLength` where `content` is whatever was written — for binaries that is the `airship-git-binary-v1:` + base64 envelope produced by src/workspace/content-codec.ts:20. The UI prints that number directly at src/ui/workspace-view.tsx:1229 (`formatBytes(node.entry.size)`) and src/ui/workspace-view.tsx:1333 (`formatBytes(buffer.size)`); `buffer.size` comes straight from the spread of the WorkspaceFile at :292. Every non-UI consumer instead uses `workspaceContentByteLength` (src/workspace/content-codec.ts:41) — src/tools/workspace-tools.ts:108, src/terminal/workspace-sync.ts, src/execution/shell/pack.ts, src/execution/wasix-pack.ts, src/execution/wasi-preview1-pack.ts, src/execution/node-webcontainer-adapter.ts — so the agent tool and the UI genuinely disagree about the same file by base64's 4/3 ratio. Note the UI cannot fix this locally for binaries: `workspaceEditorProjection` (src/ui/workspace-view.tsx:1910-1918) sets `content: ""` for binary buffers, and Explorer rows only have WorkspaceEntry, so the decoded length is not available client-side.

**Root cause:** `WorkspaceEntry.size` is defined as the storage-envelope length rather than the file's logical byte length, and the UI is the only consumer that reads it as a user-facing file size instead of a storage/quota bound.

**Smallest fix:** Make the ports report the logical length: `size: workspaceContentByteLength(content)` at src/workspace/memory.ts:50 and src/workspace/indexeddb.ts:80. This must be paired with an audit of the consumers that use `size` as a *storage* bound — src/vault/encrypted-workspace.ts:85 (`entry.size > maxBytes`), src/git/encrypted-workspace-adapter.ts:540/:574/:607, src/indexing/incremental-indexer.ts:76 — which should either keep comparing against the envelope explicitly or have their limits restated in logical bytes. If that audit is out of scope, the strictly smaller alternative is UI-only: suppress the size on the editor strip for `buffer.binary` (the binary preview panel at src/ui/workspace-view.tsx:1289 already says the envelope is never exposed) rather than print a number that is wrong.

**Acceptance:** Write a known 96 KiB PNG through the workspace port; `list()` reports 98304 and the Explorer row and editor strip both render ~96 KiB — the same number `read_workspace_file` reports in its `size` metadata (src/tools/workspace-tools.ts:108). Existing byte-limit gates still reject files that exceed their documented limits.

### 138. [low] Line numbers vanish silently past 5,000 lines — the exact failure the surface note claims to prevent

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/ui/workbench-model.ts, src/ui/workbench-model.test.ts, src/ui/workspace-view.tsx  
- **Regression risk:** low

**Why (reviewer):** src/ui/workspace-view.tsx:1936-1937 `if (lines > limit) return undefined;` with `WORKSPACE_GUTTER_LINE_LIMIT = 5_000` at :1926, and the gutter is rendered only `{gutterLines && !wrap ? … : null}` at :1297. src/ui/workbench-model.ts:358-363 `editorSurfaceNote({ wrap, binary })` has no third case and returns "UTF-8 · LF · client-side" for an unwrapped text buffer regardless of the cap; it is called with exactly those two inputs at src/ui/workspace-view.tsx:1342. src/ui/workbench-model.ts:356 states the function's purpose is to avoid "letting the numbers disappear silently". Reachable within the 128 KiB editor bound (src/ui/workspace-view.tsx:62): 5,001 short lines is ~5 KB.

**Root cause:** The gutter has two independent suppressors (wrap mode and the line cap) but the strip note was written against only one of them.

**Smallest fix:** Add a third input to `editorSurfaceNote` in src/ui/workbench-model.ts:358 — e.g. `{ wrap, binary, gutter: boolean }` — returning "UTF-8 · LF · client-side · no line numbers above 5,000 lines" when `!wrap && !gutter`, and pass `gutter: Boolean(gutterLines)` at src/ui/workspace-view.tsx:1342.

**Acceptance:** Pure-model test: `editorSurfaceNote({ wrap: false, binary: false, gutter: false })` mentions the line cap; `{ wrap: false, binary: false, gutter: true }` is unchanged from today's string. Browser: opening a >5,000-line file shows no `.code-gutter` AND the `.editor-strip` states why.

### 139. [low] The code editor is still a plain textarea with no language awareness (WKS-03)

- **Cluster:** workspace-editor  
- **Verdict:** confirmed  
- **Files:** src/ui/workspace-view.tsx, src/ui/workspace-view.css  
- **Regression risk:** high

**Why (reviewer):** Verified factually: the editing surface is one `<textarea class="code-editor">` at src/ui/workspace-view.tsx:1298-1318; src/ui/workspace-view.css:242 gives it a single ink colour and a monospace stack with no token classes; there is no highlight layer or tokenizer anywhere in src/ui. src/ui/workspace-file-icon.tsx:148 does resolve per-path language deterministically and is used only for icons. However this is not an undisclosed gap: docs/VOICE_REVIEW_BACKLOG_2026-07-28.md:624 lists "WKS-03 syntax highlighting" among items "still open from the register, unchanged by this pass", and :104 records WKS-03 as MISSING. I also checked UI copy for any claim of highlighting or code themes and found none, so nothing is misrepresented to the user.

**Root cause:** WKS-03 is unimplemented scope, explicitly deferred in the directive register — not a defect introduced by the current code.

**Smallest fix:** No minimal fix exists; this is feature work. If it is taken up, the smallest honest increment is a read-only highlight layer positioned behind the transparent textarea sharing its exact font/line-height/padding metrics (the `.code-gutter` pairing at src/ui/workspace-view.css:241-242 already documents that constraint), driven by the language already resolved in src/ui/workspace-file-icon.tsx:148, plus code-theme tokens for dark and paper.

**Acceptance:** Only if scheduled: a `.ts` buffer renders at least three distinct token colours in dark and paper; caret/selection/scroll stay in exact register with the highlight layer at every density (src/ui/workspace-view.css:590-594) and with wrap on and off; files above WORKSPACE_GUTTER_LINE_LIMIT and above WORKSPACE_EDITOR_BYTE_LIMIT keep their existing bounded behaviour; drafts still persist across remount.
