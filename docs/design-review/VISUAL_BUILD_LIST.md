Everything checks out — and three findings are already stale. Here is the build list.

---

# Airship — Build List

## 1. The verdict

Airship today looks like the work of a team that designed three or four surfaces to a genuinely state-of-the-art standard and then shipped the other forty by improvising against them. The approval dock, the post-discovery model metadata table, the Memory stat strip, the vault comparison table, the sessions zero-result pane and the phone approval sheet are as good as anything in Linear or Stripe — they have a fixed anatomy, a real ramp, and copy that gives up nothing while still reading plainly. Everything else is those same ideas re-guessed per view: eight H2 treatments, four tab patterns, 253 off-grid gaps, 17 line-heights, nine different names for one fact, and a motion layer that is absent everywhere except the three places it matters least. The design system is not aspirational — `tokens.css` is better-reasoned than most shipped systems, it predicts its own failure modes in comments, and then the theme layer silently reverts the contrast fix the comment warns about, so the product's most important claims render below AA in the two places it exists to be believed. **Be proud of the thinking and the honesty; do not be proud of the surface.** Nothing on this list is a redesign. It is one page-header, one seal, one label/value, one press state, one overlay entrance, one vocabulary — plus a mechanical pass onto tokens that already exist. The gap between what this is and what it reads as is roughly two weeks of disciplined work, and it is currently costing the product the entire impression its engineering has earned.

## 2. What I verified, and what is already fixed

I re-counted every census in the running tree rather than trusting the reports. **All the structural claims hold**: `--fs-hero` has 0 consumers, `--fs-micro` 359 / `--fs-caption` 216 vs `--fs-body` 22; 60 px font-size literals (29 at 11px); 366 literal gaps across 20 values; 179 line-heights across 17 values; 59 `space-between`; **87 `:hover` against 1 `:active`** (worse than reported); `popover.css` has zero `transition` and zero `animation`; `popover.tsx:170` is `hidden={!open}`; `catalog.ts:170` is `inkFaint: "#858d8a"`; `THEME_CSS_VARIABLES` carries 9 roles and no `--line`; `tokens.css:296` is `opacity: 0.45`; there is exactly one anchor selector in the tree (`a:focus-visible`); the 9 trust-vocabulary strings all exist at the stated counts. Baseline confirmed green: **2148 passing / 1 skipped, 245 files, 10.5s.**

Three corrections the swarm must not waste time on:

- **The page-header component already exists.** `src/ui/route-header.tsx` ships `RouteHeader` with `tool`/`document` densities and is adopted by 9 routes; `.route-title` at `routes.css:3279` is already `font: var(--fw-title) var(--fs-display)/1.15 var(--font-display)`. The craft critic's "one component" fix is *90% landed*. What remains is the 6 routes still on legacy `.page-heading` and the forbidden `clamp(30px, 4vw, 47px)` at `routes.css:63-65`. Effort drops from medium to small.
- **The first-run screen was deliberately re-centred** in commit `3e44847`, *after* the capture set. Do not re-litigate its position.
- **`type-floor.test.ts:30` already asserts copper is reserved for the asserted seal.** The colour critic's fix breaks a live contract test. See §4.

## 3. Contract guard — the rules this list obeys

Airship's currency is that a label never asserts more than the code establishes. Every item below was checked against that. Four categories:

| Guard | Applies to | Ruling |
|---|---|---|
| **Never remove a claim** | Claim-rail collapse (craft 3, clarity 8) | Rewritten as re-presentation: every claim and every disclosure stays individually addressable; only the *repetition* of the word "Asserted" collapses. |
| **Never remove a caveat** | Composer posture sentence (craft 17, mobile 5); interruption card (motion 8, clarity 12) | Both rewritten as *relocation with a reachability test*. The sentence moves into a chip popover; a unit test asserts the full string is still in the accessible tree. |
| **Never remove a provenance line** | Session-bar journal chip (craft 25), Sessions timestamps (craft 19) | Digest moves to the popover where it already exists; timestamps collapse only when byte-identical. |
| **Never let a label assert more** | Vocabulary unification (clarity 1) | **Hardest constraint on this list.** "Asserted" may only be printed where a receipt exists. Where none exists the label is "No evidence". Unifying the *word* must not unify the *state*. Enforced by test. |

One outright rejection on contract grounds is in §7.

---

## 4. Conflicts resolved

**A. Copper vs caution for "Asserted."** The colour critic wants `.seal[data-state="asserted"]` moved from `--copper` to `--v-caution` so asserted has one colour. But `type-floor.test.ts:30` reserves copper for exactly this, and copper (ΔE 2.1 from `--truth-remote`) is semantically *correct* — an assertion is a remote truth claim, and caution means "attend to this", a different axis. **Ruling: keep copper for the asserted seal; move `.attestation-chip.asserted` (shell.css:322) *to copper* instead.** Same end state — one colour for one state — with no test break and no loss of the caution/asserted distinction. Separately, give the brand mark its own token so the logo stops wearing a verdict colour. This inverts the critic's direction and achieves their stated goal.

**B. Eyebrow colour.** Craft wants the eyebrow at `--accent` (as part of the header anatomy); colour wants `--ink-muted` because brass must mean "pressable". **Colour wins.** With 253 accent references across 27 sheets in 36 hand-mixed tints, the accent's problem is that it has no job. Confining it to pressable geometry is the single highest-leverage colour decision available, and an eyebrow is not pressable.

