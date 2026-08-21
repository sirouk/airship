# Chutes Airship Voice Review — Distilled

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../SIMPLIFICATION.md`](../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

*Telegraphic / grammar-sacrifice distillation of `pasted-text.txt`. 1 section. Built with a federated extract -> explain-diagrams -> adversarial-gap-check -> consolidate pass — nothing dropped in translation.*

## Contents

- [Synthesis](#chutes-airship-voice-review-synthesis)
- [Chutes Airship discussion](#chutes-airship-discussion)

---

# Chutes Airship Voice Review — Synthesis

## Core theses

- Airship should combine chat-level simplicity with a full-strength agent workspace. Depth may be reorganized, collapsed, or progressively disclosed, but capabilities, evidence, controls, and information must not be pruned or hidden. [Section 01]
- The active profile is the primary silo for conversations, workspace, terminal, memory, indexes, audit, and proof. Vault, Connections, and Account are global. [Section 01]
- Capability activation is proactive: detect browser runtimes, acceleration, storage, extension, and remote compute; explain how to enable what is available; and keep the agent aware of live capability changes on every turn. [Section 01]
- Durability advances visibly from page-ephemeral through browser persistence, extension/device support, external encrypted storage, and a future Chutes CPU TEE tier. [Section 01]
- Airship may borrow proven jobs and interaction mechanics from agent, chat, and editor references, while keeping original implementation, its own identity and trust model, complete evidence, and full mobile capability. [Section 01]

## How the system fits together

1. A user selects a profile, which establishes the agent persona and the default scope for conversations, workspace, terminal, memory, skills, permissions, audit, and proof. [Section 01]
2. Airship probes the environment, activates safe supported capabilities, makes any required opt-in obvious, and gives the agent a live capability manifest rather than stale assumptions. [Section 01]
3. Airship maintains a living semantic index of conversations, files, Git state, terminal work, memory, and capability changes so the agent can retrieve the right bounded context automatically. [Section 01]
4. Work happens in resumable conversations with explicit continue, fork, edit, retry, model-switch, tool, and permission semantics; the workspace combines editor, source control, and persistent terminals. [Section 01]
5. State is encrypted and persisted at the strongest user-selected durability tier, with migration and reconciliation made visible and recoverable. [Section 01]
6. Every completed turn and meaningful side effect yields inspectable receipts and, where supported, independently verified attestation evidence. [Section 01]

## Cross-cutting constraints and pitfalls

- Improve hierarchy and progressive disclosure without deleting advanced detail. Avoid hidden or misleading state, jailed workflows, false switching/proof claims, and controls that only appear to work. [Section 01]
- Distinguish continuing a conversation from forking it and from editing/retrying an earlier turn. Immutable receipts record what happened; time-sensitive evidence must remain separately refreshable and honestly labeled. [Section 01]
- Automate probing, retrieval, runtime activation, storage reconciliation, and evidence acquisition where safe. Ask for consent only when a real capability or trust boundary requires it. [Section 01]
- Desktop and mobile must expose the same product power. Layout may change, but no mobile route may omit details, controls, actions, or verification state. [Section 01]

## Reference and tool index

Hermes Agent; Claude and Claude Code behavior; Codex; Cursor behavior; VS Code/Code - OSS; Open WebUI and ChatGPT interaction patterns; OPFS/IndexedDB, Google Drive, S3/MinIO; WebGPU, WebNN, WebAssembly/WASI, Python and Node runtimes; browser extension; Chutes CPU TEE; Intel TDX, AMD SEV, and NVIDIA Confidential Computing. These are lenses for functional behavior and interoperability, not source to copy. [Section 01]


---

# Section-by-Section Reference

## Chutes Airship discussion

### Product shaping mandate

Airship should feel fast, lightweight, potent, expandable, and easy to organize. The next phase is a shaping exercise, not a feature-pruning exercise: preserve all information and functionality, reorganize it into clearer hierarchy, and let a novice begin simply while an expert can descend into complete controls and evidence. Keep the existing Airship aesthetic and identity, fix visual defects such as background-grid flicker and inconsistent sizing, and use progressive disclosure rather than concealment. Mobile must retain desktop capability and detail.

### Profiles, ownership, and navigation

Put the active profile at the top of desktop navigation. The default profile set is General, Research, and Developer (renamed from Builder / Systems), with genuinely distinct themes and no accidental font-size jump. The active profile is the default silo for conversations and their branches, workspace and files, terminal sessions and history, memory and indexes, audit, and proof. Vault, Connections, and Account stay global. Shared workspace use, if retained, must be explicit rather than an accidental leak. Switching profiles should restore that profile's last working context, not silently manufacture an unrelated session.

The direct order is Profiles, Skills, Capabilities. Proof should remain close to the profile/session Memory context. Settings that define agent presentation or behavior—theme, mode, typography, density, corners, font, tool-step presentation, and reset behavior—need an explicit profile/global ownership model; reset is confirmed and truthful. Mobile More uses the same logical order and exposes equivalent depth.

### Skills and capabilities

Skills are reusable, versioned agent instructions. Global inheritance is the default, with clear per-profile enable/disable/override boundaries. Make resolved scope obvious and functional. Support discovery through slash commands, adding/importing/creating skills, and visibility into the tools and instruction boundaries each skill brings. The target is the broad practical agent strength associated with Hermes, Claude, and Codex, expressed through Airship's own contracts and permission model.

Capability probing happens on first load and lifecycle changes. Probe WebGPU, WebNN, WebAssembly/WASI, OPFS and browser persistence, Python/Node and other supported runtimes, extension capabilities, network/provider access, and available remote compute. Activate safe supported runtimes by default where cost and consent permit; otherwise present an immediate, actionable opt-in or an honest unsupported state. A global resource indicator should explain CPU, memory, GPU/accelerator, runtime, and task consumption. Capability-card actions that launch a command must create an obvious new conversation with the command visibly prefilled, not mutate an unrelated existing chat. The current capability generation and relevant changes belong in every agent turn.

### Conversation list and profile cockpit

Chat should contain its conversation tree inline rather than requiring a detached manager for ordinary work. Scope the list to the active profile; offer searchable recent and addressed/needs-attention views; provide durable, ordered favorites; and keep the current conversation obvious. Preserve a detailed library for audit and advanced search, but do not leak conversations between profiles through recents, palettes, or default filters. Titles are directly renameable and durable, including an accessible mobile action.

Continuing an existing conversation should be the easiest path and should preserve its pinned meaning. Hash URLs, reload, and profile switching restore the intended conversation when bindings still match. A fork copies the full eligible history and context into a clearly named branch without rewriting the source. Editing or retrying an earlier turn creates explicit branch semantics rather than appending a contradictory turn at the current head. Search covers messages, workspace material, and semantic/profile scope. Claim and tool detail may collapse for readability, but remains inspectable.

### Chat, composer, models, and permissions

Keep the composer visually light while retaining attachments, tools, skills, permission mode, model/provider, capability tier, E2EE/trust state, token/context budget, and send/stop behavior. Expand attachments beyond images to supported text, Markdown, PDF, and code inputs with type/size/security validation and model-capability gating.

The Chat model picker is the single rich model-selection surface: provider, model, capabilities, pricing/context facts where available, connection state, and proof compatibility. Connecting a provider should complete the connection; model choice belongs in Chat. Switching models or other pinned meaning creates a new session/fork and visibly records that transition. Normal inference must not be mislabeled as model switching.

Preserve permission modes from read-only through broader agent execution, with approval gates enforced by code rather than prompt text. The agent receives the effective policy and live capability/tool schema every turn. Tool calls, reasoning summaries where appropriate, message actions, token counts, receipts, and trust claims remain available without overwhelming the default reading path.

### Agent loop and semantic awareness

The agent should proactively inspect and use allowed tools, skills, runtimes, storage, files, Git, and indexed memory. Maintain a living semantic codebase/workspace index and retrieve bounded, provenance-bearing context each turn. Re-index incrementally after file, Git, terminal, capability, provider, profile, or storage changes. Do not force users to discover basic power through settings. Airship should adopt useful functional mechanics from capable reference agents while preserving its browser-first authority, typed tools, explicit permissions, and original implementation.

### Workspace, editor, source control, and Git

Unify Explorer, editor, Source Control, diffs, history, and terminals into one workbench. Do not keep a competing top-level Sources product. Files single-click into an italic preview, a later preview replaces it, double-click or edit pins it, dirty files stay safe, and middle-click closes where appropriate. Use a real document model with syntax highlighting and selectable code themes.

Source Control is repository/worktree aware and defaults to a path tree. Put repository selection, changes, commits, recent origin history, branches, worktrees, and relevant actions in the Source Control rail. Open working-tree and historical diffs as normal editor documents with the same preview/pin lifecycle. A commit-file or Memory-result action can reveal and select the exact file in Explorer. Add authenticated GitHub clone/fetch/push and truthful credential ownership. Export a file, a folder archive, or a complete repository with history.

### Terminal

Terminals are persistent, profile/workspace-scoped tabs with names, current directory, scrollback, history, transcripts, and safe reload/restart semantics. The target is ordinary Bash/Linux developer behavior and native Git against the authoritative repository, not a separate Shared Git injection model. Dock a resizable terminal under the editor and support Open Terminal Here from files and folders. Reconcile shell and browser workspace changes automatically at safe boundaries; surface conflicts rather than overwriting. Commands and their filesystem/Git effects join the same audit and proof chain as chat tools.

### Memory

Memory combines a dominant federated search with Recall, Graph, and Index lineage. Remove redundant jump/metric chrome when it competes with search, but preserve every underlying view and detail. Semantic indexing should choose the best supported mode automatically with deterministic fallback and visible status. Search results open the exact message, file, path, or indexed object in its native surface. Retrieval records query, scope, selected sources, lineage, and bounded injected context.

### Proof and attestation

Every completed inference turn and meaningful local/terminal side effect produces an automatic, durable, profile/session-scoped receipt. Chutes evidence acquisition should follow eligible successful turns automatically; manual refresh remains a retry/diagnostic action, not the normal path. Persist encrypted evidence and restore it after reload.

Keep claims independent: E2EE transport, Intel TDX or AMD SEV CPU evidence, NVIDIA Confidential Computing, model identity/signature, conversation binding, freshness, and Vault encryption may each be verified, unavailable, stale, or failed. Never imply a complete confidential stack from one provider assertion. Proof needs a clear master/detail presentation, complete evidence, and mobile parity. Immutable receipts say what occurred; refreshed evidence says what can be verified now.

### Vault and durability ladder

Make the durability tier unmistakable. Stage 1 is deliberate page-ephemeral memory. Stage 2 is encrypted browser-owned persistence such as OPFS/IndexedDB with clear retention limitations. Stage 3 adds the browser extension/device tier for ciphertext caching, compute help, and integration support without falsely calling a cache authoritative. Stage 4 uses encrypted external authorities such as Google Drive and S3-compatible storage/MinIO. The future highest tier is authenticated, end-to-end encrypted Chutes storage/compute inside an attested CPU TEE.

Provider adoption and migration must copy, verify, reopen, and only then switch authority. Reconciliation should be incremental, resumable, conflict-aware, and observable across devices. Sharding or offload must never expose plaintext outside the explicitly selected trust boundary. Clearly distinguish implemented durability, preview providers, unevaluated cross-device convergence, and future remote capability.

### Connections, Account, extension, and Chutes remote compute

Chutes is the primary connection and first Account tab, with OAuth preferred and API key as an advanced alternative. Connection success should return the user to Chat without forcing model choice in a setup wizard. Add provider-appropriate OAuth/API-key flows for OpenAI, Anthropic, xAI, and other supported providers. Account tabs show authenticated identity, balance, quotas, usage, reset dates, and telemetry where APIs permit, and explicitly label unavailable data.

The extension reports connection/status and can provide narrow CORS relay, encrypted storage acceleration, compute offload, and secure OAuth assistance with explicit token ownership and revocation. It is not an arbitrary security bypass. The user and agent must know when work falls back to the page.

A future Chutes CPU/TEE tier can offload a complete bounded job, compute, inference, and encrypted storage through an attested channel. It needs immutable job inputs, measured executor identity, end-to-end encryption, cancellation, reconnection, bounded outputs, signed receipts, copy-on-write deltas, and browser-side validation before adoption. Until that protocol exists end to end, it remains unavailable and must not be presented as current capability.

### Visual, responsive, and accessibility contract

Retain Airship's restrained grid and themes while eliminating flicker, accidental profile typography changes, weak placeholder contrast, inconsistent widths/weights, and unclear iconography. Theme-mode controls use recognizable icons and accessible names. Collapsing is for comprehension, not omission. Keyboard, screen-reader, touch, reduced-motion, narrow-phone, tablet, and desktop journeys must expose equivalent information and actions.

### Reference and originality boundary

Use Hermes Agent, Claude/Claude Code behavior, Codex, Cursor behavior, VS Code/Code - OSS, Open WebUI/ChatGPT behavior, CocoIndex, browser Git/terminal projects, and platform standards as focused lenses. Record pinned provenance. Extract only user-visible jobs, inputs, outputs, states, interfaces, invariants, failure behavior, accessibility, mobile behavior, and interoperability constraints into a source-free Airship specification. Implement original Airship code from that specification. Do not copy or mechanically translate source, prompts, tests, prose, styles, assets, branding, naming, or distinctive organization; do not execute research checkouts or let them enter build, test, or release paths. Treat approval to inspect as neither permission to copy nor a substitute for license/legal review.

### Delivery logic

First make state truthful and profile-scoped; then build the profile conversation cockpit and durable continuation/branching; unify composer/model/attachment behavior; unify the workspace document model and integrated terminal; complete automatic durable proof; finish the storage/extension ladder; and only then expose remote Chutes execution after its protocol and evidence gates pass. Visual/accessibility/mobile verification runs through every wave.

---
