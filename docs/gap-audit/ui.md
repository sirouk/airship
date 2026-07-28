# Interface quality, polish, and honesty

**Verdict.** This is not a clunky example — it is already a genuinely designed product, and the honest answer is that most of the eight UX constraints are met in code and enforced by tests. The route surface is 14 views behind a single `NavigationView` union (src/ui/navigation-model.ts:1-14) rendered from one `.app-shell` grid (styles.css:223-241) with three regions: a 58px topbar (brand + honest status pills + actions), a grouped Work/Agent/Trust rail with an expandable chat-thread list, and a `main` that is either the chat layout or a route layout. Real, working, non-cosmetic: a ⌘K command palette with focus restore and arrow/enter handling (platform-shell.tsx:97-175), `g`-prefix navigation chords (platform-shell.tsx:177-208), a windowed/virtualized transcript with a height cache, per-message external stream slots with incremental markdown that preserves stable block identity (chat/streaming-slot.tsx, chat/markdown.tsx:98-126), a zero-dependency markdown renderer that never touches innerHTML and puts a Copy button on every code block, real +/- colored git diff rendering with line numbers and a wrap toggle (sources-view.tsx:444, sources-view.css:321-331), an `role="tree"` file explorer with roving tabindex and arrow keys (workspace-view.tsx:429-439), `RouteSkeleton` loading states on every lazy route, a `ViewErrorBoundary` with a "Recover to Chat" affordance, focus-trapped dialogs, `prefers-reduced-motion` and `forced-colors` handling, and a unit-test-enforced 11px type floor with a scale knob that actually moves chrome (type-floor.test.ts). I empirically verified with a headless probe against `dist/`: topbar is 58px desktop / 52px mobile, no document overflow at a 200%-zoom-equivalent 720px viewport, and only one nominally unlabeled control (a file input that is implicitly labeled by its wrapping `<label>`). The honesty is real too — "Connect inference" is the literal fallback label (app.tsx:783), "Browser / Edge runtime" is hardcoded `state="none"`, and the Proof view enumerates eight unestablished claims rather than implying any. What remains is a short, specific list, and the two most serious items are not aesthetics but capability regressions: the four-axis trust claim stack is wired to a control that exists only below 640px, so on desktop it is dead code; and between 641px and 860px — which includes iPad portrait at 768px — every trust seal except the meaningless neutral one is `display:none` with no replacement, violating the project's own stated principle P9. Beyond those, the biggest felt-polish gaps are an empty chat that is 57% dead space, 35 tab stops to reach the composer with no skip link and no autofocus, and no syntax highlighting anywhere despite the diff view proving the color vocabulary already exists.

---

## 1. 35 tab stops to reach the composer, with no skip link and no autofocus
`keyboard-path-to-composer` · kind **clunky** · effort **small**

**Evidence.** I measured this directly with a headless keyboard probe against dist/: pressing Tab from `document.body` on #chat requires 35 stops to reach the `TEXTAREA` "Message Airship". The trail is brand → 3 status seals → 3 icon buttons → every nav item → chat disclosure/new → each recent conversation → each profile row → profile menu → Manage profiles → 3 session-meta buttons → Connect inference → 3 starter chips → composer. The probe also returned `SKIP LINK false` — there is no skip-to-content anchor in the document. src/ui/app.tsx:4248-4250 gives `main` a ref and `tabIndex={-1}`, so the programmatic focus target already exists, but nothing links to it. The composer textarea at src/ui/app.tsx:4452-4466 has no `autofocus` and no mount-time focus effect, unlike the command palette which does focus on open (platform-shell.tsx:114).

**Impact.** A keyboard or screen-reader user must traverse the entire chrome before they can type, on every page load. A mouse user must click into the composer before typing, which no comparable chat product requires. This is the single highest-frequency interaction in the app and it is the least reachable.

**Fix.** Three parts, with one correction the auditor got wrong.

