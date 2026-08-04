Verification complete. HEAD has moved to `3ea40cf` during this pass — two commits past what the inventory assumed — and several rows changed status as a result. Here is the register.

---

# Recovered work register

## What this is

Engineering work that was measured, argued, adversarially reviewed, and never connected to the code — recovered from 63 session transcripts, 24 workflow journals, 279 subagent transcripts, 32 federation relay runs, and one temp-directory scratchpad that is still the only home of several findings. Every row below was re-verified against the working tree at `3ea40cf` on 2026-08-04; rows that turned out to be already implemented are in §4 rather than deleted, because sending someone to "fix" working code is the failure mode this register exists to prevent.

**Read this first:** a prior verification pass re-checked 149 claimed-open findings from `docs/audit/CANON_RECONCILIATION_2026-08-03.md` and found **82 confirmed, 29 partial, 31 false positives, 7 unverifiable** — a 21% outright error rate, from three named failure modes: reading the named file and stopping, grepping for the *proposed* name instead of the *shipped* mechanism, and stale line citations. That pass's own headline instruction applies to this register too: **do not act on any row without re-deriving its evidence.** My own pass overturned six more rows against the tree, which is the rate you should expect to keep finding.

---

## 1. Fix now — a user feels this

Ranked by how much a person notices. All confirmed open at `3ea40cf`.

### 1.1 A Google Drive vault demands the recovery-key paste on every single reload — the module that fixes it was built to spec, tested, and never called

**Measurement.** `src/storage/workspace-key-handle-store.ts` (15.0 KB) exports `rememberWorkspaceKey`, `adoptCachedWorkspaceKey`, `googleDriveKeyPartition` and `openWorkspaceKeyHandleStore`, with a 13.4 KB test file. `grep -rn` for all four across `src/`, excluding the module and its own test, returns **zero hits**. The only cross-module import of the file is `src/storage/local-device-keyring.ts:9`, which takes `equivalentWorkspaceKeys` alone. `src/ui/google-drive-setup.tsx:106` still refuses to connect with "Generate or import the workspace recovery key first."

**Designed fix.** Two call sites in `src/ui/google-drive-setup.tsx`: `rememberWorkspaceKey(googleDriveKeyPartition(googleSubject))` after a successful connect; `adoptCachedWorkspaceKey` on mount, falling through to the paste field on a miss. Keep the paste field — it is the recovery path.

**Source.** `wf_4b52d8c4-84a/journal.jsonl` (CONFIRMED_OPEN, reached independently by two of six verifiers) → `docs/gap-audit/vault.md` #2; corroborated by `docs/GOOGLE_DRIVE_VAULT.md:65-70`, the repo's own self-audit.

**Blind-fix risk.** This is key custody, not UI convenience. The partition key is `google-drive:<googleSubject>` and the audit was emphatic about *that identifier specifically* — keying on email, folder id or connection id makes one signed-in user adopt another's cached key on a shared device, turning a reload annoyance into a cross-account key leak. The subject claim is the only stable, non-reassignable one of the three. Verify boot-side adoption runs *after* identity is established. Read the 13.4 KB test before wiring: it is the only surviving statement of the intended semantics, and `local-device-keyring.ts` already consumes part of the module, so the two custody paths must agree rather than both claim the key.

---

### 1.2 The only real semantic retrieval engine is unreachable on every deployed build — and would 404 even if it shipped

**Measurement.** `scripts/semantic-pack-assets.ts` registers exactly two hooks — `configureServer:37` and `configurePreviewServer:40` — and contains no `generateBundle`, `writeBundle`, `closeBundle` or `emitFile` anywhere in its 64 lines. `package.json:42` `build:static` is a bare `vite build`; `build` never invokes `semantic:prepare`. `dist/` contains `_headers, assets, execution-packs, extension, favicon.svg, index.html, manifest.webmanifest, sw.js` — no `semantic-pack`. Separately `src/indexing/semantic-transformers-loader.ts:9` hardcodes `PACK_ROOT = "/semantic-pack/v1/"` while `public/sw.js` already uses `scopedPath()` throughout and `pages.yml` builds with `AIRSHIP_PUBLIC_BASE_PATH=/airship/`. So semantic retrieval works under `vite dev` and `vite preview` and is silently absent from anything shipped — the exact shape that makes a capability look delivered.

**Designed fix.** Not mechanical — escalated as a product decision with three costed options: **(1)** ship it, build-time fetch of 78 MiB from HuggingFace with the sha256 manifest giving verifiable integrity, at the cost of a build-time network dependency; **(2)** keep it local and say plainly in the UI that deployed Airship has hash-only memory; **(3)** lazy-fetch at runtime on opt-in, needing its own CSP and integrity story. Whichever is chosen: `generateBundle()` modelled on `scripts/pyodide-assets.ts` with byte-length and SHA-256 re-verified per manifest entry, behind an opt-in env flag, and `PACK_ROOT` derived from `import.meta.env.BASE_URL`.

**Source.** `wf_4b52d8c4-84a/journal.jsonl` §2 item 5 and `docs/gap-audit/context.md` #4/#4b; independently re-derived by the 2026-08-03 reconciliation, which called it "the most consequential one."

**Blind-fix risk — four measured landmines, all still live.** (a) `release-gate.mjs:262` classifies every `dist` `.js`/`.mjs` except `sw.js` and pyodide, so `transformers.web.js` (1,086,262 B) and four ORT `.mjs` files become unclassified and blow `totalJavaScriptAndWorkers`. (b) `:254` excludes only pyodide from `wasmFiles`, so `ort-wasm-simd-threaded.wasm` (12.5 MB) and `.jsep.wasm` (25.4 MB) blow the 1 MiB per-file ceiling. An `isOptionalSemanticPackPath()` exclusion must land in the same change. (c) Moving `PACK_ROOT` breaks three assertions in `semantic-transformers-loader.test.ts` **and a security boundary** — the script-URL policy throws for anything not matching `/semantic-pack/v1/runtime/` (`docs/SEMANTIC_EMBEDDING_PACK.md:111`), so that matcher must become base-path-aware in the same edit or the pack loads and is then refused. (d) Emitting a 92.8 MiB pack that only exists when someone ran `npm run semantic:prepare` makes the build non-deterministic, colliding with §3.1. **Landing the one-line `PACK_ROOT` fix alone changes nothing and will read as done** — it converts a 404 at the wrong URL into a 404 at the right one.

---

### 1.3 Cancelling a turn makes the session report `invalid` on the next turn — the user sees a failed audit on Proof

**Measurement.** Materialization prunes cancelled turns; the audit does not. `src/core/agent.ts:1113` computes `cancelledTurnSalvage`, `:1118-1123` builds `nonActionableTurns`, `:1140` excludes them and rewrites salvaged turns. `src/core/session-audit.ts:1640-1658` only stamps `turn.terminal = "cancelled"` and increments `counts.cancelledTurns` — messages keep being pushed at `:1505/:1589/:1617`. So `expectedRequestDigest` at `:1424` is computed over a transcript prefix containing messages the real request never carried, and `:1432` emits `INFERENCE_REQUEST_DIGEST_MISMATCH`. Probed at HEAD *and* in a worktree at `d3fd7ab` before salvage landed: identical failure, so it is older than the salvage work. `git log -- src/core/session-audit.ts` ends at `632ff68`, which predates `ff21778` (the salvage commit) — the audit was never updated when salvage landed.

**Designed fix.** None written; deliberately handed off ("belongs to whoever takes the audit next"). The seam is named precisely: make the audit's incremental message rebuild apply the same cancelled/salvaged filter `materializeProviderMessages` applies, so both derive the same prefix from the same journal.

**Source.** `/private/tmp/claude-501/-Users-chrisk-airship/5772c406-b82c-4e0f-a5d8-7ba0ed70f3d1/scratchpad/msg-honesty.txt` (final paragraph) and `.../merge2.txt`; preserved in the merge body of `ff21778`. **Filed nowhere in the repo.**

**Blind-fix risk.** `grep -rn 'cancelledTurnSalvage|salvage' src/ --include='*.test.ts'` returns **nothing** — no test covers this interaction, so a fix has no safety net and must ship with one. And the two prunes are not identical: `agent.ts` *excludes* non-actionable turns but *rewrites* salvaged ones (checkpoint rewrite at `:1140-1151`). Copying only the exclusion into the audit makes the digest wrong in the other direction for salvaged turns.

---

### 1.4 Switching model or provider cannot carry the conversation — the fork type literally forbids it

**Measurement.** `src/sessions/library.ts:61` declares `historyCopied: false` as a **literal type**, not a value; `src/sessions/session-fork.ts:136` sets the literal. `grep -rn "carryContext|forkWithRoute|context.transferred" src/` returns nothing. No code path can ever set it true. This is the mechanism under "Fork to continue": the product cannot move a thread onto a different model even in principle.

**Related, same root, also open:** `#sessions` computes exactly why a conversation cannot continue (five stacked mismatch rows, all one cause: reconnect the pinned provider/model) and offers no control that reconnects. `grep -c 'Reconnect\|#access' src/ui/sessions-view.tsx` → **0**. The only enabled action is `Fork to continue` (`sessions-view.tsx:1172`), which the same panel defines as "new identity · empty transcript."

**Designed fix.** Written out in full at `docs/design-review/journey-complaints.md:803-812`, with exact copy: header `CANNOT CONTINUE HERE — this tab is on the local demo model; this conversation is pinned to Chutes · zai-org/GLM-5.2-TEE.`; full-width 44px primary `Reconnect Chutes · GLM-5.2-TEE and continue`, deep-linking to `#access` with lane/method/model preselected and returning to the session on Finish; secondary `Fork to a clean session on the local demo model`; and a closed-at-rest disclosure `▸ 5 pinned values differ` expanding to a pinned/active table.

**Source.** `docs/gap-audit/inference.md` #2; `docs/design-review/journey-complaints.md:803-812`. Reached independently by two lanes (journey capture and inference gap audit).

**Blind-fix risk — acute, and this one is time-sensitive.** Widening the `historyCopied` literal to `boolean` is the trivially wrong move: the literal is *load-bearing honesty*. It is what makes six user-facing strings true (`sessions-view.tsx:606/:1172/:1283`, `sessions-presentation.ts:380/:434`, `vault-view.tsx:380`). Widening the type without building a transfer path lets the field be set true while no history moves — converting an honest limitation into a false claim on the one surface the product uses to describe itself. **Build the transfer and its receipt first; the type follows.** Separately: `732095e` and `3ea40cf` just landed on this journey, narrowing which pin differences force a fork (`domain.ts:1140-1157` — a theme change no longer counts). A second independent fix to `requiresFork` will conflict, and worse, the two approaches can cancel: if drift stops being *reported*, the Reconnect affordance has nothing to trigger on and reads as dead.

---

### 1.5 Clicking a conversation in All conversations still does not open it

**Measurement.** `src/ui/sessions-view.tsx:779` — `onClick={() => setSelectedId(item.id)}`, selection only. Double-click was added at `:782` and Enter-when-already-selected at `:785-789`; **neither exists on touch.** The row's `title` at `:778` says "Double-click to open." Note this is a *different surface* from the sidebar rail, which was fixed at `395c12a` (`rail.tsx:810 onClick={session.open}`) — the rail half landing while this stayed is independent confirmation the two are separate.

**Source.** `docs/audit/JOURNEY_ATLAS.md:184, :786` (J024) — measured in the journey capture across three attempts, then re-hit by the owner.

