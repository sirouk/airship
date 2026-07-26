# Airship — Human-Perspective Punch List

*Synthesis of 7 reviewer lanes, 84 raw findings, deduped to 66 items. Every item below was seen in the running app on a real viewport; source anchors were verified against the tree at HEAD.*

---

## Overall verdict

**Airship is a genuinely serious product with a presentation layer that is not yet finished, and it should not go in front of a public first-run audience today.** The substance is real and rare: a live WebContainer shell, a real editor, browser-owned Git, all working with zero credentials; a connect flow whose "catalog metadata is not proof" framing is more honest than anything else in this category; error copy that is more human than most shipping agent products; an approval dialog that is textbook-correct for accessibility; a focus ring at 10:1 on a dark theme. Multiple independent reviewers used the phrase "best I have seen" about the trust prose specifically.

And yet: a brand-new visitor with no credentials reaches a working agent essentially **0%** of the time, because the recommended connect button fails with an error addressed to the developer and nothing anywhere tells them where to get a key. On desktop — the primary way this is used — **no one can copy an answer, retry a turn, or fork a session**, because all four message actions render inside a permanently-closed `<details>`. And the surface the entire pitch rests on contradicts itself: after one successful TEE turn you can have, inside a single 900px viewport, "Evidence unavailable," "E2EE · evidence recorded," "Evidence not pulled," "TEE verification — Not established," and a green "VERIFIED — Protected CPU runtime." Four lanes hit that wall independently.

None of this is architectural. There is no finding in this list that requires re-thinking how the product works. It is naming, one state machine for trust vocabulary, a `<details>` element used wrong, a fixed tab bar treated as free space, and a first screen that advertises three things that fail while hiding the three things that work. That is roughly **two to three weeks of focused presentation-layer work** — and on the other side of it, this is the rocketship. Ship it after the blockers, not before.

**How to read the counts:** where multiple reviewers hit the same wall from different pathways, I've merged them and noted "*N lanes*". That count is severity signal — it means the problem is not viewport-specific or task-specific, it's structural.

---

## BLOCKERS
*A real person cannot complete a core task, or is actively misled.*

### B1. The trust summary layer contradicts itself, four ways, in one viewport — *4 lanes*
**Where** `#chat` top-bar pill + session-model badge + message receipt chip + claim-stack rail; `#proof` → Receipt & journal. 1440×900, connected, after one completed Chutes TEE turn.

**What a user experiences** Simultaneously on screen: top-bar `◈ Evidence unavailable` (amber) · session-model badge `E2EE · evidence recorded` (green) · receipt chip `◈ Evidence not pulled` · rail `○ Turn receipt only — 7 established · 1 not established` · `#proof` card `TEE verification / Not established / compatibility mode` · and 300px below that, `VERIFIED 1 — Protected CPU runtime — ✓ Verified`, whose own expansion says *"Intel DCAP QVL verified the TDX quote… locally in this browser."* One reviewer also saw a settled receipt silently mutate from "Evidence not pulled" to "Secure hardware evidence pending" on re-render — a negative quietly upgraded to an open question with no new evidence. The most prominent and most colourful of the six is the optimistic one.

A careful user cannot answer the single question the product exists to answer. A careless one reads the green check and over-trusts. Both stop reading the paragraph-level honesty, which is where all the real value lives.

**Fix** One state value, one canonical string, one glyph, driven from one source, resolved per receipt.
- Three states only: **`Endpoint evidence verified`** / **`Endpoint evidence pending`** / **`No endpoint evidence`**. Glyphs: `●` verified, `◐` asserted-not-verified, `○` not established. Publish that three-glyph key in a hover/tap on the Proof header.
- Delete as top-level status strings: "Evidence unavailable", "Evidence not pulled", "Evidence checked per turn", "Not established", "Turn receipt only". Keep them at most as body text inside an expansion.
- The session-model badge must read the receipt's own state. It may never say "evidence recorded" until at least one claim leaves `Asserted`. Disconnected/unpulled → `E2EE · no endpoint evidence`.
- A settled receipt never transitions from a negative label to a pending one.
- `#proof`: each card names its own scope. `src/ui/proof-view.tsx:133` sets `teeVerified = receiptSeal === "verified"` — the *whole-receipt* seal — and then renders it under the label "TEE verification". Report the `cpuTee` claim instead: title **"CPU TEE (Intel TDX)"**, value **"Verified in this browser"**, sub-line **"DCAP QVL · not bound to this exact turn"**. Move the gate fact to its own card: **"Endpoint-proof gate — Not required (compatibility)"**. Banner: **"No separately fetched endpoint record matches this turn, so Airship infers no claim beyond what the turn receipt itself carries."** Top-bar pill: **"TEE verified · endpoint not turn-bound"**.

---

### B2. Copy, Retry, Fork session and Edit & resend are invisible and unreachable on every desktop viewport — *2 lanes*
**Where** `#chat`, every message, 1280×800 and 1440×900. `article.message > details.message-actions`.

**What a user experiences** Nothing. Hovering a message paints an empty ~70px band. A 70-press Tab walk goes from the banner button straight to the starter chips. `getByRole('button', {name:'Copy'})` returns zero matches; the aria snapshot shows an empty `- group`. Screenshots clipped to the exact reported bounding box of the Copy button (847,661,48×15) are blank pixels. `elementFromPoint` returns the wrapper, not the button. The dead subtree still occupies a measured 717×36 invisible block plus margin **inside every message**. At 390×844 the same menu works perfectly — only the desktop path is dead.

So on the primary form factor you cannot copy an answer, retry a failed turn, edit a prompt, or fork a session. Meanwhile the cancel banner instructs "Retry is available," pointing at a control that does not exist (see B5/M3).

**Fix** `src/ui/styles.css:1796` sets `.message-actions > summary { display: none }` while the element stays a closed `<details>`. Modern Chromium/WebKit/Gecko no longer paint closed-details content (`::details-content` is `content-visibility: hidden`), so the `.message:hover` reveal rule can never take effect. Render the desktop variant as a plain `<div role="toolbar" aria-label="Message actions">` that is `opacity:0; pointer-events:none` until `.message:hover, .message:focus-within`, keeping the buttons **in the tab order** so keyboard focus reveals them. Keep `<details>` only inside the existing `@media (hover: none), (max-width: 640px)` block. Raise the hit target from 15px to ≥24px (44px on touch).

---

### B3. A new visitor with no credentials cannot connect at all
**Where** `#access` → "Continue to Chutes", 1440×900 and iPhone 14 Pro Max.

**What a user experiences** The primary gold button, labelled **"Recommended"**, returns a red inline error: *"The local Chutes OAuth bridge is not configured. Restart the Airship companion with its process-held client secret."* No link, no next step, no pointer to the working path — which is sitting collapsed directly beneath, behind a row labelled **"Advanced: use a Chutes API key instead"**, which most people correctly read as "not for me." If they do open it, they find a `cpk_` badge, a field, and **no link anywhere to obtain a key**. This is the terminal drop-off. Measured conversion for this population: ~0%. (Visitors who already hold a key and are stubborn enough to open "Advanced" after the primary button errors: ~80% connect in 4 clicks.)

**Fix**
- When the bridge is unconfigured, **do not present sign-in as the recommended path at all.** Auto-expand the API-key panel and lead with it.
- Replace the error with: **"Chutes sign-in isn't available in this build. You can connect with a Chutes API key instead."** followed by two real controls: `[Use an API key]` `[Get a key at chutes.ai ↗]`.
- Under the key field, always: **"Don't have one? Create a key at chutes.ai → API keys ↗"** as a live link, and expand the `cpk_` badge to a sentence: **"Chutes personal keys start with `cpk_`."**

---

### B4. The first screen invites you to do three things, all three fail, and hides the three things that work
**Where** `#chat` cold, no storage, no vault. `.transcript-starters` + disconnected banner. Desktop and phone.

**What a user experiences** There is no landing page — you're dropped into `#chat` with a header of status pills. In the first 10 seconds you learn the product name and nothing else. All three suggestion cards prefill a real prompt and return the **byte-identical** canned sentence: *"Airship is running this turn entirely on your device with the deterministic demo provider. Try /write notes/hello.md…"*. "Explain my trust posture" does not explain the trust posture. "Read README.md and get oriented" does not read README.md — even though README.md (1.1 KiB) demonstrably exists and is visible at `#workspace`. "What can run here?" does not list runtimes, though that list is static local knowledge. The welcome message says "Try /help"; the first Enter appears to do nothing.

Meanwhile the disconnected banner's *only* statement about offline capability is "Slash commands work here without inference" — while `#terminal` cold renders a live WebContainer shell at `~/airship-node/airship-workspace` with a pre-filled `git status` bridge, and `#workspace` cold renders a real explorer with three files and a Source Control tab showing 3 changes. The single most differentiated thing in the product is invisible at the exact moment someone decides whether to care.

**Fix** Rebuild the disconnected first screen around what actually works.
- Replace the three cards with: **"Open a terminal — real Node processes in this tab, no account"** · **"Browse the workspace — README.md, real Git, 3 uncommitted changes"** · **"Connect a model — only chat needs this"**.
- Banner copy: **"Workspace, editor, terminal and Git work right now. Chat needs a model provider."**
- If you keep answer-shaped cards, make them local-first commands that genuinely resolve: "Explain my trust posture" renders the `#proof` claim-stack summary inline; "Inspect this workspace" runs the real read-file path against README.md and prints it; "What can run here?" prints the runtime inventory. A card that cannot work without inference must not render in the disconnected state.