**C. First-run composition.** Craft wants the block anchored to the top with `padding-block-start: var(--sp-7)`. Commit `3e44847` deliberately centred it three commits ago. **Keep centred.** Take only the type-ramp half of the fix.

**D. Demo-turn streaming.** Motion wants the canned demo answer emitted through `TranscriptStreamStore` at ~55 c/s. This is safe *only* because the content is unchanged and the "local demo · page memory" labelling stays. **Accept, with the labelling frozen.**

**E. Landscape `session-bar { display: none }`.** Mobile wants the session bar hidden below 460px height. That bar carries the seal and the model name — provenance. **Accept only because** the topbar trust chip and the Trust tab badge both persist and carry the same facts. Gated on a test asserting the seal state is still reachable.

---

# DO NOW

Fifteen items. Ranked by (people who see it) × (damage) ÷ effort. Every one is small or small-medium. Items 1–6 are the ones I would ship first if the swarm could only do six.

---

### DN-1 · The approval policy is inert on every phone, and unreadable at 360px
**2 critics (mobile ×2 findings). Blocker. Effort: small.** This is the only finding where the product silently misrepresents its own safety posture — it is the control deciding whether the agent writes files and runs shell commands without asking, it reports success (`aria-expanded="true"`, caret flips), and nothing opens.

**Root cause, confirmed by reading both sheets:** `menu-select.css:40` sets `position: fixed` on `.menu-select-popover` under `@media (max-width:640px)`. `routes.css:2841` overrides only `inset`, not `position` — so `calc(100% + var(--sp-2))` resolves against the *viewport*, not the composer. bottom = 932+8 = 940 → top = −164. The stale comment above it (routes.css:2838-2840) assumes `.composer`'s `container-type: inline-size` makes it the containing block; empirically it does not.

**Files:** `src/ui/routes.css`, `src/ui/chat.css`

```css
/* src/ui/routes.css — replace the block at 2838-2846 (comment included) */
.composer-approval-select .menu-select-popover {
  position: absolute;
  inset: auto 0 calc(100% + var(--sp-2)) auto;
  width: min(400px, calc(100vw - 20px));
  max-width: min(400px, calc(100vw - 20px));
  max-height: min(420px, 60dvh);
}
```
`.menu-select` is already `position: relative`, which restores the desktop geometry.

```css
/* src/ui/chat.css — the 360px label collapse */
.composer-approval-select .menu-select-value { flex: 0 0 auto; white-space: nowrap; }
/* src/ui/routes.css, inside the ≤640px block */
.composer-tools { flex-wrap: wrap; row-gap: var(--sp-1); }
.composer-approval-select { flex: 0 0 auto; order: -1; }
```
If space is still short below 380px, drop the `local demo · page memory` posture text — **not** the policy label. That text is duplicated in the session-status popover; the policy label is not duplicated anywhere.

**Reviewer confirms:** at 430×932, 360×800 and 932×430, activate the trigger and assert `document.querySelector('.composer-approval-select .menu-select-popover').getBoundingClientRect().top >= 0`; assert `.menu-select-value` `getBoundingClientRect().height >= 12` at 360×800. Add both to the e2e suite. Verify in chromium, webkit and firefox — the bug reproduced in all three.

---

### DN-2 · The theme layer reverts the contrast fix its own token comment warns about
**2 critics, 3 findings (craft 4; colour ×2). Blocker. Effort: one line + one test.** Highest leverage line on this list.

`tokens.css:21-27` sets `--ink-faint: #949c99` and the comment explicitly says the shipped palettes must be revised with it "before the contrast gain is what a user actually sees." `catalog.ts:170` then writes `#858d8a` inline on `<html>`, which wins. Result: six status chips on `#connection` at **4.10:1** and the four claims in the trust sheet at **4.43:1** — both below AA, in the two places the product exists to be believed.

**File:** `src/profiles/catalog.ts`
- line 170 `inkFaint: "#858d8a"` → `"#949c99"`
- line 189 `inkFaint: "#7f938e"` → `"#8ba49e"`
- line 208 `inkFaint: "#7e8994"` → `"#8a95a1"`

Then widen the middle rung so three ink tiers actually read as three (currently 6.85 and 5.05 — a 1.36× step against a 2.05× step above it): line 169 `inkMuted: "#9fa5a3"` → `"#b0b6b3"`.

**File:** `src/ui/css-variable-contract.test.ts` — add a test asserting every `THEME_CSS_VARIABLES` palette's `inkFaint` clears **4.5:1 on its own `surfaceRaised`** and `inkMuted` clears 7:1 on its own `surface`. This is what stops a theme re-opening it.

**Reviewer confirms:** the new test fails on the old hex and passes on the new. Sample the `#connection` lane chips and the trust-sheet claim labels; both must be ≥ 4.5:1.

---

### DN-3 · Four UA defaults leak into the product's most consequential surfaces
**1 critic, 4 findings — but each is independently a bug. Major. Effort: small.** Chromium is currently painting: the credential fields (`#3b3b3b` + `#ffffff`, the only pure white in a warm-ink product), two workspace buttons (`#6b6b6b` fill with a `#858d8a` label at **1.57:1**, the highest-luminance neutral surfaces in the entire app), every external link (`#9e9eff` — there is genuinely no `a { color }` rule in the tree, only `a:focus-visible` at tokens.css:289), and the trust dialog's focus ring (`#99c8ff`, because `.trust-sheet` is `div[tabindex="-1"]` and falls outside the tokens.css:284-289 selector list).