1) Skip link. Add `id="main-region"` to the `<main>` at /Users/chrisk/chutes-jumpmaster/airship/src/ui/app.tsx:4248-4250 and insert a skip cluster as the first child of `.app-shell` (app.tsx:4043), before `<header class="topbar">`: an `<a class="skip-link" href="#main-region">Skip to conversation</a>` (native anchor navigation moves focus to a tabIndex={-1} target in all modern browsers) plus a second `<button type="button" class="skip-link" onClick={() => textarea.current?.focus({ preventScroll: true })}>Skip to composer</button>` rendered only when `view === "chat"`, since `main` contains the whole transcript and landing there still leaves ~8 stops to the composer.

2) CSS. Add `.skip-link` next to `.sr-only` in /Users/chrisk/chutes-jumpmaster/airship/src/ui/styles.css:4553, reusing the same clip/1px pattern plus a `.skip-link:focus-visible` (and `:focus`) rule that restores `position: fixed; clip: auto; width/height: auto; z-index` using existing design tokens -- design-contract.test.ts locks raw palette values, so do not hardcode colors.

3) Autofocus -- CORRECTION. Do not "add a mount effect that calls textarea.current?.focus()". An effect of exactly that shape already exists at app.tsx:1681-1684 (`mainRegion.current?.focus({ preventScroll: true })` on `[view]`) and it demonstrably never fires at mount: patching HTMLElement.prototype.focus logged zero focus calls across the entire first 3.5 s of load, and document.activeElement stays BODY, even though the same effect works on route change. A copy of that pattern would be dead code. Use the file's established deferred pattern instead -- `requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }))` (as at app.tsx:815 and app.tsx:2547) -- in an effect keyed on the composer actually being mounted (`view === "chat"` and `textarea.current` non-null), guarded on `!paletteOpen && !preferencesOpen && !mobileMoreOpen && !trustSheetOpen` (the `platformOverlayOpen` const is declared at app.tsx:4023, below the hooks region, so read the state values directly), and skipped when `window.matchMedia("(max-width: 640px)").matches` so it does not pop the mobile soft keyboard.

Also flag the one real side effect: `useGlobalNavigationJumps` bails when `isTypingTarget(event.target)` (/Users/chrisk/chutes-jumpmaster/airship/src/ui/platform-shell.tsx:193), so focusing the composer on load disables the `g`+key navigation chords until the user leaves the composer. Either accept that (chat-first, matching comparable products) or exempt an empty composer from the typing-target guard. Land a regression test asserting the tab-stop count from body to the composer is <= 2; no existing e2e asserts tab order, so nothing breaks today.

---

## 2. An empty conversation is 57% vertical dead space
`empty-chat-dead-space` · kind **clunky** · effort **small**

**Evidence.** Headless measurement against dist/ at 1440x1000: `.transcript` is 702px tall, the last content (`.transcript-starters`) ends at y=519, and there are 403px of empty space between the starter chips and the composer — 57% of the transcript viewport. The cause is that src/ui/app.tsx:4363-4407 renders the welcome card and then the starter chips as ordinary top-aligned flow content inside `.transcript`, with no centering treatment for the zero-turn case. The desktop-chromium chat screenshot in test-results/route-adversarial-audit-.../desktop-chromium-chat.png shows the same void. The starter chips themselves are well designed (styles.css:1972-2012, `.starter-chip` with hover and reduced-motion handling); they are just marooned at the top.

**Impact.** This is the first screen a new user sees, and it is the single strongest 'unfinished' visual cue in the product — the polished chrome frames a large empty rectangle. Every comparable product centers its zero-state.

**Fix.** In /Users/chrisk/chutes-jumpmaster/airship/src/ui/app.tsx at the transcript container (~line 4339), change the static `class="transcript"` to a computed class that appends ` no-turns` when `messages.length <= 1` — the same predicate already used at line 4391 to gate `.transcript-starters` — e.g. `class={`transcript${messages.length <= 1 ? " no-turns" : ""}`}`.

In /Users/chrisk/chutes-jumpmaster/airship/src/ui/styles.css, after the `.transcript` rule at line 1160, add:

  .transcript.no-turns {
    display: grid;
    align-content: safe center;
  }