**Blind-fix risk.** Do not repurpose `onClick`. The row is a `<button>` carrying `aria-current`, an Alt+Arrow favourite-reorder keyboard contract, and an aria-label encoding selection state; making click open removes the ability to *select without opening*, which the detail panel (fork, rename, resume, the fork requirement) depends on. Add a separate open affordance that works on touch, and change the `title` string in the same commit or the row documents a gesture the user does not have.

---

### 1.6 A `/help` turn scrolls the transcript sideways by 57px at 320px

**Measurement.** `.transcript` reports 57px of `scrollWidth` over `clientWidth` on the `/help` turn at 320px. It is *not* the message label — zero elements inside any `.message-label` extend past their column. It is a `<p>` with `white-space: pre-wrap` holding `/deactivate-execution-runtime <runtime> | /deactivate…`, overflowing by 85px. `main.main` and the document both measure 0 because `.transcript` absorbs it, so `e2e/narrow-viewport-overflow`'s route loop stays green and structurally cannot see it.

**Tree.** `src/ui/chat.css:976-982` — `.message-body p` has no `overflow-wrap`. The property is used **11 times elsewhere in the same file** (`:507, :585, :1269, :2230, :2356, :2405, :2433, :2447, :2477, :2503, :2528`), so this is a specific omission, not house style.

**Designed fix.** `overflow-wrap: anywhere` on `.message-body p`, and widen `e2e/narrow-viewport-overflow`'s assertion from `main.main` to `.transcript` so the absorber stops hiding the whole class.

**Source.** `wf_223f0d7d-987/journal.jsonl` (left_open) — measured in a browser by the agent that had just fixed the adjacent overflow, reported *against their own green result*.

**Blind-fix risk.** `overflow-wrap: anywhere` differs from `break-word` in that it participates in min-content sizing — it changes how **every** transcript paragraph contributes to flex/grid intrinsic sizing, not just the overflowing one. Combined with the `white-space: pre-wrap` already on this rule, ordinary prose can start breaking mid-word at comfortable widths. That is why the original implementer scoped their spec to `.message-label` and left this: it is a typography decision, not a bug fix. Try `break-word` first and measure at 320/390/768.

---

### 1.7 The conversation title collapses to one or two characters

**Measurement.** On a connected phone the session bar renders the title as a literal `]` — the box has collapsed to roughly one character and what survives is the last glyph of the truncated string. Desktop rail hover-peek is a 268px overlay covering 208px of the route bar, clipping the title to `ion`. In landscape (932×430) the title is dropped entirely while it survives at 430×932. Independently reproduced during the `395c12a` repair: collapsed rail 60px, rows 67.4px starting at x=13, title `clientWidth: 29` against `scrollWidth: 132`.

**Tree.** `src/ui/chat.css:101-109` — `.session-bar__title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`. `min-width: 0` explicitly permits collapse to zero when sibling chips crowd the grid track. No floor, and no shed order anywhere in the file (`.session-bar__chips` at `:112-118` also carries `min-width: 0`).

**Designed fix.** Give `.session-bar__title` a character-unit floor — the review's neighbouring fix used `width: 18ch` sized to the longest label at `chat.css:1803-1814`, same technique — and define an explicit shed order for `.session-bar__chips` so chips drop before the title. Assert ≥8 visible characters at 390×932 connected and at 932×430.

**Source.** `docs/design-review/journey-complaints.md:221-224` and `:203-205`; `docs/design-review/visual-critique.md:519`. Three independent measurements of one cause.

**Blind-fix risk.** *Removing* `min-width: 0` is the obvious move and is wrong — it is what lets `text-overflow: ellipsis` work inside a flex/grid track at all; delete it and the title stops truncating and pushes the chips off-screen instead. Add `min-width: 8ch` **alongside** it. Also `.session-bar__title` has a scrolled-state override at `:367` and a density override at `tokens.css:446`, so a `ch` floor changes size in three states.

---

### 1.8 The phone type scale is the desktop scale verbatim; the trust vocabulary renders under the 12px floor

**Measurement.** Computed `:root` at 360, 430 and 1440 is byte-identical. The only responsive typographic change is *downward*: conversation title 21.25px desktop → 17.85px phone against 15.94px body — a **1.12:1** title-to-body ratio on phone versus 1.54:1 on desktop, i.e. no scannable hierarchy at all. `--fs-micro` resolves to ~11.7px and carries "SESSION MODEL", "Ephemeral · this page only", message author labels, "Ask First" and the composer's trust caption. `.mobile-nav__tab` (`routes.css:2717`) sits on it.

**Tree.** `src/ui/tokens.css:459`'s phone block (`max-width: 640px`, plus a landscape clause) overrides only `--density-control`, `--density-row` and `--lh-body`, with its own comment at `:462-464` saying "Tighten the body rhythm only — the reading size itself is untouched." `--fs-body` is declared exactly once, at `:136`. No `--fs-*` token is overridden at any breakpoint.

**Designed fix.** At ≤640px: `--fs-display: 24px/1.2`, `--fs-lead: 19px`, `--fs-body: 16px/1.55`, `--fs-meta: 13px`, `--fs-micro: 12px` as an absolute floor, `.mobile-nav__tab: 12px`. Moves title:body from 1.12:1 to 1.5:1 and puts every label at or above 12px. At 360px cap the body measure at 38–42 characters by trimming bubble padding 16px→12px rather than shrinking type. **No string changes.**

**Source.** `docs/design-review/journey-complaints.md:96-102`; independently from the token-census side at `docs/design-review/visual-critique.md:302` (76% of all type-token uses are the two smallest steps).

**Blind-fix risk.** Every step is `calc(<rem> * var(--type-scale))` and `tokens.css:130-132` records why: "No px-literal clamp() anywhere — `--type-scale` must be able to move the largest text in the product (WCAG 1.4.4)." Writing the designed values as px literals breaks user text scaling and the accessibility guarantee — express them as rem multiples. And do **not** reach for bumping `--type-scale` inside the media query instead: it multiplies all eight steps globally and composes *multiplicatively* with the user's own `data-type-scale` preference (`x-large` = 1.25). The narrow fix — move `.mobile-nav__tab` off `--fs-micro` — is almost certainly right on its own. Run `src/ui/type-floor.test.ts` and `src/ui/density-contract.test.ts`.

---

### 1.9 Native `window.confirm` still guards four destructive actions, and the contract test is deliberately rigged so a half-fix fails

**Measurement.** `src/ui/app.tsx:4036` (profile-draft discard), `:12801` (profile removal), `:12851` (dirty profile-card switch); `src/ui/platform-overlays.tsx:204` (preference reset). `src/ui/confirm-dialog.tsx` exists and is adopted by terminal-view, vault-view, sessions-view, sources-view and workspace-view. `src/ui/destructive-confirm-contract.test.ts:20-25` freezes `NATIVE_CONFIRM_HOLDOUTS = ["app.tsx", "platform-overlays.tsx"]` and `:42` asserts the offender list **equals** it.

**Designed fix.** Adopt `ConfirmDialog` at all four sites and delete the corresponding holdout entries **in the same commit**.

**Source.** `wf_55e920d9-4b7/journal.jsonl` (coh-05) and `wf_4b52d8c4-84a` → `docs/gap-audit/ui.md` #8. Two independent lanes four days apart; the implementer who could not fix it wrote the equality assertion rather than a permissive one, so the debt is machine-enforced.

**Blind-fix risk — three traps.** (1) The assertion is **equality**: fixing app.tsx's three sites without deleting its holdout line turns the suite red even though you improved things. Fix a whole file at a time and delete exactly that file's entry — this is deliberate, per the comment at `:15-18`. (2) `src/ui/platform-shell.test.ts:255` separately asserts the *literal source string* `window.confirm("Reset display, durability, and legacy approval preferences to their defaults?")` appears — that assertion must be rewritten in the same commit. (3) `app.tsx:4036` and `:12851` are **synchronous** guards inside navigation decisions (`const allowed = !dirty || window.confirm(...)`; an inline `onClick` guard). `ConfirmDialog` is async — the control flow must be inverted into a continuation, not the call swapped. Only `:12801` is a straight replacement.

---

### 1.10 Receipt and attestation chips have no accessible name of their own and swallow the whole explanatory essay

**Measurement.** `src/ui/app.tsx:12508` renders `<button class="receipt-chip" type="button" onClick={onProof}>` with **no `aria-label`**, so its accessible name is computed from children: the Seal's `aria-label` — built at `src/ui/seal.tsx:84` as `${label}. ${detail}` where detail is the full `receiptSummary(...)` sentence — immediately followed by the bare `<span>{receiptId.slice(-8)}</span>` with **no separator**. The prose the original complaint objected to is now *inside* the button's name rather than beside it. Same shape on the attestation chip at `:12521`.

**Designed fix.** Explicit `aria-label` on both chip buttons ("Receipt c43f0a78, encrypted, opens Proof"); move the prose to `aria-describedby` pointing at a visually-hidden node holding `receiptSummary(...)`; `aria-hidden` the Seal **at this call site only**.

**Source.** `wf_4b52d8c4-84a/journal.jsonl` and the same workflow's §2 item 4 (recovered twice — one piece of work, two records). Re-verified line-by-line by a pass that killed ~35 siblings as FALSE_POSITIVE.

**Blind-fix risk.** Do **not** add `aria-hidden` inside `seal.tsx` — `:94-95` gives it `role="img"` and Seal is used standalone elsewhere where that computed name is the only text. Do **not** delete `title={detail}` at `seal.tsx:93` — that is the sighted hover affordance the same finding asked to keep. The sibling half (no model on the answer) **is** already fixed: a `.message-model` span renders `message.receipt.model`.

---

### 1.11 Three search fields have no clear affordance, and the CSS-only fix would delete the only one they have

**Measurement.** `search-field__clear` exists at `memory-view.tsx:836` and `context-view.tsx:383`. Still missing on `sessions-view.tsx:652`, `model-picker.tsx:228`, `workspace-view.tsx:1702` — all `type="search"`. `workspace-view`'s `clearFilter()` exists but is bound only to Escape, so a pointer or thumb has no affordance at all.

**Designed fix.** Per field: wrap the input in `<span class="search-field__entry">`, add `class="search-field"` to its row, render `<button class="search-field__clear" aria-label="Clear …">`. `src/ui/search-field.css` already exists — three lines each.

**Source.** `wf_55e920d9-4b7/agent-a3317fc2362e02ec6.jsonl` (declined coh-10) and `wf_23b56318-636/agent-a464fd2d63032fc63.jsonl`.

**Blind-fix risk — recorded by the second implementer specifically.** Lifting `::-webkit-search-cancel-button { display: none }` out of `memory-view.css` and applying it globally would **delete the native cross from the three fields that have nothing else** — a capability erasure disguised as a consistency fix. `model-picker` is a sheet on a phone where the native cross is the entire affordance; do not strip it there before the button lands. And the workspace button must call the existing `clearFilter()`, not introduce a second clearing path.

---

### 1.12 The Proof journal panel's code column paints over the message — desktop only

**Measurement.** `WARNING SESSION_TITLE_SNAPSHOT_MISMATCHreation event title differs from the session record.` The 31-character monospace code needs ~205px in a 150px grid track. `src/ui/routes.css:660-664` — `.audit-findings article { grid-template-columns: 48px 150px minmax(0, 1fr); }` with the mono code at `:672-673`, rendered by `proof-view.tsx:482`. This is the one audit finding the panel exists to show.

**Correction to the recovered claim.** The phone case is **already fixed** — `routes.css:3580-3586`, inside the media query opened at `:2523`, overrides to `48px minmax(0,1fr)` with the message at `grid-column: 1 / -1`. The defect is desktop-only.