---

### B5. The approval dialogs — the trust contract — do not show what is about to happen
**Where** `#chat` capability-request modals, 1440×900. Three separate failures, one presentation layer.

**What a user experiences**
1. **Delete says Create.** Asked to delete `/workspace/demo/c.txt`. The modal `Allow remove_file once?` shows the target path and, beside it in highlighted amber — the one field styled to draw the eye — **`Change: Create`**. New size and Size delta both read "Not supplied." Nothing on the modal says a file will be destroyed except the raw tool name in the title.
2. **The batch writer shows nothing.** Three files in one turn produced one modal, `Allow text_editor once?`, whose body reads *"Every possible mutation is declared in this one approval-bound call"* and then declares none of them: no path, no file list, no size, no preview. The single-file `write_file` modal, moments earlier, had shown path, disposition, byte count and a full old→new diff. The approval with the widest blast radius carries the least information.
3. **The shell modal prints the grammar spec, not the command.** Asked for `ls -la`. The modal filled its body with a ~250-word manifest of quoting rules, parameter expansions, redirections and here-documents. The actual script appears **only** inside a collapsed "Arguments shown to the approval policy". Effect read `write` for a directory listing.

**Fix** One presentation contract: *headline states the action and its target; the body shows the change; the mechanism goes behind a disclosure.*
- `src/ui/approval-presentation.ts:26` derives disposition purely from `expectedRevision === undefined ? "Create" : "Replace"`, and delete calls carry no `expectedRevision`. Derive it from the tool's declared mutation kind. Render **"Delete"** in the destructive token, title **"Delete /workspace/demo/c.txt?"**, swap "New size"→"Current size", "Size delta"→"−N bytes", and show a bounded preview of what is being removed.
- Batch: **"Airship wants to write 3 files"** + one row per file (path · Create/Replace · bytes), per-file diff on expand. Never render a write approval whose only path information is behind collapsed JSON.
- Shell: headline **"Run a shell command in this workspace?"**, the script verbatim in monospace directly beneath, then one sentence — **"airship-sh runs entirely in this browser tab. It cannot reach your host filesystem, the network, git, python or node."** Grammar list behind **"What airship-sh supports ▸"**. Derive Effect from the parsed script.

---

### B6. A completed remote Chutes TEE turn is badged "Browser baseline"
**Where** `#chat`, assistant message header badge, immediately after connecting to `Qwen/Qwen3-32B-TEE`.

**What a user experiences** The reply bubble renders `Airship  ● Browser baseline` / `hello.` / `Final response · encrypted receipt ede5fa78` / `Evidence not pulled` — while the header chip on the same screen correctly reads `Chutes · Qwen3-32B-T…`. The answer came from a remote GPU. The badge on it says the browser.

This is the product's own failure mode pointed the wrong way: it tells the user inference happened on their device when it happened on someone else's hardware.

**Fix** Badge the actual execution origin of that turn: `Chutes · Qwen3-32B-TEE`. Reserve local wording strictly for the on-device demo provider and rename it **"On-device demo"** — "baseline" is not a location. If the badge is meant to describe the agent loop rather than the model, split it: `loop: browser` + `model: Chutes remote`.

---

### B7. The entire TRUST group is hidden and unclickable on ordinary laptop heights — *2 lanes*
**Where** left rail `.primary-nav`, all routes. 1440×900, 1440×800, 1440×700.

**What a user experiences** At 1440×700 the rail's content is 785px inside a 501px box: the list ends on a half-faded "Research" sub-item and **TRUST, Proof, Vault, Connection and Account are all below the cut**, behind the pinned AGENT PROFILE card. The only affordance is a 26px mask fade that lands mid-sub-item and reads as a rendering artefact. At 1440×900, "Connection" is present, half-visible, and dead to the mouse — `elementFromPoint` at its centre returns `DIV.sidebar-spacer`, and clicking its real bounding box leaves the URL at `#chat`. At 1440×800, clicking where Connection reports itself to be navigates to `#profiles` instead. And `scrollTop` is **0** on `#proof`, `#vault`, `#connection` and `#account` — arriving at a Trust route by any means leaves its own nav item off-screen.

On a 13" MacBook or a 1366×768 Windows laptop, the pillar the entire product is built to sell is undiscoverable. A first-time user concludes Airship has Chat, Workspace, Memory and Profiles.

**Fix** (1) `scrollIntoView({block:'nearest'})` on the active `.nav-item` on every route change. (2) Reserve space for the pinned profile card — `padding-bottom` equal to its height on the nav scroll region — and set `pointer-events: none` on `.sidebar-spacer`. (3) Replace the mask fade with an explicit clickable cue pinned above the profile card: a 28px strip reading **"3 more ▾"** (live count) that scrolls the rail. (4) Below ~820px height, collapse the recent-conversations list and Profiles children to one row each so the 7 canonical destinations always fit.

---

### B8. On a phone the app never once says your work is ephemeral — *2 lanes*
**Where** `#chat`, 390×844 and 393×852.

**What a user experiences** `.topbar-center` is not visible; `.durability-indicator` ("Ephemeral · this page only"), `.session-attestation` ("Secure hardware not checked · this session") and `.session-lifecycle` all return `isVisible() === false`. What survives in the session header is a single pill reading **"Session"** with an empty circle — and tapping it navigates away from chat to the conversation list. Desktop shows `○ Secure hardware not checked · this session · ○ Ephemeral · this page only`; the phone collapse kept the *scope noun* and discarded the *claim*.

So the words "Ephemeral", "page only" and "not checked" never appear anywhere in the phone chat experience. A phone user writes into an ephemeral session with zero indication and loses it on reload — and is shown strictly less caution than a desktop user looking at identical facts.

**Fix** Replace the "Session" pill with a durability chip whose label **is the state**: **"Ephemeral"** / **"Encrypted · this device"** / **"Encrypted · synced"**, coloured as on desktop. Tapping opens a sheet with all three posture lines and their existing tooltip sentences — tooltips are unreachable on touch, so that sheet is the *only* place a phone user can ever read them. Rule: when space forces a collapse, drop the scope, never the claim. `○ Not checked`, never `○ Session`.

---

### B9. The fixed bottom tab bar is treated as free space, and it eats the last step of onboarding
**Where** `#access` after "Discover models with key", `#terminal`, `#editor`. 430×932 and 360×800.

**What a user experiences**
- **"Finish: verify & connect"** — the only way to complete connection — measures bottom edge 908 while `.mobile-nav` occupies 876–932 opaque. A first-time phone user sees a ~10px nameless brass sliver behind the tab bar. The route scrolls, but at the resting position after discovery the CTA lands exactly underneath.
- **The terminal's entire durability footer is 100% invisible.** `.terminal-route__footer` sits at 875–905 under the same bar, and the route does not scroll at all (`scrollHeight === innerHeight === 932`; `window.scrollTo` produces no change). Its text — *"Tab metadata is stored through the active encrypted workspace. Process memory remains page-local."* — is never rendered to a user. Its child spans also overflow horizontally to right:449, 663 and 837 on a 430px viewport. Losing exactly the honesty line on the one surface where people run real commands is the wrong thing to lose.
- **The editor** leaves its last ~110px behind the bar until you discover the route scrolls.

**Fix** One rule, three fixes: `padding-bottom: calc(56px + env(safe-area-inset-bottom))` on every mobile route scroll container. Then `scrollIntoView` the Finish button after discovery resolves, and make `.terminal-route__footer` a wrapping flex column below 640px so all four facts stack above the bar.

---

### B10. The Sessions route calls a completed turn "Unfinished · Fork required · HISTORY INCOMPLETE"
**Where** `#sessions` detail panel, 1440×900, immediately after one successful Chutes turn.

**What a user experiences** Within ~150 vertical pixels: a warning-triangle badge **"Unfinished — 103 of 103 events inspected · 1 turn"**; a status cell **"● Last turn completed"**; and **"RUNTIME DECISION: Fork required / HISTORY INCOMPLETE / The session ended mid-turn or was only partially inspected; fork before continuing."** The primary button is a gold "Fork to continue" and "Active session" is greyed out — while the chat composer for that same session is fully enabled and accepting input.

The trust surface contradicts itself about the most basic fact in the product: did my turn finish. The user forks a conversation they did not need to fork, and permanently doubts every other claim the app makes.

**Fix** "Session is resumable" becomes one computed value with one name, rendered identically on both routes. If the intended meaning is "this journal has not been re-verified since the turn," say exactly that — **"Not re-inspected since last turn · fork not required"** — and delete the words *Unfinished*, *HISTORY INCOMPLETE* and *"ended mid-turn"*, which assert something factually false. Reserve "Fork required" for sessions whose pin genuinely no longer resolves. Keep "Active session" enabled whenever the composer is enabled.

---

### B11. The default vault dead-ends any deployment not built with a Google client ID, and the page's only primary button does nothing — *2 lanes*
**Where** `#vault`, 1440×900, with `VITE_GOOGLE_CLIENT_ID` unset (the shipped-unconfigured case).