Use `safe center`, NOT the bare `center` the auditor proposed. Verified measurement: the zero-state content (welcome card + starter chips, 280px block) overflows the transcript on short and mobile viewports (1100x520 gives clientHeight 219; iPhone 390x844 gives clientHeight 486 vs scrollHeight 534). With bare `align-content: center` the welcome card's top lands at -33px / -10px inside a scroll container that provides no start-edge scrollable overflow, so it is permanently clipped. `safe center` falls back to start alignment in exactly those cases and was measured identical to today's baseline there, while still centering at 1440x1000 (first child top moves 20 -> 208).

Two follow-ups the fix should include:
1. `.transcript-jump` (styles.css:1175) uses `float: right`, which is ignored on a grid item; since the no-turns state is still scrollable on short viewports the jump button can appear there, so add `.transcript.no-turns .transcript-jump { justify-self: end; }` to preserve its right-aligned pill shape.
2. No spacing change is needed — measured total content block height is 280px in both block and grid layout, so `.transcript-starters { margin: 18px 0 6px }` (styles.css:1973) does not double up, and the mobile `.transcript` padding override in the media query is unaffected because `.transcript.no-turns` sets no padding.

Keeping the class tied to `messages.length <= 1` means the moment a real turn exists the container reverts to plain block flow, so scroll anchoring, the windowed transcript spacers, and `isNearLastRealCard` are untouched.

---

## 3. No syntax highlighting in chat code blocks or the workspace editor
`no-syntax-highlighting` · kind **absent** · effort **medium**

**Evidence.** src/ui/chat/markdown.tsx:129-132 renders every fenced block as `<section class="markdown-code"><header>…language label + Copy…</header><pre><code>{block.text}</code></pre></section>` — the language is parsed and displayed (markdown.tsx:43, boundedLabel) but never used to tokenize. src/ui/workspace-view.tsx:462 is the file editor: a bare `<textarea class="code-editor">` with `spellcheck={false}` and a Cmd/Ctrl+S handler, no line numbers and no tokenization. A repo-wide grep for `highlight|shiki|prism|hljs` across src/ui/ and package.json returns only unrelated `-webkit-tap-highlight-color` and `outline-color: Highlight` matches. Notably the color vocabulary already exists and is used well elsewhere: sources-view.css:326-329 colors diff additions and deletions with `--v-verified` / `--v-failed` mixes.

**Impact.** For a product positioned at 'Claude Code / Codex-level tool power', every code block the agent emits and every file the user opens renders as undifferentiated monospace. This is the most visible quality gap between Airship's transcript and its competitors', and it undercuts the blueprint's own P5 ('The Transcript is the Instrument').