**File:** `src/ui/tokens.css` — add after the `button.primary` block:
```css
a { color: var(--accent-bright); text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: var(--accent); }
/* An unstyled button must be invisible-but-legible, never a UA slab. */
button { background: transparent; border: 0; }
```
and add `[tabindex]` to the `:focus-visible` selector list at 284-289.

**File:** `src/ui/workspace-view.css` — give the two bare buttons at `workspace-view.tsx:921-922` the secondary recipe:
```css
border: 1px solid var(--line-control); border-radius: var(--radius-control);
color: var(--ink); background: var(--surface-raised);
```
**File:** `src/ui/provider-fabric-panel.css` — the three credential inputs:
```css
.provider-fabric input[type="password"], .provider-fabric input[type="text"] {
  color: var(--ink); background: var(--ground);
  border: 1px solid var(--line-control); border-radius: var(--radius-control);
  font: var(--fs-body)/1.4 var(--font-mono);
}
```

**Reviewer confirms:** no computed `background-color` of `rgb(107,107,107)` or `rgb(59,59,59)`, no computed `color` of `rgb(158,158,255)` or `rgb(255,255,255)`, anywhere in the app. Add that as a four-assertion e2e sweep — it also prevents the next leak.

---

### DN-4 · The streaming caret has never once rendered
**1 critic, but verified twice independently (live probe returned `animationName: "none"` on all 80 sampled frames; I confirmed the DOM). Major. Effort: one line.**

`chat.css:735` targets `.message-parts .message-part.text.streaming::after`. `streaming-slot.tsx:64` returns `<div class="message-part text streaming">` **directly** — never inside `.message-parts`. The rule is live and correct; the markup simply cannot match it. This is why no capture team ever photographed a token-stream frame: there was nothing to photograph.

**File:** `src/ui/chat.css:735` — drop the ancestor:
```css
.message-part.text.streaming::after { … }
```
While there, change `border-right: 1px solid var(--state-acting)` (`#7fa8c9` steel blue) to `var(--accent-bright)` — that blue is the product's only blue in the transcript.

**Reviewer confirms:** during a live turn, `getComputedStyle($('.message-part.text.streaming'), '::after').animationName === "stream-caret"`. Add a unit test asserting the selector in `chat.css` contains no ancestor combinator before `.message-part.text.streaming::after` — the class of bug that hides for a year.

---

### DN-5 · Nothing in the product acknowledges a press
**1 critic. Major. Effort: one rule.** 87 `:hover` rules against **1** `:active` (`.tree-overflow:active`). `shell.css:50` even transitions `transform 110ms ease` on seven selectors that no rule ever changes. On a product whose actions are consequential and whose responses take 5–29 seconds, the pressed frame is the only instantaneous confirmation anyone gets — its absence is the common root of why discovery, connect, probe and copy all feel dead.

**File:** `src/ui/shell.css`, beside line 50:
```css
.nav-item:active, .topbar button:active, .small-button:active, .status-chip:active,
.starter-chip:active, .workbench-dialog button:active, .approval-dock button:active,
.connect-lane button:active {
  transform: translateY(1px) scale(.994);
  background-color: color-mix(in srgb, var(--accent) 14%, transparent);
  transition-duration: 60ms;
}
@media (prefers-reduced-motion: reduce) {
  /* keep the acknowledgement, drop the movement */
  .nav-item:active, .topbar button:active, .small-button:active, .status-chip:active,
  .starter-chip:active, .workbench-dialog button:active, .approval-dock button:active,
  .connect-lane button:active { transform: none; }
}
```
**Reviewer confirms:** `:active` rule count ≥ 8. Manually press each of the eight families and see the frame.

---

### DN-6 · The overlay layer has no entrance, no exit, and no origin
**1 critic, 5 findings, one root cause. Major. Effort: small-medium.** Command palette (714×594 — 32% of the viewport), trust sheet, Preferences, slash menu, approval dock, every phone bottom sheet, `Jump to latest`, the workbench toast: all report `transition: all 0s; animation: none`. `popover.css` contains zero of either across 251 lines, and `popover.tsx:170`'s `hidden={!open}` removes the node from the box tree, which makes a transition *structurally* impossible. Meanwhile the product demonstrably understands intent — 150ms popover dwell, 180/240ms rail dwell, a 6s self-clearing toast — and throws it away at arrival.

**File:** `src/ui/popover.tsx:170` — `hidden={!open}` → `inert={!open}` plus a `data-open={open}` attribute so the node stays in the box tree.
**File:** `src/ui/popover.css`:
```css
.popover__panel {
  transition: opacity 120ms ease, transform 120ms ease;
  transform-origin: var(--popover-origin, top center);
}
@starting-style { .popover__panel { opacity: 0; transform: translateY(-4px) scale(.985); } }
.popover__panel[data-open="false"] { opacity: 0; transform: translateY(-4px) scale(.985); pointer-events: none; transition-duration: 90ms; }

/* Touch sheets slide — the slide IS the explanation of what a sheet is. */
.popover[data-mode="sheet"] .popover__panel {
  transition: transform 180ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease;
}
@starting-style { .popover[data-mode="sheet"] .popover__panel { transform: translateY(100%); opacity: 0; } }

@media (prefers-reduced-motion: reduce) { .popover__panel { transition: opacity 90ms ease; transform: none; } }
```
Apply the same 120ms fade + 140ms `translateY(10px)→0` rise to `.approval-dock`, and give `.jump-to-latest` and `.workbench-notice` the same treatment (render `.jump-to-latest` with `hidden` rather than conditionally so the transition can run).