**What a user experiences** Storage provider defaults to Google Drive. Where the connect flow should be, the "RECOMMENDED DURABILITY" panel renders exactly one thing: *"Set `VITE_GOOGLE_CLIENT_ID` to a Google OAuth Web client ID, enable the Drive API, and allow this page origin."* No button, no link, no mention that Local Device exists. The only forward action on the page is the brass **"Configure vault"** — which, activated by mouse or keyboard, produces *nothing*: `main.innerText` is byte-identical before and after (1105 chars both times), scrollTop unchanged, focus unmoved. It calls `setVaultSetupOpen(o => !o)` and the section below renders regardless of the flag.

So the recommended durability path is a hard stop written for a maintainer, and the escape hatch is an inert button. A fully working encrypted Local Device vault is one dropdown away and is never mentioned.

**Fix**
- Replace the notice with a user-facing card: headline **"Google Drive isn't available on this deployment"**; body **"This build wasn't published with a Google client ID, so Drive can't be connected here. Local Device gives you the same encrypted, client-owned workspace, stored in this browser and available offline."**; primary button **"Use Local Device instead"** wired to the existing provider switch. Put the env-var text inside a collapsed **"Deployment setup"** for operators.
- Make "Configure vault" scroll its target section into view and move focus to its `<h2>`, or delete it. If it stays a toggle, give it `aria-expanded` and actually gate the section on the flag.

---

### B12. Both jump-tabs on the Connection page eject you to Chat
**Where** `#connection`, 1440×900, disconnected.

**What a user experiences** Clicking **"Other cloud & local models"** — the obvious control for "I want to use Ollama or another key" — navigates from `#connection` to `#chat` and renders the chat view. So does "Chutes · encrypted". They are anchors (`href="#additional-inference-providers"`, `href="#chutes-connection-card"`) whose fragments collide with the hash router, which falls back to `#chat`. No error; you are simply thrown out of the Trust section and lose your place.

**Fix** Make them buttons that call `scrollIntoView` on the target section (or `preventDefault` and scroll), with `aria-current` styling. They must not touch `location.hash` while the hash is the router.

---

### B13. Phone landscape silently loads the desktop shell into a 94px slit
**Where** every route at 932×430 (14 Pro Max landscape) and 667×375 (SE landscape).

**What a user experiences** Rotating crosses the 640px width-only breakpoint. `.mobile-nav` computes to `display:none` (measured height 0) and the desktop shell loads. In the same frame `.topbar-actions` measures `right: 1033` on a 932px viewport with **no horizontal scroll**: "Open command palette" is clipped at x 901–935, **"Open Preferences" (944–978) and "Open proof" (987–1021) are entirely off-screen**. The rail has no Settings entry, so Preferences becomes reachable only through a 31px visible sliver of the palette button. And `.transcript` measures `clientHeight = 94` against `scrollHeight 399` — two lines of the answer between a three-row session header and the composer. At 667×375 it is `clientHeight = 40`: one and a half lines.

Landscape is how people type with two thumbs, and it is the one orientation where reading the answer is impossible. "Honestly degraded" would be fine; this is silently unusable.

**Fix** Gate the mobile shell on height as well as width: keep the mobile layout at `(max-width: 926px) or (max-height: 500px)`. Until that lands, make `.topbar-actions` overflow-safe — collapse Preferences and Proof into the profile menu below 1000px rather than laying out past the viewport edge. In the mobile shell at short heights, collapse the session header to a single 44px row (title + model chip, tap to expand) so the transcript keeps ≥50% of the viewport.

---

### B14. The Terminal is a keyboard trap
**Where** `#terminal`, 1280×800, `textarea[aria-label="Terminal input"]`.

**What a user experiences** Focus the terminal, press Tab three times: `document.activeElement` stays on the terminal textarea every time. Escape does nothing. Only Shift+Tab escapes, and nothing on screen says so. The input is also an `opacity:0`, 8×18px overlay, so the brass focus ring it receives is invisible — nothing indicates the terminal has focus except a blinking caret.

WCAG 2.1.2. A keyboard-only user who enters the Terminal cannot leave it going forward.

**Fix** Let Tab move focus out by default; swallow Tab only when a completion popup is actually open. Add a persistent caption under the frame: **"Press Shift+Tab to leave the terminal."** Give the focused frame (not the 8×18 shim) a visible `2px solid var(--focus)` ring via `:focus-within`.

---

## MAJOR
*Task completes, but the person is frustrated, confused, or misinformed.*

### M1. Every assistant message ends with the literal string "TURN COMPLETED."
**Where** `#chat`, footer of every assistant message, all viewports.
**Experience** A horizontal rule, then `TURN COMPLETED.` in small-caps grey, two pixels from a timestamp and a receipt chip that already say the same thing. It is the single loudest signal that this is a debug console rather than a product. After an interruption it becomes `STOPPED — PARTIAL RESPONSE KEPT.`
**Fix** `src/ui/chat/message-parts.ts:408` emits `summary: "Turn completed."` as a visible footer part. Delete the successful-completion summary entirely. Keep the footer only for non-normal endings and write it as a sentence: **"Stopped. Partial response kept."**

### M2. Every tool row says "Tool step completed" — you cannot tell what the agent did
**Where** `#chat`, tool rows inside assistant messages.
**Experience** Reading README.md produced two stacked rows, both headed **"Tool step completed"**, with tiny grey `TOOL CALL / read_file` and `TOOL RESULT / read_file` and COMPLETED/SUCCESS pills. **No path anywhere.** Expanding dumps the file then a boxed `METADATA · BOUNDED DISPLAY` panel containing raw JSON. A failed read auto-expanded to a box containing the literal word `null`, plus a bare `call_e362dc6d0b334f39a675fb17`. Scrolling a transcript, a human cannot tell which files were read or which command ran.
**Fix** Put the argument in the headline: **"Read /workspace/README.md"**, **"Wrote /workspace/notes/hello.md (64 bytes)"**, **"Ran `ls -la`"**, **"git status on airship-workspace"**. Merge call+result into one row that changes state. Render metadata as labelled fields (Path / Revision / Size) and omit the block entirely when null. Drop the bare `call_…` id from the transcript body.

### M3. Stopping or losing a turn produces three overlapping notices, one styled as an error with a raw event code — and two of them are false — *2 lanes*
**Where** `#chat` after clicking stop mid-stream, and after `setOffline(true)` mid-turn.
**Experience** Stopping a turn — a normal, successful action — renders: a bordered warning card with a triangle reading **`turn.cancelled / Chutes inference was cancelled.`**; the partial text; a second warning card **"Turn stopped safely / Stopped — partial response kept. / Retry is available."**; then a third line **"STOPPED — PARTIAL RESPONSE KEPT."** On the network-failure path the same shape appears — and a DOM-wide scan for `/retry|resume|try again/` returns **NONE** (the only Retry lives in the unreachable menu, B2), while the ~500 streamed words are **not shown anywhere** in the message. The app tells the user two concrete, checkable things and delivers neither.
**Fix** One calm notice below the partial text: **"You stopped this turn. The partial response above was kept."** — with a real, visible Retry button *inside that card*. For failures: **"Connection lost. The partial response above was kept."** plus `Retry turn`. If the partial text is not actually rendered, the copy must read **"Partial response discarded."** Never surface `turn.cancelled`; reserve error styling for actual failures. Keep the good part — restoring the original prompt into the composer.

### M4. Streaming answers re-announce the entire growing message to screen readers on every chunk
**Where** `#chat`, `div.message-part.text.streaming[aria-live="polite"]`.
**Experience** A MutationObserver on live regions recorded **30 mutations for a two-sentence reply**, 13 of them carrying the complete final text and the rest carrying growing prefixes ("Tea", "Tea is a fragrant", "Tea is a fragrant beverage made"…). No `aria-atomic`, no `aria-relevant`, no `aria-busy`. On completion the live wrapper is removed, so nothing announces that the answer finished. For a 900-word answer this is not degraded, it is unusable, and the only escape is leaving the page.
**Fix** Remove `aria-live` from the streaming part. Set `aria-busy="true"` on the assistant `<article>` while the turn runs. On completion set `aria-busy="false"` and announce once through a single dedicated polite region: **"Airship replied. 2 sentences. Press Shift+Tab to review."** Leave the body to the reader's own navigation.

### M5. Connecting a provider silently abandons the conversation you were in
**Where** `#chat` → `#access` → connect → back, 1440×900.
**Experience** The natural first-run sequence is try → hit the wall → connect → continue. Airship breaks "continue": the transcript returns empty except a connection notice, and the sidebar now holds two identically-styled rows — the new "General conversation — No messages yet" and the orphaned "hello, who are you? — Airship: Airship is running this turn entirely on your device wi…". Nothing explains the switch. Users read this as data loss.
**Fix** Stay in the same conversation and append a system line: **"Connected to Qwen/Qwen3-32B-TEE. Earlier turns in this conversation ran on the on-device demo responder."** If model pinning genuinely forbids that, say so and offer the choice: **"This conversation is pinned to the demo responder. [Continue here] or [Start a new conversation on Qwen3-32B-TEE]"**.

