# Airship Design Direction — Executable Specification

**Version:** 1.0 · 2026-07-27 · Design Director
**Scope:** all ten routes, shipped-code-accurate. Supersedes the seven lane reviews where they conflict.
**Repo:** this repository; every path below is repository-relative.

---

## 1. Design thesis

Airship is not under-designed; it is **under-hierarchied and over-restated**. Seven reviewers measured seven surfaces and found one disease with four expressions: (a) *every fact is rendered at the altitude of a headline* — the word "completed" is 17px while the tool name is 11px, the route eyebrow is brass while the primary CTA is 102px below the fold, `.durability-indicator` at 233px out-shouts a 21px H1; (b) *every fact is rendered wherever it was computed* — "Ephemeral" appears in the topbar, the session meta and a mobile details sheet because three components each had access to the variable, and "Connect a model" appears three times on one empty screen because three components each had a reason; (c) *the design system is already correct and is routed around* — a clean 6-step type ramp renders 35 sizes, a token'd 4px grid renders 79% off-grid, and one excellent `<Seal>` component is surrounded by 49 competing status families; (d) *disclosure was built and then gated off* — `TrustPostureSheet` says "the weakest claim is shown in the topbar" and is gated to mobile-and-connected; `.composer-input-row[data-multiline]` is the correct composer layout, gated behind having already typed a newline. The result is an interface that spends 24–34% of every viewport telling you things it tells you elsewhere and 42% telling you nothing.

**The organising idea: one fact, one home, one altitude — and every home is a chip that expands.** Concretely: (1) a single **scope rule** decides where a fact lives — *topbar = true of this browser tab; session bar = true of this conversation; composer footer = true of the keystroke you are about to make; route header = true of this route* — and a fact may render as text in exactly one of them; (2) a single **disclosure ladder** — verdict word always visible → chip → popover with full detail → route — so subtraction is never amputation and no fact ever lives only in a `title` attribute; (3) a single **status family** (`<Seal>`, seven frozen states, three densities) and a single **44px bar** primitive that every route header, session bar and lane header is an instance of. Nothing in this document deletes a claim. It moves ~1,900px of restated chrome down one rung of the ladder and gives the ~2,100px it frees back to the conversation, the transcript and the credential fields.

---

## 2. Conflicts resolved

| # | Conflict | Decision | Why |
|---|---|---|---|
| 1 | Chat lane: `.stage-header` → 38px one-row `.session-bar`. Model lane: keep a ~76px header with the model chip inline on the H1 baseline. | **One 40px `.session-bar`.** Model chip is a right-cluster chip with `max-width: 32ch`. | The model lane's own defect — 526px of dead title column beside a starved 169px model field — is *caused* by the two-column header. One row removes the column, and 32ch (~250px) exceeds the 250px the model lane asked for. Two rows solves nothing that one row does not. |
| 2 | Model lane: chip carries an 8px posture dot opening the claim stack. Chat lane: posture lives in a session status chip. | **The model chip carries no posture.** Posture is the session status chip's only job. | Two click targets in one 28px chip is unusable, and it re-splits the posture fact across two controls 140px apart — the exact defect being fixed. |
| 3 | Chat lane: session chip carries durability ("Ephemeral"). Cross-surface lane: topbar chip carries durability, session instance is dropped as redundant. | **Both keep a durability claim, and the two claims stop being identical.** Topbar `vault` axis label when unadopted changes from `"Ephemeral"` to **`"No vault adopted"`** (detail unchanged). The session chip keeps `"Ephemeral · this page only"`. | They were never the same claim: one is "is a vault backend adopted in this tab", the other is "where does *this conversation's* journal live". They read identically only because today both are empty. Renaming the tab-scope one is a one-line honesty fix that removes the duplication without removing a claim. |
| 4 | Composer lane: relabel to sentence case (`Ask first`, `Auto approve`, `Full access`). | **Rejected. Labels stay Title Case verbatim.** Only the grid and the font-weight change. | `"Ask First"`/`"Auto Approve"`/`"Full Access"` are asserted `exact: true` in `e2e/composer-layout.spec.ts:125-127`, `e2e/airship-shell.spec.ts:14,244,255,285,290`, and rendered by `platform-shell.tsx:344-346`. Casing churn against eight shipped assertions buys nothing; the measured defect is the 48.2px-of-80px label track, which the grid fix repairs. |
| 5 | Composer two-row layout on phone (90px card) vs. shipped `e2e/responsive-breakpoints.spec.ts:59` `composerHeight <= 60`. | **Two rows on every viewport; the assertion is deliberately amended to `<= 92` and joined by two stronger assertions** (§7.2). | The same file asserts `approval.height >= 44` and `attachment.height >= 44` (lines 147-148). A 44px touch row plus a 44px text row cannot be 60px. The two assertions are arithmetically incompatible; the touch-target one wins, and the invariant the 60px cap actually protected (composer share of a phone screen) is re-expressed as a share assertion that is *harder* to pass. |
| 6 | Tool lane: settled turns collapse to one summary header row. Blueprint §11 line 1016: "Every tool step renders a permanently-visible one-line row"; P6 forbids default-collapsing the fact that a step occurred. | **Collapse only when `settled && every step completed && count >= 4`.** The header enumerates counts, distinct tool names and outcomes. Plus an expert override `preferences.transcriptOperations: "rows" \| "summary"` (default `summary`), which the blueprint already anticipated. | The blueprint's intent is "no invisible tool calls". `⟡ 4 steps · read_file ×2, list_files · all completed` does not hide that steps occurred, or which. At ≤3 steps there is nothing to gain, so rows stay. Any failure or denial forces rows open. This amends blueprint §11 line 1016 and the amendment is recorded there. |
| 7 | Cross-surface lane: `density="dot"` = 10px seal; tool lane: `<Seal size={13}>`. | **Rejected. Every seal renders in a ≥16px well.** `dot` density = 16px well, no label, `aria-label` carries the word. | P2 is explicit ("≥16px seal wells… *Forbids:* seal glyphs below 16px") and `sealRenderedSize()` already floors at 16 — both proposals would have silently rendered 16px anyway while the CSS assumed 10/13. The *label* scales to `--fs-micro`, not the glyph. |
| 8 | Cross-surface lane: delete every 5px and 8px border-radius as off-token. | **Rejected as diagnosed.** 5px is `--radius-control` and 8px is `--radius-panel` **resolved under the default `corners: "subtle"`** (`platform-shell.tsx:250`, `styles.css:115-118`). They are the tokens working. | The real violations are literal `3px`, `4px` and `50%`. The CI guard forbids literals, not resolved values — and must not break the `data-corners` knob, which is a shipped preference. |
| 9 | Cross-surface lane: swap `--font-display` Georgia → self-hosted Source Serif 4 (~28KB), serif gets two jobs (route title + metric value). | **Typeface swap deferred out of this program. The serif gets exactly one job: the route title.** Metric values are `--font-body` (Inter) with `font-variant-numeric: tabular-nums`. | Startup gzip has ~3.1 KiB of headroom against a 132 KiB cap that has explicitly never moved through three capability waves (`scripts/release-gate.mjs:22`). Georgia's default figures are oldstyle proportional, so the serif cannot deliver the tabular alignment that was its justification; Inter can, today, for free. The swap becomes an independently budgeted proposal with its own font line item, not a rider on a layout program. |
| 10 | Connect lane: bespoke 44px sticky route bar with count chip. Cross-surface lane: `<RouteHeader>` 44px with ⓘ + status chips. Model lane: swap the preamble for a task bar while a candidate is open. | **All three are one component: `<RouteHeader>`.** Connect's count chip is a `<Seal density="chip">` in the status slot; "How connections are held" *is* the ⓘ; candidate-open swaps the status slot content. | Three lanes independently specified the same 44px row. Building it three times is how nine tab families happened. |
| 11 | Nav lane: `rail` (60px) is the default below 1362px, including tablets. | **Amended: default `standard` (232px) for `(hover: none)` viewports ≥861px.** `rail` is the default only for fine-pointer viewports below 1362px. | The 60px rail's labels live in hover tooltips. A touch tablet has no hover, so the rail would ship 11 unlabelled icons. The reason the 104px tablet rail beat the 232px desktop rail was *content volume* (943px in a 701px box), and WP-8 fixes content volume — the rail drops to 491px, so 232px fits on an iPad with room. |
| 12 | Chat lane: delete `.chat-live-guidance`, move `id="chat-demo-guidance"` onto the model chip. | **Delete the band; the id moves to a permanently-mounted zero-pixel `<p class="sr-only" id="chat-demo-guidance">` inside `.composer-wrap`, rendered whenever `composerUsesDemo`.** | `app.tsx:5125` sets `aria-describedby="chat-demo-guidance"` on Send. A chip popover unmounts; a transcript intro unmounts after the first turn. A dangling `aria-describedby` is an accessibility regression. The sr-only paragraph is the only target with the same lifetime as the reference. |
| 13 | Nav lane: rename `#connection` from "Connection" to "Models" in the rail; page H1 stays "Connect models". | **Both become "Models".** Rail label, trust-hub tab and the `<h1 id="access-connection-title">` all read `Models`. CTAs stay `Connect a model`. Hash `#connection` is unchanged, `#models` added as an alias. | A verb CTA pointing at a noun destination is correct and normal; two different *nouns* for one destination is the defect. Costs three assertion updates (`access-view.copy.test.ts:130`, `connect-inference.spec.ts:20,249`) — those are deliberate copy guards, designed to be updated on purpose. |
| 14 | Cross-surface lane retires `--fs-h3` (22px) in favour of `--fs-title` (20px) / `--fs-display` (28px). Connect lane sets the route H1 at `--fs-h3`. | **One route title token: `--fs-display` 28px, in a 44px bar, on all ten routes.** `--fs-h3` is retained for one release as `var(--fs-title)` and deleted in WP-9. | 28px on a 1.15 line-height is 32px, which fits a 44px bar. A second 22px route-title size would recreate the 2.2× spread being deleted. |

---

## 3. The information ledger

Legend: **STAYS** = visible text, same or better prominence · **CHIP→** = becomes a chip's visible label; full string is level-1 popover body · **MOVES→** = renders on a different surface · **MERGES** = combined with a named sibling · **REMOVED** = ceases to render as text anywhere; carrier named.

### 3.1 Chat chrome — topbar and session bar

| Information (current render) | Fate | Carrier after |
|---|---|---|
| Brand "Airship / EDGE RUNTIME" (232px) | STAYS desktop; in `rail`/`focus` state → mark only | 22px seal mark + `title`/`aria-label`; restored on hover-peek and on exit |
| `local` axis "Browser / Edge runtime" (161px pill) | CHIP→ topbar posture chip | Worst-of chip label + row 1 of topbar popover with full `detail` |
| `vault` axis "Ephemeral" (95px pill) | **RELABELLED** to `No vault adopted`, then CHIP→ | Row 2 of topbar popover, `detail` unchanged ("No cloud vault is configured.") — see conflict 3 |
| `e2ee` axis "Connect a model" (128px action pill) | MOVES→ session bar | Session status popover row + the empty-state CTA + starter chip. Exactly one button with accessible name `Connect a model` remains visible on `#chat` at every width (shipped e2e selector) |
| `attestation` axis (truncates to "Secure hardware not c…") | CHIP→ session status chip | Never truncates again: full label + `detail` as popover body text |
| "Local kernel ready" (109px + teal dot) | STAYS | Unchanged, `role="status"` live region unchanged |
| 3 topbar icon buttons | STAYS | Unchanged |
| Eyebrow "ACTIVE SESSION · GENERAL" (15px band) | **REMOVED as text** | Carried by: the 18px `GE` profile monogram immediately left of the H1 (with `aria-label="Active session · General profile"`), the pinned profile row in the rail, and the profile popover. "Active session" labels the screen you are already on. The profile *name* is on screen three other times. |
| H1 conversation title (wraps to 2 lines at 165px) | STAYS, one line | 15px serif, `text-overflow: ellipsis`, full text in `title`; also in the rail's conversation popover and `#sessions` |
| `.session-runtime` eyebrow "SESSION MODEL" | **REMOVED as text** | It is a label, not a fact: it becomes the prefix of the model chip's `aria-label` and the ModelPicker popover's sticky header |
| Model id `airship/demo-v1` / `Qwen3-32B-TEE` (truncated at 169px) | STAYS, **untruncated** | Model chip, `max-width: 32ch`; full vendor-prefixed id in `aria-label` and picker |
| Boundary micro-pill `Local` (clipped to "Loca" on iPad) | STAYS | Trailing micro-pill on the model chip; the collision with the mobile `+` is gone because `+` is a first-class chip in the same cluster |
| Posture `E2EE · evidence recorded` (185px pill) | CHIP→ session status chip | Row 1 of the session status popover, verbatim from `activeConnectionBoundaryLabel()` / `activeConnectionProofLabel()`; retains its `#access` navigation |
| `.session-attestation` "Secure hardware not checked · this session" (325px) | CHIP→ | Session status popover, **promoted from tooltip-only to visible body text**, with `→ Proof` |
| `.session-lifecycle` "Ready" / "Turn in progress" / "Last turn failed" (47px) | CHIP→ | Session status popover row 3; drives the chip's word when a turn is running or failed |
| `DurabilityIndicator` "Ephemeral · this page only" (233px, 12.75px in an 11.69px row, only dashed border in the header) | CHIP→ | Session status popover row 2, with `→ Vault`. Also restated once, deliberately, in the composer posture chip at the moment of data creation |
| "20 recorded steps" | CHIP→ journal chip | Visible as `⌗ 20`; long form in `title` |
| Session id `#3af63bf0` | STAYS | Journal chip visible text |
| Branch-from-fork link | STAYS | `⑂` glyph prefix on the journal chip, own click target, source id in `title` |
| `.chat-live-guidance` "Workspace, editor, terminal and Git work right now." | **REMOVED as a band** | Verbatim as line 1 of `.transcript-intro`; paraphrased in the model chip popover |
| `.chat-live-guidance` "Chat needs a model provider; this composer is a deterministic demo." | **REMOVED as a band** | Verbatim as line 2 of `.transcript-intro`; lead of the model chip popover; **and** as the permanently-mounted `#chat-demo-guidance` sr-only description (conflict 12) |
| `.chat-live-guidance` "Connect a model" button | REMOVED (3rd of 3 on one screen) | Model chip popover action + starter chip + session status popover `e2ee` row |
| Welcome message body | MERGES with the banner copy | `.transcript-intro`, deduped, bottom-docked 24px above the composer |
| Welcome receipt pill "Initial · Browser baseline" | "Initial" REMOVED; "Browser baseline" STAYS | "Initial" is definitionally true of the first item in an empty transcript; "Browser baseline" keeps its chip, click target and receipt tooltip |
| Welcome avatar "A" + Copy/Retry/Branch menu | **REMOVED** | An avatar attributes a speaker in a transcript of turns; this is not a turn. The menu offered three operations on a message no model produced — Retry and Branch had no referent. |