**Careful:** `hidden` → `inert` changes the accessibility tree. Assert closed popovers stay out of the tab order and out of the a11y tree.

**Reviewer confirms:** each of the six overlays reports a non-zero `transitionDuration` on open; `document.activeElement` can never land inside a closed panel; reduced-motion reports `transform: none`.

---

### DN-7 · Nine names for the one fact the product most needs to say precisely
**1 critic, but this is the product's thesis. Blocker. Effort: medium. Contract-sensitive — read the guard.** Verified counts: "Not checked" ×14, "Secure hardware not checked" ×6, "Evidence not pulled" ×7, "no evidence" ×4, "Asserted, not verified" ×4, "Local key match" ×2, "verification remains unverified" ×1, "Secure hardware evidence pending" ×1, "No evidence yet" ×1. **Five are on screen simultaneously** in `conversation/56`, and two adjacent messages in one conversation carry two different words for identical state. Vocabulary sprawl reads as uncertainty — the exact opposite of what this evidence model has earned.

**The ladder is VERIFIED / ASSERTED / NO EVIDENCE.** It already exists, with good definitions, as the Proof tile headings.

**Contract guard — this is the one that can go wrong.** Unifying the *word* must not unify the *state*. "Asserted" may be printed **only** where a turn receipt exists. Where no receipt exists the label is "No evidence", not "Asserted". Before any string changes, add to `src/ui/trust-language.test.ts` a test that maps every user-visible trust label to the predicate that must hold for it — and fails if a label is emitted on a state whose predicate is false.

**Files:** `src/ui/trust-language.ts` (add the canonical map), then the call sites.

Exact copy:
- Session-bar chip: **`Asserted`** when a receipt exists; **`Not checked`** only when no provider is connected.
- Per-message chip: **`Asserted · no endpoint evidence`** — replaces *both* "Evidence not pulled" and "Secure hardware evidence pending". Nothing explained the difference between them because there is none.
- Claim-rail hero: keeps **`Asserted, not verified`** verbatim.
- Connect TRUST READINESS row: **`not verified yet — catalog metadata is not proof; the check runs when you connect`** replaces the tautology "verification remains unverified".
- Attach the three Proof definitions ("A named authority checked this claim and it held." etc.) as the session-bar chip's popover body, so the ladder is learnable from chat without leaving it.

Every existing explanatory sentence stays. Only labels change.

**Reviewer confirms:** grep for the retired strings returns 0. The new predicate test fails if you hand-edit a label onto the wrong state. Take `conversation/56` again — one word for one fact, five times.

---

### DN-8 · The first action on the first route returns an error only its author can act on
**2 sources (clarity; capture team §2 confirmed the 503). Blocker. Effort: small.** `#connection` opens with the Chutes lane expanded, the OAuth tab marked **"Primary"**, and a filled brass "Sign in to Chutes". Pressing it returns *"The local Chutes OAuth handler is not configured. Restart the Airship lab with its process-held client secret."* Nothing points at the API-key tab, which is the method that works in this build. Following the product's own visual hierarchy leads to a dead end.

**File:** `src/ui/connect/connect-lanes.ts` (Chutes failure path), `src/ui/access-view.tsx`

Exact copy:
> **Chutes sign-in is not available in this build.** Paste a Chutes API key instead — it works now and stays in page memory.

Keep the developer sentence **verbatim** inside a disclosure labelled **"Why this build cannot sign in"** — it is a provenance line and must not be deleted. Render a real `Use an API key` control beside it that switches the method tab (the OpenAI lane already ships exactly this escape hatch). When the handler is unconfigured at load, stop labelling the tab "Primary" — label it **`Sign-in · unavailable in this build`** and open the lane on the API-key tab.

**Reviewer confirms:** with the handler down, the lane opens on API-key, no tab says "Primary", and the developer sentence is still reachable in the DOM. Assert the last with a test.

---

### DN-9 · When a key is refused, nothing on screen says the key was refused
**1 critic. Blocker. Effort: small.** After `Finish: verify & connect` correctly rejects an unregistered `cpk_`, the banner says *"Endpoint discovery denied. Reconnect with chutes:invoke or an API key."* — telling a user who just pasted an API key to reconnect with an API key, and naming an OAuth scope that appears nowhere else in the product. The field is silently emptied and shows its at-rest format hint, describing a problem the user did not have. The product did something correct and important and reported it as an unrelated networking noun.

**File:** `src/ui/access-view.tsx`

Exact copy:
> **Chutes did not accept this key.** The catalog is readable without a key, so listing models succeeded; authorization is checked when you connect, and it failed. Check the key at chutes.ai → API keys, or paste a different one.

Keep the raw provider reason — including `chutes:invoke` — verbatim under a **"Provider response"** disclosure. **Do not clear the field on refusal**; leave it masked and filled so it can be corrected. Suppress the at-rest format hint whenever a submitted-key refusal is showing.

**Reviewer confirms:** submit a well-formed bogus `cpk_`; the field retains its value, the banner names the key, and the provider string is present under the disclosure.

---

### DN-10 · Preferences says your data is in Encrypted Google Drive while Vault says Disconnected
**1 critic, measured in one page state. Blocker. Effort: small.** `#vault` reads "Disconnected | No vault claim | No cloud vault is configured." while the Preferences Durability row reads "Encrypted Google Drive · cross-device", with no qualifier and rendered identically to eight cosmetic rows. A user who never visits `#vault` will believe their workspace is encrypted in Drive when nothing is attached. This is the only Preferences row whose value is a claim about the world rather than a rendering choice, and it is currently asserting more than the code establishes — a direct contract breach.