**Fix.** Add /Users/chrisk/chutes-jumpmaster/airship/src/ui/chat/highlight.ts: a bounded, zero-dependency ordered-regex scanner `highlightSpans(language: string | undefined, text: string): readonly {start:number; end:number; kind:"kw"|"str"|"num"|"com"|"fn"}[]` covering ts/js, rust, python, json, bash, md, with an unknown-language fallback that returns [] (fail-open to today's plain rendering, never a wrong-language guess). Normalize the language key by taking the first whitespace-delimited word and lowercasing it — markdown.tsx:33 captures everything after the fence (```ts title=foo yields language "ts title=foo" through boundedLabel at line 196), so a raw equality lookup would silently miss. Bound the scan by MARKDOWN_LIMITS.codeChars (already applied at markdown.tsx:43) and cap span count so a pathological block cannot allocate unbounded.

Render in /Users/chrisk/chutes-jumpmaster/airship/src/ui/chat/markdown.tsx:131 by mapping the spans to `<span class="tok-...">` children inside the existing `<pre><code>`, still via JSX/createElement — no innerHTML, so `require-trusted-types-for 'script'` and the `script-src 'self' 'wasm-unsafe-eval'` CSP in public/_headers stay intact. Streaming matters: IncrementalMarkdownView (markdown.tsx:119-126) re-renders the trailing block every flush, so tokenize inside MarkdownBlockView only (per block, on the already-frozen block objects) and keep the work O(len(block)) — never re-tokenize the frozen prefix, or the O(n) streaming property at blueprint §9 regresses to O(n^2).

Style the tok-* classes in /Users/chrisk/chutes-jumpmaster/airship/src/ui/chat/message-parts-view.css (where .markdown-code already lives, lines 17-21), NOT styles.css, and define a dedicated `--tok-kw/--tok-str/--tok-num/--tok-com/--tok-fn` family in the :root block of /Users/chrisk/chutes-jumpmaster/airship/src/ui/styles.css derived from --ink/--ink-muted/--ink-faint plus low-chroma neutrals. Do not reuse --v-verified/--v-caution/--v-failed/--truth-local/--truth-remote/--copper: src/ui/design-contract.test.ts:37-50 locks those as verdict/asserted tones and src/ui/type-floor.test.ts:29-32 asserts message-parts-view.css contains no var(--copper); reusing them would also violate DESIGN_LANGUAGE.md:49 ("color reinforces but never carries meaning") by making a keyword look like a proof state. Every new variable must be defined in a stylesheet or carry a fallback, or src/ui/css-variable-contract.test.ts fails. Also keep the tokenizer out of the deferred-capability chunks by importing it directly (entry has ~25 KiB gzip headroom under RELEASE_BUDGETS.entryJavaScript), and add a highlight.test.ts asserting spans are non-overlapping, monotonic, and that concatenating the sliced text reproduces the input exactly.

For the workspace editor (/Users/chrisk/chutes-jumpmaster/airship/src/ui/workspace-view.tsx:462) do the cheap half first: a line-number gutter alongside the textarea, scroll-synced via onScroll. A full `<pre>` underlay is buildable — .code-editor already sets `background: transparent` (workspace-view.css:34) so only `color: transparent; caret-color: var(--accent)` plus scrollTop/scrollLeft mirroring and identical font/tab-size/padding are needed — but it must preserve the existing readOnly={buffer.truncated} and binary/truncated boundary states above it, and should stay off for files near WORKSPACE_EDITOR_BYTE_LIMIT to avoid doubling DOM cost on large buffers.

---

## 4. The approval dialog is aria-modal but neither traps focus nor makes the background inert
`approval-dock-focus-escape` · kind **bug** · effort **small**

**Evidence.** src/ui/app.tsx:4023 computes `const platformOverlayOpen = mobileMoreOpen || paletteOpen || preferencesOpen || trustSheetOpen;` — the approval broker's pending state is not included. That value is what drives `inert={platformOverlayOpen}` on the topbar (app.tsx:4044), sidebar (4131) and main (4256). `ApprovalDock` is rendered separately at app.tsx:4801. Inside src/ui/approval-dock.tsx the panel declares `role="dialog" aria-modal="true"` and focuses the deny button on mount, but its `onKeyDown` handles only `Escape` — there is no `trapFocus` call, unlike every other dialog in the app (platform-shell.tsx:140 for the palette, 290 for preferences, 345 for the trust sheet, mobile-navigation.tsx:175 for the more sheet, all using a shared `trapFocus` helper).

**Impact.** During a capability approval — the highest-consequence dialog in the product, gating write, network, execute and identity effects — a keyboard user tabbing past 'Allow once' lands silently in the still-focusable background chrome while the scrim claims to be modal. Assistive tech is told the background is inert when it is not.

**Fix.** Three parts, all buildable in-browser.

1. Shared helper. Move the focus trap into a new module, e.g. /Users/chrisk/chutes-jumpmaster/airship/src/ui/focus-trap.ts, exporting `trapFocus(event, container)` and `focusableWithin(container)`; have src/ui/platform-shell.tsx (delete the private copy at line 462) and src/ui/mobile-navigation.tsx (delete the copy at line 283) import it. Do NOT simply export platform-shell's version as-is: its selector is `button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])`, which omits `summary` (and `textarea`). The approval panel contains `<details class="approval-arguments"><summary>Arguments shown to the approval policy</summary>` (approval-dock.tsx:77-80) sitting before the footer buttons, so that selector yields [deny, allow] and the wrap `allow -> deny` would make the arguments disclosure unreachable by keyboard in exactly the dialog where reading the arguments matters. Use the mobile-navigation variant's selector plus `summary` and `details > summary`, and keep its more defensive activeElement checks (`!container.contains(current)`), since focus can already be outside the panel when the key fires.

2. Trap in the dock. In /Users/chrisk/chutes-jumpmaster/airship/src/ui/approval-dock.tsx extend the scrim onKeyDown (line 33) to `else if (event.key === "Tab" && panel.current) trapFocus(event, panel.current);`. While at it, add the focus-restore the other three dialogs have: capture `document.activeElement` in the mount effect (line 14-17) and `.focus({ preventScroll: true })` it in the cleanup, mirroring platform-shell.tsx:111-117 — otherwise step 3 yanks focus to <body> when the request appears and never gives it back.

3. Inert background. In /Users/chrisk/chutes-jumpmaster/airship/src/ui/app.tsx subscribe to the broker for a pending flag (`ApprovalBroker.subscribe` at src/approvals/broker.ts:76 invokes the listener immediately and returns an unsubscribe, so `useEffect(() => approvalBroker.subscribe((s) => setApprovalPending(s.pending.length > 0)), [approvalBroker])` is sufficient) and fold it into line 4023: `const platformOverlayOpen = mobileMoreOpen || paletteOpen || preferencesOpen || trustSheetOpen || approvalPending;`.

Caveat the auditor's fix does not cover: the mobile nav bar at src/ui/mobile-navigation.tsx:106 is gated on its own `moreOpen` prop, not on platformOverlayOpen, so it stays focusable and non-aria-hidden during an approval (a pre-existing hole shared with the palette, preferences and trust sheet). Step 2's trap is what actually contains focus there; fully closing the aria-hidden side would need a separate `inert` prop threaded into MobileNavigation, since `moreOpen` also drives the sheet's own render at line 161 and cannot just be OR-ed.

Regression check for step 3: the e2e specs that drive approvals (e2e/github-import.spec.ts:23/44/49/58/64, e2e/google-drive-vault.spec.ts:64, e2e/local-device-app-journey.spec.ts:264, e2e/workspace-workbench.spec.ts:50) all scope to the dialog before clicking "Allow once", so aria-hidden on main does not break them.

---

## 5. Markdown renderer omits italics, strikethrough, nested lists, rules and images
`markdown-inline-gaps` · kind **clunky** · effort **medium**

**Evidence.** src/ui/chat/markdown.tsx:142 is the entire inline grammar: `/(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*)/gu` — inline code, links, and bold only. No `_italic_`/`*italic*`, no `~~strike~~`. At the block level, markdown.tsx:52-62 captures leading indentation in group 1 but never reads it, so nested list levels are flattened into one list; there is no thematic-break (`---`), image, or task-list (`- [ ]`) handling, and headings are capped at level 3 (markdown.tsx:46).

**Impact.** Model output that uses ordinary markdown — nested bullets in a plan, an italicized caveat, a checklist of steps — renders visually wrong or flattened. Since the transcript is the primary surface, this quietly degrades every substantive answer, and nested-list flattening actively loses structure the model intended.

**Fix.** Extend /Users/chrisk/chutes-jumpmaster/airship/src/ui/chat/markdown.tsx, keeping createElement-only rendering and MARKDOWN_LIMITS bounds. Five coordinated edits the original fix under-specified:

1. Inline (markdown.tsx:142 regex and the :147-153 dispatch chain): add `~~[^~\n]+~~` -> <del> and single-`*`/`_` emphasis -> <em>. Ordering must be fixed in BOTH places, not just the alternation: `\*\*...\*\*` must precede `\*...\*`, and the dispatch chain must test `token.startsWith("**")` before `token.startsWith("*")`, or every bold token is mis-split. Guard `_..._` with non-word boundaries — an unguarded `_` alternative italicizes snake_case identifiers in prose (`foo_bar_baz`, `MARKDOWN_LIMITS`), a regression the naive fix introduces.

2. Thematic break and h4-h6 are UNREACHABLE without also editing `startsBlock` (markdown.tsx:171-173). The paragraph accumulator at markdown.tsx:84 consumes any non-blank line for which `startsBlock` is false, so a `---` or `#### x` directly following prose is swallowed before the new block case can fire. `startsBlock` must learn `^---+$`/`^\*\*\*+$` and widen `#{1,3}\s` to `#{1,6}\s`.

3. Heading cap needs three edits in lockstep: the `level: 1 | 2 | 3` union at markdown.tsx:13, the `#{1,3}` regex plus the `as 1 | 2 | 3` cast at markdown.tsx:46-48, and `startsBlock` at :172.

4. Nested lists require changing the block shape, not just reading `list[1].length`: `kind: "list"` at markdown.tsx:15 carries `items: readonly string[]`, so depth has nowhere to live. Move to a depth-carrying or tree item type and update the `<li>` render at markdown.tsx:134. Add a nesting-depth cap (e.g. 6) beside `MARKDOWN_LIMITS.listItems` — `listItems` alone does not bound adversarially deep indentation. Note today's code also splits on ordered/unordered mismatch (markdown.tsx:58), so an ordered list nested inside a bulleted one currently emits two sibling blocks; the tree change should absorb that too.

5. Images: do NOT emit `<img>`. index.html:13 sets `img-src 'self' data: blob: https://logos.chutes.ai`, so model-supplied remote images are CSP-blocked (broken-image render) and are a tracking-pixel/IP-leak vector. Instead consume the leading `!` in the inline alternation and render alt text plus a `safeHref` link — this also fixes the current mis-render where `!` is orphaned and the alt text silently becomes a clickable link.

Extend /Users/chrisk/chutes-jumpmaster/airship/src/ui/chat/markdown.test.ts (currently 31 lines) with cases for each, including the `**bold**`-vs-`*italic*` ordering, the snake_case non-italicization guard, `---` immediately after a prose line, and nested-depth preservation.

---

## 6. An unsatisfying answer cannot be regenerated — Retry only appears after an error
`no-regenerate-affordance` · kind **absent** · effort **small**

**Evidence.** src/ui/app.tsx:5838 inside `MessageCard`: `{message.role === "assistant" && message.error && message.originatingPrompt ? <button type="button" onClick={onRetry}>Retry</button> : null}` — the retry control is gated on `message.error`. The surrounding `<details class="message-actions">` (app.tsx:5834-5842) otherwise offers Copy, Edit & resend (user messages only), and Fork session. The wiring already exists: `onRetry` at app.tsx:4376-4379 re-sends `originatingPrompt` with `originatingAttachments`, and that field is populated for successful turns too.

**Impact.** The most common recovery gesture in any chat agent — 'try that again' — is missing for the case that actually matters, a turn that succeeded but produced a poor answer. Users must manually retype or fork.

**Fix.** Three coordinated edits, all in-browser, no fork:

1. src/ui/app.tsx:5838 — replace the gate with `message.role === "assistant" && message.originatingPrompt` and keep the label "Retry" (docs/AIRSHIP_DESIGN_BLUEPRINT.md:1259 already specifies Retry on errored/stopped/COMPLETED assistant messages; "Regenerate" is not in the project's locked vocabulary). Do NOT route through `onBranch`/`branchFromMessage`: `sessionLibrary.fork` (src/sessions/library.ts:107-173) returns `historyCopied: false` and `activateForkedSession` (src/ui/app.tsx:3977-3984) wipes the transcript to a welcome message and never sends, so it would destroy the conversation. The existing same-session `onRetry` (src/ui/app.tsx:4376-4379 → `sendMessage`) is already append-only against the immutable journal, so the original turn and its receipt chain stay intact and inspectable — that is the correct path.

2. src/ui/app.tsx:2810-2817 and src/ui/app.tsx:3950-3960 — both session-resume mappings build UiMessage rows without `originatingPrompt`, so the ungated button would still never render on a resumed session. Populate it for assistant rows from the immediately preceding user row (`messagePlainText(previousUserRow.parts)`) when mapping `presentation.rows`, or expose an `originatingPrompt` on the row from src/ui/chat/session-message-presentation.ts.

3. Label honestly: because `providerContextDisposition` (src/sessions/domain.ts:382) only excludes failed/cancelled turns, a same-session Retry re-asks with the earlier answer still in provider context — it is an "ask again", not a clean regeneration. Either say so in the button title, or (larger, spec-complete option) implement blueprint §8.2 variants: append the new turn tagged `variantOf`, mark the superseded turn excluded from provider context, and render the `‹ n of m ›` switcher.

---

## 7. Raw journal counts, session digests and unexplained TEE jargon sit in the primary chat header
`jargon-in-chat-header` · kind **clunky** · effort **small**

**Evidence.** src/ui/app.tsx:4328 renders `{eventCount} page-journal event{s}`; app.tsx:4329 renders a button labelled `#{sessionId.slice(0, 8)}` (a raw digest fragment — the live screenshot shows `#968d4e9f`); app.tsx:4320 labels the session seal `TEE not checked · this session` with no expansion of TEE. All three are in `.session-meta`, the always-visible chat stage header, not behind disclosure. This contradicts the project's own principle P11 in docs/AIRSHIP_DESIGN_BLUEPRINT.md:112-114, which states 'Plain Language Leads, Machine Detail Follows' and explicitly forbids 'raw kebab enums, raw ISO strings, or raw digests in the default view'.

**Impact.** The first thing a new user reads above their conversation is three pieces of internal vocabulary. It makes a calm, honest product read as an internal debug console, and it is the clearest remaining 'example app' tell on the main screen.

**Fix.** Scope the fix to two strings and leave the session-id badge alone.

1) src/ui/app.tsx:4328 — replace the invented term with plain language and demote the technical name into the tooltip, e.g. `<span title={`${eventCount} page-journal event${eventCount === 1 ? "" : "s"}`}>{eventCount} recorded step{eventCount === 1 ? "" : "s"}</span>`. No test or doc pins the current wording (grep for "page-journal" hits only this line).

2) src/ui/app.tsx:5550 (describeAttestationSeal's disconnected fallback) — change `label: "TEE not checked"` to a plain primary consistent with the project's own mapping (docs/AIRSHIP_DESIGN_BLUEPRINT.md:1854 "Processor secure area (CPU TEE)"; src/ui/trust-language.ts:49 claimLanguage("cpuTee").primary === "Protected CPU runtime"), e.g. `label: "Secure hardware not checked"`, and move the acronym into `detail` (e.g. "No provider is connected, so no TEE evidence has been requested for this session."). `Seal` already surfaces `detail` via `title` and `aria-label` (src/ui/seal.tsx:61,68,70) — there is no `aria-describedby` on this component, so do not reference `StatusSeal` (app.tsx:5465). Apply the same treatment to the matching per-message label "TEE evidence pending" at app.tsx:5606 for consistency, and update the expectations in src/ui/attestation-seal.test.ts. The current `detail: "Demo provider"` is separately inaccurate (there is no demo provider) and should be corrected in the same edit.

3) Do NOT change src/ui/app.tsx:4329. The visible `#<sessionId.slice(0,8)>` badge is an explicit blueprint acceptance criterion (docs/AIRSHIP_DESIGN_BLUEPRINT.md:2452-2454 B14 and :2605), it is a UUIDv4 prefix rather than a digest (src/core/id.ts:4) so P11's digest clause does not apply, and e2e/airship-shell.spec.ts:38 asserts its exact format. If any change is wanted here it is additive only: give the button an `aria-label` such as `Conversation ${sessionId.slice(0,8)} — open details` while keeping the visible `#id` text.