### M6. The composer's privacy chip changes subject when you connect, and vanishes when you touch it — *2 lanes*
**Where** `#chat` composer meta row.
**Experience** Disconnected: `+ Attach image · 🔒 page memory only · ● ✓ Ask First`. After connecting: same slot, same lock glyph, now **`🔒 credential in memory`** — the chip silently changed from describing *your conversation data* to describing *your API key*, with no visual signal, at the exact moment the user is most anxious. Separately, **hovering or clicking anywhere in that row collapses it** to `+ ●Ask First` — "Attach image", the lock icon and the words "page memory only" all disappear and the composer shrinks. A privacy assertion that vanishes when you reach for it.
**Fix** Keep a permanent memory-scope chip with a stable subject: **"page memory only"** / **"encrypted vault"**. Move the credential statement to the model chip on the right (**"Qwen3-32B · key in page memory"**). Fix the row to a stable height; never hide labels on hover or focus. Under width pressure, drop the "Attach image" text label — never the privacy chip.

### M7. The slash palette is an alphabetical dump that pre-highlights a runtime teardown and hides /help — *2 lanes*
**Where** `#chat` composer `/` palette, desktop and phone.
**Experience** Typing `/` renders exactly 10 entries with no "…N more" indicator, alphabetically, **with `/deactivate-execution-runtime` first and pre-selected** — pressing Enter, the first thing anyone does with a `/` menu, tears down a runtime. Then five near-identical `/execute-*` entries. `/help` — which the welcome message tells you to use — **cannot be found by browsing at all**. On mobile the palette covers the entire conversation and descriptions truncate at ~35 chars.
**Fix** Rank by usefulness when the query is empty: a **"Start here"** group with `/help`, `/list-files`, `/read-file`, `/write-file`, `/git-inspect`; **"Advanced"** for the `execute-*`/`deactivate-*` verbs. Never pre-select a destructive entry — open with no selection. Footer: **"Showing 10 of 30 — keep typing to filter"**. One-line descriptions in the picker; the paragraph belongs in `/help`. Mark destructive entries distinctly and confirm them.

### M8. The app's own instructions cite commands that don't exist, and mistyped commands silently rewrite themselves
**Where** `#chat` disconnected, demo reply + composer.
**Experience** The only instruction the demo provider ever gives is *"Try /write notes/hello.md followed by content, /read notes/hello.md, or /ls."* Two of those three do not exist. Typing `/ls` + Enter replaced the composer with `/list-files `; a second Enter replaced it with `/list-files --path ` — two keypresses, nothing sent, no output, no error. The user cannot tell whether they mistyped, the app is broken, or something needs connecting.
**Fix** (1) Correct the copy to real command names: **"Try `/list-files`, then `/write-file notes/hello.md 'hi'`, then `/read-file notes/hello.md`."** (2) Register `/ls`, `/read`, `/write`, `/cat` as real aliases — people will type them regardless. (3) Never silently replace typed text: either run it and show **"ran /list-files"**, or show **"No command /ls. Did you mean /list-files?"**

### M9. Vocabulary: the same concept has two to four names, often on one screen
**Where** All 14 routes, swept at 1440×900.
**Experience** Observed synonym sets, all rendered: **session / conversation / thread** — `#sessions` alone uses all three, `#terminal` calls the same id "Thread e883c2a…a0bbf", `#chat` calls it "#e883c2ae" (three truncation styles for one identifier). **vault / storage provider / durability / object store / workspace key** — four on one screen, and Preferences calls the same setting "Durability". **Preferences** (desktop) vs **Settings** (mobile). **Minimum posture** vs **MINIMUM PROOF** — same value, 250px apart on `#profiles`, reading as two settings. **Connection** (nav) vs "Connect models" (h1); **Account** (nav) vs "Account standing" (h1) — the only two routes whose title disagrees with its own nav label. **Five verbs for one action**: Connect inference / Connect models / Continue to Chutes / Connect Chutes / Connect. And "Verified" means a TEE claim on `#proof` and credential validity on `#account`.
**Fix** Publish and enforce a one-word-per-concept glossary: **conversation** everywhere (retire *session* and *thread* from user copy; render `sessionId` one way only — lowercase, middle ellipsis). **Vault** everywhere (Storage provider → "Vault provider"; Durability → "Vault"; object store → "provider"). **Settings** everywhere. **Minimum proof** everywhere. Rename h1s to match nav: "Connection", "Account". One connect verb: "Connect models" on the route, "Connect" on every button.

### M10. Five different tab-strip components across five routes, and the Agent strip jumps 561px when you click Skills
**Where** `#workspace`, `#memory`, `#profiles`, `#capabilities`, `#skills`, `#proof`.
**Experience** Five implementations of "switch between siblings": Trust bar (full-width, outlined-gold active); Workspace (compact, dark-fill active); Memory (compact, **solid gold** active); Profiles/Capabilities (full-bleed thirds, solid gold); Proof (compact, dark fill). Two use gold, three use dark; two full-width, three compact. Measured: on `#profiles` each Agent tab is 381px with Skills at x=1029; on `#skills` the same three collapse to 100px with Skills at x=468 because an "APPLIES TO" control mounts — **the button you just clicked leaps 561px left.** Meanwhile the Work group (Workspace/Editor/Terminal) has no sibling strip at all.
**Fix** One tab component, one active treatment: compact left-aligned pills with dark-fill active. Reserve solid gold for primary actions only — right now "Capabilities" out-shouts the page's real CTA. Give the Agent strip `max-content` width so it cannot resize when "Applies to" mounts. Add the same strip to Work.

### M11. `#workspace` and `#editor` render byte-identical pages, and the title disagrees with the nav
**Where** 1440×900.
**Experience** Diffed main-region innerText: identical. Both show eyebrow "DEVICE-EXECUTED · PAGE WORKSPACE", h1 **"Editor"**, the same strip and panes. On `#workspace` the rail marks **Workspace** as `aria-current=page` while the page is titled after its child. Two rail rows, two hashes, one DOM. A user cannot build a mental model of where they are, and "Editor" appears to be two destinations.
**Fix** Either give `#workspace` real container content (repo/branch state, dirty-file count, terminal count, storage target, cards linking into Editor and Terminal), or delete the Editor child row and title the h1 "Workspace". Do not ship two hashes rendering the same DOM.

### M12. Header status seals silently navigate, and their explanation lands on top of the page you were teleported to
**Where** global top bar, 1440×900.
**Experience** All three pills are the same `.status-seal` with the same border and `cursor:pointer`. Clicking navigates: runtime → `#proof?session=…`, Ephemeral → `#vault`, Connect inference → `#connection`. Nothing distinguishes the two *status* chips from the one *action* chip. Worse, the runtime seal's tooltip ("The agent kernel is executing in this browser; no remote proof is implied.") is still rendered after the route change — captured floating over `#proof`, obscuring that page's own tab bar. It reads as a bug, and it teaches people to stop touching the status chips.
**Fix** Split the interaction: click/Enter expands the seal **in place** into its full claim, with an "Open Proof →" link inside the expansion. The chip body does not navigate. Dismiss on route change and Escape. Style the action seal as a button, visually distinct from claims. Normalise the seal's target to the same hash the rail uses (it currently produces `#proof?session=…` vs bare `#proof`).

### M13. The top-bar trust claim truncates mid-phrase at 1440px — "Evidence checked per turn" reads as "Evidence checked"
**Where** global top bar, `#chat`, 1440×900, connected.
**Experience** Three truncated pills on a 1440px monitor: `Chutes · Qwen3-32B-T…`, **`◐ Evidence checked per …`**, and `Encrypted session ready · endpoint evidence recorded after comple…`. The ellipsis removes "per turn" — the qualifier that makes the claim true. On iPad Pro 11 the runtime seal degrades to `Browser / Ed…`.
**Fix** Trust pills must never ellipsis-truncate a claim. Shorten the source strings to fit the smallest desktop pill: **"Per-turn evidence"**, **"Chutes · Qwen3-32B"**, **"Encrypted · evidence per turn"**. If a string still cannot fit, move the whole pill into an overflow chip (**"+1 claim"**) rather than rendering half a sentence. Tablet seal: **"Browser"**, not `Browser / Ed…`.

### M14. Six green "Passed" checks over a journal with one event and no turns
**Where** `#proof` → Receipt & journal, fresh page, zero completed turns.
**Experience** "Session journal — Journal structure passed — 1 event" above a 3×2 grid of **six green ✓ Passed** tiles: Schema, Hash chain, Manifest, Turn protocol, Receipt bindings, Complete history — for a session that has never done anything. The honest caveat ("A valid hash chain is not proof of authorship") is one grey paragraph against a wall of green. This is the first empty state a newcomer sees, and it manufactures reassurance out of nothing — the product's own anti-pattern, expressed visually instead of in words.
**Fix** When `commitment.sequence < 2` or `turns === 0`, replace the grid with one neutral row: **"Nothing to check yet — 1 event, no turns. Checks appear after the first completed turn."** Reserve the green tiles for a journal that contains a turn.