### 3.2 Composer

| Information | Fate | Carrier after |
|---|---|---|
| Placeholder "Ask Airship or type / for tools and session commands…" (349px into a 304px box; 3 clipped lines on phone) | SHORTENED to `Message Airship — / for commands`; `Message Airship` below 480px | Dropped words move to the slash menu's new sticky header (`Commands and session tools · Enter or Tab to accept`) and the textarea `title`. The menu enumerated by name is a better carrier than a clipped sentence describing it. `aria-label` stays exactly `Message Airship` (shipped selector) |
| "Attach image" visible text (103.7px) | ICON-ONLY at all widths | `aria-label="Attach image"` (already present) + `title`; matches the mobile treatment that already ships |
| "local demo · page memory" (164.9px; **0×0px on phone**, `styles.css:5551`) | CHIP→ composer posture chip, **rendered at every breakpoint** | `⚿ Local demo` / `⚿ Local endpoint` / `⚿ Key in memory` / `⚿ Offline`, each expanding to its full sentence. Restores a P9 violation and `AIRSHIP_DESIGN_BLUEPRINT.md:1357` |
| `Ask First` / `Auto Approve` / `Full Access` trigger, 700-weight, 120px fixed | STAYS verbatim; weight 700→500, width fixed→auto | Left cluster of the footer strip, keeps escalation dot colours |
| Popover option labels truncating to "Auto …" (48.2/80px), "Full …" (39/67px) | **RESTORED to full width** | `grid-template-columns: minmax(max-content,auto) minmax(0,1fr) auto`; `white-space`/`text-overflow` removed from `.menu-select-option strong` |
| Three approval descriptions | STAYS verbatim | Unchanged (`app.tsx:5101-5103`) |
| "Conversation approval policy" scope (aria-label only) | **PROMOTED to visible** | Popover header `Approval policy` + footer `Applies to this conversation only.` |
| Enter sends / Shift+Enter newline / Enter-while-busy queues (**nowhere in `src/ui/`**) | **NET-NEW disclosure** | `.composer-keyhint` legend in the footer strip on focus/input, fine-pointer only; swaps to `↵ queue` while busy |
| Send button `title` strings incl. disabled reasons | STAYS + mirrored | Kept verbatim; disabled reason additionally mirrored into the posture popover so touch users can read it |

### 3.3 Tool-call rendering

| Information | Fate | Carrier after |
|---|---|---|
| "Tool step completed" ×6 per turn, 17px, 175px wide | **REMOVED as visible text** | The row's visible word becomes `Ran`/`Running…`/`Failed`/`Denied`/`Queued`/`Stopped` at `--fs-micro`; the full sentence is verbatim in `title` and `aria-label` (`Seal` already concatenates `detail`). Screen readers hear the identical string. Colour is still not the sole carrier. |
| Eyebrows `TOOL CALL` / `TOOL RESULT` | MERGES | A joined row *is* a call and its result; the distinction is labelled inside the sheet (`ARGUMENTS · BOUNDED DISPLAY` / `RESULT`) |
| Pills `COMPLETED` + `SUCCESS` | MERGES into one outcome word | A joined row has one outcome |
| `argumentsSummary` (behind a disclosure) | **PROMOTED to the resting row** | Argument-digest cell, first scalar value, ellipsised; full bounded JSON in the sheet |
| `summary` / `metadataSummary` (behind a disclosure) | Digest PROMOTED; full text stays | Result-digest cell (`845 B`, `23 items`, `1.2 KB`, first error clause); full bounded text in the sheet |
| `callId` `call_8f2a…` | STAYS in the sheet | Sheet header, right cell |
| `capabilityTier` + `capabilityTierDetail()` | STAYS in the sheet | Sheet header `RESULT · <tier>` with its existing tooltip |
| `sequence` / `ordinal` (**discarded at render today**) | **NET-NEW disclosure** | Parallel-batch bracket + strip header ` · 3 in parallel` + group `aria-label="3 steps issued together"` |
| `operation-overflow` "12 of N tool steps shown · Show chronological remainder" | MERGES into the strip header count clause | `⟡ 18 steps · 12 shown in order · all completed`; remainder rows render inside the same strip, no nested `<details>` |
| Streaming "Thinking" chip + bottom three-dot pulse (two indicators, one turn) | MERGES | Strip header `⟡ Working · 3 steps` with the `checking` seal's existing `data-acting` rotation. The pulse is retained for messages with **no** operations, where it is the only indicator |
| Assistant answer prose (13px, unframed) | **ENLARGED** | `--fs-body` 15px; last text part of a settled turn gets `.message-part.text--answer` |
| Interstitial narration | STAYS, differentiated | `--fs-meta` 13px `--ink-muted` — planning is now distinguishable from the answer |

### 3.4 Model selection

| Information | Fate | Carrier after |
|---|---|---|
| Topbar `Chutes · Qwen3-32B-T…` on `#chat` | **REMOVED (route-aware)** | On `view === "chat"` the pill becomes `Chutes · E2EE`; the full untruncated id is 40px away in the model chip, plus in the pill's own `title`/`detail` (unchanged), plus the chip's `aria-label`. On every other route the pill keeps the full form — it is the only model display there. `E2EE` is **promoted** from hover-only to visible. |
| `STARTS A NEW PINNED CONVERSATION` ×11 rows (32 identical chars winning the width) | MERGES into one sticky footer sentence | `Choosing a different model opens a new pinned conversation. Turns already recorded keep the model they ran on.` — stated once, always visible, never truncated |
| `CURRENT PINNED MODEL` suffix | MERGES | `Current` badge + `✓` |
| Row capabilities `Text · Vision · Tools · Confidential candidate` (truncated, `Text` on 12/12, `Confidential candidate` on 12/12) | CHIP→ glyph pills at rest; full string on focus | `◧ vision`, `⌘ tools`, `⬡ TEE`, `▶ video`, each with `title`; focused row expands to 76px and shows the verbatim full line |
| Context / max output / prices | STAYS abbreviated; full on focus | Right metric column `41k · $0.10/$0.42`; focused row spells out `41k ctx / 41k max output · $0.104 in / $0.416 out per 1M` |
| Popularity, rendered in `--v-verified` green | STAYS, **recoloured** | `--ink-muted` in the metric column. Verification colour on unverified provider telemetry is a P1/P2 violation |
| `operationalTitle()` provenance tooltip | STAYS + promoted | Kept as `title`; additionally surfaced as `(lifetime, provider telemetry)` on the focused row |
| Provenance caveat (scrolls away at scrollTop 400) | **PROMOTED to a sticky footer** | `Capabilities are source-declared; catalog metadata is not proof. Popularity and load use fresh provider telemetry when available.` — permanently visible |
| Result count (invisible `aria-label` "12 eligible models") | **PROMOTED to visible** | `12 models` in the 24px status line |
| `Model · privacy-first recommendation` separate 22px label | MOVES into the trigger | `✦ privacy-first recommendation` badge travels with the model it describes |
| `modelControlOptions()` out-of-catalog escape hatch | STAYS verbatim | Pinned first row, `Current pinned model · catalog details unavailable`, `aria-disabled` |
| `safeModelControlErrorMessage()` `role="alert"` | STAYS | Unchanged |

### 3.5 Connect surface (`#access`)

| Information | Fate | Carrier after |
|---|---|---|
| Eyebrow `INFERENCE CONNECTIONS` | **REMOVED** | The hub tab `Models` is active 24px above it and the H1 is 22px below it — three renderings of one word inside 60px |
| H1 `Connect models` (45.9px) | STAYS, **renamed** `Models`, 28px | `<RouteHeader>` title (conflict 13) |
| Page paragraph "Use Chutes for application-encrypted inference…" | MOVES→ ⓘ | `How connections are held` disclosure, verbatim, one word edited: `below` → `here` |
| Jump nav `Providers` / `Cloud keys & local models` (44px, dressed as tabs) | **REMOVED** | Both destinations cease to exist as separate sections; the anchors would point at nothing |
| H2 `Providers` | **REMOVED** | Verbatim duplicate of the H1's job, 90px apart |
| Providers paragraph "Everything else in Airship … connecting one never closes the others." | MOVES→ ⓘ | Verbatim, paragraph 2 of the disclosure |
| Eyebrow `ONE, OR SEVERAL AT ONCE` | MERGES into the count chip's `title` | `Connect one, or several at once. Connecting one never closes the others.` — a fact the chip's number now demonstrates |
| `.provider-fabric__count` "0 connections" | MERGES into the count chip | `No model connected · 4 ready` / `{Title} connected · {n} more ready` |
| `.provider-fabric__empty` "No additional provider is connected. Chutes connection controls remain available above." | **REMOVED** | Clause 1 is the count chip's number; clause 2 refers to an "above" that no longer exists; each lane's own seal states its own state |
| `.oauth-browser-boundary` (168px desktop / 240px phone): heading, handler paragraph, `Registration details` (Homepage/Callback/Scopes, `client_secret_post` explanation, `Deployment detail:` warning), `Start sign-in again` | MOVES→ Chutes lane | Appended verbatim inside the existing `.oauth-mechanism` disclosure, whose summary becomes `How this works · what the handler can see`. Every word about Chutes OAuth now lives inside Chutes OAuth |
| `oauthNotice` (error tone) + `oauthDiagnosticError` | **STAY AT LANE LEVEL** | Never behind a disclosure. `role="alert"` unchanged |
| `.provider-fabric` cloud cards (OpenAI/Anthropic/xAI) — key label, input, risk-acceptance checkbox + full sentence, `Why API key instead of OAuth?` disclosure, Connect button | MOVES→ each lane's `API key` tab | Rendered in place. `onOpenDirectProviders` becomes `onSelectMethod("api-key")`; the button that scrolled 1300px now switches the tab beside it |
| `.provider-fabric` local cards (Ollama, LM Studio) with addresses and `Local connection requirements` | MOVES→ Local lane body | Verbatim, beneath "Check this machine" |
| Local lane sentence naming both addresses | EDITED | "Airship contacts only the addresses below, and only when you press Check. Your browser and the local service both have to allow this page." — the literal addresses are now rendered 60px below it |
| Card `<h4>` provider names + `API KEY · PAGE MEMORY` eyebrows | **REMOVED** | The lane header says the provider 60px above; the tab is literally labelled `API key / Page memory` |
| Fabric grouping chrome: `PROVIDER FABRIC`, `Cloud and local models`, `Keep multiple providers in page memory`, `REMOTE`, `Cloud providers`, `API-key methods · page memory`, `Configure cloud API keys`, `3 provider adapters…`, `ON THIS MACHINE`, `Local model servers`, `No remote account` | **REMOVED** | Every one is replaced by a label already present at the new location: the route-bar disclosure says "Credentials remain in page memory", every key field says "page memory only", and the Local lane's own summary already reads "A model server you host yourself. No account, and nothing leaves this computer." |
| `.companion-overview` (219px / **415px = 66% of a phone**) | MOVES→ 6th lane row | 44px `ConnectLaneCard`, `data-lane="companion"` |
| Companion status "Extension not detected" / "{version} connected" / "Checking this tab" | MERGES into the lane header qualifier | Plus the shared `Seal` state |
| Companion `<dl>` PROVIDER RELAY / ENCRYPTED CACHE / BACKGROUND COMPUTE + values | STAYS, re-laid-out; **promoted when present** | One wrapping `dt`/`dd` line in the lane body; when the extension IS present the fact strip is promoted onto the collapsed row (`Relay {n} routes · Cache {n} pages · Compute on`) |
| Companion paragraph + host sentences + install link | STAYS verbatim | Lane body |
| `.companion-overview__dot` bespoke 8px glyph | **REMOVED** | Replaced by `<Seal>` — same information, one vocabulary |
| Chutes lane `vendor: "Chutes"` rendered under `title: "Chutes"` (`connect-lanes.ts:138`) | **REMOVED** | Exact duplicate of the string 34px above it. Replaced by `Encrypted inference with per-turn evidence` — the lane's own defining sentence, **promoted from open-only to collapsed-visible** |
| OpenAI lane seal `Not available here` (`STATUS_RANK.unavailable = 5`, sorts a working route last) | **RE-HOMED, not softened** | `codexLane()` returns `kind:"ready", label:"API key only"`; the Codex sign-in state moves to `oauthStatus`, where it is true. Its full `detail` gains a rendering location **for the first time** — `CodexPanel` returns `null` today, so the OpenAI OAuth panel renders a bold heading above nothing |
| Tab sub-labels truncating (`Add the Airship e…`) | SHORTENED, long forms retained | `Primary` / `Connected` / `Checking` / `Needs the extension` / `Not in this browser` / `Not available here` / `Offline`. The long forms are `status.label`, which stay in full on the lane seal and in the panel body |
| Every `status.detail`, `status.alternative`, bridge-observation sentence, `What the extension is allowed to do` 6 bullets | STAYS verbatim | Unchanged position |
| `.connection-candidate` credential-kind 2nd line ("Profile, billing, and inference are read directly; Chutes remains authoritative.") | MOVES→ `(?)` | Verbatim |
| `.catalog-provenance` band (58px): freshness sentence, `Load live availability metadata`, `N catalog notices` | CHIP→ `Catalog read 9:50 AM ⌄` | Timestamp visible; everything else inside the disclosure, unchanged |
| `TURN PROOF POLICY` fieldset (179px, incl. a 465×108px tile for a permanently `disabled` option) | **CAPABILITY-KEYED DISCLOSURE** | When `CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available === false`: one selected chip `Verify & record · recommended` + `Strict fail-closed is unavailable in this build. Why? ⌄` containing **both** option descriptions and the strict `reason` verbatim. When it flips to `true` the full two-tile fieldset renders exactly as today — keyed on capability, not taste |
| "This policy is not proof. Completed receipts record only what the browser actually verified." | **STAYS, never disclosed** | Always visible, outside every disclosure. This is the honesty line |
| `.model-candidate-summary` 4 tiles | STAYS | Repositioned; Trust readiness tile gains a third line `catalog metadata is not proof` |
| Capability table: 4 headers, 4 rows, 12 `CapabilityMark` cells, and "These are credential-class eligibility rules, not observed grants…" | STAYS, every word | 40px summary row `Compare what each method can do`; eyebrow `CONNECTION METHODS` merges into it (a category label for a one-item category) |