**File:** `src/ui/routes.css` (Preferences rows), plus the durability value source.

Exact copy: render selection-plus-state — **`Google Drive · not connected`** / **`Google Drive · connected`**, reusing the Vault route's own chip vocabulary. Give the row the helper-sentence treatment `Tool steps` already gets:
> Where conversations survive a closed tab. Nothing is attached yet — set it up in **Vault**.

Put the row under a divider labelled **STORAGE** so it is not read as presentation. While in this row: its menu currently opens with `visibleFraction 0.49` (top 805.3, bottom 998.3 against a 900px viewport) — flip it upward when the trigger is in the lower third, and add the consequence to each option: **`Ephemeral · page memory only — nothing survives closing this tab`**.

**Reviewer confirms:** with no vault adopted, Preferences and `#vault` state the same thing. Assert the menu's `getBoundingClientRect().bottom <= innerHeight`.

---

### DN-11 · "Paper" colour mode makes every divider in the product invisible
**2 sources (colour; capture team "no light frame exists to photograph"). Blocker. Effort: small-medium.** Confirmed the mechanism: `THEME_CSS_VARIABLES` carries exactly 9 roles and `--line` is not among them. The profile theme writes those 9 inline on `<html>`, beating the light palette at `platform-shell.css:128-139`, so the *only* token that flips is `--line` — from `rgba(225,217,200,.105)` to `rgba(23,26,29,.14)` over a still-dark ground. **1.259:1 → 1.007:1.** Every panel edge, table rule and row separator becomes darker than the surface it divides. This is worse than a no-op: the most user-visible of nine Preferences rows actively degrades the one thing holding 22 near-identical dark surfaces apart.

**File:** `src/profiles/domain.ts`
Preferred fix: make `applyThemeProperties` (line ~201) skip roles the active theme has not explicitly overridden, so a default profile writes **zero** inline properties and the stylesheet cascade owns the mode.
Minimum fix: add `--line` and `--line-strong` to `THEME_CSS_VARIABLES` and to the light palette, and add the six missing light-mode roles to the shipped default theme's light variant.

Take the preferred fix — it also closes the whole class of "theme silently beats stylesheet", which is the same mechanism as DN-2.

**Reviewer confirms:** select Paper; `--line` composites ≥ 1.2:1 against `--ground`; `<html>` carries no inline custom properties under a default profile. This is also the fix that finally makes a light frame photographable — capture the set.

---

### DN-12 · `opacity: .45` cancels the disabled token declared 266 lines above it
**1 critic. Major. Effort: small.** `tokens.css:28-30` declares `--ink-disabled: #6b726f` with the comment *"Disabled is carried by explicit colour, never by transparency, so it composites predictably over any surface."* `tokens.css:296` then applies `opacity: 0.45` to every disabled button. Because opacity multiplies against whatever is behind, "disabled" has 22 different appearances (1.72:1, 1.76:1 brass-on-brass, 2.40:1, 3.83:1, 3.91:1). WCAG exempts inactive controls, so this is not a violation — it is a promise the codebase makes to itself and breaks, and it is why reviewers read enabled buttons as disabled and vice versa.

**File:** `src/ui/tokens.css:294-297`
```css
button:disabled {
  cursor: not-allowed;
  color: var(--ink-disabled);
  background: var(--surface-disabled);
  border-color: var(--line);
}
button.primary:disabled {
  color: var(--ink-disabled);
  background: var(--surface-disabled);
  border-color: var(--line-control);
}
```
Delete the duplicates: `local-lab-setup.css:209` and the `opacity:.45` on `.terminal-tab__rename` at `terminal-view.css:34`.

**Reviewer confirms:** grep for `opacity: .45` / `opacity: 0.45` on any `:disabled` selector returns 0. Every disabled button computes the same two colours on every route.

---

### DN-13 · The evidence sidebar is typeset larger than the model's answer
**2 critics (craft 3; clarity 8). Blocker. Effort: small (type) + medium (collapse). Contract-sensitive.** `.proof-bottom-line` computes to **17px** in a 310px column; the assistant's answer computes to **15.94px** in a 751px column. The caveat is set one step *louder* than the content it qualifies, in a narrower measure, which makes it optically larger still — the exact inversion of the discipline everywhere else. Below it, seven `.claim-row` at 61.56px each = 431px = **51% of an 842px main**, every one printing the identical pair "Asserted / Turn receipt".

**Ship the type fix now** (`src/ui/chat.css`):
```css
.proof-bottom-line { font-size: var(--fs-meta); color: var(--ink-muted); }
.inspector-heading h2 { font-size: var(--fs-lead); }   /* removes the 18px literal at chat.css:1556 */
```
That 18px literal is also one of the nine elements that ignore the Type scale preference — fixed here.

**The collapse is re-presentation, not removal.** Render one group header per distinct verdict — **`ASSERTED · 7 · from turn receipt`** — with the seven claim titles as a `--fs-caption` comma-run beneath, and **every per-claim disclosure preserved behind the existing chevron**. Target `.claim-row` at 34px so seven claims occupy ~240px instead of 431px. Where claims differ, they render as separate rows; the collapse fires only when they are identical. Give each row its own one-line consequence drawn from the sentences `#proof` already writes ("Protected CPU runtime — no TEE quote bound to this turn") so the rail earns its 300px.