**Designed fix.** Collapse the base rule to `grid-template-columns: minmax(0,1fr); gap: 4px`, severity as a small coloured pill inline before the code, code on its own line with `overflow-wrap: anywhere; font-variant-ligatures: none`, message below. Keep the 260px scroller at `:655-658`.

**Source.** `docs/design-review/screen-reviews.md:943-951` — part (a). Part (b) of the same finding *was* implemented, with a comment in `attestations-view.tsx` naming the defect it fixed.

**Blind-fix risk.** If you collapse the base rule, the phone override at `:3580` becomes a live two-column declaration that **re-introduces** the bug on phones — delete or update it in the same commit. The severity cell is styled by attribute at `:682` with uppercase transform at `:677-680`; turning it into an inline pill means moving those rules too.

---

### 1.13 The model picker fetches logos from a third-party host on every render

**Measurement.** `src/ui/model-picker.tsx:136` — `<img class="model-logo-img" src={`https://logos.chutes.ai/logos/${model.logoId}.webp`} alt="" />`. Host still in `img-src` in `index.html:19` and `public/_headers:2`.

**Designed fix.** Inline as `data:` URIs or self-host under the app origin, or gate behind an explicit toggle; then drop `logos.chutes.ai` from `img-src` in both files.

**Source.** `wf_2f8e9abd-63a/journal.jsonl` — reported by the agent who *built* the egress ledger and preflight, i.e. someone with every incentive to claim the surface clean, who instead named the one request they could not remove and pinned it with a test.

**Blind-fix risk.** The host is load-bearing for five test assertions across `egress-preflight.test.ts` and `egress-record.test.ts` — including `:300-306`, which uses it as the fixture for "4 requests · 3 hosts". Removing the fetch without rewriting those fixtures turns the egress ledger's own regression tests red, and someone under time pressure will "fix" them by deleting the assertions, destroying the disclosure guarantee this finding exists to protect. **Rewrite the fixtures to a different third-party host first.**

---

### 1.14 The Retry status line still calls the branch "Clean"

**Measurement.** `src/ui/app.tsx:5645` — `setRuntimeStatus("Clean retry branch ready · regeneration queued")`. The retry path forks at `message.turnStartPoint` and seals a bounded, digest-sealed ancestor-context seed, so the bare word "Clean" reinforces the blank-slate reading three remediation passes were opened to remove. **Every sibling is fixed and actively guarded** — `sessions-view.test.ts:141` asserts `not.toContain("clean fork")`, `chat/fork-notice.test.ts:84` asserts the tooltip does not match `/clean fork|empty transcript|blank/iu`, and `chat/fork-notice.ts:33` already carries correct wording.

**Designed fix.** `setRuntimeStatus(FORK_NOTICE.retry)`, or match its qualification ("without the prior answer in provider context").

**Source.** `wf_cc794805-7a4/journal.jsonl` (declined on file ownership, never on merit) and `wf_c5da82ab-ae9` residual.

**Blind-fix risk.** The two contract tests pin the *other* files' strings and will stay green whatever you do here — there is no test that catches a regression at `app.tsx:5645`. Add it to `fork-notice.test.ts`'s assertion in the same commit. Do **not** also "fix" `FERRARI_AUDIT.md:75/:196` or `ADVERSARIAL_SYSTEM_REVIEW.md:119`; two independent workers each argued those are dated historical records.

---

### 1.15 The Context surface prints the encrypted envelope as a binary file's size (~33% too large)

**Measurement.** `src/ui/context-view.tsx:716` and `:727` render `formatBytes(candidate.size)`, fed from `src/indexing/client-context-engine.ts:705` `size: entry.size` — the raw manifest entry, i.e. the base64/AES-GCM envelope. The indexer admits binaries as candidates, so a PNG reads ~33% large and the indexed/total byte statistics over-count. **The Workspace half of the identical defect was fixed** — `workspace-view.tsx` routes through `workspaceEntryByteLength(...)` with a comment at `:1968-1970` stating "a binary buffer's size is its base64 encoding and reads one third large."

**Source.** `wf_cc794805-7a4/journal.jsonl` — two independent workers, separate batches, second re-derived the first's reasoning; both declined only on file ownership.

**Blind-fix risk.** Do not just call `workspaceEntryByteLength(entry)` at `client-context-engine.ts:705` — Context candidates come from a manifest *listing*, not a read `WorkspaceFile`, so the decoded length may not be available there without a read. The engine *does* examine the bytes (binaries only become `unsupported` after inspection), so thread the length forward from that point. The indexed/total statistics will move when this lands — that is correct, not a regression.

---

### 1.16 The mobile More sheet gives Preferences the model glyph

**Measurement.** `src/ui/mobile-navigation.tsx` renders `<Icon name="model" size={21} />` above `<small>Preferences</small>` in the `entry.kind === "overlay"` branch. The `settings` gear was added to the icon map *for this exact fix* and is registered at `src/ui/icons.tsx:17` and `:53`. The desktop half of the collision was fixed; this is a one-token change deferred solely on batch ownership.

**Designed fix.** `name="model"` → `name="settings"`. Nothing else.

**Source.** `wf_23b56318-636/journal.jsonl` (`ds-14-mobile-parity`), originally `wf_55e920d9-4b7` `ds-14`. The original finding's whole point: fixing one surface leaves "two surfaces disagreeing, which is the defect, not the fix."

**Blind-fix risk.** Essentially none — the gear is already in the icon union so this cannot break typing. Only check that no visual snapshot pins the glyph.

---

### 1.17 Terminal scrollback and shell history are unrecoverable, with no export anywhere on the route

**Measurement.** After reload the pane shows only the prompt and the footer reads "Input history · 0". The route's own text says "Reload loses them; processes also end." `grep -n "Export|download|Copy scrollback|copyScrollback" src/ui/terminal-view.tsx` → only prose and config: `:768` ("One tap on × killed the shell, its scrollback and its input history"), `:809 scrollback: 5_000`, `:1014-1015` close copy. No control.

**Source.** `docs/audit/JOURNEY_ATLAS.md` J122 (index-only — measured, evidenced, never narrated into a fix).

**Blind-fix risk.** xterm's scrollback is capped at 5,000 lines, so an "export scrollback" button exports a truncated view and will be read as complete — say what it captured. And the close-confirmation copy at `:1014-1015` currently promises that closing removes scrollback and history; adding export changes what closing means, so both strings must move together or the product contradicts itself on one screen.

---

### 1.18 Files skipped by ignore rules during repository seeding are "announced" only to `console.warn`

**Measurement.** `src/git/workspace-adapter.ts:1062-1065` asserts "the omission is announced instead of being inferred from an empty status." `:1068` computes `ignored`; its **only** consumer is a `console.warn` at `:1069-1072`, truncating at 20 paths. The `RepositoryRecord` has no field for it and `git.commit` runs two lines later. "Announced" is true only for a developer with a console open; the user sees an empty Source Control status they cannot explain.

**Designed fix.** Add `ignoredAtSeed: readonly string[]` to the seed path's return value and surface it once beside the empty status. Or — the cheap correct alternative — change one word in the comment from "announced" to "logged."

**Source.** `wf_4b52d8c4-84a/journal.jsonl` → `docs/gap-audit/remediation/git-verbs.md` #7. Six of that package's nine findings were fixed; this is the one that was not. The overstated sentence *was* removed from `docs/BROWSER_GIT.md` — the doc was corrected and the code was not.

**Blind-fix risk.** Do not remove the ignore matching or force-add the paths — a seeded `.gitignore` legitimately excludes seeded files, and `git_change` already has a `force` member for the case where a user wants that. The warn truncates at 20 for a reason; an unbounded UI list can be seeded with thousands. `.git/info/exclude` is written at `:1076` **only** when `root === "/workspace"`, so the ignored set differs by repository root and one global surface will be wrong for other repos. Add the field to the *seed path's return value*, not to the deep-frozen shared `RepositoryRecord` type.

---

### 1.19 Long sessions grow heap and retained DOM without bound, and no test in the repo would catch it

**Measurement.** Across 180 turns: `JSHeapUsedSize` after three forced GCs went **150.1 MB → 818.2 MB**; retained-minus-live DOM nodes went **2,021 → 20,743** with live nodes frozen at 874. A separate 24-turn probe measured the rate: **~54 nodes and ~9.7 listeners per turn**, projecting ~27,000 nodes and ~4,900 listeners at 500 turns. Main-thread longtask time per turn nearly doubles (172ms → 296ms at 4× throttle). **Turn latency stayed flat the whole time** (p50 1,557ms, p99 1,595ms) — nothing in the product's own instrumentation would ever signal it; the tab just dies.

**Tree.** `ls e2e/*.spec.ts | wc -l` → 62; `ls e2e/ | grep -iE 'perf|memor|leak|longtask|heap'` → **nothing**. The finding recorded 51 specs and 0 matching; the suite grew by 11 and still has zero.

**Source.** `docs/audit/JOURNEY_ATLAS.md` J117, J118, J126 — three index-only findings, three independent probes, reproduced across two bundle hashes.

**Blind-fix risk.** The measurement *is* the finding: any gate built on latency or the product's own instrumentation is permanently green while the tab dies. It must read `JSHeapUsedSize` and retained-vs-live node counts via CDP after forced GC — not something Playwright does by default. Pin **growth per turn**, not absolute heap, or it flakes on CI hardware. And 180 turns is far too slow for the main suite; this belongs in a separate config or it will be the thing someone deletes to make CI fast.

---

## 2. Agent capability

**The safety question is often already answered.** `src/approvals/modes.ts` resolves Ask First / Auto Approve / Full Access per *effect*, and `src/approvals/broker.ts` + `consequence.ts` derive a stated consequence for mutating operations. A new tool that declares an effect routes through the existing broker for free — which makes several of these much cheaper than they look. **The exception, and it matters:** `consequence.ts` maps read-shaped operations to `null`, and `modes.ts:50-57` returns `"allow"` for `tool.effect === "read"` *above every mode branch*. So a capability declared read-shaped (a web search, a sub-agent that only reads) is auto-approvable **by construction** and gets no consequence derived. Classify the effect deliberately before wiring, or the broker will wave it through.

### 2.1 No sub-agent primitive — "the largest structural ceiling"

`grep -rn 'run_subagent|subagent|spawn_agent|delegate' src/tools/` → **zero**. Every task competes for one context window and one step budget. Three independent ledgers list it unbuilt: `docs/gap-audit/tool.md` #3, `docs/BUILD_PLAN_2026-07-25.md:439` (W23), and `docs/architecture/AGENT_CAPABILITY_PARITY_2026-08-04.md` NOT BUILT #4, which ranks it first by ceiling raise.