### 3.6 Shell and sidebar

| Information | Fate | Carrier after |
|---|---|---|
| 11 destination labels at 232px | STAYS in `standard`; in `rail` → tooltip | The existing `title={`${label} · ${scope} scope`}` is **more** information than the visible label, plus `aria-label`, plus the hover-peek/`:focus-within` panel at full 12px |
| Group label `WORK` | **REMOVED** | The first group in a rail has nothing above it to be disambiguated from |
| Group `AGENT` (a group of exactly one, whose children duplicate the pinned card) | **DISSOLVED** | Profiles is reachable from the pinned profile row's popover (`Manage profiles`), the command palette, and `#profiles` |
| Group `TRUST` | **RENAMED** `RECEIPTS & ACCESS` | The word "Trust" survives as the phone tab-bar label and the `TrustSheet` title. Airship's posture is that it shows evidence rather than asking for trust; a filing cabinet named TRUST is the one place the product asks for the word |
| `.profile-switcher` card (211×120px = 14.2% of the sidebar) — eyebrow, MenuSelect, link | → 48px row | `[GE] General ⌄`. Eyebrow `AGENT PROFILE` becomes the popover header and the row's `aria-label`. `Manage profiles` is a popover row. Profile **descriptions**, which the rail rows drop today, are gained |
| `.recent-conversations` (250px cap, 414px scrollHeight, titles clipped to ~13 chars) | MOVES→ 320px popover | Same 10 sessions, same row structure, title column ~232px instead of ~105px (~34 chars). `⌘⇧O` + command palette + the `+` button move into its header |
| Unread-turn badge | **STAYS on the rail row** | Visible without opening anything |
| `Account` nested under `Connection` with `↳` (100% invisible at 1440×900 default) | **UN-NESTED to a peer row** | It is a destination, not a sub-page of the provider connector |
| `Editor` / `Terminal` nesting | STAYS nested, collapsed by default | The one nesting the current model gets right; state remembered |
| `↳` `.nav-nested-marker` glyph (40 brass instances) | **REMOVED** | Nesting is already carried by a 12px indent, a 1px `--line` rail and `aria-level` |
| `data-scope` 2px stripe | STAYS in both rail states | The only always-visible scope cue |
| Topbar seals in `focus` mode | MERGES into the 28px honesty strip | The single weakest-of seal that already governs the 430px layout, one tap to the full `TrustSheet`. **The session model id is added** — it is not in the topbar today |

### 3.7 Cross-surface

| Information | Fate | Carrier after |
|---|---|---|
| Ten route eyebrows + ten route descriptions (194–213px on six routes) | MOVES→ ⓘ, **auto-opening on a route's first visit** | Exact copy verbatim. Terminal's WebContainer caveat and Proof's "different claims" caveat are explicitly named as must-be-verbatim |
| Vault's floating `Disconnected` pill, Workspace's wrapping `Ephemeral · this page only`, Account's `Account telemetry unavailable` card, Terminal's `Reconcile workspace` / `New terminal` | MERGE into the `<RouteHeader>` status/action slot | Four treatments, one slot, no words lost; each status becomes a chip whose tap opens its full detail |
| `#memory` top strip ("3 private scopes", "152 nodes", "3 sources") **contradicting** the bottom strip (Nodes 152, Relationships 647) | **REMOVED as a strip** | Re-presented as the *captions* of the cells they describe, so each number renders exactly once and the 152-vs-647 contradiction cannot recur |
| Provenance captions "real page inputs + derived terms", "typed, bounded edges", "not vector similarity", "current relationship islands", "production remote mode must fail closed" | STAYS verbatim | `<Metric>` caption slot |
| 49 status/notice CSS families | MERGE into `<Seal>` + `.notice` | Every status string is kept verbatim — the container changes, not the content. Strings that are inline prose today become the chip's `detail` and are shown in full in the claim-stack popover |
| 9 tab-strip families | MERGE into `<Tabs>` | Every label, every count, every live state kept. Terminal's `Running` second text line becomes an adjacent dot Seal carrying the same word in `aria-label` (removes a duplicate `● Running` within 90px) |
| `rgb(158,158,255)` "Get the extension ↗" | RECOLOURED | `--accent`, like every other link. The generic AI blue-purple is explicitly forbidden by `docs/DESIGN_LANGUAGE.md` |
| `.eyebrow` brass ×23 | RECOLOURED `--ink-muted` (7.39:1) | Same words |
| 9.74px `<small>` on `#profiles` | ENLARGED to 11px | Same content; clears the P4 floor |

**Nothing in this ledger loses a claim.** Every REMOVED row names the surviving carrier, and eleven items (three approval descriptions' scope, the Enter/Shift+Enter behaviour, `sequence`/`ordinal` parallelism, `argumentsSummary`, the ModelPicker result count, the provenance caveat, OpenAI's OAuth `status.detail`, the Chutes lane's defining sentence, the composer durability line on phone, profile descriptions, and the topbar's `E2EE` word) are **net-new disclosures of facts that ship today but render nowhere or only in a tooltip**.

---

## 4. The system

### 4.1 Type ramp — 8 tokens, 3 weights

```css
:root {
  --fs-micro:   calc(.6875rem  * var(--type-scale)); /* 11px */
  --fs-caption: calc(.75rem    * var(--type-scale)); /* 12px */
  --fs-meta:    calc(.8125rem  * var(--type-scale)); /* 13px */
  --fs-body:    calc(.9375rem  * var(--type-scale)); /* 15px */
  --fs-lead:    calc(1.0625rem * var(--type-scale)); /* 17px */
  --fs-title:   calc(1.25rem   * var(--type-scale)); /* 20px  NEW */
  --fs-display: calc(1.75rem   * var(--type-scale)); /* 28px  NEW */
  --fs-hero:    calc(2.375rem  * var(--type-scale)); /* 38px  NEW */
  --fs-h3: var(--fs-title);            /* deprecated alias; deleted in WP-9 */
  --fw-body: 400; --fw-strong: 600; --fw-title: 700;
}
```

One rule per step. No judgement is left to make:

| Token | px | Exclusive uses |
|---|---|---|
| `--fs-micro` | 11 | Mono uppercase, `.11em` tracking. Column headers, metric labels, eyebrows, seal chip labels in dense rows, tool-row status word and tool name, keyhints. **This is the floor.** |
| `--fs-caption` | 12 | Seal chip labels, table captions, timestamps, digests, metric captions, disclosure sub-copy |
| `--fs-meta` | 13 | Supporting sentence under a title; card subtitles; tool sheet body; interstitial narration; the composer's approval descriptions |
| `--fs-body` | 15 | All default UI text, all transcript prose, **the composer textarea**, lane summaries |
| `--fs-lead` | 17 | List-row primaries, tab labels (all variants), card titles, button labels, lane titles |
| `--fs-title` | 20 | Section and card headings; metric values. Replaces the 17.85/18/19/19.89/20/21.25/23.38/25.5 cluster |
| `--fs-display` | 28 | **The route title, once per route.** `.route-title` only. Replaces 47/45.9/34/28.8/21.25 |
| `--fs-hero` | 38 | Exactly two sites: the boot-screen wordmark, and one hero verdict number per route (Account balance). **Never a route title.** |

Weights collapse 400/500/600/620/650/700/750/900 → 400/600/700. Delete every 500, 620, 650, 750, 900 declaration.

**One heading rule replaces eight.** Delete `.page-heading h1` (`styles.css:2705`), `.stage-header h1` (`styles.css:1031`), `access-view.css:50`, `attestations-view.css:27-31`, `context-view.css:23-26`, `terminal-view.css:2`, `sessions-view.css:28`, `.boot-screen h1` (`styles.css:3263`, which re-types the serif stack inline). Replace with:

```css
.route-title { margin: 0; font: var(--fw-title) var(--fs-display)/1.15 var(--font-display); letter-spacing: -.01em; }
```

No px-literal `clamp()` anywhere: `--type-scale` must move the largest text in the product (WCAG 1.4.4).

**The serif has exactly one job: `.route-title`.** Delete `font-family: var(--font-display)` from `capabilities-view.css` (3 sites), `attestations-view.css`, `access-view.css`, `context-view.css`, `provider-fabric-panel.css`, `sources-view.css`, `terminal-view.css`, `workspace-view.css`, `platform-shell.css` (2 sites) and `chat/message-parts-view.css`. Add it to Vault's H1, which renders in Inter today. **One documented exception:** `.markdown h1–h6` in the transcript keeps the serif, because it usefully distinguishes the model's structure from Airship's chrome — record this in `docs/DESIGN_LANGUAGE.md` so a later cleanup does not delete it.

### 4.2 Spacing and radius

```css
:root {
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;
  --radius-chip: 999px;   /* NOT remapped by data-corners */
  --radius-control: 6px;  /* remapped: square 3 / subtle 5 / rounded 9 */
  --radius-panel: 10px;   /* remapped: square 5 / subtle 8 / rounded 14 */
}
```

| Step | Exclusive use |
|---|---|
| `--sp-1` 4px | Gap between a glyph/Seal and its label; block padding inside a chip |
| `--sp-2` 8px | Inline padding inside a chip; block padding inside a control; gap in a dense list row. *Absorbs today's 6, 7, 9, 10px* |
| `--sp-3` 12px | Inline padding inside a control; gap between sibling controls; compact card padding. *Absorbs 11, 13, 14px* |
| `--sp-4` 16px | Card padding; gap between cards in a group. *Absorbs 15, 17, 18px* |
| `--sp-5` 24px | Gap between sections in a route body; the `.route-body` grid gap. *Absorbs 22, 25, 26px* |
| `--sp-6` 32px | Route body inline padding. *Absorbs 34, 39px* |
| `--sp-7` 48px | Space above a route footer or between major regions |

