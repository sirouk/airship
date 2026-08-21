# Devil's advocate — attack on the proposals

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../../SIMPLIFICATION.md`](../../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

## 1. INFORMATION LOSS — proposals that quietly drop something

**"One HTTP 429 renders as 270px" (cold, blocker).** It calls "Turn stopped safely" and "Connection lost — partial response kept" duplicates. They are not: the first comes from the recovery path (`src/ui/chat/turn-recovery.ts`), the second from transport. Merging them under a headline that hardcodes *rate limiting* asserts a cause for every failure shape — the code emits a generic `Chutes E2EE invoke failed with HTTP {status}`. And it demotes the one caveat a sceptic needs at rest ("Local state was kept; no remote success is assumed") into a `What was kept` disclosure. Keep it at rest.

**"The first screen spends 398px" (cold, major).** Drops the banner's `Connect a model` button on the theory that "the identical topbar seal and the identical third suggestion card both remain." The topbar element is a seal, not a labelled action, and the same critic measured that suggestion cards *prefill rather than send*. This deletes the only unambiguous route to `#access` from the cold screen.

**"Unstyled purple links… every message printing its author twice" (phone, minor).** Drops the avatar and claims its "only unique carry was colour-coding." Its unique carry is a positional author anchor for a message scrolled into mid-viewport — and the power-user journey wants that same row to carry `Chutes · DeepSeek-V3.2-TEE`. Two proposals are spending the same 60px in opposite directions.

**"One turn, six phrasings" (sceptic, blocker).** Collapsing the four topbar pills into `◐ Trust · 1 of 8 verified` deletes the independent-axis property from the resting UI while citing the sentence that states it ("Each axis is independently scoped. The weakest claim is shown in the topbar"). "1 of 8 verified" is a *claim count* from `claim-stack-model.ts`; the pills are the *four-axis posture*. A rollup that silently swaps one enumeration for the other is exactly the failure the complaint is about.

**"At 25 conversations every rail row is the same three lines" (returning, major).** Changes the rail subtitle from the assistant preview to `You: <last user turn>` — deleting the surface the developer journey identified as the app's saving grace when the answer is collapsed ("the sidebar conversation row shows the answer at the same moment").

**"/models list is less informative" (power, major).** Moves the connection UUID behind a disclosure. In a product whose thesis is pinning, the credential *generation* id is the discriminating fact — and the same journey separately complains that the sidebar hides the pin. Pick one.

**"Model sheet: 59% of it is filters" (phone, major).** Silently drops `PAGE_SIZE = 30` / `Show all {n}` (`model-picker.tsx:6, 91`). At three-line rows and 40+ models, "first result at ~150px" is true and the list is then ~5,000px with no pagination.

---

## 2. HONESTY REGRESSION

**The worst one is the fix for the worst complaint.** "Same receipt, one click apart: VERIFIED 1 then VERIFIED 0" proposes the copy *"this receipt is not signed by a trusted authority, so no claim on it can rise above Recorded."* The code says something narrower and different. `src/ui/attestations-model.ts:299` is:

```
"Receipt integrity and embedded claim authority were not authenticated; non-unavailable claim states are shown as assertions only."
```

and there are **two independent ceilings**, not one:
- `assertedState(declaredState)` → `qualifier: \`asserted-${declaredState}\`` — applied to every conversation-receipt dimension (`attestations-model.ts:~403`);
- `statusWithAuthority(declaredState, authority)` → `qualifier: "verified-without-authority"` — applied to endpoint-evidence dimensions (`:343, :380, :450`).

Nothing checks a signature. Shipping "not signed by a trusted authority" states a mechanism the product does not implement, to explain a contradiction caused by overclaiming. Render the qualifier the model **already computes**, in English, and name both ceilings separately.

**"Delete 'established'" is right; "recorded" is a downgrade.** `trust-language.ts:26` maps `partial → "Asserted"`. "Asserted" says *a party asserted this*; "Recorded" says *we wrote it down* and drops the author. Delete `established`; keep Verified / **Asserted** / No evidence.