### M15. A loopback MinIO on plain HTTP is labelled "Cloud Vault active"
**Where** `#vault` with provider = S3-compatible / MinIO, lab endpoint connected.
**Experience** Green pill **"Cloud Vault active"**, eyebrow **"PRIVATE CLOUD STATE"**, sub-head "Encrypted journal and workspace state travel directly between this device and the selected object store" — and the config table immediately below reads `ENDPOINT http://127.0.0.1:9900`. Meanwhile "Data synchronization: **Not evaluated**" sits quietly among six "Verified" rows. Anyone running the lab, or any self-hoster pointing at a machine-local MinIO, is told their work is off-device when it is on the same disk as the browser.
**Fix** Derive the label from the endpoint host. `localhost` / `127.0.0.1` / `[::1]` → pill **"Local S3 vault active"**, eyebrow **"On-device object store"**. Only a non-loopback endpoint earns "Cloud". Promote the sync row out of the Verified grid to a line under the headline: **"Nothing has been checked about off-device replication."**

### M16. With nothing connected, the most prominent card reads "SESSION MODEL / airship/demo-v1 / Local"
**Where** `#chat` cold, top-right card (desktop) / under the title (mobile).
**Experience** A model-shaped name, a `Local` pill, and a header reading "Local kernel ready". Nothing says "no model connected". A user reasonably concludes a local model is loaded and running on their machine — the single most valuable claim in this space. They then send a message, receive a fluent sentence in an assistant bubble with a receipt hash, and the false belief is confirmed.
**Fix** Disconnected: **"SESSION MODEL / None connected"** with a muted `Connect` affordance. If the demo provider must be named, label it **"Demo responder (not a model)"** and drop the `Local` pill — in this product "Local" means "ran on your device", a claim the demo responder does not deserve.

### M17. "Edit & resend" does not edit and does not replace
**Where** `#chat`, user message actions (reachable only at 390×844 today).
**Experience** Choosing it leaves the popover open, drops the original text into the composer, and shows nothing in the transcript to indicate an edit is in progress — no highlight, no chip, no cancel. Sending took the DOM from 17 message articles to **19**: the original message and its answer remain above, unchanged and still in provider context. The name promises the ChatGPT/Claude behaviour. Notably, Retry's tooltip is scrupulously honest about exactly this ("The earlier answer stays in the transcript and in provider context") — Edit & resend carries no such warning.
**Fix** Either implement the branch (truncate from that message, re-send, show the discarded branch as collapsible history), or rename it to what it does — **"Copy to composer"** — and give it Retry's honesty tooltip. If kept as-is, add an editing banner above the composer naming the message being reused, with Cancel, and close the popover on selection.

### M18. At 1024×768 the model name disappears and the transcript becomes the narrowest column
**Where** `#chat`, 1024×768 (fine again at 1280×800).
**Experience** The session-model card collapses to `CHU…` above an **empty select** — nothing on screen names the model answering you. The header wraps to four lines, pushing the transcript down ~300px. The rail keeps ~232px and the claim stack keeps ~260px while the transcript is squeezed to ~500px: the reading surface loses to two chrome panels. Chips truncate to `Browser / Ed…`, `Chutes · GL…`, `Evidence una…`.
**Fix** Below ~1200px, collapse the claim stack to a header toggle chip rather than a permanent 260px column. Make the model name the *last* thing to truncate in the session card — truncate the "CHUTES · SESSION MODEL" eyebrow instead — and never render the select with an empty label.

### M19. A turn can hang in "Thinking" indefinitely after the network dies
**Where** `#chat`, live turn with the network cut at t+10s.
**Experience** 100 seconds after the cut, the header still showed the thinking chip, the message still said "Thinking" with 2,659 chars of partial essay, and the send button was still the armed stop button. No failure card ever appeared. The header pill *did* correctly flip to "Offline · local only" and the composer read "Offline · remote services are paused…" — which reads as "it will resume", so the user waits forever. A separate run failed at ~30s, so it is non-deterministic.
**Fix** Add a stall watchdog on the streaming reader: abort if no bytes arrive for 20s, or immediately when `navigator.onLine` goes false with a stream in flight, and render the same "Connection lost — [Retry turn]" card. Do not rely on `fetch` to error; an open stream often just goes quiet.

### M20. The connect flow is broken for keyboard users at its two pivotal moments
**Where** `#access`, 1280×800, keyboard only.
**Experience** (a) Pressing "Discover models with key" applies the `disabled` attribute to both the input and the button, so **focus falls to `<body>`** — sampled at 300ms, 1.5s, 4s and 8s: BODY every time, never restored. The page auto-scrolls to the newly-rendered model picker while the keyboard user's focus sits at the document root. (b) The model picker `div[role=dialog]` has **no `aria-modal`, no inert background, no scrim and no visible Close**; tabbing forward escapes the panel at Tab #18, which closes it on focus-out and drops the user on "Verify & record" behind where the overlay was. 42 of the next 60 tab stops were background controls. Escape does work correctly and restores focus.
**Fix** (a) Use `aria-disabled="true"` + `aria-busy="true"` instead of `disabled` so the button keeps focus; on resolve, move focus to the model-picker trigger. Keep the existing polite status text — it is already right. (b) Add `aria-modal="true"`, set `inert` on the app root while open, wrap Tab from the last item back to search, and add a visible Close button in the panel header.

### M21. Terminal output is pushed through an assertive live region, padded with ~20 empty list items
**Where** `#terminal`, `div.live-region[aria-live="assertive"]` and the output `<ul>`.
**Experience** `ls -la` sent its full output through an **assertive** region, interrupting whatever the user was hearing including their own typing echo. `npm install` or a `git log` would interrupt continuously with no way to defer. The output `<ul>` carries no `role=log` and its aria snapshot shows the real lines followed by roughly **20 consecutive empty `- listitem` entries**, so navigating by item means hearing "blank" twenty times after every command.
**Fix** `role="log" aria-live="polite" aria-atomic="false"`. Stop emitting empty `<li>` padding — give the container `min-height` in CSS instead.

### M22. Opening a second tab collapses the header and squashes the global controls over the sidebar
**Where** `#chat`, 1280×800, same vault open in a second tab.
**Experience** The notice "Open in another tab · page-memory state is not shared" is injected as a 210×33 span between wordmark and pills. `.topbar-actions` wraps to a second row at y=36 (bottom 70px) and **paints on top of the sidebar's "WORK" label**. The three header icon buttons shrink from 34px to **17px, 20px and 20px** — the ⌘ glyph visibly clipped — and the session status truncates to "Encrypted S3 vault a…". The chrome visibly breaks at exactly the moment the app is trying to reassure you about state sharing.
**Fix** Render the multi-tab notice as a full-width strip below the header, or collapse it to a **"2 tabs"** pill with the explanation in its accessible name. Give `.topbar-actions` `flex: 0 0 auto; white-space: nowrap` and let the wordmark/status shrink instead; icon buttons never below 34px, never wrapped.

### M23. On a phone, the receipt is half-clipped by the composer and the transcript never scrolls to the end of a completed turn
**Where** `#chat` after a completed live turn, 430×932.
**Experience** Six seconds after settling, `.transcript.scrollTop = 104` of a possible 255 — the view never reached the bottom. On screen: "TURN COMPLETED. 2:53 PM", then "Final response · encrypted receipt bad77648" with the **"Jump to latest" pill sitting on top of its right edge**, then **"Evidence not pulled" sliced horizontally in half** by the composer. The trust chips are precisely what gets hidden: the user reads "OK." and never learns evidence wasn't pulled.
**Fix** Auto-scroll to bottom on turn *completion*, not just on stream start. Give `.transcript` `scroll-padding-bottom` equal to the composer height. Move "Jump to latest" above the composer, out of the transcript's content flow.

### M24. Mobile Workspace: three tab strips under a marketing heading, first file 60% down the screen
**Where** `#workspace` / `#editor`, 360×800 and 430×932.
**Experience** Measured stack: outer tabs 66–119, page heading **131–293** (162px of eyebrow + H1 + two-line description + chip), mode tabs 376–424, Explorer/Source Control to ~470, "WORKSPACE +" row ~440–470, **first file row at y≈480** — 60% of a Pixel before one filename appears; 51.5% on a 14 Pro Max. Five file rows fit. The same place is called three things in that stack: parent tab "Files & editor", H1 "Editor", active sub-tab "Files".
**Fix** On mobile merge the two inner rows into one segmented control (**Explorer · Editor · Sources · Git**) and collapse the page heading to the H1 plus the Ephemeral chip on one line, description behind an info affordance. Target the first file row above y=240.

### M25. The first-run composer on a phone clips its own placeholder and runs it into the controls
**Where** `#chat` empty state, 430×932 and 360×800.
**Experience** Textarea height 52px against scrollHeight 63px: the placeholder "Ask Airship or type / for tools and session commands…" renders as two lines with the second **sliced through the descenders**, running up against the `+` and `●Ask First` chips. At 360×800 the word "commands…" never renders at all. The moment you type one character the composer switches to a clean, fully legible two-row layout — the correct variant already exists, two states away from the one every user sees first.
**Fix** Use the two-row layout unconditionally on mobile. If a compact resting state is wanted, shorten the mobile placeholder to **"Ask Airship, or / for commands"** so it fits one 52px line at 360px.