4) If a shared humanizer is desired, add a new exported function to src/ui/trust-language.ts — the existing exports (proofLevelLabel, postureLabel, proofStatusLabel, claimLanguage, relativeEvidenceAge, rankedReceiptVerdict, claimExpiry) cover none of these cases.

---

## 8. Destructive profile actions use native window.confirm instead of the app's dialog system
`native-confirm-dialogs` · kind **clunky** · effort **small**

**Evidence.** src/ui/app.tsx:5937 — `if (!window.confirm('Remove ' + selected.name + ' from the profile manager? …')) return;` — and src/ui/app.tsx:5961 — `onClick={() => { if (!dirty || window.confirm('Discard unsaved profile edits?')) …}}`. These are the only two native modals in the UI. The app already has a designed confirmation pattern: src/ui/workspace-view.tsx:469 implements `.workbench-dialog` with `role="dialog" aria-modal="true"`, danger/primary button variants, and dedicated copy for delete and discard-unsaved-changes cases.

**Impact.** Two OS-chrome alert boxes break an otherwise fully custom, themeable, dark-mode surface at the exact moment the user is making an irreversible decision. They also ignore the user's theme, type-scale and density preferences, and cannot carry the reassuring 'immutable history stays available' framing the surrounding panel uses.

**Fix.** Add a shared ConfirmDialog to src/ui/platform-shell.tsx and delete both window.confirm calls in ProfileManagerView.