Radius: `--radius-chip` for seal chips and dots (the only round things); `--radius-control` for buttons, inputs, tabs, menu items; `--radius-panel` for cards, popovers, dialogs. **Delete literal `3px`, `4px`, `8px`, `50%` radii.** Do *not* delete resolved 5px/8px — those are the tokens under the default `corners: "subtle"` (conflict 8).

### 4.3 Colour and contrast

```css
:root {
  --line:            rgba(225,217,200,.105); /* 1.26:1 — DECORATIVE DIVIDERS ONLY */
  --line-strong:     rgba(225,217,200,.18);  /* 1.55:1 — emphasis dividers only */
  --line-control:    rgba(225,217,200,.40);  /* 3.07:1 — NEW: every control boundary */
  --ink-faint:       #949c99;                /* 6.59:1 ground / 5.72:1 raised (was 5.44/4.73) */
  --ink-disabled:    #6b726f;                /* 3.48:1 on --surface — NEW */
  --surface-disabled:#1a1f23;                /* NEW */
}
```

- Every `border` on a `button`, `input`, `select`, `textarea`, `[role="tab"]`, `[role="button"]` or clickable card switches to `--line-control`. WCAG 1.4.11 requires 3:1 for control boundaries; `--line` is 1.26:1. **This single change is what makes the interface read as built rather than sketched.**
- Delete every `opacity: .45` / `.48` on a disabled control. Replace with one rule: `:disabled, [aria-disabled="true"] { color: var(--ink-disabled); background: var(--surface-disabled); border-color: var(--line-control); cursor: not-allowed; }`. Disabled is carried by explicit colour, never transparency, so it composites predictably. Disabled Send glyph: 1.71:1 → 3.48:1.
- "Remove profile from new work" stops using `--v-failed` while disabled. Danger colour is reserved for *enabled* destructive actions; 1.91:1 red conflates disabled with danger.
- `--v-failed`, `--truth-remote` and `--copper` are **forbidden as text on `--surface-raised`** (4.24:1). They remain legal as Seal stroke colours, where P2 guarantees shape + adjacent word and 1.4.11's 3:1 applies.
- Body text is healthy and is not touched: `--ink` 15.13:1, `--ink-muted` 7.39:1, `--accent` 7.08:1, `--v-verified` 6.42:1, `--v-caution` 8.23:1.

**The accent contract** (into `docs/DESIGN_LANGUAGE.md`). Brass `--accent` may mean exactly one of four things:

1. **You are here** — active rail item (3px left bar), active tab underline (2px), active menu item.
2. **Act here** — primary button fill (`--accent-bright`, 10.05:1, `--ground` ink on top), and the `attention`/action Seal state.
3. **Focus** — `--focus`, unchanged.
4. **The mark** — the Airship seal (`--copper`), unchanged.

Forbidden: brass on any label, eyebrow, kicker, list marker, tree glyph, divider or decorative rule. `.nav-nested-marker` and `.eyebrow` alone account for 63 of ~90 brass text sites (70%, encoding nothing). Five duplicate eyebrow implementations (`styles.css:867`, `sessions-view.css:42` which uses `--accent-bright` and `.12em`, `vault-view.css:31`, `local-lab-setup.css:25`, `local-device-vault-setup.css:53`) collapse to one `.eyebrow`. Result: 347 brass instances → ~90, and `#chat`'s `Connect a model` becomes the only brass object above the fold — which is exactly the one thing a disconnected user must do.

### 4.4 The one status family

`seal.tsx` is the north-star artifact and it is **frozen as-is**: seven states, six SVG shapes, word-first labels, `role="img"`, `sealRenderedSize()` flooring at 16px. Add one prop: `density`.

| State | Shape | Label | Meaning |
|---|---|---|---|
| `none` | outlined circle | "Not checked" | No evidence requested |
| `checking` | interrupted arc (animated via `data-acting`) | "Checking" | In flight |
| `stale` | interrupted arc, dashed static | "Stale" | Evidence exists but is past freshness |
| `verified` | solid check seal | "Verified" | Cryptographically verified |
| `asserted` | half seal (`--copper`) | "Asserted" | Transport/service evidence only |
| `attention` | warning diamond | "Attention" | Policy mismatch, expiry, incomplete |
| `failed` | crossed seal | "Failed" | Verification failed |

Three densities. **Every density renders a ≥16px well** (conflict 7):

```css
/* dot — 16px SVG, no visible label; aria-label carries the word.
   For nav badges and row markers where a label is already adjacent. */
.seal[data-density="dot"] .seal__label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }

/* chip — the default */
.seal[data-density="chip"] {
  display:inline-flex; gap:var(--sp-1); align-items:center;
  min-height:24px; padding:0 var(--sp-2);
  border:1px solid color-mix(in srgb, currentColor 34%, transparent);
  border-radius:var(--radius-chip);
  background:color-mix(in srgb, currentColor 10%, transparent);
  font:var(--fw-strong) var(--fs-caption)/1 var(--font-body);
}

/* hero — 28px SVG + --fs-title label + one --fs-meta detail line. MAX ONE PER ROUTE. */
```

**Retires (all keep their strings, verbatim):** `.status-seal`, `.posture-chip`, `.durability-indicator`, `.runtime-posture`, `.audit-state`, `.receipt-chip`, `.attestation-chip`, `.connection-badge`, `.mobile-trust-chip`, `.state-label`, `.skill-state`, `.operation-state`, `.account-state`, `.editor-status`, `.proof-level`, `.access-live-status`, `.context-*-status`, `.embedding-engine-state`, `.evidence-join__state`, `.claim-seal`, `.proof-hero-seal`, `.nav-proof-dot`, `.pulse-dot`, `.composer-policy__dot`, `.companion-overview__dot`, `.terminal-status`, `.attestation-status-mark`. Five `__notice`/`callout` families collapse to one `.notice` = a chip plus a sentence on one row, same seven states.

**The disclosure contract.** Every `chip` and `hero` is a `<button>` that opens the claim-stack popover modelled in `claim-stack-model.ts`: issuer, subject, scope, age, expiry, evidence digest, verifier policy, export. Prose that states a claim inline today becomes the chip's `detail` and is shown in full in the popover.

Copy manifest, preserving today's strings so no claim weakens:

```
none      "Not checked"                  · Secure hardware not checked · this session
none      "Ephemeral"                    · This page only. Nothing is written to disk.
verified  "Encrypted · this device"      · (durabilityLabel("local"))
checking  "Syncing"                      · Syncing encrypted state
verified  "Synced"                       · Encrypted state synced
none      "Local"                        · No remote inference required.
asserted  "Encrypted · no proof gate"    · Encryption is required, but fresh endpoint proof is not enforced.
asserted  "Encrypted · proof required"   · Policy requires fresh endpoint proof before invocation; only turn evidence can verify the claim.
attention "Plaintext remote"             · Remote plaintext permitted.
failed    "Not established"              · production remote mode must fail closed
none      "No vault adopted"             · No cloud vault is configured.      [renamed, conflict 3]
```

This also fixes the doubled `○ ○` on `#chat` mobile: a single `<Seal>` renders one glyph, and durability is carried by the word.

### 4.5 Layout primitives

Seven components. Nothing else may define these shapes.

1. **`<RouteHeader>`** — `src/ui/route-header.tsx`. A 44px flex row, `padding: 0 var(--sp-6)`, `border-bottom: 1px solid var(--line)`:
   `[ h1.route-title 28px ] [ ⓘ 24px ] ——— spacer ——— [ Seal chips ] [ actions ]`
   The ⓘ is `aria-label="About this view"`, opens a 320px popover containing the route's eyebrow (as the popover's first line) and description verbatim. **Auto-opens on a route's first visit** and is remembered-dismissed per route in page memory, so first-run users still read the caveat without a permanent 200px tax.
2. **`<Seal>`** — three densities, above.
3. **`<Tabs>`** — `src/ui/tabs.tsx`, two variants, **one "you are here" encoding**: 2px `--accent` bottom border plus `--ink-muted` → `--ink`. `min-height: 40px`, `--fs-lead` 17px, intrinsic width, never full-bleed. `variant="section"` for region switching; `variant="document"` for closable tabs (name + live state + close), which get `--radius-control` top corners, a `--line-control` border and `--surface-raised` when active. Counts are `<span class="tabs__count">` at `--fs-caption` `--ink-faint`, not filled badges. Retires all nine families plus `.connect-method__switch` and `.workbench-mobile-switch` (the section variant already scrolls horizontally with 44px targets, so mobile is not a special case).
4. **`<MetricStrip>` / `<Metric>`** — `grid-auto-flow: column; grid-auto-columns: 1fr`, cells separated by `border-left: 1px solid var(--line)`, `padding: var(--sp-3) var(--sp-4)`:
   `LABEL` (`--fs-micro`, mono, uppercase, `.11em`, `--ink-muted`) / **Value** (`--fs-title`, `--font-body`, `font-variant-numeric: tabular-nums`, `--ink`; or a `chip` Seal if the value is a state, never a serif word) / `caption` (`--fs-caption`, `--ink-faint`, one line — where provenance lives).
5. **`<Popover>`** — `src/ui/popover.tsx`. **The single anchored-disclosure primitive.** Opens on 150ms hover-intent at `(pointer: fine)`, on tap at `(pointer: coarse)`; `:focus-within` pins it open. `Esc` closes, outside-click closes, focus is trapped via the existing `src/ui/focus-trap.ts`. Anchors below with a right-edge flip when `rect.right > innerWidth - 12`. At `≤640px` it becomes a bottom sheet with a 44px sticky header and a `Done` button. `prefers-reduced-motion` → instant. Every chip in the product opens one of these.
6. **`.route-body`** — `display: grid; gap: var(--sp-5); grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); align-content: start;`. One primitive fixes both failure modes: it reflows under-filled routes into their dead space (`#account` 329px, `#workspace` 200px) and packs over-long routes 2–3 cards per row (`#connection` 2,743px → ~1,300px).
7. **`<Rail>`** — `src/ui/rail.tsx`, three states on one width token.

### 4.6 The collapse and disclosure model

**The scope rule.** A fact renders as visible text in exactly one band:

| Band | Owns |
|---|---|
| **Topbar** (58px) | Facts true of *this browser tab*: runtime location, vault adoption, connectivity |
| **Session bar** (40px) | Facts true of *this conversation*: title, model, connection posture, endpoint attestation, journal durability, turn lifecycle, journal size, lineage |
| **Composer footer** (36/44px) | Facts true of *the keystroke you are about to make*: credential posture, approval policy, attachment, send/queue |
| **Route header** (44px) | Facts true of *this route*: title, description, route-level status, route actions |

**The disclosure ladder.** Four rungs; a fact may never skip a rung downward.

- **L0 — always visible.** A ranked plain-language verdict word and its seal shape. Never hidden, never truncated, never collapsed. The *fact that something happened* lives here (P6).
- **L1 — chip → popover.** One gesture. Full label, full `detail`, the count of siblings, and any navigation the chip's source had. Keyboard-reachable, focus-trapped, `Esc`-dismissible.
- **L2 — popover → route.** `→ Proof`, `→ Vault`, `→ Models`. Deep-linkable via the existing hashes (P6).
- **L3 — payload.** Bounded JSON, digests, ISO timestamps, registration details. Inside an L1/L2 surface, internally scrolled, never pushing the document.

**Two hard rules that follow:**

- **No fact may live only in a `title` attribute.** Every `title`-only string in this program gains a popover row. Touch users have no hover.
- **Counts are honest.** A chip that hides *n* facts renders `· n`. The affordance states its own cost.