### M26. Mobile Sessions: filters and conversation cards are silent horizontal scrollers that chop text mid-word
**Where** `#sessions`, 430×932 and 360×800.
**Experience** Four filter triggers in one row with right edges at 468 and 602 on a 430px viewport, while `documentElement.scrollWidth` is still 430 — **no fade, no chevron, no scrollbar**. "All provider" is sliced flush at the edge; nothing indicates three more filters exist. The conversation list does the same: the second card renders as "General conver…" cut by the edge, and both cards share the same y — it is a horizontal strip, not a list. A user sees one filter and one and a half conversations and concludes that is all there is.
**Fix** Below 640px, stack the four filters as full-width rows under the search field (or collapse them into one "Filters" sheet), and make `.session-library-list` a vertical single column. Any horizontal strip that remains gets the standard edge-fade mask so the cut reads as "more".

### M27. Vault workspace-recovery renders raw grey system buttons on the one screen where a mistake is unrecoverable
**Where** `#vault` → Configure vault → "Workspace recovery", 360×800.
**Experience** "Create a new workspace" (202×26) and "Recover with Google Drive" (217×26) draw as **native grey/white system buttons with dark text on the dark panel** — no border, radius or brass — directly beneath the copy *"This key—not your Google account—decrypts the vault."* Grey-on-dark also reads as *disabled*. The "Show imported recovery key" checkbox is a 13×13 native control. 26px targets on a destructive-adjacent action invite mis-taps.
**Fix** Give `.google-drive-setup__secondary` and the unclassed recover button the standard button base (border, radius, padding, `min-height: 44px`); mark "Recover with Google Drive" as `button.primary`. Replace the native checkbox with the app's 44px-target pattern.

### M28. "Asserted verified" — status strings collide, and one renders with no space
**Where** `#proof` → Attestation evidence, Claim Detail panel.
**Experience** Claim tile: `◐ Asserted / Protected CPU runtime / Asserted verified · receipt unauthenticated`. Detail panel: **`Attested endpoint-key bindingASSERTED · ASSERTED PARTIAL · RECEIPT UNAUTHENTICATED`** — the technical label runs straight into the status because `<small>` and `<strong>` are adjacent inline siblings (`src/ui/attestations-view.tsx:315`). Another run produced `bindingASSERTED · LOCALLY MATCHED · NOT VERIFIED`. "Asserted" appears up to four times in one status line, and "Asserted verified" is a phrase with no meaning. The most important status string on the page looks like a rendering failure.
**Fix** Put the status on its own line (`<strong>` → `display:block`). Never concatenate a status with a qualifier that repeats its word — render one sentence per state: **"Asserted — the turn receipt reports a verified CPU TEE, but the receipt itself carries no authority signature."** / **"Asserted — the endpoint key digest matched locally; no external authority confirmed it."**

### M29. Google Drive connect fails with "Popup window closed" after you've been told to save a recovery key
**Where** `#vault` → Google Drive → Create a new workspace → Create with Google Drive.
**Experience** One line of feedback: **"Popup window closed"**. No cause, no retry, no mention of popup blockers. The generated recovery key is still displayed with "I saved this recovery key" already ticked — **the user has permanently saved a secret for a vault that was never created**, which erodes the credibility of every recovery-key prompt they see afterwards. Separately, "Create with Google Drive" renders in muted grey beneath the gold "Configure vault", so the primary action of the recommended flow reads as disabled.
**Fix** **"Google sign-in didn't finish — the popup was closed or blocked by your browser. Allow popups for this site, then try again."** with a `Try again` button that reuses the same recovery key and says so: **"The key above is still the one that will be used."** Give "Create with Google Drive" the gold primary treatment once the acknowledgement is ticked.

---

## MINOR

### m1. The first Enter on a slash command appears to do nothing
`#chat` composer. With `/help` typed and the palette open, Enter adds a trailing space and sends nothing; a second Enter runs it. The welcome message points new users straight at `/help`, and their first keypress produces no perceptible feedback. **Fix:** when the highlighted item exactly equals what's typed, let Enter submit. Otherwise make acceptance visible, or show **"Enter to accept · Enter again to run"** under the palette.

### m2. "Ask First" looks like a control, is inert, and there is no per-conversation approval setting
`#chat` composer footer. It carries a coloured dot and a checkmark and sits beside the interactive "Attach image", but it is a plain `<span>` with no title and no aria description; clicking does nothing. Meanwhile a three-file + shell + delete task produced three full-screen modals with only "Deny" and "Allow once" — no "allow for the rest of this task". The real setting lives inside the profile editor's "Profile boundaries" disclosure, labelled "Legacy session approvals", and applies to new sessions only. **Fix:** make it a real menu with three modes and a one-line description each (**"Ask First — prompt before anything changes"**) applying to the current conversation, and add **"Allow this tool for the rest of this turn"** to the approval modal. At minimum, remove the checkmark/dot styling that implies it is toggleable.

### m3. The "Jump to latest" pill floats over content and swallows controls — *2 lanes*
Observed covering a code block's **Copy** button, a user message ("Just render them"), the right end of a `/fetch-url` palette row, and a receipt hash on mobile. It is vertically centred against the transcript, so it lands in the middle of whatever you're reading. **Fix:** anchor bottom-centre, ~16px above the composer; hide it whenever a palette or popover is open.

### m4. The connection boundary reads "Switching…" during every normal turn
`#chat` session model card. On every turn the badge becomes an amber **"Switching…"** for the whole duration — in a product that emphasises conversations being pinned to an exact connection generation, this says the model is churning under you. `src/ui/model-control.tsx:90` and `:134` gate on `busy || switching`. **Fix:** gate on `modelSwitching` only. If a busy state is wanted, say **"Working…"** — the stop button and session line already communicate it.

### m5. Jargon on the primary connect path
`#access`. The recommended option's entire body is *"The browser creates the S256 PKCE request; the same-origin loopback bridge completes the registered confidential exchange."* Then a choice between "TURN PROOF POLICY: Verify & record" and "Strict fail-closed · unavailable", and "TRUST READINESS: evidence candidate / verification remains unverified". Every word is accurate; none is addressed to a person deciding whether to sign in — so the genuinely admirable disclosures get skipped, which defeats their purpose. **Fix:** lead with one plain sentence, demote mechanism to a disclosure. **"Sign in to Chutes. Your password never touches Airship, and the sign-in secret stays outside the browser. [How this works ▸]"**. Policy chooser heading: **"How strictly should Airship check the server?"** Options: **"Check every turn, and show anything it couldn't verify (recommended)"** / **"Refuse any turn that can't be fully proven (not possible in a browser yet)"**.

### m6. "production remote mode must fail closed" is a spec sentence shown to users
`#proof`, fresh page. A requirements statement rendered as a status, plus *"the compatibility lab remains visibly unattested"* — a sentence about a place the user has never heard of. **Fix:** empty-state sub-line **"No turn has run yet"**; paragraph → **"You haven't completed a turn, so there is no receipt to check. When you do, Airship records what it actually verified about the endpoint — and shows anything it could not verify as unverified rather than hiding it."**

### m7. "Raw evidence withheld by design" contradicts the page's own headline
`#proof` → Attestation evidence, empty ledger. Eyebrow: "INSPECTABLE, PORTABLE EVIDENCE". Right-aligned beneath it: **"Raw evidence withheld by design"** — displayed while the ledger holds zero records. It reads as Airship hiding something, the exact opposite of the intent. **Fix:** show only when records exist, and word it as a route, not a refusal: **"Raw quote, certificate and key bytes aren't rendered here — use Export raw verification bundle to inspect them."**

### m8. Evidence record list items ellipsize down to single characters
`#proof`, 1440×900, 2 records. The "EVIDENCE RECORDS (2)" column renders `◐ Asserted / E… / Ins… ENDPOINT / Jul…` and `◐ Asserted / C… / Qw… ASSERTED / Jul…`. Every distinguishing field is truncated to one to three characters, so you cannot tell records apart or choose which to inspect. **Fix:** `min-width: 220px`; two lines per row — line 1 the model or record kind ("Qwen3-32B-TEE"), line 2 status + relative time ("Asserted · 8 seconds ago"). Never ellipsize below the full model name.

### m9. Local Device: "Open existing" is styled primary and always fails on a new browser
`#vault`, status "Not opened". The filled button reads as primary; clicking it returns *"No browser-profile key is enrolled for this Vault."* at the bottom of the page. The recovery key offers only **Download** — no Copy, which is how most people actually save secrets. **Fix:** when status is "Not opened", give **Create new** the primary treatment and render Open existing disabled with the reason inline: **"No key enrolled in this browser yet."** Add **Copy recovery key**.

### m10. Empty, loading and error states are five unrelated inventions
`#workspace` centred icon + title + subtitle; `#proof` large hollow circle + serif title; `#vault` a gold-bordered card immediately followed by a second unbordered card saying the same thing in different words; `#memory` three identical inline sentences inside stat cards; `#account` a thin monospace bar with a leading dot, and connected, the same sentence centred in two adjacent tiles. Five formats mean five reading strategies, in the ten minutes a newcomer spends here. **Fix:** one `EmptyState` component — 24px outline icon, sentence-case title stating the fact, one grey line stating the consequence, at most one action. Collapse the two `#vault` cards into **"No vault configured — journal and workspace stay in page memory and are lost on reload."** + `[Configure vault]`. De-duplicate the `#account` tiles.