**Reviewer confirms:** every claim id is still individually reachable and its disclosure still opens — assert all seven in a test. The "Asserted, not verified" sentence is the loudest thing in the column.

---

### DN-14 · Finish the route-header migration and delete the forbidden clamp
**1 critic, but it fires on every navigation. Major. Effort: small — 90% already landed.** `RouteHeader` + `.route-title` (correct: `var(--fs-display)`, one baseline) is adopted by 9 routes. Six still render legacy `.page-heading`: `access-route.tsx:35`, `app.tsx:5295`, `app.tsx:7004`, `billing-route.tsx:33`, `capabilities-view.tsx:56`, `context-route.tsx:37`. And `routes.css:63-65` still carries `font-size: clamp(30px, 4vw, 47px)` — which `tokens.css:59` forbids **by name**, citing WCAG 1.4.4, and which produces the 47px/29.75px title split and the 90px vertical wander.

**Files:** the six `.tsx` above → `<RouteHeader>`; then delete `.page-heading` and its `h1`/`p` rules from `routes.css` (58-74, 2866-2876) entirely. Also move `#connection`'s title out of the `--connect-measure` column so its x matches the other nine — the 760px measure should govern the lane list, not the page header.

**Reviewer confirms:** `grep -r "page-heading" src/` returns 0; `grep -rn "clamp([0-9]" src/ui --include="*.css"` returns no `font-size` hit. Navigate all ten routes and assert the h1's `getBoundingClientRect()` x and y are constant, and its computed size is 28px at `--type-scale: 1`. `route-adversarial-audit.spec.ts` already measures this — extend it.

---

### DN-15 · 60 font-size literals bypass the ramp; nine elements ignore the Type scale preference
**2 critics (craft 1, craft 9). Blocker. Effort: medium, but purely mechanical.** Verified breakdown: 29×11px, 7×12px, 6×16px, 4×18px, 4×15px, 4×13px, 3×17px, 1 each of 19/20/25px, plus two unspaced. The 11px literals are *below* `--fs-micro` and do not scale. Consequence: `data-type-scale="x-large"` moves 39 of 48 elements on `#chat` and freezes the wordmark, the runtime status line, both disclosure chevrons, both skip links and the largest heading — so every relationship tuned at 1× is wrong at 1.25×, and the preference fails the guideline `tokens.css` cites by number.

**Re-home by role, not by nearest value.** `--fs-micro` is identifiers, counts and units only; every sentence of prose goes to `--fs-caption` minimum; every reading paragraph to `--fs-body`.

Named offenders to start with: `shell.css:93` `.brand-name` 20px → `var(--fs-title)`; `shell.css:530` `.runtime-line__text` 11px → `var(--fs-micro)`; `shell.css:141` `.topbar-posture-chip__count` — remove the em-relative shrink (it produces 9.74px, the smallest text in the product) → `var(--fs-micro)`; `chat.css:1556` → `var(--fs-lead)` (done in DN-13); `sessions-view.css:637`; the two disclosure chevrons → `var(--fs-meta)`.

**Guard:** extend `src/ui/type-floor.test.ts` (which already owns the 11px floor) with an assertion of **zero** `font-size:\s*[0-9.]+px` outside `tokens.css`. Extend `src/ui/density-contract.test.ts` with an assertion that toggling `data-type-scale` changes the computed `font-size` of **every** element carrying a text node on `#chat`.

**Reviewer confirms:** both new tests. Then set `x-large` and confirm nothing is frozen.

---

# DO NEXT

Real, worth doing, but either larger or lower-frequency than the above.