**Collapse triggers** (the only four in the product):
1. `.session-bar` 40px → 32px on `.transcript` scroll past 48px, at `(pointer: fine)` only. Chips shed labels, keep glyph + count + every `title`/`aria-label`. Restores at scrollTop 0.
2. Tool strip → one summary header when `settled && all completed && count >= 4`.
3. Rail `standard` → `rail` → `focus`, manual (`⌘\`, `⌘.`) with a viewport-derived default.
4. `<RouteHeader>` ⓘ popover, auto-open on first visit only.

Nothing else collapses on scroll. Nothing collapses automatically that hides a claim the user did not choose to hide.

---

## 5. Per-surface specifications

### 5.1 Chat chrome

**Resting (1440×900, empty).**

```
 0   ┌ .topbar ─────────────────────────────────────────────────── 58px ┐
     │ [◈ Airship / EDGE RUNTIME]   [◔ Browser / Edge runtime · 3]      │
     │                     [• Local kernel ready]   [⌘K] [?] [⚙]        │
58   ├ .session-bar ────────────────────────────────────────────── 40px ┤
     │ [GE] General conversation   [⬡ Demo · local ⌄][○ Not checked · 4]│
     │                                       [⌗ 20 · #3af63bf0][ + ]    │
98   ├ .transcript ──────────────────────────────────── 702px ──────────┤
     │                                                                  │
     │        (align-content: end; padding-bottom: 24px)                │
     │  ── .transcript-intro ──────────────────────── ~56px ──          │
     │  Airship is running in this tab. Workspace, editor, terminal     │
     │  and browser-owned Git work right now, with no account.          │
     │  Chat replies come from a deterministic local demo until you     │
     │  connect a model provider.          [ Browser baseline ]         │
     │  ── 3 starter chips ───────────────────────── 58px ────          │
800  ├ .composer-wrap ─────────────────────────────────── 100px ────────┤
900  └──────────────────────────────────────────────────────────────────┘
```

- `.session-bar { display:grid; grid-template-columns: minmax(0,1fr) auto; align-items:center; gap:var(--sp-2) var(--sp-4); min-height:40px; padding:var(--sp-1) var(--sp-5); border-bottom:1px solid var(--line); }`
- Left: `<button class="session-bar__identity">` = 18px `.profile-monogram` + `<h1>` at `--fs-body` serif, one line, ellipsis, full text in `title`. Opens `#sessions`.
- Right cluster, in this order, each 28px: **ModelControl chip** (`max-width: 32ch; min-width: 12ch`) → **SessionStatusChip** → **JournalChip** → **`+` new conversation** (promoted from `.mobile-new-conversation` to all widths, which is what permanently removes the iPad collision with the model card).
- **Shed order** when the cluster exceeds its track (container query on `.session-bar`, `@container (max-width: N)`): journal chip label → status chip label → model chip label. The `+` and every glyph always survive. Nothing wraps, nothing horizontally scrolls.
- Chrome total **98px = 10.9%** (was 219px empty / 266px with turns). At 1280×800: 98px = 12.3% (was 27.4%). iPad Pro 11: 98px = 8.2% (was 253px / 21.2%).

**SessionStatusChip** (`src/ui/chat/session-status-chip.tsx`):

```tsx
<button class="session-status-chip" data-state={worst.state}
        aria-label={`Session. ${durabilityLabel}. ${worst.label}. ${worst.detail} ${count} facts.`}>
  <Seal state={worst.state} density="dot" size={16} />
  <span>{worst.short}</span><small>{count}</small>
</button>
```

`aria-label` **must** begin `Session. ` immediately followed by the durability clause, so the shipped selector `getByRole("button", { name: /Session\. Ephemeral · this page only\./u })` (`e2e/responsive-breakpoints.spec.ts:104`) keeps passing unmodified.

Precedence for `worst`: any `failed`/`attention` axis → a running turn → the weaker of connection-posture vs attestation by `TRUST_STATE_SEVERITY` → ties to attestation. Reuse `worstTrustAxis` (`platform-shell.tsx:366`).

Short forms (≤14 chars, from the real vocabularies at `sessions/domain.ts:99`, `durability-indicator.tsx`, `describeAttestationSeal`):
`○ Not checked` · `◔ Working` · `◐ Asserted` · `● Verified` · `● On this device` · `◔ Syncing` · `✕ Check failed` · `✕ Turn failed` · `△ Cancelled` · `△ Offline`.

Popover body (320px), one renderer shared with `TrustPostureSheet` — extract the body from `platform-shell.tsx:376`:

```
SESSION STATE
[seal] Encrypted · evidence recorded          → Models
[seal] Secure hardware not checked · this session
       No endpoint proof has been requested in this session.   → Proof
[dot]  Ephemeral · this page only
       This session journal exists only in page memory. Nothing is synced. → Vault
[dot]  Ready
       No turn has started in this session.
```

**Topbar posture chip.** Exactly one chip in `.topbar-center` at every width and in every connection state: `[seal] {worstTrustAxis(tabAxes).label ≤14ch} · {n} axes`. Remove the `inferenceConnected` gate on `.mobile-trust-chip` (`app.tsx:4607`) so the pattern is universal. Centre band 398px → ~150px; the truncated 4th pill is gone. `TrustPostureSheet`'s own sentence — "The weakest claim is shown in the topbar" — becomes true on desktop for the first time.

**Active states.**
- *Scrolled past 48px, fine pointer only:* `.chat-stage[data-scrolled]` → bar 40 → 32px, chips glyph+count only, H1 `--fs-body` → `--fs-caption`. **No scroll collapse at `(pointer: coarse)`** — 44px targets are non-negotiable.
- *Scrim:* `.transcript::before`, 24px `linear-gradient(to bottom, var(--ground), transparent)` pinned under the bar. Removes the hard 1px guillotine at the transcript's top edge, which currently reads as a rendering fault. Pairs with the existing `.transcript-jump` pill so the two scroll affordances read as one system.
- *With turns:* the bar does **not** grow. `.transcript-intro` unmounts once `messages.length > 1`.
- *Demo variant:* model chip `data-state="demo"` renders `⬡ Demo · local` in brass outline; popover lead is the verbatim demo sentence plus `[ Connect a model → ]`.

**Mobile (≤640px).** Topbar 52px + session bar 48px (chips 44px, no scroll collapse) = 100px. Composer-wrap 106px. Tab bar 56px. Non-transcript chrome **262px = 28.1%** (was 321px / 34.4%); transcript **670px** (was 611px). The `.mobile-session-details` DOM instance is deleted — it was a third rendering of the same pair, and its doubled `○ ○` glyph disappears because the chip renders exactly one `<Seal>`.

### 5.2 Composer

**The diagnosis is a width-theft bug, not a height bug.** `grid-template-columns: minmax(0,1fr) auto` (`styles.css:2013`) gives `.composer-footer` a fixed intrinsic 449.6px on every desktop-class viewport, leaving a 33px content box against a 23.2px line box. The correct layout already exists at `styles.css:2019-2023`, gated behind having already typed a newline. **Ungate it. Two rows is the only layout** — which is what `AIRSHIP_DESIGN_BLUEPRINT.md` §11.1 already draws.

**Resting geometry.**

| | Desktop ≥641px | Mobile ≤640px |
|---|---|---|
| `.composer-input-row` | `display:grid; grid-template-columns: minmax(0,1fr)` | same |
| textarea | `min-height:44px; padding:10px var(--sp-4) var(--sp-2); font:var(--fs-body)/24px var(--font-body)` | `min-height:44px; padding:10px 14px var(--sp-2); font-size:16px; line-height:24px` (iOS zoom guard) |
| `.composer-footer` | `min-height:36px; padding:0 var(--sp-2) 0 var(--sp-3); justify-content:space-between` | `min-height:44px` |
| Card | 44 + 36 + 2 = **82px** | 44 + 44 + 2 = **90px** |
| `.composer-wrap` | `padding: 9px max(var(--sp-5), calc((100% - 790px)/2))` → **100px** | padding 7/9 → **106px** |
| Textarea content box | 304px → **758px (+149%)** | 174px → **382px (+120%)** |
| iPad content box | 200px → **652px (+226%)** | — |

Delete the density override at `styles.css:183` (`min-height: calc(var(--density-control) + 12px)`, `padding: 17px 17px 8px`) — it is the fixed-height half of the bug.

**Delete the `fit()` oscillation guard** (`app.tsx:917-947`). The `data-multiline` toggle/re-measure branch exists only to guard an oscillation that cannot happen once the width is constant, and it is what forces a 23-character phone prompt onto two lines. `fit()` reduces to: set height to `min`, read `scrollHeight`, clamp, set `overflowY`.

**Growth cap, viewport-aware:**
```ts
const available = window.visualViewport?.height ?? window.innerHeight;
const maximum = Math.min(parseFloat(style.maxHeight) || 180, Math.round(available * 0.34));
```
At 900px → 180px (unchanged). At a 404px visual viewport → 137px, so the composer region is 46% of visible height instead of 64.1%, and the transcript keeps ~110px instead of **24px**.

**Footer strip** — left cluster keeps the class `.composer-tools` (it is asserted by `e2e/airship-shell.spec.ts:244`):

```
[ + ] [ ⚿ Local demo ] [ ● Ask First ⌄ ]  ……  [ ↵ send  ⇧↵ newline ] [ Send ]
```

1. **Attach** — icon only at every breakpoint. 32px desktop / 44px mobile square, `Icon name="plus" size={16}`, `aria-label="Attach image"` (already present, `app.tsx:5089`), `title="Attach image"`. Delete the visible `<span>`. Saves 78px.
2. **Posture chip** — a `<button class="composer-posture">`, rendered at **every** breakpoint. Delete `styles.css:5551` (`.composer-tools span:nth-child(2) { display:none }`), which renders the credential fact at 0×0px on phone. States: `⚿ Local demo` / `⚿ Local endpoint` / `⚿ Key in memory` / `⚿ Offline` (`--v-caution`, carrying `OFFLINE_INLINE_REASON` verbatim). Each opens its full sentence.
3. **Approval** — `width: auto` (was `120px` fixed), 28px desktop / 44px mobile, escalation dot + **Title Case label verbatim**, `font-weight: 500` (was 700), `--fs-micro`, `--ink-muted`. Popover fix: `.composer-approval-select .menu-select-option { grid-template-columns: minmax(max-content,auto) minmax(0,1fr) auto; }` and remove `white-space:nowrap; text-overflow:ellipsis` from `.menu-select-option strong`. Add header `Approval policy` and footer `Applies to this conversation only.`
4. **Keyhint** — `<span class="composer-keyhint" aria-hidden="true"><kbd>↵</kbd> send <kbd>⇧↵</kbd> newline</span>`, `--fs-micro`, `--ink-faint`, `kbd` 16px tall on `--surface-soft`. Rendered only when `input.length > 0 || composerFocused`; `display:none` below 640px. Swaps to `↵ queue ⇧↵ newline` while busy — the only place the shipped queue-on-Enter behaviour (`app.tsx:5065-5079`) is stated *before* the user trips over it.
5. **Send** — 32px desktop / 44px mobile, brass fill, `--radius-control`. Every existing `title` kept, and the disabled reason mirrored into the posture popover.
6. Strip is `justify-content: space-between`; `container-type: inline-size` on `.composer` with `@container (max-width: 380px)` collapsing left-cluster labels to glyphs. Never a horizontal scroll, never a `display:none`.

**Placeholder:** `Message Airship — / for commands` (32 chars ≈ 211px at 13.81px, 239px at 16px). Below 480px: `Message Airship` (≈112px). `aria-label` stays exactly `Message Airship`. The slash menu gains a sticky header `Commands and session tools · Enter or Tab to accept`.

**Keyboard-open mobile.** Implement `AIRSHIP_DESIGN_BLUEPRINT.md` §11.6, which is specified but not shipped: on `visualViewport` resize, `transform: translateY(100%)` the `.mobile-tabbar` and pin `.composer-wrap` to the visual-viewport bottom. Extend the existing subscription at `platform-shell.tsx:424`. Returns 56px + `env(safe-area-inset-bottom)` (~90px on iPhone 14 Pro Max) to the transcript — more than repaying the +21px resting cost.

**Scroll fade at the cap.** `scrollTop > 0` → `data-scrolled` on `.composer-input-row`; `mask-image: linear-gradient(to bottom, transparent 0, #000 14px)`. Matching bottom fade when `scrollHeight - scrollTop - clientHeight > 1`. The half-sliced top line becomes legible as scrolled content.

### 5.3 Tool-call rendering

**Resting row** — one row per *invocation*, not per message-part. `pairOperations(parts)` in `message-parts-view.tsx` folds each `ToolResultPart` into the `ToolCallPart` with the same `callId` and renders at the **call's** chronological index. Orphans render the same shape with the missing half marked.

```
grid-template-columns: auto auto minmax(0,1fr) auto auto;  min-height: 32px  (44px ≤640px)

[◉ Ran]  read_file   /workspace/README.md              845 B   ›
```

| Col | Content | Type |
|---|---|---|
| 1 | `<Seal density="dot" size={16}>` + outcome word | `--fs-micro` mono, state colour |
| 2 | Tool name | `--fw-strong` `--fs-micro` mono, `--ink`, `min-content`, **never truncated** |
| 3 | Argument digest — first scalar of `argumentsSummary` | `--fs-micro` mono `--ink-muted`, flexible, ellipsis |
| 4 | Result digest from `metadataSummary`/`summary` — `845 B` / `23 items` / `1.2 KB` / first error clause | `--fs-micro` `--ink-faint`, no shrink |
| 5 | Disclosure chevron | at an actual edge |

Outcome words: `Ran` / `Running…` / `Failed` / `Denied` / `Queued` / `Stopped`. (`Approved` was specified here originally and was never shipped: approval is an authority, not an outcome — a step the turn ended underneath is `Stopped`, which is the case that actually needed a word.) The 175px 17px string "Tool step completed" becomes a 26px 11px word; the full sentence stays in `title` and `aria-label` (`Seal` already concatenates `detail`). **This 149px of reclaimed width is what stops the phone truncating the tool name to `rea…`.**

Fix the grid collision while here: `::after` moves to column 5 and `.operation-state { margin-right: 17px }` is deleted — it existed only to dodge the stranded glyph, and produced a 17px dead right gutter.

**One strip, not six cards.** Each maximal run of consecutive operation parts becomes one `<section class="op-strip">` with **one** border and **one** background; rows are dividers.

```css
.op-strip { overflow:clip; border:1px solid var(--line-control); border-radius:var(--radius-control);
            background:color-mix(in srgb, var(--surface-soft) 91%, transparent); }
.op-strip > .op + .op { border-top:1px solid var(--line); }
.op { border:0; border-radius:0; background:none; }
.op-group[data-parallel="true"] { box-shadow: inset 2px 0 0 var(--line-control); }
```

Hierarchy restored: answer `--fs-body` 15px `--ink`; narration `--fs-meta` 13px `--ink-muted`; machinery `--fs-micro` 11px inside one strip. The ratio goes from *13px prose under 17px machinery* to *15px prose over 11px machinery*.

**Bounded expansion.** Keep native `<details>` (keyboard, find-in-page, no-JS), bound the body:

```css
.op__body { display:grid; gap:var(--sp-2); max-height:min(320px, 38vh); padding:var(--sp-2);
            overflow:auto; border-top:1px solid var(--line);
            background:color-mix(in srgb, var(--ground) 65%, transparent); }
.op__body pre { max-height:none; }   /* the sheet owns the scroll, not each pre */
```

Sheet header: `ARGUMENTS · BOUNDED DISPLAY` … `RESULT · <capabilityTier>` … `call_8f2a…`. **Accordion within a strip:** `onToggle` closes siblings. **Answer anchoring**, six lines: read `answerEl.getBoundingClientRect().top` before the toggle, then `container.scrollTop += (newTop - oldTop)` after commit. Worst-case turn growth: +929px → +320px. Answer displacement: **687px → 0px.** "Jump to latest" never fires from an expand again.

**Collapsed summary** — only when `settled && every step completed && count >= 4` (conflict 6):

```
⟡ 4 steps · read_file ×2, list_files · all completed          Show steps
⟡ 5 steps · 1 failed, then recovered · list_files             Show steps
⟡ 3 steps · 1 denied by Ask First · write_file                Show steps
⟡ 7 steps · 6 completed, 1 failed · 3 in parallel             Show steps
⟡ 18 steps · 12 shown in order · all completed                Show steps
```

Any `failed` or `denied` step forces the strip open. Expert override: `preferences.transcriptOperations: "summary" | "rows"`. `boundedMessageParts` is kept — the chronological guarantee is real — but overflow renders as further rows in the same strip, not a `<details>` inside a `<details>`.

**Streaming (active state).**
- Strip is always expanded; header reads `⟡ Working · 3 steps` with the `checking` seal's existing `data-acting` rotation. Suppress the bottom three-dot pulse for messages that have an active strip; keep it where it is the only indicator.
- Remove `open={status === "running"}` entirely. Rows are a fixed 32px running or done; the seal, word and digest change **in place**. Eliminates a 98px layout jump per completed step and 114px per in-flight call.
- **Reserve the claim-stack column at all times** in the `#chat` grid (render an empty placeholder while streaming), or pin `.message` to `width: min(100%, 780px)` independent of rail presence. The measure is constant across streaming→settled, so nothing re-wraps at the moment the turn finishes.

**Mobile.** Rows 44px, same five columns, argument digest ellipsised first, tool name never truncated. Six op rows at 377px (62% of the phone conversation area) become three rows at 132px, or a single 44px header on a settled clean turn.

### 5.4 Model selection

**Chat, resting.** `.session-model-chip` — 28px, `max-width: 32ch`, `min-width: 12ch`, `[logo 16px] Qwen3-32B-TEE ⌄`. No posture dot (conflict 2). `aria-label`: `Session model Qwen/Qwen3-32B-TEE on Chutes. Change model.` Disconnected: `Connect a model` with the same tap target, navigating to `#connection`. `.session-runtime-error` (`role="alert"`) keeps its absolute anchoring, re-parented to the chip.

**Chat, active.** The chip opens the **real `<ModelPicker>`** — delete the 260px `MenuSelect` from `model-control.tsx`. `width: min(680px, calc(100vw - 32px))`, `top: calc(100% + 8px)`, right-edge flip. `ModelControl` takes `readonly AirshipModel[]` instead of the flattened `ModelControlOption[]`; `app.tsx:4813` already has `availableModels` in hand and throws the metadata away in a `.map()`.

**ModelPicker structure** — `display:flex; flex-direction:column`; `overflow:auto` moves to the **list alone**.

```
┌ sticky header, 96px, never scrolls ─────────────────────────────┐
│ [ search                                              ] 40px    │
│ [ All 12 · Vision 5 · Tools 12 · Confidential 12 · Hot 9 ] 32px │  scroll-snap-x
│ 12 models                                    Popular ⌄    24px │
├ list, overflow:auto ────────────────────────────────────────────┤
│ [logo 20] Qwen3-32B-TEE      ◧ ⌘ ⬡        41k · $0.10/$0.42  44px
│ …                                                               │
├ sticky footer, 32px, never scrolls ─────────────────────────────┤
│ Capabilities are source-declared; catalog metadata is not proof.│
│ Popularity and load use fresh provider telemetry when available.│
└─────────────────────────────────────────────────────────────────┘
```

- A facet whose count equals `All` renders `disabled` with `title="All 12 models in this catalog are confidential candidates"` — the fact stays, the false affordance goes.
- Focused/hovered row expands to 76px revealing the verbatim second line: `Text · Vision · Tools · Confidential candidate · 4.5M invocations (lifetime, provider telemetry) · 41k ctx / 41k max output · $0.104 in / $0.416 out per 1M`. Gate expansion on `:hover` **plus keyboard-active**, not the current `onPointerMove`-driven `data-active`, with `transition: height 90ms` and a `prefers-reduced-motion` opt-out — a mouse crossing the list must not thrash layout.
- Popularity moves from `--v-verified` to `--ink-muted`.
- `modelControlOptions()`'s `STARTS A NEW PINNED CONVERSATION` boilerplate is deleted from the rows and becomes one sticky footer line.
- Visible rows at a 630px popover: 9 → 12.

**`#access` trigger and popover.**
- `.model-picker-trigger { text-align:left; justify-content:flex-start; }`, caret `margin-left:auto`, `:hover`/`[aria-expanded=true]` brass border matching `.menu-select-trigger`. Content: `[logo] Qwen/Qwen3-32B-TEE · ✦ privacy-first recommendation ⌄`.
- `width: max(100%, min(680px, calc(100vw - 28px)))` — **never narrower than its own trigger** (620px under a 914px trigger today).
- At `min-width: 900px` the open popover renders **in flow** (`position:static; box-shadow:none; margin-top:var(--sp-2)`) inside the candidate card, pushing the summary down instead of covering 324px of the metadata about the model you are choosing.

**`#access` candidate panel** — 914×637px (146 words) → ~360px, four rows:

```
44px  [lock] Chutes API key · direct session  (?)        [ Catalog read 9:50 AM ⌄ ]
56px  MODEL      [ full-width left-aligned picker trigger · ✦ recommendation ⌄ ]
150px [ 4 summary tiles ]                    │ [ ● Verify & record · recommended ]
                                             │ Strict fail-closed is unavailable
                                             │ in this build. Why? ⌄
44px  [ Use a different credential ]                    [ Finish: verify & connect ]
─────
      This policy is not proof. Completed receipts record only what the browser
      actually verified.                        ← always visible, never disclosed
```

Discovery's 589px `scrollIntoView` is replaced by a scroll to the top of `#connect-surface-card` plus a one-frame brass focus ring on the panel.

**Mobile.** Bottom sheet with a 44px sticky header (`Session model` / `Done`) and a scrim. Facets `display:flex; flex-wrap:nowrap; overflow-x:auto`, 32px tall (was five stacked 48px buttons = 265px); sort returns inline as `Popular ⌄`. Picker chrome falls from ~400px of 518px (77%) to ~140px (27%); visible rows go from **1 to 5**.

### 5.5 Connect surface (`#access`)

**Resting, desktop 1440×900, 842px pane:**

```
  0  <RouteHeader>  Models  ⓘ        [ ○ No model connected · 4 ready ]   44px
 58  ▾ Chutes · Encrypted inference with per-turn evidence   ○ Sign in    44px
116    Sign in, or paste an API key.                                      21px
137    Sign in with your Chutes account, or…                              21px
158    [ OAuth · Primary ][ API key · Page memory ]                       52px
210    Sign in to Chutes  ──────────────────────────────────────────     148px
       ↑ primary CTA at y≈250 (was y=944, 102px below the fold)
358  ▸ Anthropic · Claude account or API                                  44px
408  ▸ xAI · Grok account or API                                          44px
458  ▸ Ollama & LM Studio · This machine                                  44px
508  ▸ OpenAI · Codex account or API                                      44px
558  ▸ Airship Companion · Not installed                                  44px
608  ▸ Compare what each method can do                                    40px
648  ─────────────────────────────────  194px to spare
```

**Lane header, 44px, one row**, `align-items:center`, one shared `padding-inline: var(--sp-3)` with `--lane-gutter: 34px` text indent applied to header *and* body (fixes the measured 34px misalignment inside every open lane):

```
[icon 20]  {Title} · {qualifier}  ·········  {Seal chip}  ⌄
```

Title `--fs-lead` 17px `--fw-strong`; qualifier `--fs-caption` `--ink-muted` on the same baseline. Qualifiers: `OpenAI · Codex account or API`, `Anthropic · Claude account or API`, `xAI · Grok account or API`, `Ollama & LM Studio · This machine`, `Chutes · Encrypted inference with per-turn evidence`, `Airship Companion · {state}`.

**Never render a method heading with no control under it.** `CloudMethodPanel`'s initial state becomes `oauthStatus.kind === "ready" || "connected" ? "oauth" : "api-key"`. The OAuth tab stays present and selectable — that is where the honest reason lives — it simply is not the default when it cannot work. `<p class="connect-method__title">` renders **only** when the panel below it has a control; otherwise `.connect-method__blocked` = `<Icon name="warning">` + `status.detail` + a `Use an API key` button that switches the tab beside it.

**The fabric is merged into the lanes it duplicates.** `CloudProviderCard` (`provider-connections-view.tsx:379`) renders inside its own lane's `api-key` tabpanel; both `LocalProviderCard`s render in the Local lane body. `onOpenDirectProviders` becomes `onSelectMethod("api-key")`; the button that scrolled 1300px to a second copy of itself now switches the tab beside it. `ProviderConnectionsView` keeps only `.provider-fabric__connections`, which moves inside each lane as its connected state. Every cloud provider name drops from 5 mentions to 2.

**One measure.** `--connect-measure: 760px` on `.access-connection-view`, `margin-inline: auto`, inherited by every descendant. Delete `.access-connection-layout`'s competing `max-width: 980px` and `.connect-surface`'s inset. Four widths (1208/1156/980/942) → one. Below 1050px, `max-width: none`. The open capability table keeps its existing `.capability-table-wrap` horizontal scroll.

**Type.** `access-view.css` has 36 hardcoded rem font-sizes across 18 values — fourteen sizes inside a 3.6px band — against 8 token uses. `connect-surface.css` is already clean (36 token uses, zero hardcodes) and is the model. Map by **role**, not nearest value, per §4.1.

**Mobile.** The 640px overrides at `connect-surface.css:641` and `access-view.css:820` — which already `display:none` the eyebrow, the paragraph, the jump nav, the whole `.connect-surface__heading` and the lane detail line, with comments saying each "delayed the first usable credential control by more than a viewport" — become **the desktop layout too**, and the overrides are deleted. Desktop is strictly worse than the mobile layout the team already shipped; this ends that. Phone content: 3549px (5.62 screens) → ~909px (1.44).

### 5.6 Shell and sidebar

**Three states on one token.** Replace `--density-sidebar` with `--rail-width`, driven by `data-rail` on `<html>`:

| State | `--rail-width` | Contents |
|---|---|---|
| `focus` | 0px | Rail hidden, topbar brand + `.topbar-center` hidden |
| `rail` | 60px | 8px inline padding, 44×44 icon targets, 18px icons, 4px gaps, icon only |
| `standard` | 232px | Today's rail |

`.app-shell` and `.topbar` both use `grid-template-columns: var(--rail-width) …` so the brand block keeps tracking the rail exactly (measured pixel-identical at 232px today).

**Defaults** (conflict 11): `standard` at ≥1362px (= 232 + 820 measure + 310 inspector — the width at which the designed layout stops fitting); `standard` for `(hover: none)` at ≥861px; `rail` otherwise. Once toggled, `preferences.railState` is stored **per band** (`wide` / `narrow`) and wins forever after.

**Triggers:** `⌘\` / `Ctrl+\`; command palette "Collapse navigation rail" / "Expand navigation rail"; a 24×24 chevron at the rail's bottom-left with `aria-expanded`. `⌘.` / `Ctrl+.` enters/exits `focus`; `Esc` exits.

**Hover-peek** (`rail` state, `(hover: hover)` only): 180ms pointer-dwell expands an **overlay** panel to 268px (`position:absolute; inset-block:0; left:0; z-index:30; box-shadow:var(--shadow)`) — it does not reflow the grid, so the conversation never jumps. Collapses 240ms after pointer-out. `:focus-within` pins it open. `prefers-reduced-motion` → instant swap.

**Structure:**

```
(no group label)
  Chat              ▸   [unread badge]
  Workspace         ▸   (Editor, Terminal nested, collapsed by default)
  Memory

RECEIPTS & ACCESS
  Proof                 [receipt dot]
  Vault
  Models
  Account
──────────────────────
[GE] General          ⌄     48px pinned row
```

Content height: 5 rows (230) + 1 label (19) + 4 rows (184) + 24 nav padding + 10 group gap + 24 item gaps = **491px**; **399px** with Workspace collapsed. Plus the 48px profile row and 1px rule = 540 / 448px. **Fits without scrolling at every viewport height ≥598px (≥506px collapsed)** — versus today's 785–943px of content in a 501–701px box.

**Recent conversations leave the rail.** The existing `.chat-nav-disclosure` chevron (`app.tsx:4673`) becomes a popover trigger: 320px, `max-height: min(420px, 60vh)`, rendered over the main region, focus-trapped via `src/ui/focus-trap.ts`. Same rows, same ten sessions from `recentProfileConversations.slice(0, 10)`, but the title column gets ~232px instead of ~105px (~34 chars instead of ~13). Header carries the `+` (`aria-label="New conversation"`); last row is `↳ All conversations`. `⌘⇧O` opens it directly; the command palette gains "Recent conversations". Removes 250px at the cap — which is exactly what puts Proof/Vault/Models/Account back above the fold.

**One scroll region, three tab stops.** Both inner scrollers (`.recent-conversations` at `min(250px,30vh)`, `.recent-conversations.profile-navigation` at `min(310px,38vh)`) are gone by construction. Keep the `data-scroll-edges` mask machinery at `styles.css:625-655` verbatim — it is correct, measured rather than assumed, and has a `forced-colors` fallback; it simply stops firing at realistic heights. Make the rail a roving-tabindex composite: `↑`/`↓` between destinations wrapping, `→`/`←` expand/collapse Workspace, `Enter`/`Space` navigate, `Home`/`End` jump. 20 tab stops (29 with 8 conversations) → **3**. Skip links at `app.tsx:4547` are unchanged.

**Fix the specificity accident** while the code is open: `:root[data-density] .nav-item { min-height: var(--density-control) }` (`styles.css:165`, 0-2-1) beats `.sidebar .nav-item { min-height: 50px }` (`styles.css:4931`, 0-2-0). Compose instead of colliding: `min-height: var(--rail-item-height, var(--density-control))`.

**Retire the tablet override block.** `@media (max-width: 860px)` at `styles.css:4893` spends ~60 lines re-specifying the rail and `display:none`-ing `.chat-nav-disclosure`, `.chat-nav-new`, `.recent-conversations` and `.profile-switcher` — i.e. the tablet layout loses the conversation switcher and the profile switcher entirely, which is a P9 violation. It collapses to one declaration: `:root:not([data-rail]) { --rail-default: rail; }`. Everything it hid comes back as popovers.

**Focus mode's honesty strip** — 28px, pinned top-right of `.chat-stage`, **first tab stop**, always visible:

```
[◐] Ephemeral · Ready · airship/demo-v1              ⌘. exit focus
```

`[◐]` is `<Seal size={16} density="dot">` fed by the already-computed `mobilePostureSeal` — the weakest claim across the stack, exactly the rule the 430px header already applies. Clicking opens the existing `TrustSheet` unchanged. `aria-label`: `Runtime trust: <weakest claim label>. Open full claim stack.` **Focus mode hides chrome, never claims:** nothing is newly hidden that a 430px phone does not already hide, and the model id — absent from the topbar today — is *added*. Manual trigger only; an automatic trigger would hide claims the user did not choose to hide.

**Net:** 262px of chrome returned at 1440×900 (232 rail + 58 topbar − 28 strip). Chat stage 898px → 1130px with the inspector open: 155px gutters around the 820px measure instead of 39px. The minimum width for the designed rail+measure+inspector layout drops from 1362px to 1190px, so 1280×720 finally renders the full 820px measure instead of compressing it by 82px.

---

## 6. Sequenced build plan

`src/ui/app.tsx` is **7,045 lines** and `src/ui/styles.css` is **6,022 lines**. These two files are named in 11 of the 12 work packages below and are the entire collision risk. The strategy is: **split them first, in one pure-move PR, then forbid concurrent edits.**

### WP-0 — Seams and tokens (blocks everything; nothing runs in parallel with it)

Two commits in one PR, in this order.

**0a. Pure extraction — no behaviour change.** Verified by `git diff --stat` showing only moves plus imports, and by `npm run test && npm run typecheck` green with zero test edits.

| New file | Extracted from |
|---|---|
| `src/ui/chat/session-bar.tsx` | `app.tsx` 4780–4874 (`.stage-header` JSX) |
| `src/ui/chat/composer.tsx` | `app.tsx` 5000–5140 + the `fit()` effect at 917–947 |
| `src/ui/chat/transcript-intro.tsx` | new (welcome-message replacement) |
| `src/ui/topbar.tsx` | `app.tsx` topbar JSX |
| `src/ui/rail.tsx` + `src/ui/rail.css` | `app.tsx` 4600–4760 (sidebar JSX) |
| `src/ui/route-header.tsx` | new |
| `src/ui/popover.tsx` | new |
| `src/ui/chat/session-status-chip.tsx` | new |

`styles.css` splits to `tokens.css` (`:root`, density, corners, type-scale), `shell.css` (topbar, rail, route-layout), `chat.css` (stage, transcript, composer), retaining `styles.css` as the `@import` barrel so `route-layout.test.ts`, `density-contract.test.ts`, `design-contract.test.ts` and `type-floor.test.ts` — which read `styles.css` by URL — must have their read paths updated **in this PR and only this PR**.

**0b. Tokens.** Add `--fs-title/--fs-display/--fs-hero`, `--fw-*`, `--sp-1..7`, `--radius-chip`, `--line-control`, `--ink-disabled`, `--surface-disabled`, `--ink-faint` revision, `--rail-width`, `--connect-measure`. Keep `--fs-h3` as an alias. **No consumer changes.** Nothing visual moves.

> **The rule from here:** after WP-0, a PR may touch `app.tsx` **or** an extracted component, never both. `app.tsx` edits are limited to prop wiring and deletions of the extracted blocks, and every WP that needs one declares it in its title.

### Work packages

| WP | Scope | Files | Depends on | Collisions |
|---|---|---|---|---|
| **1** | `<Seal density>`, `<Popover>`, `.notice` unification | `seal.tsx`, `seal.test.ts`, `popover.tsx`, `styles.css`+`tokens.css`, `durability-indicator.tsx/.css`, `posture-chip.tsx`, `claim-stack-model.ts`, `proof-view.tsx` | WP-0 | `design-contract.test.ts` asserts seal internals — extend, don't rewrite. Touches 49 CSS families across ~14 files: land as **one** PR, not fourteen. |
| **2** | Session bar, session status chip, topbar posture chip, guidance-band deletion, transcript intro, scroll collapse + scrim | `chat/session-bar.tsx`, `chat/session-status-chip.tsx`, `chat/transcript-intro.tsx`, `topbar.tsx`, `platform-shell.tsx`, `chat.css`, `scroll-affordance.ts`, **`app.tsx` (delete 4780–4878, wire props, rename `vault` axis label)** | WP-0, WP-1 | Owns `app.tsx` for the sprint. `chat-layout.test.ts:43-46` asserts `.stage-header-title`/`.stage-header-model`/`.session-meta-*` selectors — rewrite to the new selectors in the same PR. Amends 3 e2e assertions (§7.2). |
| **3** | Composer: two rows, `fit()` simplification, footer strip, posture chip, approval popover grid, keyhint, placeholder, `visualViewport` cap + tab-bar yield | `chat/composer.tsx`, `chat/composer-state.ts`, `chat/composer-focus.ts`, `chat.css`, `menu-select.css`, `platform-shell.tsx`+`.css` | WP-0, WP-1 | **Parallel-safe with WP-2** only because WP-0 extracted `composer.tsx`. Both touch `platform-shell.tsx` — WP-2 takes `TrustPostureSheet`, WP-3 takes the `visualViewport` subscription at line 424; different functions, land WP-2 first. |
| **4** | Tool rows: `pairOperations`, op-strip, bounded sheet, answer anchoring, collapse header, streaming locus, parallel bracket | `chat/message-parts-view.tsx/.css`, `chat/message-parts.ts`, `chat.css` (answer/narration sizes), `platform-shell.tsx` (preference) | WP-0, WP-1 | **Fully parallel** — the only WP that does not touch `app.tsx` or the shell. Start it on day one. |
| **5** | `<RouteHeader>`, `.route-body` auto-fit, `<Tabs>`, `<MetricStrip>` across ten routes | `route-header.tsx`, `tabs.tsx`, `metric-strip.tsx`, all ten `*-view.css`, `memory-view.tsx`, `proof-view.tsx`, **`app.tsx` (route wiring)** | WP-0, WP-1 | **Serialise behind WP-2** for `app.tsx`. Largest surface area; split into 5a (component + 3 routes), 5b (4 routes), 5c (3 routes) so review stays tractable. `route-layout.test.ts` asserts the route-layout string literals in `app.tsx` — update in 5a. |
| **6** | ModelPicker rebuild, chat chip → picker, `#access` trigger/anchor, candidate panel, route-aware topbar pill | `model-picker.tsx/.css`, `model-control.tsx`, `access-view.tsx/.css`, `chat/session-bar.tsx`, **`app.tsx` (`inferenceStatusLabel`, pass `availableModels`)** | WP-2, WP-5 | The chip is a **slot** WP-2 leaves empty; WP-6 fills it. `model-control.test.ts` and `model-picker.test.ts` both change. |
| **7** | Connect IA: fabric→lanes, companion lane, lane headers, default method, boundary aside re-home, one measure, `access-view.css` type sweep | `connect/connect-surface.tsx/.css`, `connect/connect-lanes.ts`, `provider-connections-view.tsx`, `provider-fabric-panel.css`, `access-view.tsx/.css` | WP-5, WP-6 | **Largest single WP.** Owns `access-view.tsx` exclusively; WP-6 must land its candidate-panel change first. `access-view.copy.test.ts` has ~15 exact-string assertions — budget a full pass. |
| **8** | Rail three states, recents popover, profile row, regrouping, roving tabindex, tablet block retirement, specificity fix | `rail.tsx/.css`, `navigation-model.ts`+`.test.ts`, `shell.css`, `mobile-navigation.tsx`, **`app.tsx` (sidebar deletion, `railState` preference)** | WP-0, WP-1 | **Serialise behind WP-5** for `app.tsx`. Amends `responsive-breakpoints.spec.ts:169-202` (rail overflow) — see §7.2. |
| **9** | Sweeps + CI guards: type ramp everywhere, spacing/radius, brass reclaim, contrast tokens, delete `--fs-h3`, serif to one job | every `*.css`, `type-floor.test.ts`, `density-contract.test.ts`, `css-variable-contract.test.ts`, `docs/DESIGN_LANGUAGE.md` | **WP-1..8 all merged** | **Must land last.** The guards fail the build on any non-token `font-size`, `padding`, `margin`, `gap`, `border-radius` literal; landing them before the sweeps blocks every other WP. |
| **10** | Focus mode `⌘.`, honesty strip, command-palette entries, `⌘⇧O` | `app.tsx`, `shell.css`, `platform-shell.css`, `seal.tsx` | WP-8 | Small; the last `app.tsx` touch. |
| **11** | Copy: "Connection" → "Models" | `navigation-model.ts:121,148`, `platform-shell.tsx` `TRUST_TABS`, `access-view.tsx` H1, `access-view.copy.test.ts:130`, `e2e/connect-inference.spec.ts:20,249` | WP-7 | Mechanical, isolated, do it alone so the diff is reviewable as a copy change. |
| **12** | *(Deferred, not in this program)* Self-hosted display serif | — | WP-9 | Requires its own font-budget line item in `scripts/release-gate.mjs`. See conflict 9. |

**Critical path:** WP-0 → WP-1 → WP-2 → WP-5 → WP-7 → WP-9. WP-4 runs fully parallel from day one. WP-3 runs parallel after WP-2's `platform-shell.tsx` edit lands. WP-6 and WP-8 are the two mid-program merges most likely to conflict; give them adjacent slots and a shared owner.

**`app.tsx` ownership calendar** (the single most important line in this plan): **WP-0 → WP-2 → WP-5 → WP-8 → WP-6 → WP-10.** Exactly one open PR may hold `app.tsx` at a time. Every other WP is either pre-extracted or CSS-only. Expected line count after WP-10: **~4,100** (−2,900).

---

## 7. What must not regress

### 7.1 The honesty contract — non-negotiable

1. **No claim is deleted.** Every REMOVED row in §3 names a surviving carrier. A reviewer may reject any PR whose diff removes a string not accounted for in the ledger.
2. **P1** — `--v-*` and `--truth-*` remain outside the theme system. No verdict token may alias `--accent`. `design-contract.test.ts` already pins the six hex values; keep it.
3. **P2** — every seal renders in a **≥16px well** with an adjacent plain word. `sealRenderedSize()`'s `Math.max(16, size)` floor stays. No colour-only distinction anywhere, including the new escalation dots (which are always accompanied by their label).
4. **P4** — no computed font-size below 11px. `type-floor.test.ts` stays and is **extended** to fail on any `font-size`/`font:` in `src/ui/**.css` that is not `var(--fs-*)`.
5. **P6** — nothing moves behind a *removed* destination. Every collapsed fact is one gesture away, keyboard-reachable, and deep-linkable through the existing hashes. The tool-strip collapse ships with the `preferences.transcriptOperations` override.
6. **P9** — no blanket `display:none` on any trust, approval or review surface. This program **removes two existing violations**: `.composer-tools span:nth-child(2)` at 0×0px on phone, and the tablet block's four `display:none`s.
7. **P11** — no raw kebab enums, ISO strings or digests in a default view. Every new chip label comes from an existing humanizer; `trust-language.test.ts` stays green untouched.
8. **P12** — durability remains explicit. The topbar rename (`Ephemeral` → `No vault adopted`) changes the *label of the vault-adoption axis*, not the durability claim; the session chip and the composer posture chip both still say "page memory" in plain words.
9. **Never behind a disclosure:** `oauthNotice` (error tone), `oauthDiagnosticError`, `safeModelControlErrorMessage`, `.session-runtime-error`, and the sentence *"This policy is not proof. Completed receipts record only what the browser actually verified."*
10. **No fact lives only in a `title`.** Every `title`-only string gains a popover row.

### 7.2 e2e assertions — kept, and the four deliberate amendments

**Kept, unmodified — these constrain the design and the design was drawn to satisfy them:**

- `responsive-breakpoints.spec.ts:54` `topHeight <= 68` → topbar unchanged at 52/58px.
- `:55` `stageHeight < 0.18 × viewport.height` → 48px session bar vs 167px allowance at 430×932. **Improves.**
- `:56` `stageTop >= topBottom - 1` → bands still stack.
- `:57-58` `detailsRight/navRight <= viewportWidth + 1` → `.mobile-session-details` is deleted; update the selector to `.session-bar__chips`.
- `:74` `aboveTranscript <= 0.30 × viewport.height` → 100px vs 279px at 430×932. **Improves from 180px.**
- `:75` `transcript > 0.50 × viewport.height` → 670px vs 466px required. **Improves from 611px.**
- `:83-85`, `composer-layout.spec.ts:73-75,83-90,129-136` — composer height and approval anchor invariant across focus, hover, one-line typing, policy disclosure and clear. The two-row layout satisfies these **more strongly**: the footer is a separate grid row, so nothing in it can move when the textarea grows.
- `:104` `getByRole("button", { name: /Session\. Ephemeral · this page only\./u })` → the session status chip's `aria-label` **must** begin `Session. ` immediately followed by the durability clause (§5.1).
- `:27` `getByRole("button", { name: "Connect a model", exact: true })` visible on phone `#chat` → exactly one such button survives at every width.
- `:141` `header + guidance <= 74` in landscape → 48 + 0 = 48. **Improves.**
- `:147-148`, `composer-layout.spec.ts:67-68` `approval.height >= 44`, `attach.height >= 44` → the 44px mobile footer row exists **because of** these.
- `composer-layout.spec.ts:60,125-127` `"Ask First"` / `"Auto Approve"` / `"Full Access"` exact → **unchanged** (conflict 4).
- `composer-layout.spec.ts:118-119` `100 < textarea.height <= 181` when multiline → the 180px cap is retained on tall viewports.
- `airship-shell.spec.ts:244` `.composer-tools` contains `"Ask First"` → the approval control keeps the class `.composer-tools` on its left cluster.
- `getByRole("combobox", { name: "Message Airship" })` → the textarea's `aria-label` is **exactly** `Message Airship`. Only the placeholder changes.
- `connect-inference.spec.ts`, `claim-stack-layout.spec.ts`, `proof-truthfulness.spec.ts`, `route-adversarial-audit.spec.ts`, `disconnected-capabilities.spec.ts` — no intentional changes; run every WP against them.

**Amended, deliberately, four assertions:**

| File:line | Today | Becomes | Why |
|---|---|---|---|
| `responsive-breakpoints.spec.ts:59` | `composerHeight <= 60` | `composerHeight <= 92` **plus** `composerHeight <= 0.13 × innerHeight` **plus** (new) with the keyboard open, `composerRegion <= 0.46 × visualViewport.height` and `transcript >= 100` | 44px touch row + 44px text row cannot be 60px (conflict 5). The replacements protect the invariant the cap was proxying for, and the keyboard assertion is entirely new — today the transcript collapses to **24px** and nothing catches it. |
| `composer-layout.spec.ts:79` | `.chat-live-guidance` contains "this composer is a deterministic demo" | `#chat-demo-guidance` contains "deterministic local demo" **and** the model chip's accessible name contains `Demo` | The band is deleted; the sentence survives in the sr-only description and the transcript intro (conflict 12). |
| `composer-layout.spec.ts:82` | Send has `aria-describedby="chat-demo-guidance"` | **unchanged** — but the target moves to the permanently-mounted sr-only `<p>` | A popover or an unmounting intro would dangle the reference. |
| `responsive-breakpoints.spec.ts:196-202` | Rail `data-scroll-edges === "end"` and masked at 1440×800/700 | At `standard` with the WP-8 content set: `edges === "none"`, `masked === false` at every height ≥598px; the `"end"` case is re-asserted at a synthetic 480px height | The mask machinery is kept verbatim and stays correct; it simply stops firing because the rail now fits. Asserting it *never* fires would delete a working affordance, so the test proves it still fires when it should. |

New assertions to add (`e2e/`):
1. `main.scrollHeight / main.clientHeight < 1.4` at 1440×900 and `< 1.6` at 390×844 on `#access`.
2. The `Sign in to Chutes` button's document Y `< main.clientHeight` at 1440×900 (it is 944 vs 842 today).
3. `document.querySelectorAll('.connect-lane').length === 6`, all six headers within the first viewport at 1440×900.
4. `body.innerText.match(/Anthropic/g).length <= 2` (5 today) — proves the duplicate is gone without asserting wording.
5. No `<small>` inside `.connect-method__switch` has `scrollWidth > clientWidth` — proves no status sub-label truncates.
6. Opening every lane and every method tab yields no tabpanel whose only content is a heading.
7. On `#chat` with 3 turns, expanding every operation moves the answer's `getBoundingClientRect().top` by ≤2px, and `.transcript-jump` does not appear.
8. On `#chat`, no element's `scrollWidth > clientWidth + 1` inside `.session-bar` at 1440, 1280, 834 and 430.

### 7.3 Keyboard and focus

- Every chip is a `<button>`; every popover is `Esc`-dismissible, outside-click-dismissible and focus-trapped through the existing `src/ui/focus-trap.ts`. `focus-trap.test.ts` stays green.
- `:focus-visible` remains a 2px `--focus` outline at `outline-offset: -2px` on every new control.
- The skip links at `app.tsx:4547` ("Skip to conversation", "Skip to composer") are unchanged and keep working through every layout change.
- Rail tab stops go 20 → 3 with **no** loss of reach: arrow-key traversal is added, not substituted.
- Focus mode's honesty strip is the **first** tab stop inside `.chat-stage`.
- The slash-command combobox contract (`role="combobox"`, `aria-expanded`, Escape-without-clearing, disabled-option skipping, Enter-accepts-highlight) is untouched; `slash-menu-state.test.ts` stays green.
- Every `aria-label` named in §3 is a **contract**, not a suggestion. `menu-select.test.ts`, `posture-chip.test.ts`, `seal.test.ts`, `platform-shell.test.ts` all assert accessible names — run them on every WP.

### 7.4 Touch targets

44px minimum on every interactive element at `(pointer: coarse)`, enforced by the existing density block. Specifically: session-bar chips 44px on mobile (**no scroll collapse at coarse pointer**), composer footer row 44px, tool rows 44px, lane headers 44px, rail items 44×44, ModelPicker rows 44px, popover-as-bottom-sheet rows 44px, the `Done` sheet header 44px.

### 7.5 The 132 KiB gzip startup budget

`scripts/release-gate.mjs:22` — `allJavaScriptAndWorkers: { raw: 640 KiB, gzip: 132 KiB }`, measured at **405.45 KiB raw / 128.89 KiB gzip**: **3.11 KiB of headroom**. This ceiling has explicitly never moved through three capability waves and **does not move here.**

Rules:

1. Every WP runs `npm run check:release` and reports its gzip delta in the PR description. No exceptions.
2. **Any WP that pushes `allJavaScriptAndWorkers` above 130.0 KiB must ship a deletion in the same PR.** 2 KiB is the reserve, not the budget.
3. Expected deltas — this program is **net-negative** by design: WP-1 deletes 49 CSS families and ~26 status components (large negative); WP-2 deletes the guidance band, `.mobile-session-details` and ~120 lines of `.stage-header` CSS (negative); WP-3 deletes the `fit()` oscillation branch and the `[data-multiline]` variant (negative); WP-4 deletes two card renderers for one row renderer (negative); WP-5 deletes five bespoke header blocks and eight H1 rules (large negative); WP-7 deletes `.provider-fabric`'s setup block (large negative); WP-8 retires ~60 lines of media-query CSS (negative). The only additions are `popover.tsx` (~1.2 KiB gzip), `tabs.tsx` (~0.4), `metric-strip.tsx` (~0.3), `route-header.tsx` (~0.5), `session-status-chip.tsx` (~0.4) and `rail.tsx` (~1.5, offset by the `app.tsx` deletion).
4. **No new runtime dependency.** `AIRSHIP_DESIGN_BLUEPRINT.md:2246` pins runtime deps at exactly `preact, sigma, graphology`. No popover library, no headless-UI, no CSS-in-JS, no icon package. `<Popover>` is hand-rolled on the existing `focus-trap.ts`.
5. **No web font ships in this program** (conflict 9). `--font-display` stays `Georgia, "Times New Roman", serif`.
6. **No `backdrop-filter`, no decorative gradient, no idle animation loop** (P8/P10). The two motions this program adds — hover-peek 240ms and the focused-row 90ms height transition — are both transform/height only, both under 160ms where they gate interaction, and both `prefers-reduced-motion`-gated.

---

### Measured outcome, stated so it can be verified rather than felt

| Surface | Before | After |
|---|---|---|
| `#chat` chrome, 1440×900 empty | 219px (24.3%) | **98px (10.9%)** |
| `#chat` chrome, 1440×900 with 3 turns | 266px (29.6%) | **98px** (does not grow) |
| `#chat` non-transcript total, 1440×900 | 304px (33.8%) | **198px (22.0%)** |
| `#chat` transcript, 1440×900 | 596px | **702px (+17.8%)** |
| `#chat` void, 1440×900 empty | 374px (41.6%) | **0px** (bottom-docked) |
| Composer typing width, 1440 | 338px (42.8%) | **758px (+124%)** |
| Composer typing width, iPad 834 | 234px (34.2%) | **652px (+179%)** |
| Composer typing width, iPhone 430 | 209px | **382px (+83%)**, no clipping at any viewport |
| Transcript at keyboard-open, iPhone | 24px | **~110px**, ~200px once the tab bar yields |
| 3-tool turn, desktop | 373px of machinery (45% of the message) | **104px**, or **32px** collapsed |
| 3-tool turn, phone | 377px (62% of the conversation area) | **132px**, or **44px** collapsed |
| Answer displacement on expand-all | 687px (1.20 viewports, off-screen) | **0px** |
| Chat model name field | 169px, truncated | **~250px**, untruncated |
| Chat model list width | 260px, 12/12 rows ellipsised | **680px**, 0 truncated |
| ModelPicker rows visible, phone | **1** | **5** |
| `#access` content | 2,689px (3.19 screens) | **~1,023px (1.21)** |
| `#access` chrome above the lanes | 656px (78% of screen 1) | **62px (7%)** |
| `#access` primary CTA | y=944 (102px below fold) | **y≈250** (694px rise) |
| `#access` phone | 3,549px (5.62 screens) | **~909px (1.44)** |
| Rail destinations visible, 1440×900, 8 conversations | 8 of 11 | **11 of 11**, no scroll ≥598px |
| Rail tab stops | 20 (29 with 8 conversations) | **3** |
| Route title sizes across 10 routes | 47 / 45.9 / 34 / 28.8 / 21.25px (2.2× spread) | **28px (1.0×)** |
| Rendered font sizes, 10-route walk | 35 in 58 size/weight pairs | **8 in 3 weights** |
| Status/notice CSS families | 49 (18 rendering simultaneously) | **1** (`<Seal>`, 3 densities) |
| Tab-strip families / active encodings | 9 / 4 | **1 / 1** |
| Brass instances | 347 across 41 sites | **~90**, all four meaning one of four things |
| Control boundary contrast | 1.26:1 | **3.07:1** |
| Disabled Send glyph | 1.71:1 | **3.48:1** |
| `app.tsx` | 7,045 lines | **~4,100** |