### m11. Mobile "More" uses a plus icon and labels four destinations "Destination" — *2 lanes*
Bottom bar: Chat / Workspace / Trust / **More**, where More's icon is a **`+`** — the same glyph that means "new conversation" in the desktop rail — and its label is the only 11px one in the bar. Inside: Memory, Profiles, Vault and Connection are each subtitled with the literal word **"Destination"**; Vault, Connection and Account also live under the Trust tab, with different labels. The Editor entry carries the Source Control git-branch icon. **Fix:** horizontal-ellipsis or 2×2 grid glyph for More, label at sibling size, `+` reserved exclusively for creation. Subtitle every entry with its rail group so the phone teaches the same IA as desktop: **"Memory — Work"**, **"Profiles — Agent"**, **"Vault — Trust"**. Drop Vault/Connection/Account from More since Trust owns them; put Sessions there. Folder icon for Editor.

### m12. Tap targets of 13–36px across Terminal, Proof, Capabilities, Memory, Chat and Workspace
Measured on a connected phone: "Command history · 0" summary **128×13**; "Browser primitives" summary 344×15; "Show imported recovery key" 276×19; "Technical journal details" 370×20; "× Close" 26×30; "Create a new workspace" 202×26; Explorer "+" 26×26; "⌃C Interrupt" 37×30; "Restart" 80×30; "Attach image" 23×34; "Session" 97×36; "Export session audit" 149×36; "Skills" 130×39. A 13px summary row is a coin-flip tap, and those summaries are the only way into detail on their pages. **Fix:** one global rule under `(max-width: 640px)`: `summary, button, [role=tab], label:has(input) { min-height: 44px; display: flex; align-items: center; }`. Disclosure summaries first.

### m13. Reading a file on a phone means scrolling sideways for every line
`#workspace` → README.md → Editor, 430×932. The textarea spans 472–984 against a 932px viewport with the tab bar at 876; the route *does* scroll to recover it, but nothing says so, and 470px (50%) of chrome sits above the code. Lines are `white-space: pre` with `scrollWidth 2154` vs `clientWidth 402`, so every line truncates ("This is the agent's private virtual worksp") with no wrap toggle. **Fix:** when a file is open on mobile, collapse the page heading and outer tab strip to a sticky 44px breadcrumb (**"‹ Files · README.md"**) so the editor starts near y=120. Add a wrap toggle beside Save, defaulted **on** below 640px.

### m14. Tablet drops the WORK / AGENT / TRUST headings, flattening the IA to ten undifferentiated rows
iPad Pro 11 (834×1194). The rail becomes an icon-over-label mini-rail and the three group headings vanish entirely, along with the pinned profile card and recent conversations — so there is no rail path to switch profiles. The three-group model is taught on desktop, taught differently on phone, and not taught at all on tablet — on the viewport most likely to be used for auditing. **Fix:** keep the headings on tablet; widen the rail ~16px and render them at 9px small-caps. If vertical space is tight, drop the nested `↳` rows before dropping the group headings — nesting is recoverable from the destination page, grouping is not.

### m15. The app pins `:root` font-size to absolute pixels, discarding the browser's font setting
`getComputedStyle(document.documentElement).fontSize` returns **17px** on a default profile, from `:root[data-density="comfortable"] { font-size: 17px }` (compact 15px). Because it is absolute it *overrides* rather than scales from the user's preference. The in-app escape hatch tops out at 19px (`platform-shell.css:120`) — about +12%. `.nav-item` computes to a hardcoded 12px, so the primary navigation does not scale with anything: force-injecting `html{font-size:24px}` grew the message body while the sidebar stayed put and conversation rows truncated to "General con… / No mess…". **Fix:** express density relatively — `comfortable: 106%`, `compact: 94%` — so it multiplies the user's setting. Widen the type scale to at least 1.5× at X-large, and convert the hardcoded 11–12px nav/pill sizes to the existing rem-based `--fs-*` tokens.

### m16. The composer is the only control in the app without a real focus indicator
`textarea[aria-label="Message Airship"]` computes `outline: none 0px`. The only cue is a wrapper border shifting 1.55:1 → 2.32:1 — a 1.49:1 change — against the **2px #dfba72 / 10.05:1** ring every other control gets. The composer also grows on focus, which is what actually makes it noticeable, and that reflows the transcript each time. **Fix:** `.composer:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }`. Keep the expansion if you like it, but reserve the space.

### m17. An unlabelled 1×1 file input sits in the tab order, and the command-palette button is named "⌘" — *2 lanes*
On `#chat` the **first** Tab press from a fresh load lands on `<input type="file">` with no accessible name and a 1×1 box near the composer — a focus ring on nothing, and for a screen reader, "blank, file upload". Two tab stops later, a button whose entire accessible name is the glyph **"⌘"**, sitting between two properly-labelled siblings. **Fix:** `tabindex="-1" aria-hidden="true"` on the hidden input (the visible "Attach image" button already forwards the click). `aria-label="Open command centre (⌘K)"` on the palette button.

### m18. The paragraph explaining why strict fail-closed is unavailable renders at 4.24:1
`#access`, the disabled policy card, dimmed with `opacity: 0.48` over `rgb(20,25,28)`. Composited, its 12.92px body copy — *"Independent NVIDIA GPU verification is not yet browser-complete; strict endpoint proof would reject every turn…"* — measures **4.24:1**, below the 4.5:1 threshold; its heading measures the same. Every other body colour in the app clears easily (`--ink` 15.13, `--ink-muted` 6.85, `--ink-faint` 5.05). This is exactly the copy a cautious user leans in to read, and it is the least legible text on the page. **Fix:** stop expressing "unavailable" with opacity. Recess the card with `--surface-soft` and a dashed `--line` border; body copy at `--ink-muted`, heading at `--ink`. Reserve opacity dimming for decorative chrome.

---

## POLISH

### p1. User messages label themselves "You" twice on a phone
430×932. A bold "You" header inside the bubble's top-right corner **and** a separate outlined chip containing "You" immediately outside it at x 393–418 of a 430px viewport. Because "You" is three characters the chip renders as a cramped oval next to the assistant's clean round "A". **Fix:** below 640px drop the user avatar chip entirely — the right-aligned brass bubble already identifies the speaker — or use a single-glyph round avatar matching the assistant's.

### p2. Chrome budget on a phone is 311px — 33.4% on a 14 Pro Max, 38.9% on a 360×800 Android
Topbar 52 + session bar 88 + composer 115 + tab bar 56. The header portion (140px, 15–17.5%) respects the budget; the overrun is the bottom pair (171px, 21% of a Pixel), driven by a 115px composer carrying a persistent two-line footer: *"Encrypted inference through Qwen/Qwen3-32B-TEE; this compatibility connection has no required endpoint-proof gate."* It works today, but the next thing added breaks it. **Fix:** move that two-line footer into the model chip's detail sheet, leaving a single line — **"Encrypted · no endpoint-proof gate"** — when it matters. Returns ~50px, taking chrome to ~33% on a 360px phone.

### p3. A connected S3 vault still renders the entire empty connect form beneath its own active state
`#vault`, connected. Top of page: "Encrypted runtime active", config table, seven verified probe rows, Verify again / Edit configuration / Disconnect. Scroll down: the complete "Connect your loopback S3 lab" setup form again, in full, with empty Endpoint/Region/Bucket/Access key/Secret key fields and both acknowledgements unticked. The page says "you are connected" and shows an untouched connect form, inviting you to paste credentials that would replace the working vault. **Fix:** when connected, collapse the harness behind "Edit configuration" (which should expand it *pre-filled*) and drop the duplicate empty form from the connected view.

---

## Cheapest wins
*Highest experience-improvement per unit of work. Build these first — most are single-file.*

1. **Delete `.message-actions > summary { display: none }` and render a `<div role="toolbar">` on desktop** (`src/ui/styles.css:1796`). One CSS/JSX change restores Copy, Retry, Edit & resend and Fork session for every desktop user, unblocks the "Retry is available" honesty problem, and reclaims ~70px of dead geometry per message. **Highest ROI item on the list.**
2. **Delete `summary: "Turn completed."`** (`src/ui/chat/message-parts.ts:408`). One line removes a debug string from the bottom of every assistant message.
3. **Gate "Switching…" on `modelSwitching` only** (`src/ui/model-control.tsx:90` and `:134`). Two-token change; removes a false signal shown on every turn.
4. **Derive delete disposition from the tool's mutation kind** (`src/ui/approval-presentation.ts:26`). Removes the most dangerous mislabel in the product — "Change: Create" on a destructive delete.
5. **`padding-bottom: calc(56px + env(safe-area-inset-bottom))` on mobile route scroll containers.** One rule un-hides the "Finish: verify & connect" CTA, the terminal durability footer, and the bottom of the editor.
6. **`scrollIntoView({block:'nearest'})` on the active nav item on route change, + `pointer-events:none` on `.sidebar-spacer`, + `padding-bottom` for the pinned profile card.** Three small changes make the entire TRUST group reachable on the modal laptop.
7. **Auto-expand the API-key panel when the OAuth bridge is unconfigured, and add the `chutes.ai` link.** Copy + one conditional. Takes new-visitor conversion from ~0% to something real.
8. **`.composer:focus-within { outline: 2px solid var(--focus); outline-offset: 2px }`** — one line, on the most important control in the app.
9. **`tabindex="-1" aria-hidden="true"` on the hidden file input** and `aria-label="Open command centre (⌘K)"` on the palette button. Two attributes; fixes the very first keyboard interaction with the product.
10. **Global mobile rule: `summary, button, [role=tab], label:has(input) { min-height: 44px }`.** One rule fixes thirteen measured sub-44px targets.
11. **Change the `#connection` jump-tabs from `<a href="#…">` to buttons calling `scrollIntoView`.** Stops the page ejecting users to Chat.
12. **Remove `aria-live` from the streaming part; add `aria-busy` on the article and one completion announcement.** Turns the screen-reader experience from unusable to correct.
13. **Express density as percentages instead of `17px`/`15px`.** One-line change that stops silently discarding a low-vision user's browser setting.
14. **Replace the phone "Session" pill label with the durability state itself.** Small change; restores the single most important warning to the device most newcomers arrive on.