1. **The spacing grid** (craft 5; 253 off-scale gaps, 115 padding values, `--sp-5/6/7` used 16 times total). Snap in one pass — 1,2,3→`sp-1`; 5,6,7→`sp-2`; 9,10,11→`sp-3`; 13-18→`sp-4`; 20,22,24→`sp-5`. Nothing moves more than 3px. Then *spend* the recovered budget: `sp-5` between sections, `sp-6` between panels, `sp-7` header-to-first-panel. **Measure gzip before and after** (see §8).
2. **Seventeen line-heights, nine letter-spacings** (craft 13). Add `--lh-heading: 1.25`, `--lh-ui: 1.4`, `--track-caps: 0.08em`; map all 179 literals onto four values. Find-and-replace; nothing moves >2px per line.
3. **`space-between` as the default layout** (craft 7 + 18; 59 declarations, 20 rows pushing label from value 150–982px). Add `.kv` as a two-column grid capped at 46ch. Preferences becomes `grid-template-columns: 180px minmax(0,1fr)` — which also stops "Encrypted Google Driv…" truncating with 210px of void beside it.
4. **In-button busy state for the 5.7s and 18.3s waits** (motion ×2). The product already owns the spinner (`shell.css:409`, used in 3 places, none of them these). Label swaps to "Discovering…"/"Verifying…", `aria-busy`, `Seal state="checking" acting` in the leading slot. Render the status strip into a present-but-empty slot so pressing stops moving the button 46px down / 18px up under the cursor.
5. **Copy acknowledges nothing** (motion 10 + capture team). Four implementations, four durations, three glyph vocabularies — and the most-used one is silent. Extract `useCopyFeedback(1200)`; delete the `button.textContent` mutation at `markdown.tsx:302-304` (a direct DOM write inside a Preact subtree — that is *why* it never paints).
6. **29 seconds of an identical looping ellipsis** (motion 2). Elapsed `m:ss` from submit, sentence-cased phase word, endpoint named after 8s. Keep the dots mounted until the first character lands so the card stops *shrinking* at the moment progress begins.
7. **The slash menu** (clarity 5 + 6): model-facing manifests rendered at users (1,069 chars into a 481px slot, 92% unreachable, no `title`), and row 0 pre-selected is `/deactivate-execution-runtime` — a destructive teardown that wins the Enter key purely by alphabetical sort. Add a human `label` field beside the model-facing `description`; order by consequence, not alphabet.
8. **Confine the accent to pressable geometry** (colour 2). 253 references, 36 hand-mixed tints, 17 adjacent steps below JND. `.eyebrow` → `--ink-muted`; `.receipt-chip`/`.runtime-posture` → `--ink-muted`; name the four unnamed brass border alphas as `--accent-line` / `--accent-line-strong`. Then one primary-button recipe (currently three, in two golds) — solid `--accent-bright` with `--ground` text, the 10.06:1 one.
9. **Two-tone focus ring** (colour 10). Current ring is the accent on accent-bordered controls — 1.73:1 apart, 0° hue, same radius. Add `box-shadow: 0 0 0 4px var(--ground)` so it always sits on a dark halo.
10. **Landscape phone** (mobile 3 + 4). 54% chrome at rest; keyboard-up the composer renders *under* the tab bar with a 41px overlap. Drive `--shell-vh` from `visualViewport`; add a `(max-height: 500px) and (pointer: coarse)` block.
11. **Phone chat chrome budget** (mobile 5). 312px fixed regardless of viewport = 60% of what you can see with the keyboard up. Target 236px at rest, 160px keyboard-up.
12. **Four tab treatments** (craft 15) → the `#proof` one (quietest, most legible), which also returns 384px of brass fill from a *navigation state* back to actions.
13. **Four nested borders on the Connect lane** (craft 16); equal-mass primary and escape hatch; a raw locale timestamp with seconds.
14. **`.seal` renders at three heights in one viewport** (craft 11) and wraps to two lines inside a fixed-width pill. Pin the anatomy; shorten labels at source rather than wrapping.
15. **Session-bar collapse strobes** (motion 7): a single threshold at 48px on a continuously variable input, with a 29% type-size change across one pixel of scroll. `COLLAPSE_AT = 72` / `RESTORE_AT = 16`, plus a 140ms transition.
16. **Dismissal is the loudest object on every overlay** (craft 10). "Close" measures 14.03:1 in the trust sheet; the four claims measure 4.43:1. DN-2 fixes the claims; this fixes the ordering.
17. **Workspace / Terminal / Sources on phone** (mobile 9, 10, 11) — 350px before the first file, 227px of shell in 932px, and 629px of boundary copy unreachable in a 372px box with no scroll cue. **The Sources one is a contract issue**: the caveat is rendered, so the code believes it is honest, but the user cannot read it. Wrap, don't scroll.
18. **Four remaining copy fixes**: interruption card states one fact three times under two red ⚠ boxes for a deliberate user action (clarity 12); the workspace filter's zero state says nothing while the product's own sessions zero state is the best I have seen (clarity 11); lane status chips mix three grammatical moods and "API key ready" reads as configured (clarity 8); the topbar truncates away the clause that carries its caveat (clarity 15).
19. **Diff blocks render additions and deletions in identical ink** (colour 13). The one place the verdict palette would earn its keep gets nothing while the TypeScript block beside it gets five hues. Use a 2px inset bar so colour is never the only carrier.
20. **`1 claim … declare verification`** (clarity 22) — confirmed at `proof-view.tsx:261`: the noun pluralises, the verb doesn't. On the hero verdict of the Proof route. Also define "ceilings" once, or rename to "limits".

# NICE

- 22 rendered surface fills from 5 tokens, 38 pairs below JND (colour 11) — real, but *large* effort for a difference the eye largely cannot resolve. Do it as cleanup, not as a design pass.
- Memory graph legend: 6 kinds, 3 swatch colours, two of them ΔE 8.9 apart at 7px (colour 14). Fix by shape + size, not by adding golds.
- Monospace used as a tone of voice — 117 mono elements in one viewport including full sentences (craft 12). Accept the principle; do it view-by-view.
- Twenty-five chips in a viewport containing one sentence and three cards (craft 22); the doubled `⌗ 1 #3dd85763` hash; the unbounded journal count in the product's smallest face.
- Boot splash: 46ms when unneeded, static for 27s when needed (motion 12). Put the mark in `index.html` so the first paint on a slow connection is the brand, not a black rectangle.
- Route skeletons flashing for one frame on four routes, and one that never unmounts (motion 14).
- `.pulse-dot` does not pulse (motion 11). Either animate it or rename it.
- "a Anthropic" / "a xAI" (clarity 27) — one line at `connect-lanes.ts:494`, confirmed. Trivial, but it lands on the sentence explaining a refusal.
- More sheet: dismissal in the hardest thumb zone, five rows describing themselves as "Destination", and `#capabilities`/`#skills`/`#context` unreachable from the phone at all (mobile 13).
- Touch surfaces still speaking keyboard: "Esc or a tap outside dismisses this menu" and `⌘S` on a device with no ⌘ (mobile 19).

# REJECTED