1) Component: put `ConfirmDialog({ open, title, body, confirmLabel, tone, onConfirm, onCancel })` in src/ui/platform-shell.tsx, modeled on TrustPostureSheet (platform-shell.tsx:341-345): `.platform-scrim` wrapper with role="presentation" + onMouseDown target check, inner div with role="dialog" aria-modal="true" aria-labelledby tabIndex={-1}, and onKeyDown handling Escape -> onCancel and Tab -> trapFocus(event, dialog.current). trapFocus already exists at platform-shell.tsx:462 and is module-local, so keeping the component in that file needs no new export.

2) CSS: do NOT reuse the `.workbench-dialog` class from src/ui/workspace-view.css:50-55 — that stylesheet is imported only by src/ui/workspace-view.tsx, which loads solely inside the lazy `import("./editor-view")` chunk (src/ui/app.tsx:1289), so the Profiles route would show an unstyled dialog. Copy the panel/scrim rules into src/ui/platform-shell.css (already pulled in by styles.css:1) under a new class (e.g. `.confirm-dialog`), and re-declare the danger button rule, since workspace-view.css:49 scopes it as `.workbench-dialog .danger`.

3) Archive site (src/ui/app.tsx:5937): replace the window.confirm early-return with a `confirm` state; the button at app.tsx:6046 sets it, and the dialog's confirm handler runs the existing onDelete/status block. Reuse the copy already in .profile-archive-zone (app.tsx:6042-6043): title "Remove {name} from new work", body "Immutable history stays available — existing conversations, receipts, audits, and pinned revisions remain inspectable", danger button "Remove profile".

4) Discard site (src/ui/app.tsx:5961): the click handler switches profiles synchronously, so add pending-selection state — when `dirty`, store the clicked profileId and open the dialog ("Unsaved profile edits", "Discard and switch" / "Keep editing"); on confirm run setStatus(undefined) + setSelectedId(pendingId). When not dirty, switch immediately as today.

5) Tests: update the two Playwright specs that depend on the native dialog — e2e/master-browser-acceptance.spec.ts:122 (`page.on("dialog", (dialog) => void dialog.accept())`) and e2e/conversation-navigation.spec.ts:79 (`page.once("dialog", ...)`) — to click the in-app confirm button instead; otherwise the removal assertions on the following lines will fail.

Alternative that needs no new CSS: reuse the app's other existing destructive pattern, the armed two-step "Confirm disconnect" button in src/ui/provider-connections-view.tsx:317-344, which already has a source contract test at src/ui/provider-connections-view.test.ts:76.