---

## Honesty watch
*Every place the interface risks making someone believe something stronger than the truth. This project's value rests entirely on never overclaiming — treat all of these as blockers regardless of the severity assigned above.*

**Says local when it was remote**
- **"Browser baseline"** on a completed remote Chutes TEE turn (B6). Tells the user inference happened on their device when it happened on someone else's GPU.
- **"SESSION MODEL / airship/demo-v1 / Local"** plus "Local kernel ready" with nothing connected (M16). Reads unmistakably as a loaded local model, and the demo reply then confirms the false belief with a receipt hash.

**Says verified when nothing was verified**
- **"E2EE · evidence recorded"** while the receipt on the same screen says "Evidence not pulled" (B1). The most prominent and most colourful of six labels is the optimistic one.
- **Six green "✓ Passed" tiles** over a journal with one event and no turns (M14). Manufactures reassurance out of an empty state.
- **A settled receipt mutating from "Evidence not pulled" to "Secure hardware evidence pending"** on re-render (B1). Silently upgrades a negative to an open question with no new evidence.

**Says off-device when it is on-device**
- **"Cloud Vault active" / "PRIVATE CLOUD STATE"** for `http://127.0.0.1:9900` (M15). Reads as durability that does not exist, on a screen where the failure mode is data loss.

**Truncation and collapse that strengthen a claim**
- **"Evidence checked per turn" → "Evidence checked"** at 1440px (M13). The ellipsis removes the qualifier that makes the claim true.
- **The phone posture pill collapsing to the single word "Session"** (B8), dropping "not checked" and "Ephemeral". Phone users are shown strictly less caution than desktop users looking at identical facts.

**States a capability that does not exist**
- **"Retry is available"** with no retry control anywhere in the DOM (M3 / B2).
- **"partial response kept"** while showing none of the kept text (M3).
- **"Edit & resend"** that appends rather than replaces, leaving the mistake in provider context — while Retry, two rows away, carries a scrupulously honest tooltip about exactly that (M17).
- **"Every possible mutation is declared in this one approval-bound call"** on a modal that declares none of them (B5).

**Understates in a way that is still false**
- **"Unfinished · HISTORY INCOMPLETE · The session ended mid-turn"** 60px below "Last turn completed", for a turn that completed (B10). Wrong direction, same crime: the screen asserts something factually untrue.

**Honesty that cannot be read**
- **"Asserted verified"**, and `bindingASSERTED · ASSERTED PARTIAL` with no space (M28) — the most important status string on the page looks like a rendering failure.
- **The 4.24:1 paragraph explaining why strict fail-closed is unavailable** (m18) — the app's most careful disclosure is its least legible text.
- **"Raw evidence withheld by design"** on the page headlined "INSPECTABLE, PORTABLE EVIDENCE", shown when there is nothing to withhold (m7).
- **The terminal's durability footer**, which is never rendered to a phone user at all (B9) — the honesty line lost on the one surface where people run real commands.

**The rule to enforce, in one line:** *one state, one string, one glyph — and the summary layer may never be more optimistic than the detail layer it summarises.* Add a test that asserts every trust string in the app comes from a single enum, and a test that fails if any pill renders with a CSS ellipsis.

---

## Device reality

**Desktop (1280–1440 wide, ≥900 tall) — genuinely good, with two holes.** Connecting is excellent, streaming is smooth, auto-scroll follows tokens correctly, markdown/tables/syntax highlighting are handsome, code blocks have Copy, error copy is the most human in the category, interruption preserves partial text and restores your prompt. But **you cannot copy, retry, edit or fork any message** (B2), and the approval dialogs do not tell you what they are about to do (B5). At 1440×900 the TRUST nav group is half-buried and Connection is dead to the mouse (B7). Below ~1200px the transcript becomes the *narrowest* of three columns and the model name disappears entirely (M18) — 1024×768 and split-screen widths are not designed. **Verdict: usable for real work today only if you never need to retry a turn.**

**Tablet (iPad Pro 11, 834×1194) — the least-considered viewport.** It works, but the rail loses its WORK/AGENT/TRUST grouping, the pinned profile card, and recent conversations, flattening ten destinations into an undifferentiated column with no path to switch profiles (m14). Trust pills degrade to `Browser / Ed…` (M13). This is the viewport most likely to be used for reading and auditing — exactly the Trust workflow — and it is where Trust stops looking like a pillar. **Verdict: fine for reading, weak for navigating.**

**Phone, portrait (390–430 wide) — genuinely good and, importantly, honest about what it can't do.** Reviewers connected with a real key, ran live turns, typed into the WASI terminal and got output, opened a file in the editor, and walked all 14 routes at 430×932 and 360×800. The header budget is respected (140px, 15–17.5%), the composer really does expand to 12 lines, the send/stop button is a true 44×44 and stays pinned, there is zero horizontal document overflow on 12 of 14 routes, and the trust surface degrades in the correct direction under pressure. The bottom tab bar and the single unambiguous "Connect" pill make first-run *better* on a phone than on desktop. What's broken: the tab bar eats the final connect CTA and the terminal footer (B9), the ephemeral warning never appears anywhere (B8), Workspace puts your first filename 60% down the screen (M24), and the vault recovery panel — the one screen where a mistake is unrecoverable — renders raw grey system buttons (M27).

**Phone, landscape — do not attempt.** Rotating crosses a width-only breakpoint, so the app silently loads the desktop shell: the tab bar disappears, Preferences and Proof lay out entirely past the right edge with no horizontal scroll, and the conversation collapses to a **94px** reading window (40px on an SE). This is not degraded, it is a different, broken app.

**What a person should not attempt on a phone today:** completing first-run connection without knowing to scroll past the tab bar; reading a file in the editor (every line truncates horizontally with no wrap toggle); finding an old conversation (the filter strip and card list are silent horizontal scrollers showing one and a half items); anything involving vault recovery; and any use of landscape at all.

---

## Observed vs inferred

**Everything in this list was observed in the running application** on a real viewport, by a reviewer walking a real pathway — measured bounding boxes, `elementFromPoint` probes, MutationObserver instrumentation, aria snapshots, contrast sampling, `scrollTop`/`scrollWidth` readings, and screenshots. There are no findings here that exist only as a code reading.

**Inferred from source — mechanism only, never the symptom.** In the following items the *visible failure* was observed first and the *cause* was then located in the tree. I re-verified every anchor below against HEAD:

| Item | Anchor | Verified |
|---|---|---|
| B2 message actions dead | `src/ui/styles.css:1796` — `.message-actions > summary { display: none; }`, with the 44px re-enable only inside the mobile block at `:1804` | ✅ |
| B5 delete says "Create" | `src/ui/approval-presentation.ts:26` — `disposition: expectedRevision === undefined \|\| expectedRevision === null ? "Create" : "Replace"` | ✅ |
| B1 Proof card mislabelled | `src/ui/proof-view.tsx:133` — `const teeVerified = receiptSeal === "verified"` (whole-receipt seal), rendered at `:150` under the label "TEE verification" | ✅ |
| M1 "TURN COMPLETED." | `src/ui/chat/message-parts.ts:408` — `summary: "Turn completed."` | ✅ |
| m4 "Switching…" on every turn | `src/ui/model-control.tsx:90` and `:134` — both gate on the busy flag, not on `modelSwitching` | ✅ |
| M28 `bindingASSERTED` run-on | `src/ui/attestations-view.tsx:315` — adjacent inline `<small>` / `<strong>` siblings with no separator | ✅ |
| m15 absolute root font-size | `src/ui/platform-shell.css:120` — `:root[data-type-scale="x-large"] { font-size: 19px }`; density set in absolute px in `styles.css` | ✅ |
| m2 approval policy is new-sessions-only | `src/ui/platform-shell.tsx:298`, `src/ui/app.tsx:6101` — setting lives in the profile editor as "Legacy session approvals" | not re-verified |
| B11 "Configure vault" inert | `setVaultSetupOpen(open => !open)` with the section below rendering regardless of the flag | not re-verified |

Two behaviours are **non-deterministic and should be reproduced before being closed**: the hung-turn watchdog (M19 — one run failed at ~30s, another never failed at 100s), and the top-bar readout for an identical successful turn, which produced three different strings across three sessions (B1).