| # | Item | Why |
|---|---|---|
| R1 | **Model switch keeps the prior transcript on screen with a divider** (motion 6) | **Contract violation.** A switch creates a new pinned session with its own receipt chain. Rendering the previous conversation's messages under the new session id makes the visible transcript no longer correspond to the receipts that cover it — the product would be showing evidence that does not apply to what is on screen. *Replacement:* keep the fork, but promote the explanation from `--ink-muted` grey below the headline to a full-width divider row *above* the first-run block, and add `Open the previous conversation →` resolving to the prior session id. Same information, correct binding. |
| R2 | **Move `.seal[data-state="asserted"]` to `--v-caution`** (colour 1, colour 12) | Breaks `type-floor.test.ts:30`, and conflates "asserted" (a truth-source axis) with "caution" (an attention axis). Achieved instead by moving `.attestation-chip.asserted` *to copper* — see §4A. |
| R3 | **Find a consumer for `--fs-hero`** (implied by craft 1) | A token with zero consumers is not a gap to fill; inventing a use to justify it is backwards. Keep it declared and unused, or delete it — do not add 40px type to a product whose problem is that it has no ramp. The first-run lead goes to `--fs-display`. |
| R4 | **Anchor the first-run block to the top with `padding-block-start: var(--sp-7)`** (craft 2) | Directly reverses commit `3e44847`, three commits old and deliberate. Take the type ramp only. |
| R5 | **Delete the second instruction sentence on the Connect lane** (craft 16) — *partially* | The sentence is instructional, not a caveat, so deletion is allowed — but the `cpk_` hint inside it **must** survive into the field's placeholder or helper line. Rejected as written; accepted with that condition. |
| R6 | **Blanket mono→body sweep across 117 elements** (craft 12) | Right principle, wrong blast radius for one pass. The Connect discovery banner in mono/verdigris is genuinely distinguishing machine-read catalog output from product prose. Demoted to Nice, done per view. |
| R7 | **Reduce the composer's four stacked facts by dropping the posture sentence** | Not proposed by any critic in this form, but it is the obvious shortcut a swarm will reach for. The sentence is a caveat. It **moves** into the `credential in memory` chip's popover — which already reads as a control and currently has no hover affordance at all — and a test asserts it is still in the accessible tree. |
| R8 | **Add a pagination control to the model picker at >30 models** (capture team §2.5) | `PAGE_SIZE` is 30 and the live credential returns 12–13 eligible models. The control cannot render with the credential the spec prescribes. Not a defect — remove it from the spec. |
| R9 | **"Five lanes reachable at once" / conversation delete / profile delete / discard-a-change** (capture team, multiple) | These are states the product does not have (the lane list is an accordion by design; there is no delete anywhere; Source Control has no revert). Not design defects — **spec drift**. Fix the capture script, not the app. Same for `#access` as a URL: it is a view id, not a hash. |

---

# Must not regress

| Guardrail | Baseline | How it breaks |
|---|---|---|
| **132 KiB gzip startup cap** | **128.89 KiB measured — 3.11 KiB headroom** (`scripts/release-gate.mjs:22`) | **The most likely casualty on this list, and no critic mentioned it.** Every Do-now/Do-next item *adds* CSS. The token re-homing passes look byte-negative (`var(--sp-2)` is 11 chars vs `8px`) but gzip should net *win* on them, since 366 identical `var(--sp-2)` strings compress far better than 20 distinct literals. The genuinely additive items are DN-3, DN-5, DN-6 and DN-12. **Run `npm run check:release` after every item, not at the end** — with 3.11 KiB of headroom, the swarm will find out too late otherwise. If it tightens, the cheapest recovery is deleting `.page-heading` (DN-14) and the duplicate disabled rules (DN-12), both already on this list. |
| **2148 unit tests / 245 files** | Verified green, 10.5s | DN-7 changes user-visible strings — `access-view.copy.test.ts`, `trust-language.test.ts` and `coherence-contract.test.ts` will need updating *deliberately*, not silently. DN-14 deletes `.page-heading` — check `route-layout.test.ts` and `route-header.test.ts`. Any change to `--copper` hits `type-floor.test.ts:30`. **A test that changes is a decision; make it in the commit message.** |
| **e2e suite** (33 specs) | Green | DN-1, DN-6 and DN-14 all touch things `route-adversarial-audit.spec.ts` measures. Extend it rather than relaxing it. |
| **Keyboard reachability** | Full | **DN-6 is the risk**: `hidden` → `inert` changes the a11y tree. Assert closed panels stay out of the tab order *and* out of the a11y tree. Also: the skip links must stay first in tab order on phone (currently better than desktop — do not lose that). |
| **44px touch targets** | Met almost everywhere | DN-1 reflows the composer tools row — re-measure every control in it. Known existing exceptions to fix, not create: `.capability-chip` 137×20, Send 41×44, journal chip 36×42. |
| **Reduced motion** | Honoured | DN-5 and DN-6 both add motion. Every new rule ships inside `@media (prefers-reduced-motion: reduce)` in the same commit — opacity survives, transform does not. |
| **Contrast floor** | AA everywhere after DN-2 | The new `css-variable-contract.test.ts` assertion is what makes this permanent. Do not ship DN-2 without it, or the next theme reverts it exactly as this one did. |

**Suggested swarm split:** DN-1/DN-10/DN-14 (layout+routing), DN-2/DN-3/DN-11/DN-12 (colour+theme — all four touch `tokens.css`/`catalog.ts`/`domain.ts`, keep them on one agent to avoid conflicts), DN-4/DN-5/DN-6 (motion — one agent, one file each), DN-7/DN-8/DN-9 (copy+contract — the highest-risk lane, needs the predicate test *first*), DN-13/DN-15 (typography).