**Blind-fix risk.** Do not build it as "a tool that calls `runTurn`." It needs a step budget separate from the parent's 32-step bound; an approval story (`ToolRegistry` has **no `subset`**, so a child inherits the parent's full authority); a journal story (does a sub-agent turn appear in the parent's event stream, and what does that do to the request digest §1.3 already breaks?); and a cancellation story. **Design authority narrowing before the primitive.**

### 2.2 Oversized tool results discard the tail — both halves of the fix already exist

`src/core/agent.ts:588` bounds via `boundToolResultContent` (`:886`) and truncates. There is no spill target: the only OPFS references near this path are `src/tools/live-environment.ts:165-167`, which merely *report* OPFS as a capability. The `read_file` windowing half **did** land (`MAX_READ_FILE_BYTES` with offset/limit in `workspace-tools.ts`). Estimated **two days** to connect them: spill the overflow to OPFS and hand the model a windowed handle on the same offset/limit contract.

**Source.** Parity survey structural gap #3, `fa3c4bea….jsonl:1950`.

**Blind-fix risk.** `boundToolResultContent`'s output is what the journal records and what the request digest is computed over. Spilling changes what the model receives, so it changes the digest — same seam as §1.3. Land the audit fix first, or ship behind a flag and prove `auditSessionHistory` still agrees. Related constraint from FANOUT-PLAN #11: do not put the window notice at the *tail* of `content` — `boundToolResultContent` truncates the tail, and the notice is the only carrier of `nextOffsetBytes` since `metadata` never reaches the model (`agent.ts:936-938`).

### 2.3 `declareModelMetadata` has no caller — an operator can never declare a context window, so compression stays silently unavailable

`grep -rn declareModelMetadata src/ | grep -v test` → **exactly one line**: the definition at `src/inference/fabric.ts:458`. Zero `.tsx` references. Consequences, all live: no operator can declare a window for a cloud model; nothing in `src/ui` states that context compression is unavailable when `contextPolicy === undefined` (`grep -rn "context compression|no context window" src/ui` → nothing); and `InferenceModelPromptDefinition` (`src/core/operating-charter.ts:42-46`) is still `{id, inputModalities?, features?}`, so **the model is never told its own context window** — the `ctx=` facet exists only in `renderInferenceAvailabilityForPrompt`, which is referenced solely from a test.

**Designed fix (three edits, one commit).** Field pair on the model row in `provider-connections-view.tsx` calling `fabric.declareModelMetadata`; branch `contextPolicyForProviderModel` on `model.source.kind`; add `contextWindowTokens?/maxOutputTokens?` to the prompt definition and append facets on the **live** path (`inferenceDirectoryFromAvailability` → `composeAirshipOperatingPrompt`).

**Source.** `wf_4b52d8c4-84a/journal.jsonl` §2 items 15/16/17 and `docs/gap-audit/inference.md` #1/#3.

**Blind-fix risk — this is the dangerous one.** `declareModelMetadata` stamps `source: {kind:"manual"}`, but `contextPolicyForProviderModel` **ignores `model.source`** and stamps `{kind:"provider-catalog", field:"contextTokens"}` unconditionally. Wiring only the UI makes every session manifest assert that a provider directory published a number a human typed — false provenance in an immutable record, strictly worse than not being able to type it. `canonicalContextWindowSource` (`src/core/context-policy.ts:173-182`) already accepts a `runtime-config` variant; extend the vocabulary in the same change or `session-audit.ts:1389` raises `INFERENCE_REQUEST_METADATA_INVALID`. Separately: do **not** route the numbers through `promptFacet` — `operating-charter.ts:149-155` constrains facets to `^[a-z0-9][a-z0-9._+-]{0,63}$` and **throws inside the immutable-prompt path**, so a bad value yields a session that cannot be created. And key the "unavailable" message off the *resolved* `contextPolicy`, never off provider id: `docs/PROVIDER_FABRIC.md:23` invariant 5, `agent.ts:167-168` and `context-policy.ts:12` all forbid a model-family capability table.

### 2.4 `git_remote` offers only clone/fetch; push and worktree verbs are withheld from the model while available to the human

`src/tools/git-tools.ts:197` — `enum: ["clone", "fetch"]`. No `git_push`. Worktree create/remove absent from `git_change`'s enum (`:76`) although `createWorktree`/`removeWorktree` exist at `encrypted-workspace-adapter.ts:329/:333` and `memory-adapter.ts:341/:367` and are reachable from the terminal bridge. `src/git/types.ts:3-20` `GIT_CAPABILITIES` **does** list `push` and `worktree`, so only the tool surface withholds them. Also absent entirely: rebase, cherry-pick, revert — `terminal-commands.ts:828` says so out loud.

**Naming correction the inventory got wrong:** the remote-management verbs live in a fourth tool, `git_configure` (`:242`, enum `[add_remote, set_remote_url, remove_remote, create_tag, delete_tag]`), **not** `git_change`. Worktree lifecycle belongs in `git_change` (effect: write, carries `worktreeId`/`expectedWorktreeVersion`), not `git_configure`.

**Blind-fix risk.** `remoteFeature("push", permittedOrigins)` is **one flag for the whole build**, but the decision governing a push is **per-remote** (`sources-view.tsx:148-150` says so). Wire the per-remote check or the model pushes to an origin no human reviewed. `push` is also the first git tool with a write effect that leaves the device — classify it correctly or `modes.ts:50` auto-approves it. `removeWorktree` shares one object/ref database with its siblings, so a model-driven remove can destroy refs another worktree depends on.

### 2.5 WASI: no stdin, one preopen, a spin-loop sleep, and a 10s ceiling against WebContainer's 120s

Four bounded fixes, and **the sequencing is the whole point.**

- **(d) Spin loop.** `src/execution/wasi-preview1-worker.ts:82-83` passes `wasi.wasiImport` through unwrapped to both import names; `package.json:50` pins `@bjorn3/browser_wasi_shim` at `0.4.2`, whose `poll_oneoff` is `while(endTime>getNow()){}`. Any guest `sleep()` pegs a core. **Fix:** wrap the import object — `{...wasi.wasiImport, poll_oneoff: ourClockPoll}` — using `Atomics.wait`.
- **(a) stdin.** `:65` builds fd 0 as `new OpenFile(new File([]))`; `grep -n stdin` returns **zero** in `wasi-preview1-worker.ts`, `runtime-registry.ts` and `wasi-preview1-contract.ts`. **Fix:** optional bounded `stdin?: Uint8Array` threaded through the RunMessage.
- **(b) One preopen.** `:59` `new PreopenDirectory(".", root.contents)` is the only directory fd. **Fix:** add `PreopenDirectory("/tmp", new Map())`, excluded from `collectFiles(preopen.dir)`.
- **(c) Timeout asymmetry.** `execution-tools.ts:79/:126/:224` all `maximum: 10_000`; `:318` `maximum: 120_000`.

**Source.** `docs/gap-audit/shell.md` #3/#8/#9/#10, all re-verified 2026-08-03 by a pass that marked 35 sibling claims FALSE_POSITIVE — these four were not among them.

**Blind-fix risk.** **(c) must come after (d)** — raising the ceiling while `poll_oneoff` spins converts a bounded 10-second core-peg into a two-minute one. The 10s cap is currently the *only* thing bounding the spin. `Atomics.wait` needs cross-origin isolation, which `docs/audit/JOURNEY_CLOSEOUT.md:167-170` records as supplied **only by Playwright's own server** — so the obvious fix works perfectly in the harness and silently spins in deployment; detect and degrade with a named reason. A blanket timeout bump is not symmetric: `runtime-registry.ts:96-99` names an `abort-interpreter` cancellation class precisely because Pyodide cannot be interrupted mid-statement — raise WASI first, Pyodide last or not at all. stdin needs its own ceiling in `wasi-preview1-contract.ts` (that worker re-validates every payload on the principle that "a Worker must never trust an unbounded structured-clone payload"), and **Pyodide's stdin is deliberately *closed*, not empty** (`setStdin({ stdin: () => null })`) — a shared field without changing that line ships an argument silently discarded. Adding a preopen shifts fd numbering (the table is positional; preopen is currently fd 3), and without the `collectFiles` exclusion scratch files sweep into the workspace change list — where, because `files` stays *absent* rather than empty on failure, a scratch-inflated collection that trips the mount budget reports a successful run as a workspace error. Note `src/execution/shell/interpreter.ts:29` already models stdin correctly as `ByteReader` — reuse that shape.

### 2.6 No `web_search`, no MCP, no cost accounting

`grep -rn 'web_search|webSearch' src/tools/` → nothing. `grep -rli 'mcp' src/` → nothing. `ls src/billing/` → `client.ts`, `honesty.ts` only — the Chutes account surface, not per-turn cost. Recorded unbuilt in three ledgers each. `docs/architecture/AGENT_CAPABILITY_PARITY_2026-08-04.md` carries a ranked build list with effort estimates and the files each builds on.

**Adjacent, one-line, independently fixable today:** `src/tools/network-tools.ts:51` blames the remote — "The site may be offline or may not grant Airship CORS access" — for what can equally be Airship's own CSP refusal, because `safeHttpUrl` (`:201`) checks only parseability, scheme and embedded credentials, never the `connect-src` allowlist. **Fix:** reject off-allowlist origins *before* the fetch with a message naming Airship's own policy.

**Blind-fix risk.** Do not implement the allowlist check as a CORS probe — CSP and CORS refusals are indistinguishable at the catch site, so a probe burns a network turn learning something knowable statically. The allowlist lives in **two** places that must not drift (`index.html:19`, `public/_headers:2`, both dirty right now under a concurrent workflow); derive it or add a contract test, do not hardcode a third copy. And it includes twelve loopback origins for local models — a naive check that forgets those breaks local-provider probing. For the honest string: the failure genuinely *can* be either, so swapping one confident wrong attribution for another is not a fix; name both and say which the browser reported.

### 2.7 `GitSynchronizedWorkspace.readBounded` bounds nothing

`src/tools/git-synchronized-workspace.ts:18-21` — `this.workspace.readBounded ? this.workspace.readBounded(path, maxBytes) : this.workspace.read(path)`. The fallback discards `maxBytes` entirely. The presence of the method is not a bound. This was load-bearing for the `read_file` windowing design, which slices bytes at the tool *because this delegation could not be trusted*.

**Blind-fix risk — the fix is four times larger than the claim suggests.** The optionality is declared once, at `src/workspace/contracts.ts:42`, and the same silently-unbounded fallback repeats at **four more sites** the finding never names: `src/workspace/profile-scope.ts:64-66`, `src/execution/node-webcontainer-adapter.ts:373`, `src/terminal/workspace-sync.ts:41`, `src/ui/app.tsx:11673`. Making the method required forces every `WorkspacePort` to grow a real bounded read at once; fixing only this file leaves four unbounded paths including the WebContainer mount. And **at least one consumer depends on the current behaviour**: `src/attestation/workspace-endpoint-evidence-persistence.ts:121` calls `readBounded(path, MAX + 1)` and treats `file.size > MAX` as rejection — a `+1` sentinel that only works if the read *does not* stop. Changing the fallback to slice would break it.

### 2.8 Composer attachments are image-only

`src/ui/app.tsx:10307` — the composer's only file input is `accept="image/*"` with `aria-label="Attach image"`; `:5563` filters to `file.type.startsWith("image/")`. Directive CMP-02 asked for text, Markdown, PDF and code, with **image** being the type gated on a vision-capable model. The vision gate was built (`:5940-5949`); the widening never was.

**Source.** `8164e732….jsonl:1517` — self-reported as unfixed by the agent that closed the surrounding directives in the same pass.

**Blind-fix risk.** Keep the `imageInputCapability !== "supported"` refusal scoped to images; if the widened input reuses it for all attachments, a text-only model loses the ability to accept a Markdown file it could always have read. And `:5563` currently *discards* non-images silently, so widening `accept` without changing it produces a picker that accepts a PDF and drops it with no message.

### 2.9 The prompt manifest never declares a negative capability boundary

`src/core/operating-charter.ts:75-84` composes exactly three capability sections — installed tools, browser capabilities, inference directory — all positive. Nothing tells the model what Airship *cannot* do, which is what produces confident attempts at unreachable things.

**Blind-fix risk.** Derive it from resolved runtime state, never a hardcoded list, or it becomes a stale capability table that lies in the other direction — and a wrong "cannot" is worse than a missing one, because the model refuses things that work. `inferenceDirectorySection` throws when the roster exceeds 16; the charter has hard prompt-size discipline, so an unbounded negative section pushes real instructions out of context.

### 2.10 The Memory relationship graph contributes nothing to what the model sees

`grep -rln 'memory-graph|memoryGraph' src/retrieval/ src/core/ src/tools/` → **zero files**. The graph is built, rendered and tested, and referenced only from `src/deferred-capabilities.ts` and UI modules.

**Blind-fix risk.** Having retrieval import the graph inverts the dependency direction the tree maintains deliberately — `src/memory-graph` is UI-side and lazily loaded (`renderer.tsx:30-33`) to keep 36.9 KB of canvas renderer out of the boot path, and crossing that boundary makes Rollup emit a shared chunk the release gate refuses to classify (FANOUT-PLAN #6). Extract `derive.ts` from the rendering first and let retrieval import only the derivation.

### 2.11 Repository import skips binaries and cannot reach private repositories

`src/tools/repository-import.ts` fetches with `credentials: "omit"`, `redirect: "follow"` and `headers: { Accept: … }` — no Authorization. The *silence* was fixed (`skippedBinary` is computed at `:154` and reported at `:203`); the capability gaps remain.

**Blind-fix risk.** This is not a header addition. `credentials: "omit"` is deliberate, and a GitHub token in a browser fetch lands in page memory and every redirect hop. `CANON.md:1096-1097` lists browser-safe GitHub auth as *planned* precisely because the safe shape is undesigned. Un-skipping binaries interacts with `MAX_SINGLE_FILE_BYTES` and the bounded reader — pair it with a size policy.

---

## 3. Internal quality

### 3.1 The build is not deterministic across checkouts — ranked *ahead of* the app.tsx split by the owner

`src/ui/chat/transcript-operations.ts` is imported from both a boot path (`platform-shell.tsx:17`) and a deferred module (`chat/message-parts-view.tsx:10`), so Rollup emits **a 350 B stub in one clone and a 10.5 KiB chunk in another, from a byte-identical tree**. `release-gate.mjs:66-75` deliberately sizes ceilings for both layouts and says so (171.49 KiB gzip here, 175.56 KiB from a clean clone). Naming the chunk in `vite.config.ts:156` gave it a stable name for *attribution* and did not pin the split — `:150-155` concedes this. **The owner's reasoning for the priority:** while two clean clones produce different artifact graphs, "the thing we deployed" and "the thing we measured" are not provably the same object. *Blind-fix risk:* tightening the ceilings to one layout is exactly what caused the original failure; remove one import edge first, then re-tighten, and update both explanatory comment blocks (`:62-75`, `:312`) or the gate argues for a state that no longer exists. Entangled with 3.2 — `platform-shell.tsx` is the boot-path importer. — `docs/audit/JOURNEY_CLOSEOUT.md:134-165`; `8164e732….jsonl:8012, :8095`

### 3.2 `src/ui/app.tsx` is 13,325 lines / 657 KB and still growing — 642 KB at the 2026-08-03 reconciliation. Composer and SessionBar *were* extracted and it grew anyway. **The causal claim attached to this file was tested and retracted:** the 33 browser-test timeouts were blamed on crossing Babel's 500 KB deopt threshold, and that was disproved by running the same suite against the production build (identical failures). Both federation peers independently advised deferring the refactor while canon was locked; that advice has expired. Codex's rule survives: extract only a seam a concrete fix or test needs, never a broad behaviour-preserving refactor. *Trap:* `chat-layout.test.ts:59` asserts compiled styles do **not** contain `.stage-header`, so the third extraction and that assertion must reconcile in one change. This file being contended is the single most-cited reason for declined work across the entire corpus — nine agents declined a fix solely because someone else held it, and two workflows hold it today. — `devils-advocate.md` WP-0; `wf_4b52d8c4-84a` §3

### 3.3 `docs/CANON.md` is bound to `3f11393` and is now **32 commits behind** (was 28 when the inventory was written; it drifted twice during this pass). `grep -rn CANON scripts/release-gate.mjs .github/workflows/ci.yml package.json` → **0 hits**. The binding is prose. *Designed fix:* a release-gate check parsing the SHA from CANON's header, same shape as the `measured-sha.txt` certification already in `ci.yml`. *Blind-fix risk:* `783bdae` ("the gate measured its own harness and certified the wrong tree") is this repo's own record of getting this wrong — the gate must compare against the CI-provided commit, not anything the tree can influence. And require the *reconciliation date* to move too, or it just automates the lie. — relay `cross_reads/reply_codex.txt` canon plan step 6

### 3.4 `docs/RELEASE_GATE.md`'s budget table is stale in six rows and drifting wider. Doc vs script: entry JS gzip 110 vs 112 KiB; deferred capability 388/113 vs **422/125**; first-party JS 1,768/462 vs **2,057/653**; installed backstop 2,152/643 vs **2,733/841**; vendor aggregate 656/182 vs 677/188; entry CSS 160 vs 171+ KiB. Phantom figures survive: `RELEASE_GATE.md:66` and `EDGE_RUNTIME_CAPABILITY_LADDER.md:174` both cite 224 KiB, `BROWSER_EXECUTION_PACKS.md:504` cites a 226 KiB gate that exists nowhere. The doc at `:52-54` declares itself the mirror that must never drift. *Blind-fix risk:* `parseDocumentedBudgets` (`release-gate.mjs:938-952`) reads `//` lines only — a budget documented with `/** */` parses as empty prose and survives a green gate. Mirror at freeze time; `release-gate.mjs` is dirty right now. — scratchpad `CANON-FULL-REPORT.md:262` (§5.5)

### 3.5 The release-gate budget guard structurally cannot catch a stale-high comment. `assertDocumentedBudgetMeasurements` compares the documented figure to the *ceiling*, never to the artifact the gate measures in the same run — so a budget can be justified by a measurement that no longer exists. `release-gate.mjs:655` already carries a comment admitting it "did not catch it." *Blind-fix risk:* turning on the cross-check reddens the gate for every comment quoting a delta or a historical reading; the parser takes the largest figure per comment and a cross-check must respect that rule. Land it with a re-measure of all five DOCUMENTED budgets in one commit. — `wf_223f0d7d-987/journal.jsonl`

### 3.6 The 44px touch floor exempts three routes and never types a query. `e2e/touch-target-floor.spec.ts:25-38` ROUTES omits `terminal`, `context`, `capabilities`; `screen-reviews.md:16` measured Terminal Interrupt/Restart/Close at 95×30, 80×30, 65×30. Separately the spec never enters a queried state — `grep` shows only `goto` and `querySelectorAll`, no `fill`/`type`/`press` — and **18 controls sit under the floor in queried Memory**, 34px graph-match buttons the sweep cannot reach. *Blind-fix risk:* the spec's header at `:18-21` **forbids an allowlist** ("how a floor becomes a suggestion"), so adding routes plus exceptions is exactly what it was written to prevent. Raise the Terminal controls first — the bar already wraps to three lines at 390px and starts the emulator at y=372 of 632. And FANOUT-PLAN #10: do not assert the floor outside `@media (pointer: coarse)`; `setViewportSize` changes the viewport, not the pointer type. Adding a route to this list has a 100% hit rate for finding real defects — `skills` immediately exposed a 37px `role=switch` and a 38px menu trigger. — `wf_4b52d8c4-84a` §2 item 8; `fa3c4bea….jsonl:1559`

### 3.7 `e2e/browser-worker.spec.ts:55-57` lost its first attempt in **six of six** recorded CI runs, at six different commits over two days, always `page.evaluate: Execution context was destroyed`. The shape is visible: `page.goto("/#chat")` immediately followed by a `page.evaluate` whose first statement dynamically imports a module. Invisible only because `playwright.config.ts` sets `retries: 2` under CI; it costs a full retry of a serial single-worker suite every run. The file has not been touched since 2026-07-27. This was *predicted in advance* not to be fixed by the assertion-budget change, twice, and the prediction held both times. *Blind-fix risk:* do not reach for a timeout — `ad68031` records that `profile-silo` was first "fixed" by raising the budget 5s→15s, which lowered the failure rate enough to look like a fix. Wait for an observable shell condition, then lower retries to prove it. — scratchpad `{ev,c2,c3,c4,mc,pv}/desktop.json`; relay_log.md

### 3.8 Three other flaky specs unaddressed: `account-providers.spec.ts:3` (flaky on all four gate/project combinations), `workspace-terminal.spec.ts:28`, plus browser-worker. `profile-silo` failed 3/3 on integration/desktop from the same tree that had it merely flaky on head/desktop — severe flakiness, not a code difference. *Blind-fix risk:* FANOUT-PLAN #1 — all three profile-silo attempts failed at the **full 15000ms**, i.e. a latched state (`openIndex(false)` setting `indexDismissed`, `memory-view.tsx:729-733`) that no timeout can outwait. Re-run the probe before touching anything; the population was measured five days ago. — relay_log.md probe run 30838072444

### 3.9 No gate checks the Caddyfile against `public/_headers`. The deployment landed (`Caddyfile`, `deploy.sh`, `Dockerfile`, `caddy-entrypoint.sh`, `docker-compose.yaml`, `.env.sample`) and `deploy.sh --verify` compares them directive-by-directive. But `grep -rn 'Caddyfile' scripts/ package.json .github/` → **zero**, and `check-static-security.mjs` reads only `index.html` and `public/_headers`. The Caddyfile's own comment concedes it. So a CSP edit that correctly updates both source files passes every gate while diverging from what the deployed site sends. *Blind-fix risk:* `check-static-security.mjs` already strips frame protection before comparing (`headerWithoutFrameProtection`) because `frame-ancestors` is header-only — a third source must fold into that normalization, not compare naively. This gate is load-bearing beyond CSP: the Caddyfile's COEP/COOP is what supplies cross-origin isolation, which §2.5's `Atomics.wait` fix depends on. Both source files are dirty right now — exactly the window this gate does not cover. — scratchpad `STATIC-SITE-CADDY-DEPLOY.md` trap #2

### 3.10 `pages.yml` runs deploy in an environment named `production`; `actions/deploy-pages` requires `github-pages`. `:71 name: production`, `:190 uses: actions/deploy-pages@v4`, with `:64-70` recording the defect in-file as deliberately unfixed. Pages has **never** deployed from this repo — 14+ runs back to 2026-07-20, every one a `failure` with a 0-step deploy job. The "Actions billing failure" explanation was refuted; plan-gating is the better hypothesis. And no plan upgrade buys the missing control: required environment reviewers are **public-repository-only** on Free, Pro *and* Team. *Blind-fix risk — sequencing:* `main` carried a live `push: branches: [main]` auto-deploy trigger until the merge removed it, so making the job *work* before the plan/visibility question is settled arms a real deploy. And a Caddy self-host path landed since (`c3368d5`, `7eb7f7f`), so the right fix may be "delete the Pages job." Decide that first; a green rename is not a green deploy. — relay `reply_codex.txt` Q2, `reply_claude.txt` Q2

### 3.11 The lab's synthetic Google client ID hijacks the generic Playwright matrix locally. `scripts/local-lab.mjs:59` always injects `VITE_GOOGLE_CLIENT_ID`; `playwright.config.ts:64` sets `reuseExistingServer: true` on 4173. So a lab-owned Vite is adopted by the matrix and `vault-provider-switch.spec.ts` fails on a premise the harness broke. **CI was fixed** (`lab:storage` at `ci.yml:226`); the local path is unchanged and `grep -rn VITE_GOOGLE_CLIENT_ID e2e/` returns zero — no test-side guard. Prose warnings exist in three files, but prose is not a gate. *Blind-fix risk:* `reuseExistingServer: false` is not free — every local run cold-boots Vite and the 30s timeout becomes load-bearing; and the four dedicated configs each set their own synthetic registration on their own port and must not inherit the guard. **Standing do-not-do:** the failing spec looks like a ready TDD target and is not — Claude proposed a "vault product fix" for it and the coordinator's blind A/B proved that would have changed correct provider-availability semantics to satisfy a contaminated harness. Federation prevented a real regression. — relay_log.md decisive experiment

### 3.12 A billing idempotency key is minted, digested and journaled and never transmitted. `agent.ts:403` mints `${sessionId}:${turnId}:${step}`; `chutes/transport.ts:374-382` sends exactly seven headers and no idempotency header. A retried turn cannot be deduplicated — the user can be charged twice. *Blind-fix risk:* headers ride **outside** the E2EE envelope, so sending the raw key hands the endpoint a stable session id and an exact turn/step counter — precisely the metadata the posture claims to withhold. Send an opaque digest, add it to the CORS preflight, and **confirm the provider honours the header name first** — inventing one and shipping it makes the journal look honest while changing nothing, which is worse than a discoverable gap. `transport.ts` is dirty right now. — `ADVERSARIAL_SYSTEM_REVIEW.md` AR-008

### 3.13 No writer lease for a session epoch. Session concurrency is an advisory heartbeat roster (`tab-presence.tsx`) plus optimistic CAS on the journal. A real lease with TTL, renewal and observation exists — for terminals only (`manager.ts:41-46`, acquire `:1126-1147`, renew `:1218-1247`). This is the mechanism under J129/J130/J131 (a second tab declares the first tab's live conversation destroyed; a conversation's own URL does not open it in tab 2). *Blind-fix risk:* the terminal lease is workspace-file-backed (`/workspace/.airship/terminal/leases`) — siting a session lease there makes taking a turn depend on workspace availability, a different failure domain. Pick the storage plane deliberately, and verify against J129/J130/J131 rather than treating them as separate work. — `ADVERSARIAL_SYSTEM_REVIEW.md` AR-007

### 3.14 Duplicated implementations, each a deletion. **Four** `formatBytes` copies in `src/ui` (`app.tsx:13253`, `chat/message-parts-view.tsx:763`, `context-view.tsx:932`, `connect/egress-panel.tsx:207`) plus two renamed twins (`vault-view.tsx:1022 formatVaultBytes`, `local-device-vault-setup.tsx:945 formatLocalDeviceBytes`) against the exported `src/core/bytes.ts:26` — this is why the same `navigator.storage.estimate()` reads "256 MB" on #capabilities and "256 MiB" on #vault. **Correction:** the contract test at `single-implementation.contract.test.ts:76` bounds at 5 and its comment claims five copies — the comment and the bound are themselves stale-high, the same drift class as 3.5. Set the bound to what actually remains, and convert the two *renamed* twins too — they are not matched by the contract regex and are where the user-visible MB/MiB split actually lives. **A fourth `effectiveSkillIds`** at `memory-view.tsx:1957` against the exported `resolveSkillDecisions` (`domain.ts:394`) — note `app.tsx:13286` declares a same-named function that is **not** a copy (its docblock at `:13280` says so; it calls through), so a symbol grep finds two and one must not be touched. **`abortableDelay`** twice (`inference-retry.ts:204` required signal, `s3-object-store.ts:834` optional) — the signatures differ, so a naive unify breaks one side. — `wf_55e920d9-4b7`, `wf_23b56318-636`, `wf_1deb7bbc-db8`

### 3.15 Three identifier-truncation conventions live at once, and one renders receipt URNs as `urn:airsh`. Tail-8 at `app.tsx:12517/:12912`, `proof-view.tsx:511`; head-8 at `session-bar.tsx:328/:350`, `proof-view.tsx:512/:737/:746`, `platform-shell.tsx:1185`, `app.tsx:5287`, `chat/session-message-presentation.ts:255`, `workspace-view.tsx:2702`; a third form at `sessions-presentation.ts:237`; **both in one expression** at `proof-view.tsx:210`. *Blind-fix risk:* receipt ids are URNs, so tail-8 is *correct* for receipts and head-8 for session ids — a consistency pass that picks one form makes the trust surface worse. `session-bar.tsx:350` is documented at `:347-349` as a live e2e selector. `proof-view.tsx:511-512` feed **exported filenames**. And two `slice(0,8)` hits in `src/ui` slice arrays, not strings — do not regex-replace. — `wf_4b52d8c4-84a` §2 item 10

### 3.16 Documentation that names things the tree does not have. `docs/ARCHITECTURE.md` lists five narrow-waist ports (`AuthPort`, `AccountTelemetryPort`, `PaymentPort`, `SessionStore`, `AttestationVerifier`) that exist under no such names — **but CANON has already been corrected for three of them** (`CANON.md:529-533` marks them **planned**), so only ARCHITECTURE and CANON's remaining two need the treatment. *Trap:* `AttestationVerifierPorts` **is** a real type at `src/attestation/types.ts:209` with 12 consumers, so a grep without a word boundary "refutes" the whole finding. `docs/MEMORY_RELATIONSHIP_GRAPH.md:7-11,:47` specifies **Sigma.js v3.0.3 + Graphology v0.26.0**; `grep -i sigma package.json` → zero, the surface is a bespoke canvas renderer — but everything else in that document, including all ten device limits, verifies exactly, so this is a four-sentence replacement, not a rewrite. `docs/CONTEXT_FABRIC.md:5-7` and `EDGE_RUNTIME_CAPABILITY_LADDER.md:84` both omit the Local Device Vault, which `platform-shell.tsx:463-469` makes the ordinary default. `CANON.md:809` says xterm renders sessions "over those browser runtimes" (plural) when `manager.ts:397` spawns only `jsh`. CANON has **no entry** for `airship-sh` (a full first-party POSIX-sh interpreter in `src/execution/shell/`, 13 modules) or the shipped Ollama/LM Studio adapter — the ledger's only *under*-claims, covering the tier that works everywhere. `npm run lab:test` step 5/5 runs pytest in `../chutes-api`, a sibling repo not in this tree. — scratchpad `CANON-FULL-REPORT.md` §5; `wf_75fb6156-dbd`

### 3.17 Six canon claims are implemented with **zero test coverage**, violating canon's own §1 definition of "implemented" (`CANON.md:213`). Confirmed: the WebContainer `.git` exclusion (`node-webcontainer-adapter.ts:17`, used at three sites; `grep -c git` on its 549-line test → **0**); the pristine-bootstrap adoption branch (`pristineBootstrap` — five hits, all in `app.tsx`, none in any test); the 3 MiB/12 MiB evidence ceilings (exported and enforced at five sites, no covering test); and "canonical events contain no UI framework, provider SDK, database, cloud or chain type" — true by inspection, enforced by nothing. Narrowed: the workspace-binding start-refusal **is** implemented (`app.tsx:11427`, with a doc comment stating the invariant) but only serialization is tested. *Blind-fix risk:* do not write a test for the layering rule — `single-implementation.contract.test.ts` checks declaration rules, not import closure, so "add it there" is a category error; either write an import-closure contract test or mark it an unenforced design rule. And `pristineBootstrap` sits inside a `Promise.all` in a 13k-line file with no seam, so testing it is decomposition work, not test work. — scratchpad `CANON-FULL-REPORT.md:99-129` (§3)

### 3.18 Smaller confirmed items, each with a file:line. `ProfileGovernanceStrip` — a fully built, tested, styled component with **zero importers** (only its label constants are consumed); wiring it means replacing four `<details>` disclosures in app.tsx and moving three e2e locators, deleting it means also removing `css-variable-contract.test.ts:358` and a `memory-view.css:411` comment. A **second** provider-connection surface, 986 lines TSX+CSS, no route, but *with* a test and a CSS-contract entry — the suite proves a surface nobody can navigate to. `turn.plan.restated` is journaled and falls into `proof-activity.ts`'s `default: continue`, counted in `totalEvents` but not `accountedEvents`, with no UI row (`context.summary.updated` gets the same treatment, so it is a class). Inference retries emit **no** AgentSignal — a user watching a stall sees nothing between attempts; the omission is argued from the digest contract, so emit a *transient signal*, not a durable event. `generationDigest` (`client-context-engine.ts:601-610`) omits the retrieval mode, so two differently-scored generations are digest-identical — *and adding the field without making the mode change rebuild produces the opposite of the intent.* `SEMANTIC_DENSE_FLOOR = 0.35` was tuned for 384 dimensions and now governs a 4096-dimension chute; `retrieval-floor.test.ts:37` pins behaviour *at the constant*, not its value, so a green suite is not validation. Chunk ids are path- and revision-scoped (`incremental-indexer.ts:166`), so identical text embeds twice — `contentDigest` is computed one line above and unused, which is the seam. Vector search recomputes both L2 norms per chunk on the main thread (`flat-index.ts:84-95`) — matters ~10× more at 4096 dimensions; `cloneChunk` round-trips through `structuredClone` so a norm stored on the Float32Array will not survive. ADR-001 §4 specifies weighted RRF and **explicitly rules out** the raw-score addition that shipped; a third divergent lexical scorer survives at `context-driver.ts:185/:216` with its own local `overlap()`. Encrypted-workspace read/stat/list/write/delete each decrypt the whole manifest and every write re-seals it (`encrypted-workspace.ts:232/:238`; same on Drive) — the OPFS cache cannot help, by its own stated boundary. A pasted OAuth redirect URL's **origin is never compared** to the registration (`authorization-code.ts:128-150`) — S256 binding and constant-time state are mitigations, not the check; use exact-origin, never `startsWith`. The OpenAI provider card tells users Airship ships Codex "with product-owner approval" (`official-providers.ts:25`, rendered at `provider-fabric-panel.tsx:239`) while three docs deny any grant — reword the string, do **not** edit the docs and do **not** change `state`, which `provider-catalog.ts:227` throws on. The workspace-egress guard is triplicated with the 512-char ceiling now under two names, one aliased into the other's use. Georgia is bound directly **eleven** times in `routes.css` (not nine — `:2136` and `:2819` were missed) against a `--font-display` token; both tokens are currently Georgia, so mechanical replacement binds body-role text to the display token invisibly until the face changes. `--fs-hero` has exactly two references: its declaration and a test inventory. Focus mode (⌘.) was designed and never built — "focus" survives only as a palette keyword on the *collapse* toggle, so typing it today silently gives the wrong command. `preferredWorkspaceStorage` and `heavyPackLoading` are observed, printed and fed to the model and gate nothing — except `heavyPackLoading` is *half*-wired at `client-context-runtime.ts:131`, so "making it gate something" collides with an existing partial gate. Four generic containers in app.tsx carry an `aria-label` ARIA discards, recorded in an `AWAITING_A_CONCURRENT_EDIT` allowlist in `aria-name-contract.test.ts:39-45` — each is one `role="group"` from clean, and the test is built so a partial fix fails. `PASS1_FINDINGS.md:222` overstates what the contrast suite enforces — 3 of 6 named tokens are checked on one surface bed only (the unchecked pairings were measured and *do* clear AA, so this is an enforcement gap, not a live failure). `preferredWasmTier` selects no differently-compiled artifact — no `+simd128` build exists — and `maxWorkerConcurrency`'s misleading name is now serialized **into the model prompt**, with the corrective warning pinned by `browser-capabilities.test.ts:48`, so field, warning and test must rename together or the mitigation stops working. Source Control's designed 44px repo bar was never built (what shipped is a `<details>` over the trust band). Skills and Capabilities have no rail presence — `navigation-model.ts` RAIL_LAYOUT is two frozen sections and neither appears; adding rows also feeds TRUST_TABS, so set `scope`/`group` deliberately.

### 3.19 The twelve measured negative constraints — **the highest-leverage thing on this list and the least recoverable.** `FANOUT-PLAN.md:417-444` is a numbered list of things *not* to do, each with the measurement that killed it. None appears anywhere in the repository, and it lives only in `/private/tmp`. The load-bearing ones are cited inline throughout this register (#1/#2 flake latching, #4/#5 retrieval-mode digest, #6 shared-chunk classification, #7 dynamic-import boundary, #8 `"inherit"` in `skillModes` making an authored skill permanently undeletable, #9 `//`-only budget parsing, #10 coarse-pointer, #11 tail-truncated window notices, #12 glob-to-RegExp as a frozen tab). Plus the companion from `msg-honesty.txt`: a NUL-byte scan written as `grep -rlP` — **BSD grep has no `-P`**, so it exits non-zero printing usage, produces no output, and reads exactly like a clean result. A real byte scan then found three NULs in `src/ui/tabs.tsx` immediately. *"A check that reports success by failing is the same defect as a gate that measures nothing."* **Copy this section into the repo before the temp directory is reaped, verbatim with its numbers** — stripped of the measurements these become unfalsifiable advice, which is the genre this repo already has too much of.

### 3.20 Two other unrecovered scratchpad documents, same volatility. `CANON-FULL-REPORT.md` **§5** — thirteen canon-versus-subsystem contradictions, each adjudicated on tree evidence with a verdict (several against canon). It was lost because the seven-agent classification fan-out logged "classified 0 docs, 0 contradicting canon" and the hand-written section was never merged. *Do not bulk-apply it:* seven of thirteen conclude canon is already right, and §5.6 is an open question nobody has answered ("Canon takes no position on this; it should") — applying a verdict there invents policy. And `STATIC-SITE-CADDY-DEPLOY.md`, an 11 KB reusable deployment guide: four traps each with its failure signature, annotated contents of all six files, a stand-up procedure. The six files are in the repo; `ls docs/*DEPLOY*` finds nothing and `grep -rln Caddy docs/ README.md` finds nothing. Commit it as `docs/DEPLOYMENT.md`, keeping trap #1 phrased as a standing rule rather than history.

### 3.21 **The 38 KB verified polish worklist itself.** `wf_4b52d8c4-84a/agent-a692018cb8b4f13bf.jsonl` — six read-only verifiers re-checked 149 claimed-open findings from a committed inventory, a seventh synthesised the survivors. §2 ranks 23 confirmed bounded user-facing fixes with a per-item *"what breaks if you fix this blind"*; §4 is a **33-row table of working code the inventory reports as broken**; §5 names the 7 unverifiable items and the exact experiment for each. `grep -rn CONFIRMED_OPEN docs/` → nothing. The reconciliation still sits in the repo with a measured 21% false-positive rate and no correction beside it. **Commit it as `docs/audit/CANON_VERIFICATION_2026-08-03.md` with a dated derivation header** — and *not* verbatim: it was written at `a8c777a`, and this pass alone found several of its rows closed, two of its §4 citations now dead (`authorization-code-paste.ts:163` does not exist; the FERRARI P0-01 gate it says not to delete is not in `scripts/` at all), and its copy count off by one. Committing it unqualified reproduces exactly the failure it exists to correct. — `wf_4b52d8c4-84a`

### 3.22 **48 of the 152 journey findings were measured, evidenced, owned — and never narrated into a fix.** `JOURNEY_ATLAS.md:724` still reads "152 findings · 104 narrated · 48 index-only"; my independent `grep -c '| no |'` over the index tables returns exactly 48, matching. **Do not adopt this pool wholesale:** of 14 sampled, 13 were already fixed. That is a two-thirds false-positive rate. The action is triage — run the 34 unchecked rows through the same verify-against-tree pass, then narrate only the survivors. The ones still believed open are already broken out above (J117/J118/J126 → §1.19, J122 → §1.17, J129/J130/J131 → §3.13, J110 → §1.4, J147 → §3.18, J024 → §1.5).

---

## 4. Already done — do not re-fix

Each verified implemented at `3ea40cf`. Sending someone here wastes a day and risks breaking working code.

| Recovered as open | Actually shipped | Evidence |
|---|---|---|
| **Skills authoring UI missing (CAP-02)** | Shipped | `src/ui/skill-editor.tsx` (create + edit revisions, "Create skill"/"Save revision" at `:199`); `app.tsx:13114` renders the `New skill` button; `skill-editor.css` is a lazily-fetched route stylesheet. Landed in `afc52f2`. |
| **Sidebar rail row does not open the conversation** | Fixed `395c12a` | `src/ui/rail.tsx:810` `onClick={session.open}`. The e2e guard that hid it (`if (await firstConversation.count())`) was deleted from `conversation-navigation.spec.ts` with a comment naming it as how the defect shipped. **Note the All-conversations list is a different surface and is still open — §1.5.** |
| **Collapsed rail clips titles to two characters** | Fixed `395c12a` | `rail.tsx:319` carries a comment about "RECENT" rendering as "RECE"; the commit records browser geometry (rail 60px, rows 67.4px at x=13, title clientWidth 29 vs scrollWidth 132). `e2e/rail-collapse.spec.ts` now tracked. |
| **Proof grouped as a global destination** | Fixed `395c12a` | `platform-shell.tsx:866-871` TRUST_TABS carries `scope` from CANONICAL_DESTINATIONS; `:892-894` draws one GLOBAL band; measured 375px→438px strip. `e2e/trust-scope-agreement.spec.ts` tracked. |
| **A theme change forces "Fork to continue"** | Fixed `732095e` | `src/sessions/domain.ts:1140-1157` — `PROFILE_REVISION_NEWER` is now `severity: "info"`, with the comment recording the measurement: choosing a theme and saving a revision turned a completed conversation's only forward action into a fork. `e2e/resume-without-forking.spec.ts` tracked; `3ea40cf` extended it to phone. |
| **Sub-390px Proof overflow / 320px `#memory` + `#context` overflow** | Fixed, regression-pinned | `e2e/narrow-viewport-overflow.spec.ts` asserts no sideways scroll across 12 routes at `PHONE_WIDTHS = [320, 360, 375, 390]`. Root cause preserved in `memory-view.css:386-398` (`repeat(auto-fit, minmax(320px,1fr))` — a fixed track minimum `1fr`/`justify-content`/`min-width` cannot lower, which is why three prior fixes were inert) and `context-view.css:882-889` (the second declared floor). |
| **`git restore` / `git reset` "have no UI"** | **Refuted** — reachable from the Terminal | `terminal-commands.ts:75` `case "reset"`, `:79-84` `case "restore"`, the `restore` function at `:483` with feature-gating at `:491`, reset at `:529-536`, and both in `git help` at `:817-818`. `docs/BROWSER_GIT.md:97` is **accurate** — do not "correct" it. Only the *Source Control panel* lacks buttons, which is what `sources-view.tsx:1290`'s comment actually says. |
| **Context route's mode toggle reports nothing selected under a third mode** | Already three-way at HEAD | `git show HEAD:src/ui/context-view.tsx` → `aria-pressed` at `:259` bootstrap, `:260` semantic, `:274` chutes. Predates the in-flight edits. |
| **CANON names five ports that do not exist** | 3 of 5 already corrected | `CANON.md:529-533`: "`AuthPort`, `AccountTelemetryPort`, and `PaymentPort` are **planned** contract names, not symbols in this tree." Only ARCHITECTURE.md and CANON's other two remain (§3.16). |
| **Proof journal panel unreadable** | Phone case fixed | `routes.css:3580-3586` overrides to `48px minmax(0,1fr)` with the message at `grid-column: 1 / -1`. Desktop still open (§1.12). |
| **`flat-index.test.ts` missing** | Exists, 12 tests | Three describes: lexical scoring, retrieval modes, corpus statistics. The finding demanded it *before* touching the arithmetic; that precondition is met. |
| **Two `optionalMemoryView`/`optionalProofSurface` budget comments stale** | Re-measured | Both now record figures consistent with their ceilings. The *structural* blind spot remains (§3.5). |
| **`read_file` unbounded; `search_text` uncursored; answer model not rendered; catalog skill-ceiling disagreement; `humanIntentDecisions` missing; `checkLocalModelServers` a stub; `profiles-governance` dead; terminal 256 KiB clear-and-rewrite** | All landed | `workspace-tools.ts:104-119` and `:241-328`; `app.tsx:12563-12579` (with a comment saying never to read the active binding); `domain.ts:27` `MAX_CATALOG_SKILLS = 512`; `session-audit.ts:218/:1101`; `app.tsx:8956`; `app.tsx:87` + `posture-floor.ts`. |
| **Retry/backoff, cancellation salvage, tool-result windowing, parallel read dispatch, loop guardrails, plan re-injection, length-limit honesty** | 7 of 14 parity items built | `e02e42e`, `ff21778`, `cbdf7ff`, `f1c82ae`, `632ff68`, `agent.ts:312/:829`, `67a2636`. |
| **The capability-parity analysis is lost in a temp directory** | Recovered | `docs/architecture/AGENT_CAPABILITY_PARITY_2026-08-04.md` (195 lines), commit `4e0828d`. Its unbuilt items are §2.1/2.2/2.6. |
| **The "prove what you measured" CI pattern** | Implemented and load-bearing | `ci.yml:79` (`ref: github.workflow_sha`), `:98` (gate script copied to `$RUNNER_TEMP`, checkout deleted before `npm ci`), `:102` (`Certify what is being measured`), `:113` (`measured-sha.txt`), `:226` (`lab:storage`), `:267`, `:297`. It caught a two-parent merge commit on the probe run. Reuse this shape for every future gate. |

---

## 5. Could not verify

Read-only rules and two concurrent workflows made these unsettleable. Each names the experiment that settles it.

| Item | Why unsettled | What settles it |
|---|---|---|
| **`browser-worker.spec.ts` flake still reproduces** | I proved the file is *untouched* since 2026-07-27 and the racy shape is intact, but did not run the suite. | `npx playwright test e2e/browser-worker.spec.ts --repeat-each=5 --project=desktop`. |
| **The three other flaky specs** | Population measured five days ago; the suite has churned by 11 specs. | Re-run the probe with `--repeat-each` on `account-providers`, `workspace-terminal`, `profile-silo` before touching any of them. |
| **"Fork to continue" → "Create fork" changes nothing, refusal renders at top=-351 (LOCAL_COMMAND_INCOMPLETE arm)** | Code path is live (`session-audit.ts:1692` emits the code; `sessions-view.tsx:175` quotes the sentence) and adjacent fixes landed (`sessions-view.tsx:1298`'s scroll comment), but this arm needs a driven browser. | Drive the app with a Vault active into a session whose head fails the local journal audit; assert the refusal's `getBoundingClientRect().top ≥ 0`. |
| **Second tab declares the first tab's live conversation destroyed** | Needs two live tabs, not a grep. The lane verified that *with* a Vault the second tab restores correctly, narrowing it to the no-Vault case. | Two browser contexts on one origin; open tab 2 while tab 1 is live and no Vault is active; read the topbar and continuity card. Also settles the hash-rewrite half (J130) and the audit-silo half (J131). |
| **Proof verdict unsurvivable on mobile (2520px summary, 3802px attestation in an 824px pane)** | Rendered-geometry claim; I found no `position: sticky` verdict bar in `proof-view.tsx` but did not measure. | One Playwright run at 430×932 asserting the verdict bar's rect stays on screen after a 1000px scroll. |
| **"Offline · remote inference paused" persists after reconnect** | String is set at `app.tsx:5935` as a send-time refusal; `observeConnectivity` runs at `:2608` and `online` appears in two dependency arrays, but I found no effect clearing `runtimeStatus` on offline→online. `app.tsx` is dirty. | Toggle network offline→online in a driven browser and read the composer status line. |
| **E2EE invoke returns 429 while plain chat returns 200 on the same key and model** | A live-service observation; `transport.ts` is being edited right now (the `X-E2E-Stream` hardcode is already gone). | Re-run the controlled comparison — same key, same model, `/e2e/invoke` vs plain chat — after the in-flight transport work lands. |
| **Source Control's 614px preamble** | Absence of the designed repo bar is confirmed; the pixel figure predates route changes. | Measure the route in a build before claiming a reclaimed-pixel result. |
| **No live cross-origin browser gate for the three cloud vendors; the Drive gate runs against a fabricated client id** | Config-file claims I did not open at HEAD; two independent lanes reached them the same day. | `playwright.google-drive.config.ts` + `package.json` read; then an env-gated Drive project (`AIRSHIP_LIVE_GOOGLE=1` + a real client id) and a cross-origin project driving built `dist/`. |
| **The 7 UNVERIFIABLE worklist items** | By construction — the read-only pass could not settle them without a browser, and neither could I. | Each carries its own probe: FERRARI P0-02/03/04/05/07 → `npx playwright test` against a built origin plus `check:release:live`; the 1px-border census → extend `type-ramp.spec.ts`'s walker at 1440×900; AR-005 crash-after-effect → a harness terminating the page between effect application and journal commit (CDP `Target.closeTarget` mid-write); the 230px content-start budget → read `.transcript`'s rect top on a connected turn; **phone terminal tap-to-focus** → a mobile-chromium test that `.tap()`s `.terminal-emulator` and asserts `activeElement` is `textarea.xterm-helper-textarea`, then types `ls`+Enter. **Run that last one before building a command bar**, or the terminal gets two divergent input queues. |
| **34 of the 48 index-only journey findings** | Not individually re-checked. 13 of 14 sampled were already fixed. | Verify each against the tree before narrating (§3.22). |
| **The three in-flight journeys** | Two workflows hold `app.tsx`, `sessions/domain.ts`, `context-view.tsx`, `transport.ts`, `index.html`, `public/_headers`, `release-gate.mjs`. | Re-verify §1.4, §1.7, §3.12 against the final commits, not this snapshot. |

---

## 6. Where the originals live

Nothing here depends on this register being complete. Every source is readable.

### Corpora

| Corpus | Path |
|---|---|
| Federation relays (32 runs) | `/Users/chrisk/relay/*/` — `relay_log.md`, `round_1/reply_*.txt`, `round_1/cross_reads/`, `brief_*.md` |
| Session transcripts (63) | `/Users/chrisk/.claude/projects/-Users-chrisk-airship/*.jsonl` |
| Workflow journals (24) | `.../[session]/subagents/workflows/wf_*/journal.jsonl` |
| Subagent transcripts (279) | `.../subagents/workflows/wf_*/agent-*.jsonl` |
| Scratchpad (522 files, one session) | `/private/tmp/claude-501/-Users-chrisk-airship/5772c406-b82c-4e0f-a5d8-7ba0ed70f3d1/scratchpad/` — **volatile** |
| In-repo audits | `/Users/chrisk/airship/docs/` |

### Item → source

| § | Item | Source |
|---|---|---|
| 1.1 | Drive key-handle store unwired | `wf_4b52d8c4-84a/journal.jsonl`; `docs/gap-audit/vault.md` #2; `docs/GOOGLE_DRIVE_VAULT.md:65-70` |
| 1.2 | Semantic pack absent from build | `wf_4b52d8c4-84a/agent-a692018cb8b4f13bf.jsonl` §2.5; `docs/gap-audit/context.md` #4/#4b; `fa3c4bea….jsonl:1163,:1326,:1378,:1515` |
| 1.3 | Cancelled turn → invalid audit | scratchpad `msg-honesty.txt`, `merge2.txt`; `fa3c4bea….jsonl:2123`; merge body of `ff21778` |
| 1.4 | Cannot carry a conversation / no Reconnect | `docs/gap-audit/inference.md` #2; `docs/design-review/journey-complaints.md:803-812` |
| 1.5 | All-conversations click | `docs/audit/JOURNEY_ATLAS.md:184,:786` (J024); `JOURNEY_FINDINGS.json` |
| 1.6 | `/help` transcript overflow | `wf_223f0d7d-987/journal.jsonl` (left_open) |
| 1.7 | Title collapse | `journey-complaints.md:221-224,:203-205`; `visual-critique.md:519`; commit `395c12a` |
| 1.8 | Phone type scale | `journey-complaints.md:96-102`; `visual-critique.md:302` |
| 1.9 | `window.confirm` holdouts | `wf_55e920d9-4b7/journal.jsonl` coh-05; `docs/gap-audit/ui.md` #8 |
| 1.10 | Chip accessible names | `wf_4b52d8c4-84a/journal.jsonl` + §2.4; `journey-complaints.md:521` |
| 1.11 | Search clear affordance | `wf_55e920d9-4b7/agent-a3317fc2362e02ec6.jsonl`; `wf_23b56318-636/agent-a464fd2d63032fc63.jsonl` |
| 1.12 | Journal panel code column | `docs/design-review/screen-reviews.md:943-951` |
| 1.13 | Third-party logo fetch | `wf_2f8e9abd-63a/journal.jsonl` |
| 1.14 | "Clean retry branch" | `wf_cc794805-7a4/journal.jsonl`; `wf_c5da82ab-ae9` residual |
| 1.15 | Context envelope size | `wf_cc794805-7a4/journal.jsonl` |
| 1.16 | More-sheet glyph | `wf_23b56318-636/journal.jsonl` ds-14-mobile-parity |
| 1.17 | Terminal scrollback | `JOURNEY_ATLAS.md` J122 |
| 1.18 | Git seed ignored files | `wf_4b52d8c4-84a/journal.jsonl`; `docs/gap-audit/remediation/git-verbs.md` #7 |
| 1.19 | Unbounded session growth | `JOURNEY_ATLAS.md` J117/J118/J126; `8164e732….jsonl:4562` |
| 2.1 | Sub-agents | `docs/gap-audit/tool.md` #3; `BUILD_PLAN_2026-07-25.md:439`; `AGENT_CAPABILITY_PARITY_2026-08-04.md` #4 |
| 2.2 | Tool-result spill | `fa3c4bea….jsonl:1950` |
| 2.3 | `declareModelMetadata` / context window | `wf_4b52d8c4-84a` §2.15/16/17; `docs/gap-audit/inference.md` #1/#3 |
| 2.4 | Git verbs | `docs/gap-audit/tool.md` #4; `docs/gap-audit/git.md` #6; `wf_4b52d8c4-84a` §2.14 |
| 2.5 | WASI tier | `docs/gap-audit/shell.md` #3/#8/#9/#10; `wf_4b52d8c4-84a` §2.18-21 |
| 2.6 | web_search / MCP / cost | `docs/gap-audit/tool.md` #7; `AGENT_CAPABILITY_PARITY_2026-08-04.md`; `fa3c4bea….jsonl:1950,:2573` |
| 2.7 | `readBounded` | `wf_5bb59718-d24/journal.jsonl`; scratchpad `FANOUT-PLAN.md:452` |
| 2.8 | Composer attachments | `8164e732….jsonl:1517` |
| 2.9 | Negative capability boundary | `docs/gap-audit/tool.md` #6 |
| 2.10 | Memory graph inert | `docs/gap-audit/context.md` #10 |
| 2.11 | Repository import | `docs/gap-audit/git.md` #9 |
| 3.1 | Build nondeterminism | `JOURNEY_CLOSEOUT.md:134-165`; `8164e732….jsonl:8012,:8095` |
| 3.2 | app.tsx | `devils-advocate.md` WP-0; `wf_4b52d8c4-84a` §3; relay `cross_reads/` §3.6 |
| 3.3 | CANON SHA binding | relay `cross_reads/reply_codex.txt` step 6 |
| 3.4 | RELEASE_GATE table | scratchpad `CANON-FULL-REPORT.md:262` |
| 3.5 | Budget guard blind spot | `wf_223f0d7d-987/journal.jsonl` |
| 3.6 | Touch floor | `wf_4b52d8c4-84a` §2.8; `fa3c4bea….jsonl:1559` |
| 3.7 | browser-worker flake | scratchpad `{ev,c2,c3,c4,mc,pv}/desktop.json`; `relay_log.md` |
| 3.8 | Other flakes | `relay_log.md` probe 30838072444 |
| 3.9 | Caddyfile gate | scratchpad `STATIC-SITE-CADDY-DEPLOY.md`, `msg-deploy.txt` |
| 3.10 | Pages deploy | relay `reply_codex.txt`/`reply_claude.txt` Q2; `fa3c4bea….jsonl:138,:188,:378` |
| 3.11 | Lab client-ID hijack | `relay_log.md` decisive experiment; `reply_codex.txt` Q1 |
| 3.12 | Idempotency key | `ADVERSARIAL_SYSTEM_REVIEW.md` AR-008 |
| 3.13 | Writer lease | `ADVERSARIAL_SYSTEM_REVIEW.md` AR-007; J129/J130/J131 |
| 3.14 | Duplicated implementations | `wf_55e920d9-4b7`, `wf_23b56318-636`, `wf_1deb7bbc-db8` journals |
| 3.15 | Truncation conventions | `wf_4b52d8c4-84a` §2.10; `journey-complaints.md:521` |
| 3.16 | Doc/code name drift | scratchpad `CANON-FULL-REPORT.md` §5; `wf_75fb6156-dbd/journal.jsonl` |
| 3.17 | Untested canon claims | scratchpad `CANON-FULL-REPORT.md:99-129` |
| 3.18 | Smaller items | `wf_269957dd-144`, `wf_c5da82ab-ae9`, `wf_58b710ad-c6b`, `wf_1deb7bbc-db8` journals; `docs/gap-audit/*`; `ADVERSARIAL_SYSTEM_REVIEW.md`; `lane-proposals-surfaces.md`; `PASS1_FINDINGS.md:222` |
| 3.19 | "Do not do this" ×12 | scratchpad `FANOUT-PLAN.md:417-444`; `msg-honesty.txt` |
| 3.20 | §5 contradictions; deploy guide | scratchpad `CANON-FULL-REPORT.md:252-280`; `STATIC-SITE-CADDY-DEPLOY.md` |
| 3.21 | The 38 KB verified worklist | `wf_4b52d8c4-84a/agent-a692018cb8b4f13bf.jsonl` (+ six verifier siblings in the same directory) |
| 3.22 | 48 index-only findings | `JOURNEY_ATLAS.md:780-830`; `JOURNEY_FINDINGS.json` |
| 4 | Already-done evidence | Direct reads at `3ea40cf`, cited inline |
| 5 | Unverifiable set | `wf_4b52d8c4-84a/agent-a692018cb8b4f13bf.jsonl` §5 |

---

**Three things to do before anything else, in this order.** (1) Copy `FANOUT-PLAN.md`'s "Do not do this," `CANON-FULL-REPORT.md` §3 and §5, and `STATIC-SITE-CADDY-DEPLOY.md` out of `/private/tmp` — they are one reaper away from being unrecoverable, and §3.19 is the most expensive knowledge in the corpus. (2) Commit the verified worklist as `docs/audit/CANON_VERIFICATION_2026-08-03.md` with a dated derivation header, so the committed reconciliation stops being trusted at face value. (3) Do not start §1.4 or §1.7 without talking to the two workflows holding `app.tsx` and `sessions/domain.ts`.