**Durability option chips (cold, blocker #1) assert availability the code doesn't compute.** `platform-shell.tsx:336` is a preference (`value.vaultBackend`), defaulted by `resolveDefaultVaultBackend(VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER, VITE_GOOGLE_CLIENT_ID)`. The only availability function is `availableVaultBackend(value, googleClientId)` — build-time, Drive-only. `"Encrypted S3 · local MinIO lab — needs endpoint"` and `"Encrypted Local Device · offline — available"` would print guesses as facts. Ship the effective/target split; ship state chips only where a state exists.

**"Shared Git reports on a different repository" (dev, blocker).** The proposal *keeps* the claim "Authoritative Editor/source-control state" (`terminal-view.tsx:140`) and adds a repo name. Do not label before you bind. If the binding slips, the honest interim is to strike "Authoritative" and print the resolved path of whatever repo actually answered.

**The Return card asserts counts that cannot survive the event it describes.** "You were in *X* — 2 conversations, 207 recorded steps, 4 approved tool calls" after an ephemeral reload. Ephemerality is the premise; page memory is gone. Unless something survives (sessionStorage, BFCache, `PerformanceNavigationTiming`), the card invents its own loss report. Build it from what actually survives: the session id already in the hash, the vault snapshot, the adoption error. This is the highest-emotion proposal in the set and therefore the one that must not be fabricated.

**Phone terminal degradation copy blames the platform.** *"This browser will not open a keyboard for the terminal surface"* — the measured fact is that Airship's own `textarea.xterm-helper-textarea` (9×23px) never receives focus on tap. That is a defect in `terminal-view.tsx`, not a browser refusal.

**Collapse-as-burial, two cases.**
- Cold #10 collapses `#proof`'s eight negations behind `Show all 8` and leads with "Journal structure passed." That inverts the hierarchy on a proof page — and `e2e/claim-stack-layout.spec.ts` already asserts `.claim-absence` carries `open` and renders all eight labels. Someone already litigated this. Reject.
- The developer's "ASSERTIONS 6 · all asserted from turn receipt ▾" hides all six names; the sceptic's variant keeps all six visible inside the summary row. Take the sceptic's.

**"All 12 are Confidential candidates → drop the per-row token to a shield glyph"** (power, minor). A glyph's *absence* is a silent negative the first time a non-confidential model appears. Take the one-sentence header; refuse the glyph swap.

---

## 3. CONTRADICTIONS — and the winner

1. **Empty-state alignment.** Cold #4 wants top-alignment. `e2e/responsive-breakpoints.spec.ts:214` asserts `.transcript.no-turns` is centred with `firstTopWithin > 120`, with a documented `safe center` fallback. **Winner: keep centring.** The real finding is the ~40 duplicated words between banner and first message; deleting the duplicate shrinks the void by itself.
2. **Placeholder text** — four candidates. **Winner: `Message Airship`.** It is already the accessible name (`app.tsx:5024`), so visible text and accessible name converge for free, and `e2e/composer-layout.spec.ts` selects `[aria-label="Message Airship"]` **exactly**.
3. **Where `/` lives** — first-run hint vs toolbar chip vs slash-menu header. **Winner: the 44px toolbar chip**, the only variant reachable by thumb; a slash-menu header is circular.
4. **Composer layout ≤640px.** **Winner: two-row grid at ≤640px only**, desktop untouched, so the desktop geometry assertions don't move.
5. **Terminal header.** Both cold #11 and dev #22 want a rebuilt 44px bar + ⓘ. It is *already* a `<details>` (`terminal-view.tsx:126`) defaulting open via `!matchMedia("(max-width: 760px)")`. **Winner: change the default and persist it** — same ~300–400px reclaimed, one line, no new markup.
6. **Model switcher.** Power user proposes both "reuse `<ModelPicker>`" and "build a 360px two-zone MenuSelect". **Winner: reuse `ModelPicker`** — `app.tsx:4816` already hands it real `AirshipModel[]`; a second menu is the thing the complaint is against.
7. **Claim rail collapse.** **Winner: the sceptic's** — the only version that collapses height without collapsing names.
8. **Sidebar rows** — 60px three-line (power) vs 56px with date groups (returning). **Winner: 56px, two lines, model as a right-aligned muted chip on line 2.**
9. **"Ephemeral" instance count** — three proposals legislate it. **Winner: `durability-indicator.tsx` is 13 lines and already the single source.** Make every surface render it; let the count fall out of layout.

---

## 4. FEASIBILITY

**Budget.** `scripts/release-gate.mjs`: startup `allJavaScriptAndWorkers` = 640 KiB raw / **132 KiB gzip against a measured 128.89** — ~3.1 KiB, and the comment says in terms this is the one ceiling that does not move. Consequence: **command-palette indexing of connections/models/sessions must be lazy** (built on first `⌘K`, not at mount) or it drags `src/models` filtering into first paint. Everything landing in `app.tsx` lands in startup.

**`src/ui/app.tsx` is 7,045 lines, not 6.3k.** Seventeen of the 84 proposals edit it. That is the plan's dominant constraint.

**Six phone proposals name files that do not exist:** `chat/composer.tsx`, `chat/tool-call-card.tsx`, `chat/turn-status.tsx`, `chat/session-header.tsx`, `chat/slash-command-menu.tsx`, `chat/message.tsx`. All of that lives in `app.tsx` and `chat/message-parts-view.tsx` (201 lines). Five "isolated" items are actually five edits to the collision file.

**`src/ui/styles.css` is a 17-line `@import` barrel** whose header warns *"the order is the cascade."* Every `styles.css:3253` / `:5022` reference is stale; the rules are in `chat.css` (1,711), `routes.css` (3,380), `shell.css` (706), `platform-shell.css` (153).

**The keyboard bug is real to the line** — `platform-shell.css:125` sets `bottom` on `.composer-wrap`, which has no `position` (`chat.css:973`). But `position: fixed` is a **contract change to two e2e specs** (`composer-layout.spec.ts` bottom invariants; `responsive-breakpoints.spec.ts:89` landscape overlap), not a two-line patch. Budget it.

**`MenuSelect` portal (cold #1) fights three shipped mechanisms.** `menu-select.tsx` already flips right on overflow, computes `--menu-select-available-height` from `visualViewport`, scrolls the trigger into view under 88px, and goes `position: fixed` full-width ≤640px; `responsive-breakpoints.spec.ts:420` asserts menus stay anchored at intermediate widths. Portalling breaks (i) `root.current?.contains(...)` outside-close, (ii) the Preferences dialog's own `trapFocus(event, dialog.current)` — portalled options become untabbable inside the modal trap, (iii) `platform-shell.css:83`. **The bug is that the Preferences dialog clips; fix the dialog.**

**`git` PATH shim (dev, blocker).** `manager.ts:190` spawns `jsh`. A shim forwarding to page-owned isomorphic-git needs an RPC *out of* the WebContainer (port + `server-ready`, or a polled file protocol) — and the bridge is approval-gated, so `git commit` typed at a prompt raises a countdown modal over a terminal you are typing into. The proposal is silent on approval. **Downgrade to: intercept `command not found: git` and print the bridge pointer** (a string change), and treat the shim as its own project.

**Any proposal moving the composer's aria-label breaks `composer-layout.spec.ts`'s exact attribute selector — and is an a11y regression**, turning a clean 15-character accessible name into a sentence read on every focus.

**`responsive-breakpoints.spec.ts:248` — "the composer is two tab stops from the start."** The Return card cannot be "first in tab order after skip links"; that is the composer's slot. Use `role="status"`/`role="alert"` plus a skip-link target.

**Cold #2's premise is false.** `scroll-affordance.ts` + `data-scroll-edges` + a mask exist, and `responsive-breakpoints.spec.ts:169` asserts the mask paints **only** when the rail genuinely overflows, at 700/800/900/1080. The residual defect is that max-height is not a multiple of the 46px row, so a row is sliced. **Snap to whole rows.** An always-on chevron is exactly the "fake an overflow" the test forbids.

**Phone type ramp.** `type-floor.test.ts` asserts the literal string `--fs-micro: calc(.6875rem * var(--type-scale))`, a no-literal-below-11px sweep of every UI stylesheet, and the `large`/`x-large` multipliers. A hard `12px` at ≤640px breaks the exact-string assertion and **silently disables the user's Large/Extra-large type-scale preference on phones.** Ramp via `--type-scale` at the media query.

**`density-contract.test.ts`** asserts `:root[data-density] .composer textarea` exists. Keep the hook.

**Transcript content search (returning #57)** means materialising decrypted transcripts for every listed session per keystroke — the same bounded-materialization path the critic found 893px down the page. Feasible only as an explicit, debounced, scoped action.

**Auto-titling already exists** at `app.tsx:2508–2518` (`conversationTitleFromPrompt`), gated on `headSequence === 1` **and** `title === \`${profile.name} conversation\``. The 25-identical-titles observation is a gap in that gate, not a missing feature. Scope accordingly.

**Highest-confidence, zero-collision item:** the diff renderer, confirmed verbatim at `sources-view.tsx:~444`:
```tsx
diff.patch.split("\n").map((line, index) => <div class={diffLineKind(line)} key={...}>
  <span>{index + 1}</span><b>{line.startsWith("+") ? "+" : line.startsWith("-") ? "−" : " "}</b><code>{line}</code></div>)
```

---

## 5. FASHION OVER FUNCTION

- **Date-grouped session headers** ("Linear ships them day one"): at 25 conversations created in one session every row is "Today". Ship the 56px row and the count; earn the headers at a scale that has dates.
- **The six-verb ⌘K "Actions" group** is Raycast cosplay. Two verbs were *measured* as missing (47 keystrokes to switch a model; zero results for "chutes"/"glm"): `Switch model`, `Connect a provider`. Ship two.
- **`⌘⇧M`** mints a global chord to route around a tab-order defect (36 stops to the trigger). Fix the tab order / add the trigger to the skip-link set first.
- **`Allow for this repository`** is a security-policy change wearing a UX proposal's clothes, against copy that says "Approval applies only to this operation ID." **Reject.** Take the rest of that proposal — `oldText`/`newText` are both already in the payload, so rendering the diff at approval costs nothing.
- **`git@p-limit ▸` prompt prefixes** — cosmetic. The binding is the fix.
- Earned, not fashion: two-gutter diffs, answer-last-and-visible, a `History` view (the data is in the object DB and `git log` already returns it).

---

# THE SURVIVING DESIGN DIRECTION

Ordered by (impact × confidence) / effort. One owner per package. `app.tsx` collisions flagged.

**WP-0 — Extract `<StageHeader>`, `<Composer>`, `<SessionRail>` out of `app.tsx`.** Pure move, no behaviour. Unblocks five packages to run in parallel instead of serially. Probably a day; pays for itself immediately. *Files: `app.tsx` → three new modules under `src/ui/chat/`.*

**WP-1 — Diff correctness.** `sources-view.tsx`, `sources-view.css`. Parse to hunks; `---`/`+++` to a sticky header; `@@` as a separator row; two gutters (old/new); strip the prefix char from `<code>`; `tab-size: 4`; `Wrap` default on; full content width; `▸ raw patch` byte-identical. No collisions. Ship first.

**WP-2 — Composer geometry + phone keyboard.** `chat.css`, `platform-shell.css`, `Composer` module. Placeholder → `Message Airship`; **aria-label untouched**; 44px `/ tools & commands` chip; ≤640px two-row grid; `.composer-wrap` fixed + `bottom: calc(var(--visual-viewport-bottom,0px) + env(safe-area-inset-bottom))`; `.fixed-mobile-nav` → `display:none` when keyboard open; transcript padding from measured composer height + scrim; re-run scroll-to-bottom on `visualViewport` resize; durability chip rendered on phone as a 44px strip. **Updates `composer-layout.spec.ts` and `responsive-breakpoints.spec.ts:89` in the same change.**

**WP-3 — Answer-first turn rendering.** `chat/message-parts.ts`, `.tsx`, `.css`. Invariant: an overflow region may never contain a trailing text part. Settled turn = machinery strip → answer → collapsed steps. One 32px row per *invocation* (call+result merged, status carried once by the glyph). Failures expanded by default. Answers dev #14, dev #23 and phone #43 in one file set, no `app.tsx`.

**WP-4 — Trust vocabulary + one counter.** `trust-language.ts`, `claim-stack-model.ts`, `attestations-model.ts`, `attestations-view.tsx`, `proof-view.tsx`, `seal.tsx` + their tests. Delete `established`. Three count words: Verified / Asserted / No evidence. One counting function feeding rail and ledger. **Render both existing ceilings in the model's own words** (`asserted-*` = receipt integrity and embedded claim authority not authenticated; `verified-without-authority` = declared verified, no external authority), printing uncapped and capped figures. Fix `qualifierLabel` concatenation ("bindingASSERTED") and the double casing. Collapse ASSERTIONS to one row that still names all six. Persistent legend containing exactly the emitted state words. **Does not touch the four posture pills.**

**WP-5 — Attestation-view layout** (sequential after WP-4). `attestations-view.tsx/.css`. Full-width three-line tiles; verifier names wrap, never ellipsise; EVIDENCE RECORDS as full-width rows; "Records are not merged…" made readable.

**WP-6 — Preferences durability: effective vs target.** `platform-shell.tsx:336`, `platform-shell.css`, `durability-indicator.tsx`. Effective state from the same source as the status row; the preference labelled as target; fix the clip by making the **dialog** not clip; state chips only where `availableVaultBackend` computes one. Smallest fix for the worst first-run contradiction.

**WP-7 — Failure states** (after WP-2). `chat/retry-prompt.ts`, `chat/turn-recovery.ts`, `request-state.ts`, `message-parts-view.tsx`, topbar string. One card, explicit status→cause table **with a stated fallback**, `Retry` visible at rest at 44px, safety claim at rest, amber everywhere, session badge → "no evidence this turn".

**WP-8 — One session strip** (serialise with WP-2/WP-7). Merge topbar pills + floating model card + status row. Full model id, never clipped. One posture control expanding to the four axis rows **carrying the existing "each axis is independently scoped" sentence** — ship `.mobile-trust-chip` (`app.tsx:4609`, already built, `display:none` at desktop) at every breakpoint. Rollup shows the **weakest axis**, not a claim count.

**WP-9 — One model picker.** `model-picker.*`, `model-control.tsx`, `provider-model-control.tsx`. Reuse `<ModelPicker>` in chat. Sticky, un-truncated, once-only "starts a new pinned conversation". Phone: full-screen sheet, revert `.model-picker-toolbar{display:grid}` at ≤640px to a scroll-snap row, 44px/16px search, ids wrap. Scope any `text-overflow` change under `.model-*` — `.menu-select-option strong` is shared by ~10 sites. **Fix `aria-label={option.label}` on `MenuSelect` options, which currently hides every description from screen readers.**

**WP-10 — Return / reconnect.** `app.tsx` (mount notice), `turn-recovery.ts`, `sessions-view.tsx`, `vault-view.tsx`, `vault-provider-transition.ts`. One card, three variants (ephemeral reload / adopted-but-not-continuable / adoption failed), **built only from surviving state**. Kill the 11.7px caption and the forever spinner. Split `#vault` into `Storage contract` and `History adoption`. Five mismatch rows → one resolved statement + `Reconnect Chutes · <model>` deep link, five rows verbatim in the disclosure plus a pinned/active table. Disable mutating controls when the detail pane is outside the filter.

**WP-11 — Access route order.** `access-view.*`, `connect/*`, `provider-fabric-panel.tsx`, `provider-connections-view.tsx`, `capabilities-view.tsx`. Lanes at ~200px; Companion below; `Chutes/Chutes` → the description that exists one line lower; one provider list; truthful counter; confirmation above the model select and scroll-to-Finish; orphan "Sign in with ChatGPT" heading removed, fact promoted; per-card probe results; **selected/unselected method tabs made perceivable (currently byte-identical — WCAG 1.4.1, cheapest fix here)**; `Compare capabilities` transposed to providers-as-columns with the credential-class table kept below.

**WP-12 — Git loop completion** (after WP-1). History view + Recent commits + durable commit receipt; row-click → diff in the editor pane; ± counts on workbench rows; commit box in the panel footer. **Bind Shared Git to the Sources selection before labelling it.** Terminal: intercept `command not found: git`, print the bridge pointer.

**WP-13 — Terminal density + phone input.** `terminal-view.*`, `focus-trap.ts`. `setupOpen` default closed + persisted; `git status` value → placeholder; 44px command bar + key strip on touch, with copy that blames Airship not the browser; documented Escape-Escape out of the Tab trap; real `── process restarted ──` boundary line in the scrollback.

**WP-14 — Sidebar + list at scale.** `shell.css`, `SessionRail`, `sessions-view.*`, `sessions/library.ts`. Snap the rail to whole rows; pin `↳ All conversations · N`; 56px two-line rows + model chip; **close the auto-title gate at `app.tsx:2508`**; message search as an explicit, debounced, scoped action with a truthful badge; empty state that names what was searched.

**WP-15 — Slash menu, /help, command surface.** `slash-menu-state.ts`, `commands/registry.ts`, `commands/autocomplete.ts`. Never pre-select a destructive command; intent groups + pinned "Start here"; first sentence at rest, full schema in expansion; `/help` as a grouped card + `/help <command>`; `↵ / ↵↵ / esc` footer; distinct `/models list` vs `use` descriptions; `/models use` with no arg opens the picker instead of stamping FAILED TURN; `/inspect-inference-connections` as a table with `▸ Raw JSON` byte-identical.

**WP-16 — Targets, links, overflow, ramp** (land last; touches many sheets). 26 sub-44px targets via padding only; `a { color: var(--accent-bright) }`; `#memory`/`#sessions`/`#terminal` overflow rows via the **existing** `useScrollEdges`; phone ramp via `--type-scale`, never literal px; `#editor` collapses three tab bars to one and actually selects Editor.

**Explicitly rejected or deferred:** `git` PATH shim (no approval story, needs WebContainer RPC); `MenuSelect` portal; top-aligning the empty state; `Allow for this repository`; six-verb palette; date-grouped headers; renaming "Asserted" to "Recorded"; any change to the composer's `aria-label`; the "unsigned receipt" ceiling copy.

**`app.tsx` sequencing if WP-0 is skipped:** WP-8 (stage header ~4780–4870, topbar ~4600–4620) → WP-2 (composer ~5000–5060) → WP-7 (topbar status) → WP-14 (rail ~4690–4710, titling ~2508) → WP-10 (mount ~990, ~3400). Do not run these concurrently.