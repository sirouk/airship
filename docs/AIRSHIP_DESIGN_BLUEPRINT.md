# Airship Design Blueprint

**Status:** Detailed design reference; [`CANON.md`](CANON.md) governs current product decisions
**Design language:** Instrument  
**Generated:** 2026-07-18  
**Scope:** Visual design, product behavior, interaction logic, responsive behavior, performance, accessibility, component architecture, and delivery sequencing. This is deliberately not a security audit.

This blueprint consolidates the completed Claude Opus 4.8 design-only ultracode fanout: 36 recovered specialist and adversarial outputs spanning the design constitution, information architecture, chat, workflows, state systems, performance, QA, and delivery planning. The original recovered outputs remain unchanged under `.airship-lab/harvest/`. It remains the detailed design record, but later navigation, provider, trust, and implementation decisions are reconciled in `CANON.md` and supersede conflicting blueprint text.

## Canonical coherence locks

These decisions resolve the five contradictions found across independently authored drafts. They are also applied directly in the relevant sections below.

| Lock | Canonical decision |
|---|---|
| **C1 · Mobile navigation** | Exactly five fixed tabs: **Chat · Sessions · Workspace · Trust · More**. The bar never scrolls horizontally. Seven additional top-level destinations and the nested Skills/Account tabs live in More and Cmd/Ctrl+K. |
| **C2 · Editor display cap** | **128 KiB** before bounded/windowed reveal. |
| **C3 · Transcript overscan** | **8 variable-height message cards on each side** of the visible window. |
| **C4 · Command palette** | All **11 destinations**, nested Skills and Account tabs, authorized slash commands, recent sessions, and trust drill-downs. |
| **C5 · Seal grammar** | Resting token is `none`, labelled **Not checked**. The system has **six SVG shapes and seven named states**; `stale` is the dashed variant of the `checking` arc. |

## Reading order

1. Design constitution and original visual language
2. Information architecture and wireframes
3. Chat, transcript, and composer
4. Detailed interaction specifications
5. State matrix, component architecture, performance, and QA
6. Prioritized backlog, simplification list, and north-star walkthrough

---

<!-- Reconciled source: airship/.airship-lab/harvest/30_constitution.md -->

# THE AIRSHIP DESIGN CONSTITUTION
### D1 — Executive Verdict & Governing Principles · D3 — Original Visual Language

---

## D1 · EXECUTIVE DESIGN VERDICT

### What Airship is

Airship is a **static, backendless, edge-first browser agent** whose one defensible reason to exist is **radical trust honesty**: it tells you, at a glance and in a drill-down, exactly how much is proven — local vs remote, ephemeral vs synced, encrypted vs attested, asserted vs verified — while remaining as capable as a first-class CLI agent on a phone. Everything else (the chat, the file tree, the graph) is table stakes that competitors already ship. The trust layer is the product.

### What is genuinely strong (preserve, do not regress)

- **The trust *model*** — three honest postures, asserted-vs-verified copy (`"Key match · unverified"`), fail-closed approvals, local-tool results tagged `excluded from model context`, optimistic-concurrency guards, identity-fenced streaming. No mainstream agent does this.
- **The streaming engine** — rAF-coalesced deltas, identity fences, disciplined `AbortController`. Superior to the borrow target.
- **The lightweight footprint** — three runtime deps (preact/sigma/graphology). This constraint *is* the moat; every fix below ships as zero-dep Preact.
- **Honest bounding as first-class UI** — transcript-boundary banner, bounded diff preview, 200-session cap.

### What is broken (the load-bearing failures)

1. **The signature does not exist as an artifact.** The shape-encoded proof seal — the single ownable idea — ships as Unicode glyphs (`✓ ◐ × · —`) typed into CSS circles, drawn *differently on every surface*, with the Proof hero seal **hardcoded to `◐`** regardless of posture. The differentiator lives only in prose.
2. **Truth colors are themeable.** The Verdigris profile inverts verified-green and caution-brass, so a "verified" seal renders gold. A differentiator that flips meaning between profiles is worse than none.
3. **The transcript is sub-CLI.** Agent output is an unstyled `<p>`; model tool-calls are invisible; nothing auto-scrolls; nothing is virtualized. The capability promise fails in the first message.
4. **Trust dies on mobile.** All four runtime seals, the proof inspector, and the pending-evidence badges are `display:none` on a phone — the immutable "legible at a glance" truth is the first thing dropped.
5. **7–9px type is pervasive and unfixable** — 107 sub-10px label sites, and the one "large type" knob is defeated by px-locked chrome (a WCAG 1.4.4 failure).
6. **Two immutable truths are orphaned** — "ephemeral vs synced" and "selected workspace" have no indicator anywhere.

### The single north-star bet

> **Make the proof seal a crafted, shape-first, six-state SVG instrument that is Airship's visual signature — rendered identically from favicon to topbar to every transcript turn and tool action — sitting inside a genuinely CLI-grade transcript, on top of a color system where trust meaning can never move.** Everything else is plumbing that must ship but earns no identity credit.

---

### THE 12 GOVERNING PRINCIPLES

Each is named, stated, and testable via a **Means / Forbids** clause.

**P1 · Truth is Immutable, Personality is Themeable.**
Verdict and truth colors are defined once in `:root` and are structurally outside the theme system.
*Means:* `--v-*` and `--truth-*` tokens; profile themes touch only accent/corners/density/font. *Forbids:* any `theme.colors` path that can recolor a seal, meter, or status; any verdict token aliasing `--accent`.

**P2 · Shape Carries, Color Confirms.**
Every trust state is distinguishable with color removed, via a distinct SVG shape plus an adjacent plain-language word.
*Means:* six-shape seal set, `role="img"` + `aria-label`, word-first labels, ≥16px seal wells. *Forbids:* color-only distinction (warn vs neutral dot); a glyph-in-a-circle as the sole encoder; seal glyphs below 16px.

**P3 · One Seal, Everywhere.**
A single `<Seal>` component and one state→shape table render identically on topbar, transcript, proof inspector, and attestations.
*Means:* shared component; hero seal computed from real posture. *Forbids:* divergent inline glyph ternaries; a hardcoded `◐` hero; `×` here / `!` there for the same state.

**P4 · Legibility Floor of 11px.**
No computed font-size is below `0.6875rem` (11px), and the type-scale knob actually enlarges the chrome.
*Means:* rem type tokens multiplied by `--type-scale`; chrome authored in tokens. *Forbids:* px-literal type sizes; any label under 11px; a scale knob that only moves the root em.

**P5 · The Transcript is the Instrument.**
The agent's actual work — structured output and every tool action, each stamped with its trust seal — is the primary surface; chrome serves it.
*Means:* markdown/code rendering; inline sealed tool-step rows; provenance stamped on turns. *Forbids:* plain-`<p>` output dumps; invisible model tool-calls; a permanently-mounted inspector that starves the chat column below ~1040px.

**P6 · Progressive Disclosure Without Amputation.**
The default view is minimal, but every expert forensic stays exactly one gesture away and deep-linkable.
*Means:* summary inline, detail one tap; preserved `#hashes`; Cmd/K palette as prerequisite for any nav merge. *Forbids:* hiding forensics behind *removed* destinations; default-collapsing the *fact* that a step/tool action occurred; hard row caps with no "show all N."

**P7 · Bounded by Default.**
Every unbounded surface is virtualized or capped and states its bounds honestly.
*Means:* windowed transcript/file-list with a measurement cache; metadata-only workspace reads; boundary banners. *Forbids:* `map`-all rendering; eager full-content reads after every turn; silent truncation; "progressive count" that never unmounts.

**P8 · Manufacturing Quality, Not Costume.**
Instrument feel comes from precision — hairlines, engraved rules, an exact 4px grid, milled selection bars — never from glass, glow, or texture.
*Means:* CSS+SVG geometry only. *Forbids:* `backdrop-filter` on any surface with <15% transparency; decorative gradients/glows that encode no data; gears/dirigibles/scanlines/particles; motion added to satisfy an adjective.

**P9 · Trust Survives Every Breakpoint.**
The local/remote/encrypted/attested/ephemeral posture and pending-evidence signals are legible on phone, tablet, and desktop.
*Means:* a worst-of trust chip in the mobile topbar expanding to a sheet; badges mirrored to mobile nav. *Forbids:* blanket `display:none` on any trust, approval, or review surface without an equivalent replacement.

**P10 · Motion Reports State, Never Decorates.**
Animation exists only to convey live agent/system state or ≤160ms state-change feedback; otherwise the interface is instant.
*Means:* one in-flight "acting" pulse that runs only while working; functional transitions ≤160ms. *Forbids:* any idle animation loop; decorative-only motion; motion not gated by `prefers-reduced-motion`.

**P11 · Plain Language Leads, Machine Detail Follows.**
User-visible trust/status is a ranked plain-language verdict; enums, digests, and ISO timestamps live behind disclosure.
*Means:* humanizers on every surface; one bottom-line verdict per receipt; relative age with absolute in `title`/`<time>`. *Forbids:* raw kebab enums (`encrypted-unattested`), raw ISO strings, or raw digests in the default view.

**P12 · Ephemeral vs Synced is Always Answered.**
Durability is a first-class, explicit indicator, and this build is honestly labeled ephemeral-only.
*Means:* a per-artifact durability state (`ephemeral | syncing | synced`); a stated single-workspace scope. *Forbids:* silent ephemerality; any UI implying sync that the runtime does not perform.

---

## D3 · THE ORIGINAL VISUAL LANGUAGE

The system is named **Instrument** — a precision-tool aesthetic where trust is machined into the surface. Everything below is authored in `rem`, on a 4px grid, in two modes, with a locked truth tier.

### (a) Color system — dark + paper, with locked truth semantics

**Architecture:** three tiers. **Neutrals** and **Truth/Verdict** are fixed per mode. **Personality** is the only themeable tier.

```css
/* ============================================================
   TIER 1 — NEUTRALS (fixed per mode; themes may NOT change)
   ============================================================ */
:root,
:root[data-mode="dark"] {
  color-scheme: dark;

  --ground:         #101417;  /* app backdrop (deep graphite) */
  --surface:        #171c20;  /* default panel fill           */
  --surface-raised: #1c2226;  /* composer, dropdowns, code     */
  --surface-soft:   #14191c;  /* sidebar, insets, field fills  */
  --surface-sunk:   #0d1113;  /* wells, track backgrounds      */

  --ink:        #ece8de;      /* primary text (warm ivory)     */
  --ink-muted:  #a6aca9;      /* secondary (nudged up for AA)  */
  --ink-faint:  #8f9793;      /* tertiary  (11px floor min)    */

  --line:        rgba(225,217,200,0.11);
  --line-strong: rgba(225,217,200,0.20);
  --rule-hi:     rgba(225,217,200,0.05); /* engraved highlight */
  --rule-lo:     rgba(0,0,0,0.35);       /* engraved shadow    */

  --shadow-panel: 0 12px 34px rgba(0,0,0,0.20);
  --shadow-float: 0 16px 45px rgba(0,0,0,0.28);
  --shadow-modal: 0 22px 64px rgba(0,0,0,0.42);
}

:root[data-mode="light"] {
  color-scheme: light;

  --ground:         #f3efe5;  /* paper */
  --surface:        #efe9dc;
  --surface-raised: #fbf7ee;
  --surface-soft:   #eae3d4;
  --surface-sunk:   #e2dccb;

  --ink:        #1a1d1f;
  --ink-muted:  #454b49;
  --ink-faint:  #5c635f;

  --line:        rgba(23,26,29,0.14);
  --line-strong: rgba(23,26,29,0.24);
  --rule-hi:     rgba(255,255,255,0.55);
  --rule-lo:     rgba(23,26,29,0.10);

  --shadow-panel: 0 10px 26px rgba(60,50,30,0.10);
  --shadow-float: 0 14px 38px rgba(60,50,30,0.14);
  --shadow-modal: 0 20px 56px rgba(60,50,30,0.20);
}

/* ============================================================
   TIER 2 — TRUTH & VERDICT (IMMUTABLE. Never themeable.
   Same token names in both modes; only the value darkens for
   paper so meaning is pixel-stable across mode AND profile.)
   ============================================================ */
:root, :root[data-mode="dark"] {
  /* verdict tier — drives seals, meters, status */
  --v-verified: #67a39a;  /* verdigris  — verified / attested / synced / good */
  --v-caution:  #d9a441;  /* amber      — pending / stale / refresh-due / warn */
  --v-failed:   #c86758;  /* red        — failed / expired / blocked / danger  */
  --v-info:     #7fa8c9;  /* steel-blue — checking / in-progress / neutral-info*/
  --v-neutral:  var(--ink-faint); /* resting / not-applicable                 */

  /* truth-axis metals — origin & durability (shape reinforces) */
  --truth-local:  #8ba0a6; /* steel  — on-device / local origin                */
  --truth-remote: #bd6f4c; /* copper — remote / encrypted-unattested / asserted*/

  /* runtime state (motion carries; color reinforces) */
  --state-acting: var(--v-info);   /* animated while in-flight ONLY  */
  --state-wait:   var(--ink-faint);/* static                         */

  /* cost / standing — aliases of verdict; no new hue */
  --cost-ok:       var(--v-verified);
  --cost-warning:  var(--v-caution);
  --cost-exhausted:var(--v-failed);
}

:root[data-mode="light"] {
  --v-verified: #2f6f66;
  --v-caution:  #8f6410;
  --v-failed:   #a2402f;
  --v-info:     #2f5f86;
  --truth-local:  #47585e;
  --truth-remote: #8a4326;
}

/* ============================================================
   TIER 3 — PERSONALITY (the ONLY themeable colors)
   Profile themes may set --accent / --accent-bright within a
   contrast-checked range. Brass is identity, NOT truth.
   ============================================================ */
:root, :root[data-mode="dark"] {
  --accent:        #c19a58;  /* brass — CTA, active nav, links   */
  --accent-bright: #dfba72;  /* bright brass — focus, active fill*/
  --accent-ink:    #17130c;  /* text ON brass CTAs               */
  --brand-brass:   #c19a58;  /* brand mark — PINNED, never themed*/
}
:root[data-mode="light"] {
  --accent:        #9a7136;
  --accent-bright: #b8894a;
  --accent-ink:    #fbf7ee;
  --brand-brass:   #9a7136;
}
```

**Truth-color semantics profile themes may NEVER override:**

| Concept | Token | Reinforcing shape/treatment |
|---|---|---|
| local / on-device | `--truth-local` (steel) | solid seal, "on-device" |
| remote / encrypted-unattested / asserted | `--truth-remote` (copper) | **half seal** ◐ |
| verified / attested / synced | `--v-verified` (verdigris) | **filled check seal** |
| checking / in-progress | `--v-info` (steel-blue) | **interrupted ring** |
| caution / stale / refresh-due / expiry | `--v-caution` (amber) | **warning diamond** |
| failed / expired / blocked | `--v-failed` (red) | **crossed seal** |
| ephemeral | `--truth-local` + **dashed border** | hollow / dashed |
| synced | `--v-verified` + **solid border** | solid |
| acting vs waiting | `--state-acting` **animates** / `--state-wait` static | motion carries |
| cost healthy/warning/exhausted | `--cost-*` (verdict aliases) | flat meter fill |

> Brass (`--accent`) carries **no** truth meaning and appears on **no** seal, meter, or status. This is what makes profile theming safe.

---

### (b) Typography — three roles, one scale, 11px floor

```css
:root {
  /* families */
  --font-display: Georgia, "Times New Roman", serif; /* editorial display */
  --font-body:    Inter, system-ui, sans-serif;      /* humanist body     */
  --font-mono:    ui-monospace, "SF Mono", Menlo, monospace; /* evidence   */

  /* type scale knob — actually multiplies every size */
  --type-scale: 1;

  /* MODULAR SCALE (rem @16px root) × --type-scale.  Floor = 0.6875rem/11px */
  --fs-micro:  calc(0.6875rem * var(--type-scale)); /* 11px HARD FLOOR      */
  --fs-caption:calc(0.75rem   * var(--type-scale)); /* 12px                 */
  --fs-meta:   calc(0.8125rem * var(--type-scale)); /* 13px labels/evidence */
  --fs-body:   calc(0.9375rem * var(--type-scale)); /* 15px body copy       */
  --fs-lead:   calc(1.0625rem * var(--type-scale)); /* 17px lead / h4       */
  --fs-h3:     calc(1.375rem  * var(--type-scale)); /* 22px                 */
  --fs-h2:     calc(1.875rem  * var(--type-scale)); /* 30px                 */
  --fs-h1:     clamp(2rem, 1.4rem + 2.6vw, 2.75rem);
  --fs-hero:   clamp(2.25rem, 1.6rem + 3vw, 3.25rem); /* metric heroes      */

  --lh-tight: 1.2;
  --lh-body:  1.6;
  --tracking-eyebrow: 0.08em;
}
:root[data-type-scale="large"]   { --type-scale: 1.15; }
:root[data-type-scale="x-large"] { --type-scale: 1.30; }
```

**Role assignment (enforced, consistent across ALL views — no more Inter-h1 drift):**

- **Display serif** (`--font-display`): every page/stage/proof `h1`/`h2`, boot headline, and **all numeric hero values** (metrics, balance, runway). Applied to the four rem-views' `h1` too.
- **Body sans** (`--font-body`): all body copy at `--fs-body` / `--lh-body`; composer at `--fs-body`, bumped to 16px on mobile only (iOS-zoom guard, applied to **every** input including `.git-sources`).
- **Evidence mono** (`--font-mono`): digests, receipts, telemetry, code blocks, eyebrows. **Minimum size `--fs-micro` (11px). The 7/8/9px stratum is deleted.**

> `data-body-font="system-serif"` swaps `--font-body`→serif **only**; it must not touch `--font-mono` or `--font-display`.

---

### (c) Spacing / density scale

```css
:root {
  --pad-scale: 1;                    /* density knob multiplier */
  --u: 0.25rem;                      /* 4px base unit           */
  --sp-1: calc(1  * var(--u));       /* 4  */
  --sp-2: calc(2  * var(--u));       /* 8  */
  --sp-3: calc(3  * var(--u));       /* 12 */
  --sp-4: calc(4  * var(--u));       /* 16 */
  --sp-5: calc(6  * var(--u));       /* 24 */
  --sp-6: calc(8  * var(--u));       /* 32 */
  --sp-7: calc(12 * var(--u));       /* 48 */

  /* padding tokens flex with density; margins/gaps do not */
  --pad-tight:   calc(var(--sp-2) * var(--pad-scale));
  --pad-control: calc(var(--sp-3) * var(--pad-scale));
  --pad-panel:   calc(var(--sp-5) * var(--pad-scale));

  /* touch/target */
  --target-min: 44px;   /* mobile & pointer-coarse */
  --target-desk: 36px;  /* pointer-fine baseline   */
}
:root[data-density="compact"]     { --pad-scale: 0.8; }
:root[data-density="comfortable"] { --pad-scale: 1.1; }
```

**Density rules:** `data-density` scales **padding tokens only** (not type, not gaps) so rhythm compresses without breaking the 11px floor. All literal odd-value paddings (`13px 22px 12px`) are replaced by `--pad-*` tokens on the 4px grid. `@media (pointer: coarse)` forces `--target-min` on all interactive rows regardless of viewport (fixes sub-44px desktop-touch).

---

### (d) Shape, engraved rule, depth, material

```css
:root {
  --radius-sm:   5px;
  --radius-md:   8px;   /* controls */
  --radius-lg:   12px;  /* panels   */
  --radius-pill: 999px;
}
:root[data-corners="square"]  { --radius-sm:3px; --radius-md:5px; --radius-lg:7px; }
:root[data-corners="rounded"] { --radius-sm:8px; --radius-md:12px; --radius-lg:16px; }
```

**Engraved rule** — the milled-edge signature, CSS-only, no texture:

```css
.rule--engraved {                 /* a machined divider */
  border: 0;
  height: 0;
  border-top: 1px solid var(--rule-lo);
  box-shadow: 0 1px 0 var(--rule-hi);
}
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-panel);
}
.is-selected {                    /* knurled selection bar */
  box-shadow: inset 3px 0 0 var(--accent);
  background: var(--surface-raised);
}
```

**Material discipline (P8):**
- Depth = shallow token shadows + hairlines + engraved rules. One heavy shadow (`--shadow-modal`) reserved for the blocking approval dialog.
- `backdrop-filter: blur()` is **permitted only** where the surface is >25% transparent **and** the surface is gated behind both `@media (max-width: 640px)` removal and `prefers-reduced-transparency: reduce`. The approval scrim and slash menu are added to those guards. Topbar/composer/dropdowns become 100% opaque solid fills (they were already 88–96%) — blur deleted.
- The blueprint grid and radial glows are **removed** unless a rendered pass proves them visible AND they encode data (they do not). Structure comes from rules and grid, not ambient wash.

---

### (e) Iconography + the proof-seal shape grammar

**Icons:** 24×24 viewBox, `stroke-width: 1.65`, `stroke: currentColor`, `aria-hidden` unless labeled. One stroke system.

**The Seal** — one component, six shapes, drawn as real SVG (not glyphs). Minimum well **16px**, glyph strokes scale with it. Every instance: `role="img"`, `aria-label={word}`, and a **plain word rendered adjacent**.

```
STATE            SHAPE (SVG)                 WORD          COLOR(reinforce)
─────────────────────────────────────────────────────────────────────────
none              ○  thin outlined ring       "Not checked" --v-neutral
checking / stale  ◜◞ interrupted 270° ring     "Checking" /  --v-info /
                     (dashed for stale)         "Stale"       --v-caution
verified          ⬤✓ filled disc + check       "Verified"    --v-verified
service / partial  ◐  half-filled seal          "Asserted"    --truth-remote
warning/expiry    ◇! rotated-square diamond+!   "Attention"   --v-caution
failed            ⊗  crossed circle             "Failed"      --v-failed
```

```jsx
// One canonical component. Kills every inline glyph ternary.
function Seal({ state, size = 18, label }) {
  return (
    <span class={`seal seal--${state}`} role="img" aria-label={label}
          style={`--seal-size:${Math.max(size,16)}px`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{SEAL_PATHS[state]}</svg>
    </span>
  );
}
```

**Rules:** the Proof hero seal is **computed from posture** (solid check = attested, half = encrypted-unattested, outlined-steel = local) — never hardcoded. The topbar warn state uses the **diamond**, not a colored dot. The **brand mark and the verified seal share one geometry** (the diamond seeds the warning shape; the disc seeds the mark) so favicon, PWA icon, boot, topbar, and seal are visibly one instrument, all pinned to `--brand-brass`.

---

### (f) Motion tokens

```css
:root {
  --dur-control: 120ms;   /* hover/press/nav state feedback   */
  --dur-surface: 160ms;   /* panels, sheets, popovers          */
  --dur-acting:  1400ms;  /* the ONE in-flight pulse loop      */
  --ease-std:  cubic-bezier(0.2, 0, 0, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);
}

/* the only permitted loop — runs ONLY while an operation is in-flight */
.is-acting .pulse { animation: acting-pulse var(--dur-acting) var(--ease-std) infinite; }
@keyframes acting-pulse { 0%,100%{opacity:.45; transform:scale(1)} 50%{opacity:1; transform:scale(1.12)} }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important; animation-iteration-count: 1 !important;
    transition-duration: .001ms !important; scroll-behavior: auto !important;
  }
}
```

Transitions animate **transform / opacity / color / border-color / background-color only**, capped at 160ms, and are **excluded from any element rendered per-row inside the transcript or file list** until those are virtualized. No idle loops. The acting pulse mounts only while `message.status` is present or a route/turn is busy, and reverts to a static dot on completion.

---

### (g) Focus & selection

```css
:root { --focus-ring: 2px solid var(--accent-bright); --focus-offset: 2px; }

*:focus { outline: none; }
:where(button, a, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset);
  border-radius: var(--radius-sm);
}
```

**One focus color app-wide** — the vault/local-lab blue `#8db8df` ring is deleted; those views inherit brass. Selection uses the inset knurl bar (`inset 3px 0`), never color alone. A visible **"Skip to content"** link is the first focusable element; the approval dialog gets a real focus trap + `inert` on the shell behind it.

---

### (h) Responsive breakpoint tokens

CSS media queries cannot read custom properties, so these are the **canonical, exclusive** breakpoints; every stylesheet must use exactly these three (the 8-vocabulary sprawl is banned). Component-level adaptation uses **container queries** instead of new page breakpoints.

```
--bp-rail:    1040px   /* proof inspector collapses to a toggle; grids reflow  */
--bp-compact:  860px   /* sidebar → icon rail; inspector → drawer               */
--bp-mobile:   640px   /* bottom nav; trust chip; safe-area; 16px inputs        */

content rails:
--measure-prose: 72ch          /* readable text column     */
--rail-side:     220px         /* sidebar                  */
--rail-side-min: 74px          /* icon rail                */
--rail-inspect:  min(340px, 30vw)
```

**Mobile trust mandate (P9):** at `--bp-mobile`, `topbar-center` is **not** removed — the four seals collapse into one **worst-of trust chip** (`<button class="trust-chip">`) that expands to a sheet listing all axes; proof/attestation badges mirror to the fixed mobile nav; the five fixed tabs never horizontally scroll, while overflow destinations live in the More sheet and command palette; `env(safe-area-inset-*)` on all four sides; `visualViewport` pins the composer above the keyboard.

---

### (i) How profile themes may vary — without breaking truth or a11y

A theme manifest is validated against this **allow-list**; anything else is rejected at load.

```
THEME MAY SET                    THEME MAY NEVER SET
──────────────────────────────   ─────────────────────────────────────
--accent        (brass hue)      any --v-*  (verified/caution/failed/info)
--accent-bright                  any --truth-* (local/remote/durability)
data-corners  (square|rounded)   --state-acting / --cost-*
data-density  (compact|comfy)    --ink / --ground / --surface* / --line*
data-body-font(system-serif)     any --fs-* / --type-scale floor
data-mode     (dark|light)       --font-mono / --font-display
                                 --brand-brass (identity is pinned)
                                 motion tokens
```

**Validation gate (build + runtime):**
1. `--accent` must pass **≥4.5:1** contrast against both `--ground` and used as text, and **≥3:1** as a non-text UI element; reject otherwise.
2. `--accent-ink` on `--accent` must pass ≥4.5:1 (CTA legibility).
3. `applyTheme` may `setProperty` **only** the allow-listed tokens plus the four enum `data-*` attributes; it can touch nothing in Tiers 1–2.
4. A **light/paper theme** ships once the truth tier is locked — it inherits identical `--v-*`/`--truth-*` semantics, so a verified seal is the same *meaning* (and shape) on paper and graphite. Type-scale/density/corners live in a real **Settings** surface, not only in a profile's `themeId`.

**Result:** a profile can feel warmer, tighter, squarer, serif, or light — but a *verified* seal is the identical verdigris check, an *asserted* seal the identical copper half, and a *failed* seal the identical red cross, in every profile, on every device, at 11px and up.

---

```
SHELL WIREFRAME (desktop ≥1040px) — chrome serves the instrument
┌───────────────────────────────────────────────────────────────────────┐
│ ◆Airship   [⬤✓ Local][◐ E2EE][◇ Attest ·this session]      ⟳acting  ⌘K │  ← topbar: seals = shape+word, session-scoped one flagged
├────────┬──────────────────────────────────────────────┬────────────────┤
│ WORK   │  Active session · Engineer         [model ▾] │  PROOF          │
│ ·Chat  │  ┌────────────────────────────────────────┐  │  ⬤✓ Verified    │  ← hero seal computed, not hardcoded
│ ·Sess. │  │ You  ▸ …                                │  │  Encrypted &    │
│ ·Files │  │ A    ▸ prose (markdown/code rendered)   │  │  attested       │
│ ·Mem   │  │      ├ ◐ read README.md → 512B   [▸]    │  │  ─ engraved ─   │
│ AGENT  │  │      └ ⬤✓ write app.tsx  +12 −3  [▸]    │  │  claim stack…   │
│ ·Ctx   │  │ ▼ jump-to-latest (streaming)           │  │  (1 tap deep-   │
│ ·Prof. │  └────────────────────────────────────────┘  │   link #proof)  │
│ TRUST  │  [ Ask Airship or / for tools…      ] (send) │  [collapse ◂]   │  ← inspector toggles ≤1040
│ ·Vault │  🔒 credential in memory · tool approvals on  │                 │
└────────┴──────────────────────────────────────────────┴────────────────┘
 Every turn + every tool action stamped with the ONE seal. Trust never
 display:none'd — on ≤640 the seal row becomes one worst-of trust-chip.
```

This constitution resolves the review's tensions by decision: **subtract chrome, but never expert reach** (P6); **render structure and tool activity inline, but only after virtualization lands** (P5+P7); **make the seal the signature, but only once truth colors are locked** (P1+P3); **keep it materially precise, not glassy** (P8). Build the seal, lock the truth tier, floor the type at 11px, and stamp the transcript — and Airship stops being a beautiful proof shell around a generic chat and becomes the instrument it claims to be.

---

<!-- Reconciled source: airship/.airship-lab/harvest/34_synth-ia.md -->

# D2 — INFORMATION ARCHITECTURE, NAVIGATION MODEL & SCOPE

## D2.0 Governing decisions (how the adversarial tensions were resolved)

| Tension | Decision |
|---|---|
| TOO DENSE ("collapse to ~9, one posture home") vs HIDES POWER ("keep Sources/Proof/Attestations/Vault top-level, deep-link hashes survive, Cmd/K first") | **Expert reach is preserved; density is paid down elsewhere.** Ship the **Cmd/K command palette first** (it is the licensing prerequisite). Reduce top-level from 13 → **11** by nesting only two *same-scope* pairs (Skills→Profiles tab, Account→Access tab). **Sources, Proof, Attestations, Vault stay single-click with their own `#hash`.** Density is removed from the four places it actually hurts: the 4-seal topbar cram → one posture cluster; the duplicate profile switcher → deleted; the always-mounted 310px inspector → collapsible at 1040px; the 7–9px stratum → 11px floor; the horizontal-scroll mobile bar → **5 fixed tabs + More-sheet + palette**. |
| Scope encoding (IA "tint + legend") vs TOO DENSE ("≤1 mark, no legend") | **One 2px left edge-mark per item, no nav legend.** Scope is *taught contextually* by a one-word scope token in each view's `.stage-header` breadcrumb, not by a decoder key in the sidebar. |
| Trust-illegible + Mobile-fiction ("posture must be glanceable, one worst-of") vs HIDES POWER ("all 4 dimensions visible where they fit") | **Responsive posture control.** ≥1040px: labeled 4-seal *cluster*, each seal a clickable drill-down (one chrome region = one posture home). 640–1040px: single **worst-of chip** → sheet. ≤640px: worst-of chip in 52px topbar → sheet + a **Trust primary tab**. |
| Completeness ("ephemeral/synced + selected workspace orphaned; no Settings") | Add a **Durability** dimension to the posture control (this build = `Ephemeral`, stated honestly), a **workspace name token** in the Workspace stage-header, and a **Settings sheet** (transient, not a nav slot). |

---

## D2.1 The five scopes and their spatial expression

```
SCOPE          RE-RENDERS WHEN…            EDGE-MARK TOKEN        BREADCRUMB WORD   HOME
─────────────────────────────────────────────────────────────────────────────────────────
session        active session switches    --scope-session       "Session · <prof>" stage-header + Trust cluster
workspace      workspace/files change      --scope-workspace     "Workspace"        stage-header (carries ws name)
profile        active profile switches     --scope-profile       "Profile · <name>" topbar profile control
global         never (app singletons)      --scope-global        "Global"           topbar / Access
transient      opened/dismissed            (none — overlays)      —                 sheets/dialogs/pills
```

```css
/* low-chroma "tolerance marks" — reinforcement, never the sole cue */
:root{
  --scope-session:   color-mix(in srgb, var(--truth-local)  50%, transparent);
  --scope-workspace: color-mix(in srgb, var(--v-verified)   45%, transparent);
  --scope-profile:   color-mix(in srgb, var(--accent)       45%, transparent);
  --scope-global:    color-mix(in srgb, var(--ink-faint)    60%, transparent);
}
.nav-item{ box-shadow: inset 2px 0 0 var(--scope-tint); }      /* scope: always visible  */
.nav-item.is-active{ box-shadow: inset 3px 0 0 var(--accent); background: var(--surface-raised); }
```

The **active** brass inset bar (3px) sits over the **scope** 2px mark on the same edge, so at rest every item shows its scope tint and the active item shows brass — two states, one edge, no legend.

---

## D2.2 Complete surface inventory

**A · Navigable destinations (11 top-level + 2 nested)**

| # | Surface | Scope | Route | Group | Persistence (this build) |
|---|---|---|---|---|---|
| 1 | **Chat** | session | `#chat` | Work | ephemeral journal |
| 2 | **Sessions** (library) | global | `#sessions` | Work | ephemeral, ≤200 listed |
| 3 | **Workspace** (files/editor) | workspace | `#workspace` | Work | ephemeral (`MemoryWorkspace`) |
| 4 | **Sources** (git) | workspace | `#sources` | Work | ephemeral adapter state |
| 5 | **Memory** (graph) | session-derived | `#memory` | Work | derived, page-memory |
| 6 | **Context** (retrieval) | workspace | `#context` | Agent | derived, page-memory |
| 7 | **Profiles** | profile | `#profiles` | Agent | page-memory revisions |
| 7a | ↳ **Skills** (tab) | profile | `#skills` | Agent | page-memory |
| 8 | **Proof** (session receipt) | session | `#proof` | Trust | last receipt |
| 9 | **Attestations** (endpoint ledger) | global | `#attestations` | Trust | page-memory ledger |
| 10 | **Vault** (storage posture) | global | `#vault` | Trust | probe state |
| 11 | **Access** | global | `#connection` | Trust | connection state |
| 11a | ↳ **Account/Billing** (tab) | global | `#account` | Trust | snapshot |

Legacy aliases preserved: `#access`→Access·Connection, `#billing`→Access·Account.

**B · Transient surfaces (overlays — never consume a nav slot)**

| Surface | Class | Trigger | Form |
|---|---|---|---|
| Command palette | `.cmdk` | `Cmd/Ctrl+K`, topbar `⌘K`, mobile search | focus-trapped dialog |
| Slash menu | `.slash-menu` | `/` in composer | combobox popover |
| Model picker | `.model-picker` | model control | searchable, ≤30-row bounded list |
| Approval dock | `.approval-dock` | tool gate | dialog (desktop) / bottom sheet (mobile) |
| Trust sheet | `.trust-sheet` | posture chip | bottom sheet / popover |
| Profile sheet | `.profile-sheet` | topbar profile control | popover / sheet |
| Settings sheet | `.settings-sheet` | Cmd/K, sidebar gear | sheet (`#settings`) |
| More sheet (mobile) | `.more-sheet` | `More` tab | bottom sheet grid |
| Jump-to-latest | `.jump-pill` | scrolled up while streaming | pill |
| Offline banner | `.runtime-banner--offline` | `navigator.onLine=false` | slim strip |
| Update banner | `.runtime-banner--update` | SW `controllerchange` | slim strip |
| Boundary banner | `.boundary-banner` | truncation/bounds | conditional strip |
| Error boundary | `.crash-fallback` | render throw | replaces `.stage` only |

---

## D2.3 Desktop navigation model (≥1040px)

```
Regions (constitution grid):
  --topbar-h: 58px;  --rail-side: 220px;  --rail-side-min: 74px;
  --rail-inspect: min(340px, 30vw);  --mobile-nav-h: 56px;

.app-shell{
  display:grid;
  grid-template-columns: var(--rail-side) minmax(0,1fr);
  grid-template-rows: var(--topbar-h) minmax(0,1fr);
}
```

- **Sidebar** (`.sidebar`, 220px): 3 semantic groups (WORK / AGENT / TRUST), 11 items, each with scope edge-mark + `aria-current`. Pending-evidence badge dots on Proof and Attestations. Footer: **durability status line** (`Ephemeral · nothing synced`) + **Settings gear** + rail-collapse toggle. **No profile switcher here** (deleted duplicate).
- **Topbar** (`.topbar`, 58px, opaque, no blur): brand mark (pinned `--brand-brass`) · **trust cluster** (4 labeled clickable seals) · spacer · **acting indicator** · `New` (creates session) · `⌘K` · profile control.
- **Stage** (`.stage`): every view mounts here. `.stage-header` carries the **scope breadcrumb**, the view title (serif `--font-display`), and view-local tabs.
- **Inspector** (`.inspector`, `min(340px,30vw)`): Chat only; **collapsible at ≤1040px** (Scale-Perf demand). Hosts the ProofInspector whose **hero seal is computed from posture**.
- **Command palette**: hard prerequisite. Lists all 11 destinations + nested tabs (with `#hash`), all authorized slash commands, recent sessions, Settings.
- **860–1040px**: sidebar → 74px icon rail; inspector → toggle drawer; trust cluster → worst-of chip.

---

## D2.4 Mobile navigation model (≤640px) — the horizontal-scroll solve

**Decision: fixed 5-tab bottom bar + More-sheet + palette. Zero horizontal overflow, ever.**

```css
.mobile-nav{
  display:grid;
  grid-template-columns: repeat(5, 1fr);   /* FIXED 5 — never scrolls */
  height: var(--mobile-nav-h);              /* 56px + safe-area */
  padding-bottom: env(safe-area-inset-bottom);
}
.mobile-nav__tab{ min-width:0; min-height:44px; }
.mobile-nav__tab.is-active{ box-shadow: inset 0 2px 0 var(--accent); }  /* SHAPE cue, not color-only */
```

- 5 primary tabs (min 72px each; fits ≥360px): **Chat · Sessions · Workspace · Trust · More**.
- **Trust tab** opens Proof (session receipt) and mirrors pending badges. Persistent glance-posture also lives in the 52px topbar **worst-of chip** → trust sheet.
- **More tab** opens `.more-sheet` — a **vertical grid** (`repeat(4,1fr)`, wraps down, scrolls vertically) of the remaining peers: **Sources · Context · Memory · Profiles · Skills · Attestations · Vault · Access · Settings**. Sources is a *peer tile* here — a single tap to its own `#sources`, **not** a Workspace sub-tab.
- The More-sheet header is a **search field = mobile Cmd/K** (type-ahead over destinations + commands).
- The five primary tabs remain fixed and never call horizontal `scrollIntoView`; navigation to an overflow destination opens or selects its row in the More sheet. Active state uses a 2px top rail + filled icon.
- `visualViewport` pins the composer above the keyboard; the bottom nav yields while the keyboard is open.

```
MOBILE NAV STATE MACHINE
 [52px topbar: ◆  (worst-of trust chip)  ⌘K/⚲ ]
 ────────────── stage (100dvh − topbar − nav) ──────────────
 [ Chat ][ Sessions ][ Workspace ][ Trust• ][ More ]   ← 5 fixed, safe-area
        └ More → bottom sheet (search + 4-col vertical grid, no h-scroll)
```

---

## D2.5 Command palette spec (`.cmdk`)

```
┌─ ⌘K ──────────────────────────────────────────────┐
│  ⌕  jump to… ▏                                     │  role=combobox, aria-expanded
├────────────────────────────────────────────────────┤
│  DESTINATIONS                                      │
│   ▸ Chat                                    #chat  │  session ·
│   ▸ Sources · Git                        #sources  │  workspace ·
│   ▸ Proof · this session                   #proof  │  session ·
│   ▸ Attestations · endpoint ledger  #attestations  │  global ·
│  COMMANDS (authorized only)                        │
│   / read <path>     / write <path>    /sessions.new│
│  RECENT SESSIONS                                   │
│   ⟲ Engineer · deploy audit           2 min ago    │
│  SETTINGS                                          │
│   ⚙ Type scale · Density · Theme       #settings  │
└────────────────────────────────────────────────────┘
Esc closes → focus restored. ↑/↓ move, Enter run, focus trapped.
```

---

## D2.6 Trust posture control (one component, three responsive forms)

```
DESKTOP ≥1040  .trust-cluster  (4 labeled clickable seals, one region)
   [(✔) Local][(◐) E2EE][(◐) Attest·session][(▨) Ephemeral]
     └steel     └copper    └copper +scope tag  └dashed/caution

COMPACT 640–1040  .trust-chip (worst-of)
   [(◐) Encrypted · unattested  ⌄]   → opens .trust-sheet

MOBILE ≤640  .trust-chip in 52px topbar → .trust-sheet (bottom)
```

Trust sheet (drill-down, plain-language-first, ranked):

```
┌ Trust posture ──────────────────────────── ✕ ┐
│  BOTTOM LINE                                  │
│  (◐) Encrypted · not independently checked    │  ← ranked worst-of verdict
│  ─ engraved ─                                 │
│  Origin        (✔) On-device            →Vault│
│  Encryption    (◐) E2EE · asserted   →Access  │
│  Attestation   (◐) This session      →Proof   │  ← carries session id
│  Durability    (▨) Ephemeral · nothing synced │  ← honest, this build
└───────────────────────────────────────────────┘
```

Seals are the **one `<Seal>` component**; shape carries meaning, color reinforces, every seal has `role="img"` + adjacent word.

---

## D2.7 Token & seal conventions used by all wireframes

```
SEAL ASCII → <Seal state> (SVG, well ≥16px, aria-label = word)
  (○) not-checked  --v-neutral      (◔) checking    --v-info
  (▨) stale/eph.   --v-caution/dash (✔) verified    --v-verified
  (◐) asserted     --truth-remote   (◆!) attention  --v-caution
  (✕) failed       --v-failed
TYPE FLOOR: --fs-micro .6875rem (11px) — no computed size below it.
DENSITY: data-density scales --pad-* only. MOTION: control 120ms / surface 160ms /
acting 1400ms pulse (in-flight only). BREAKPOINTS: 1040 / 860 / 640 (exclusive).
```

---

# D4 — WIREFRAMES

## Desktop shell (≥1040px)

```
┌ .topbar (58px, opaque) ───────────────────────────────────────────────────────────────┐
│ ◆Airship   [(✔)Local][(◐)E2EE][(◐)Attest·sess][(▨)Ephem]        ⟳acting  New  ⌘K  (E)▾ │
├ .sidebar 220px ─────────┬ .stage  minmax(0,1fr) ──────────────────┬ .inspector 340px ◂ ┤
│ WORK   ·session/ws      │ .stage-header                           │  PROOF · session   │
│  |▍Chat        ·session │  Session · Engineer   [model ▾]  (▨)Eph │  (◐) Asserted      │
│  | Sessions    ·global  │ ─────────────────────────────────────── │  Encrypted, not    │
│  | Workspace   ·ws      │  You ▸ ship the deploy audit            │  independently     │
│  | Sources     ·ws  •   │  A   ▸ prose (markdown / code rendered) │  checked           │
│  | Memory      ·session │      ├(◐) read README.md → 512 B   [▸]  │  ─ engraved ─      │
│ AGENT  ·profile         │      └(✔) write app.tsx  +12 −3    [▸]  │  Transport   (◐)   │
│  | Context     ·ws      │      ▼ jump to latest (streaming)       │  Evidence    (▨)   │
│  | Profiles    ·profile │ ─────────────────────────────────────── │  CPU TEE     (○)   │
│ TRUST  ·global/session  │ [ Ask Airship, or / for tools…  ] (Send)│  Endpoint    (◐)   │
│  | Proof       ·session•│ 🔒 credential in memory · approvals on  │  [ open #proof ]   │
│  | Attestation ·global •│                                         │  [ collapse ◂ ]    │
│  | Vault       ·global  │                                         │                    │
│  | Access      ·global  │                                         │                    │
│ ───────────────────     │                                         │                    │
│ (▨) Ephemeral·no sync ⚙ │                                         │                    │
└─────────────────────────┴─────────────────────────────────────────┴────────────────────┘
Hero seal COMPUTED from posture (not hardcoded ◐). Inspector collapses at ≤1040 → toggle.
```

## Mobile shell (≤640px)

```
┌ .topbar 52px ───────────────────────────┐
│ ◆  [(◐) Encrypted·unattested ⌄]     ⌕ ⌘K │  ← worst-of chip → trust sheet
├ .stage (100dvh − 52 − 56, safe-area) ───┤
│  Session · Engineer        [model ▾]    │
│  ─────────────────────────────────────  │
│  A ▸ prose…                             │
│    └(✔) write app.tsx +12 −3      [▸]  │
│  ▼ jump to latest                       │
│  ───────────────────────────────────    │
│  [ Ask Airship…            ] (Send)     │  ← pinned via visualViewport
├ .mobile-nav 56px (5 fixed, safe-area) ──┤
│ [Chat][Sessions][Workspace][Trust•][More]│  ← NO horizontal scroll
└──────────────────────────────────────────┘
 More → bottom sheet: ⌕search + grid{Sources•,Context,Memory,Profiles,Skills,
        Attestations•,Vault,Access,Settings}  (4-col, wraps down, v-scroll)
```

## Chat

```
DESKTOP: see shell. Each turn + each tool action stamped with ONE <Seal>. Tool rows are
collapsible, default-EXPANDED (HIDES POWER), bounded-preview capped (broker 512c/32i).
Streaming: only the in-flight card re-renders; stick-to-bottom; jump-pill when scrolled up.

MOBILE:
┌ Session · Engineer   [model ▾]  (▨)Eph ┐
│ You ▸ …                                │
│ A   ▸ prose (md/code)                  │
│   ┌ tool ─────────────────────────┐    │
│   │(✔) write app.tsx  +12 −3   [▸]│    │  ← sealed action card, tappable
│   └────────────────────────────────┘    │
│ ▼ jump to latest                        │
│ [ Ask Airship…              ] (Send)    │
└─────────────────────────────────────────┘
```

## Sessions

```
DESKTOP ─────────────────────────────────────────────────────────────
 Sessions · Global          [⌕ filter] [Resumable ▾][Sort ▾]   (▨)all ephemeral
 ┌ list (max-height, overflow-y) ─┬ detail ─────────────────────────┐
 │ ★ Engineer · deploy audit ●Act │ Engineer · deploy audit  ✎rename │
 │   Reviewer · schema fork       │ Health: Locally consistent      │
 │   Engineer · welcome           │ Structural linkage only ·       │
 │   … (200 cap, banner if more)  │ digests not recomputed          │
 │                                │ Forked from ⟲a1b2 (→navigate)   │
 │  [★ pin] toggles per row       │ ┌ action ─────────────────────┐ │
 │                                │ │ resume=[Resume session]     │ │  ← primary only if resumable
 │                                │ │ fork  =[Fork to continue]▐  │ │  ← primary when fork-required
 │                                │ │ "Fork = new identity ·      │ │
 │                                │ │  empty transcript · source  │ │
 │                                │ │  untouched"                 │ │
 │                                │ └─────────────────────────────┘ │
 └────────────────────────────────┴─────────────────────────────────┘
 Resume busy → button reads "Auditing history…" + aria-live.

MOBILE ── list = VERTICAL cards (not h-rail); pins sticky on top; tap → detail view;
          Sort/filter in a [⋯] overflow (never display:none).
```

## Workspace

```
DESKTOP ─────────────────────────────────────────────────────────────
 Workspace · /workspace (single workspace, this build)   (▨)Ephemeral
 ┌ files (own max-height, overflow, VIRTUALIZED) ─┬ editor ───────────┐
 │ ⌕ filter files                                 │ app.tsx           │
 │  ▸ src/                                         │ showing first     │
 │    app.tsx        12 KB                         │ 64 KiB — bounded  │
 │    styles.css     88 KB                         │ ┌───────────────┐ │
 │  ▸ docs/                                        │ │ <pre> bounded │ │
 │  N of M shown ▾ (metadata-only; content lazy)   │ │  + load full  │ │
 └────────────────────────────────────────────────┴───────────────────┘
 (dead "Tracking unavailable" 3rd column REMOVED → width reclaimed to editor;
  git lives in Sources.)

MOBILE ── stacked: [⌕ files ▾] collapsible → editor below; file-list virtualized.
```

## Sources (Git)

```
DESKTOP ─────────────────────────────────────────────────────────────
 Sources · Workspace · git    [Refresh]     Remote: origin · https  ↑2 ↓0 · fetched 3m
 ┌ changes (role=list) ───────────────┬ diff ─────────────────────────┐
 │ [☑ all/none]  [Stage all]          │ app.tsx  [Staged][Working][⤶wrap]│
 │ ☐ [M]staged  app.tsx    +12 −3     │  @@ -1,4 +1,6 @@   (--accent)  │
 │ ☐ [A]work    new.ts     +40        │ + added line     (--v-verified)│
 │ ☐ [◆!]CONFLICT merge.ts            │ - removed line   (--v-failed)  │
 │    → not bulk-stageable; [Resolve] │   context line                 │
 │   [Stage][Unstage]                 │                                │
 └────────────────────────────────────┴────────────────────────────────┘
 Status = LETTER+shape pill (M/A/D/R/C), index=filled / working=outlined, ≥.8rem --ink.
 [Commit locally] → approval · [Push] → separate approval · force-push NOT surfaced.

MOBILE ── all inputs ≥16px (iOS zoom-guard extended to .git-sources).
          Sticky bottom action bar mirrors notice + next action (Stage→Commit→Push),
          so post-commit confirmation is in the thumb zone, never off-screen at top.
```

## Context

```
DESKTOP ─────────────────────────────────────────────────────────────
 Context · Workspace                       Preview only — not yet inserted into replies
 Searches supported text & code in this workspace. Sessions/memory indexed separately.
 ┌ metrics ─────────────────────────────────────────────────────────┐
 │ State: Ready · some files skipped(◆!)   Files searchable: 42       │  ← degraded ≠ green
 │ Skipped 3 · Failed 1   Index size: 2.1 MiB                        │
 └───────────────────────────────────────────────────────────────────┘
 ⌕ search ▏
 ┌ results — "What will be pulled in — and why" ────────────────────┐
 │ This folder    src/agent.ts   read 8 KiB / 64 KiB budget         │
 │   why: folder match + recent edit                                │
 │ Recent work    app.tsx        read 4 KiB                         │
 │ (◆!) recall reduced — 1 expert unavailable                       │
 │ ▸ Technical details (digests, dims, cosine 0.72/lexical 0.28)    │  ← forensics kept, disclosed
 └───────────────────────────────────────────────────────────────────┘

MOBILE ── metrics stack; results one per row; Technical details collapsed by default.
```

## Memory

```
DESKTOP ─────────────────────────────────────────────────────────────
 Memory · Session-derived   "bounded materialized view — not durable memory"
 (◆!) Bounded view — omitted: 120 terms · 3k chars   Isolated: 4   Density: Sparse ·0.003
 ┌ graph (WebGL, lazy) ───────────────────────┬ inspector ───────────┐
 │        ● session   ■ file   ◆ skill         │ Node: app.tsx        │
 │        ○ term      ◇ profile ● message      │ when: 3 min ago      │
 │   (kind = SHAPE+color, legend == canvas)    │ lineage: extracted   │
 │   select → camera pans/zooms to node        │   from conversation  │
 │                                             │ Relations by kind ▾  │
 │   [legend tiles are clickable → hide kind]  │  contains 18 of 256  │
 └─────────────────────────────────────────────┴──────────────────────┘
 ⌕ search (debounced 140ms, listbox, N of M) · [Hide from view]/[Reset] (view filter only)

MOBILE ── canvas touch-action:none ("drag to explore"); tap node → detail scrolls into view;
          WebGL-unsupported → DOM node list fallback (not a dead end).
```

## Profiles / Skills

```
DESKTOP ─── tabs: [ Profiles | Skills ]  (#profiles / #skills) · scope: profile
 Profiles · Engineer                                    rev ⟲3f9 · parent ⟲2a1
 ┌ catalog ─────────────┬ editor ───────────────────────────────────┐
 │ ▸ Engineer  (active) │ Name  [ Engineer            ]  •unsaved     │  ← dirty indicator
 │   Reviewer           │ System prompt [ …………………… ]                 │
 │   Researcher         │ Trust floor: (◐) Encrypted · unattested ▾  │  ← minimumPosture SHOWN
 │                      │ Model: airship-demo-v1 (fork to change)    │
 │                      │ Theme swatch: ▉ground ▉surface ▉ink ▉accent│  ← incl. ink + danger
 │                      │             ▉signal ▉danger  [Preview]      │
 │                      │ [Save new revision]   [Apply in new session]│  ← Apply disabled if dirty
 └──────────────────────┴────────────────────────────────────────────┘
 SKILLS tab: card = name · resolved on/off · "Instructions reference: read_file…"
   note: "Enabling adds pinned instructions to the next session's prompt.
          It does NOT grant tools — tool approvals are separate and always prompt."

MOBILE ── catalog = top strip; editor stacked; tabs as segmented control.
```

## Vault

```
DESKTOP ─── Vault · Global (storage posture)          focus/status = app brass (no off-brand blue)
 ┌ phase ───────────────────────────────────────────────────────────┐
 │ (○) Disconnected → [Configure vault]   |  or ready state below     │
 └───────────────────────────────────────────────────────────────────┘
 READY:
 ┌ readiness matrix (8 items, shape+word) ──────────────────────────┐
 │ (✔) Storage contract passed     (▨) Sync not evaluated            │
 │ (◐) Key present · unverified     (○) …                            │
 └───────────────────────────────────────────────────────────────────┘
 DEGRADED: code · retryable · requestId · "probe residue" warning (no raw provider data)
 Probing → live working state with [Cancel]. This surface sets the topbar Vault seal.

MOBILE ── matrix stacks; [Configure vault] full-width primary.
```

## Attestations

```
DESKTOP ─── Attestations · Global · endpoint evidence ledger   ("Records are not merged")
 ┌ record header counts ────────────────────────────────────────────┐
 │ (✔) Verified 4   (◐) Asserted 2   (◆!) Attention 1   (✕) Failed 1  (▨) Expired 1 │  ← Expired split out
 └───────────────────────────────────────────────────────────────────┘
 ┌ record ─────────────────────┬ dimension inspector ───────────────┐
 │ [ENDPOINT] llm.chutes.ai     │ Transport   (✔) Verified            │
 │  (✔) Endpoint key · verified │ CPU TEE     (◐) Present·unverified  │  ← plain qualifier
 │ [ASSERTED] conversation      │ scope · subject · age(3m) · expiry  │
 │  (◐) Key match · unverified  │ evidence digest ▸ (disclosure)      │
 └──────────────────────────────┴─────────────────────────────────────┘

MOBILE ── record list top; inspector below; StatusMark keeps dashed border for Expired.
```

## Access (Connection + Account)

```
DESKTOP ─── tabs: [ Connection (#connection) | Account (#account) ] · scope: global
 CONNECTION:
 ┌───────────────────────────────────────────────────────────────────┐
 │ ●Recommended  [ Sign in with Chutes ]  (verdigris card)            │
 │   (disabled on non-registered origin + inline reason beside button)│
 │ ▸ Use an inference API key instead (cpk_)                          │
 │ Capability matrix:  Chutes account (cak_) | Inference key (cpk_)   │  ← plain nouns lead
 │ ☑ I understand this endpoint is not independently attested         │
 │ Model: [⌕ searchable picker ▾]  (≤30 rows, facets: hot·tools·$·ctx)│  ← no raw all-models select
 └───────────────────────────────────────────────────────────────────┘
 ACCOUNT (gated — needs OAuth):
 ┌───────────────────────────────────────────────────────────────────┐
 │ Balance (✔)$12.40  Runway (◆!)2d  Usage (?)unknown  Auth (✔)ok     │  ← honest datum states
 │ Observed 3m ago (warn tint if stale)                              │
 │ (◆!) Balance low → [ Add funds at Chutes ↗ ]  (in-card CTA)        │
 └───────────────────────────────────────────────────────────────────┘

MOBILE ── tabs = segmented control; picker = full-screen search list; metric cards 1-col,
          money/tokens ≥11px (type-scale reaches them).
```

## Approval dock (transient — referenced by Workspace/Sources/Chat)

```
DESKTOP dialog / MOBILE bottom sheet (focus-trapped, shell inert, Esc=Deny):
┌ Allow write to app.tsx?  ───────────────────────────── expires 4:58 ┐
│ (△ write) Effect: writes to your workspace                          │
│ Target: /workspace/app.tsx   [Replace] · 512 B (Δ +12 −3)           │  ← consequence first-class
│ ▸ bounded diff preview (old→new)      ▸ arguments (collapsed)        │
│  [ Deny ]              [ Allow once ]                                │  ← equal weight; Deny focused;
└─────────────────────────────────────────────────────────────────────┘   mobile: sticky footer, Allow NOT sole thumb target
```

---

## D2.8 Scope → chrome summary (spatial rules, final)

- **Global** truths live in **topbar** (trust cluster, profile, acting) and are addressable in **Access/Vault/Attestations/Sessions**; edge-mark `--scope-global`.
- **Session** truths live in **stage-header breadcrumb** ("Session · <profile>"), the **Chat inspector**, and the **Proof/Memory** destinations; the topbar Attestation seal carries a `·session` tag so it never reads app-global.
- **Workspace** truths live in the **Workspace/Sources/Context** stage-headers, which carry the workspace name token (single-workspace stated).
- **Profile** truth lives in the **topbar profile control** and **Profiles**; theme edits preview reversibly and never silently repaint a pinned session.
- **Transient** surfaces are overlays only — they never occupy sidebar, mobile-nav, or topbar slots, keeping the per-view chrome budget bounded.
- **Ephemeral vs synced** is answered everywhere the artifact lives: a `(▨) Ephemeral` durability chip in the topbar cluster, the sidebar footer status line, and each session/workspace stage-header — with one honest global statement that this build syncs nothing.

---

<!-- Reconciled source: airship/.airship-lab/harvest/33_synth-chat.md -->

# D5 — HIGH-PERFORMANCE CHAT / MESSAGE / COMPOSER SPEC
**System: Instrument. Surface: the Transcript (P5 — "the transcript is the instrument").**
Grounded against shipped source: `AgentSignal` (`src/core/agent.ts:17-20`), the rAF `pendingDelta` flush (`src/ui/app.tsx:240-241,384-399`), `UiMessage` (`app.tsx:108-119`), `messages.map` render (`app.tsx:1516-1524`), the composer JSX (`app.tsx:1526-1595`), receipt claim keys `transport/freshness/cpuTee/gpuTee/endpointKey/modelArtifact/conversation/payment` (`src/receipts/types.ts:11-22`), and journal events `tool.requested/approved/denied/failed/resulted` + `inference.usage` (`src/core/agent.ts:180-245`). Tokens below are the **Design Constitution D3** target tier; where a shipped value differs it is called out inline.

---

## 0 · GOVERNING DECISIONS (adversarial tensions resolved, not listed)

1. **Virtualization + `memo(MessageCard)` is a HARD PREREQUISITE.** No new per-message chrome (tool rows, receipt chips, action row, reasoning) mounts on the live transcript until windowing + memoization land. This is a build-order gate, not a suggestion (resolves TOO-DENSE ↔ HIDES-POWER: the fix is not "hide the cards," it is "make the surface cheap enough to show them").
2. **The FACT of a tool action is never collapsed; its PAYLOAD is one gesture away** (P6 forbids default-hiding that a step occurred). Every tool step renders a permanently-visible one-line row: **seal + verb + target + cost/duration**. Only `displayArgs` and the result body collapse. An expert `Settings › Transcript › Expand tool detail by default` flips the default to expanded (resolves HIDES-POWER's "expanded by default" vs TOO-DENSE's "collapsed by default").
3. **Stop and failure NEVER overwrite streamed tokens.** They append a footer part (resolves CONNECTIVITY gauntlet: current `app.tsx:848` clobbers content with `"Turn stopped before completion."` — deleted).
4. **One `<Seal>` component, one state→shape table, everywhere** (P2/P3). No Unicode-glyph ternaries in the transcript. Word leads, shape carries, color reinforces.
5. **Markdown is parsed incrementally**: completed blocks freeze, only the trailing open block re-tokenizes per frame (resolves SCALE gauntlet O(n²) attack).
6. **Windowing UNMOUNTS above and below viewport** with a measured-height cache. The Open-WebUI "progressive `messagesCount`" pattern is **rejected** — it never unmounts and regrows to unbounded DOM.
7. **Vocabulary lock**: message-level alternatives created by retry/edit are **"variants" / "response branch"** (a view over the immutable journal). Session-level copy-identity-empty-transcript stays **"Fork."** The reserved future ancestor-resolving feature keeps the bare word "branch." (resolves SESSIONS lane's three-verbs-for-one-act finding.)

---

## 1 · TYPED MESSAGE-PART MODEL

### 1.1 Runtime signal extension (`src/core/agent.ts`)
The agent already emits every needed fact as a durable journal event; D5 only **surfaces** them. Extend `AgentSignal` — no new capability, no new dep:

```ts
export type ToolEffect = "read" | "write" | "network" | "execute" | "identity";

export type AgentSignal =
  | { type: "durable";  events: DurableEvent[] }
  | { type: "text-delta";      turnId: string; text: string }
  | { type: "status";          turnId: string; status: string }
  // ── D5 additions (each mirrors an existing journal event) ──
  | { type: "reasoning-delta"; turnId: string; text: string }                       // optional; provider summary stream
  | { type: "tool-call";       turnId: string; callId: string; name: string;
        effect: ToolEffect; displayArgs: BoundedJson }                              // ← tool.requested
  | { type: "tool-progress";   turnId: string; callId: string;
        state: "approving" | "running" | "denied" | "failed"; startedAt: number }   // ← tool.approved/denied/failed
  | { type: "tool-result";     turnId: string; callId: string; isError: boolean;
        preview: string; bytes: number; durationMs: number; receiptRef?: string }   // ← tool.resulted
  | { type: "usage";           turnId: string; callId?: string; tokensIn: number; tokensOut: number } // ← inference.usage
  | { type: "citation";        turnId: string; anchor: string; source: CitationSource };
```

`displayArgs`/`preview` reuse the **existing broker bounds** (512-char strings, 32-item arrays, 64 keys, depth 7, secret-key redaction — `src/approvals/broker.ts:42,154-173`). No full tool output is ever retained on a message (SCALE gauntlet demand).

### 1.2 UI part model (`src/ui/app.tsx`)
`UiMessage.content: string` is replaced by an **ordered parts array**. `content` survives only as a memoized derived getter for Copy.

```ts
type PartId = string;

type MessagePart =
  | { kind: "text";       id: PartId; md: string }                    // markdown source
  | { kind: "reasoning";  id: PartId; md: string; open: boolean }     // collapsed summary
  | { kind: "tool";       id: PartId; callId: string; name: string; effect: ToolEffect;
        state: "approving" | "running" | "denied" | "failed" | "ok";
        displayArgs: BoundedJson;
        result?: { isError: boolean; preview: string; bytes: number };
        durationMs?: number; tokens?: number; receiptRef?: string; open: boolean }
  | { kind: "citation";   id: PartId; anchor: string; source: CitationSource }
  | { kind: "attachment"; id: PartId; name: string; mime: string; bytes: number;
        origin: "user" | "agent"; thumbUrl?: string; supported: boolean }
  | { kind: "error";      id: PartId; code: string; plain: string; retry?: RetryRef }
  | { kind: "footer";     id: PartId; tone: "stopped" | "partial" | "queued-note"; text: string };

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  status?: string;                    // transient acting label (header only)
  receipt?: ConversationReceipt;
  seq: number;                        // journal head sequence (stable sort key)
  createdAt: string;                  // ISO; rendered as relative age
  branch: { variantOf?: string; index: number; total: number };   // §8
  history?: Readonly<{ turnStatus: "completed"|"failed"|"cancelled"|"incomplete";
                       providerContext: "included"|"excluded" }>;
};
```

### 1.3 Per-part render map (default view)

| Part | Renders as | Seal | Legibility floor |
|---|---|---|---|
| `text` | Markdown → Preact vnodes (§9). Prose `--fs-body` (15px). | — | body |
| `reasoning` | One-line eyebrow `⌁ Reasoned for N steps · 1.2s [▸]`, collapsed by default; expands to `--fs-meta` (13px) muted prose. Absent if provider gives none. | — | meta |
| `tool` | One-line `.tool-step` row, **always visible**: seal + verb + target + `bytes · ms` + toggle (§5). | per-step `<Seal>` from effect+state | meta, ≥16px well |
| `citation` | Inline superscript chip `[1]` in text; footnote row below turn linking to source + evidence seal. | source seal | micro (11px floor) |
| `attachment` | Removable/openable chip w/ 24×24 type icon, name, `formatBytes`. `supported:false` → dashed border + "not sent to model." | durability seal | meta |
| `error` | `.part-error` block, `--v-failed` hairline, plain-language line + inline **Retry** (§8). Never a raw transport code. | crossed seal | body |
| `footer` | `.part-footer` muted rule + text (`Stopped — partial response kept`). | — | meta |

---

## 2 · STREAMING BEHAVIOR

### 2.1 Token cadence (preserve the shipped engine — it beats the borrow target)
Keep the rAF-coalesced `pendingDelta` ref + single per-frame flush (`app.tsx:384-399`) and the identity fence on `activeSessionIdentity.current` (`app.tsx:807/813/821`). **Change:** the flush updates **only the streaming part**, not `content`, and (post-virtualization) updates **only the active card's signal**, never `setMessages(items => items.map(...))` over the whole array.

```
delta arrives ──► pendingDelta.current.text += delta
                  (schedule 1 rAF if none pending)
   rAF fires  ──► append buffered text to the LAST open `text` part of the streaming msg
                  ──► incremental markdown: re-tokenize trailing open block only (§9)
                  ──► if pinnedToBottom: scrollToBottomOffset()  (§2.3)
```

### 2.2 Partial parts
- First `text-delta` with no open text part → push `{kind:"text", md:""}`.
- A `tool-call` mid-text → close the current text part; push `{kind:"tool", state:"approving", open:false}`; subsequent `text-delta` opens a **new** text part after it (interleaving preserved, matching real agent step order `agent.ts:196-245`).
- `tool-progress` / `tool-result` **mutate the existing tool part by `callId`** (never append).
- Pre-first-token window: header shows the **acting indicator** (§10) + status word; body shows a **skeleton line**, never an empty padded `<p>` (fixes `app.tsx:2196` blank bubble).

### 2.3 Scroll-anchoring (stick-to-bottom)
The `.transcript` is the scroll container (`styles.css:606-611`). Today nothing drives it (grep-clean of `scrollTop/scrollIntoView`) — the single worst streaming defect. Spec:

```
pinThreshold      = 64px from bottom
follow state      = pinnedToBottom (boolean, default true on new turn)
on wheel/touch/keydown-up that moves away from bottom → pinnedToBottom = false, show pill
on each rAF flush / new message:
    if pinnedToBottom:
        el.scrollTop = lastRealCardBottomOffset()   // NOT scrollHeight (virtual estimate overshoots)
        behavior: 'auto' during streaming (smooth reserved for user-initiated jumps)
prefers-reduced-motion → always instant
```

Anchor to the **measured bottom offset of the last mounted real card** (SCALE gauntlet: `scrollHeight` is a virtual estimate and overshoots). "Jump to latest" pill (`.jump-latest`) appears bottom-right when `!pinnedToBottom`; tap re-pins.

### 2.4 Stop (fail-safe, non-destructive)
`stopTurn` → `AbortController.abort()` (keep `app.tsx:872`). **Do not overwrite content.** Instead:
- freeze all streamed parts as-is,
- append `{kind:"footer", tone:"stopped", text:"Stopped — partial response kept"}`,
- `status: undefined`, `history.turnStatus:"cancelled"`,
- restore the user's typed text to the composer (it was cleared at `app.tsx:783`).

Mid-stream network failure → same pattern, `tone:"partial"`, plus an `error` part with plain cause (§9 of D-States mapper) and inline Retry. A one-second blip must cost neither the answer nor the prompt.

---

## 3 · THE SEAL (one component, six shapes / seven named states) — used by every part

```tsx
// src/ui/seal.tsx — the ONLY seal renderer app-wide (P3). Replaces glyph ternaries
// at app.tsx:1940, 2217, 2606, 2713 and attestations StatusMark.
function Seal({ state, size = 18, label }: { state: SealState; size?: number; label: string }) {
  return (
    <span class={`seal seal--${state}`} role="img" aria-label={label}
          style={`--seal-size:${Math.max(size, 16)}px`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{SEAL_PATHS[state]}</svg>
    </span>
  );
}
```

```
STATE       SHAPE (real SVG)          WORD (leads)   COLOR (reinforces)
──────────────────────────────────────────────────────────────────────
none         ○ thin ring               Not checked   --v-neutral
checking     ◜◞ interrupted 270° ring   Checking      --v-info      (animates only while acting)
stale        ◜◞ dashed interrupted ring Stale         --v-caution
verified     ⬤✓ filled disc + check     Verified      --v-verified
asserted     ◐ half-filled seal         Asserted      --truth-remote (copper)
attention    ◆! rotated square + bang   Attention     --v-caution
failed       ⊗ crossed circle           Failed        --v-failed
```

Well ≥16px (P2). Word always adjacent — a bare seal is never the sole encoder. `stale ≠ none` (fixes the CONNECTIVITY/TRUST finding that "refresh due" and "no evidence" render the identical `—`).

---

## 4 · CITATIONS + INLINE EVIDENCE / RECEIPT CHIPS

### 4.1 Citations
When retrieval feeds a turn (future), a `citation` signal carries `anchor` + `source`. Inline: a superscript `.cite-ref` chip `[1]` (`--fs-micro`, 11px floor, `--accent` text, **not** a truth color — citations are provenance, not verdict). Below the turn, a `.cite-list` footnote row: `[1] README.md · This folder · read 512 B  [open →]`, each with a **source-kind** word (folder / recent work / connected source) and, if the source is itself sealed, its `<Seal>`.

### 4.2 Message receipt chip (per turn)
A single `.receipt-chip` row directly under the turn body, driven by the real `receipt` (not hardcoded `◐`):

```
<Seal state=verified/asserted/none size=16 label="Verified">  Encrypted & attested · this session   receipt a1b2…9f  [›]
```

- Posture → seal + plain lead word computed from `receipt.claims` (`endpointKey.status==="verified"` → Verified/attested; `proofLevel==="conversation-bound"` w/o attest → Asserted/copper; local → Not checked/steel). **Never** the hero-hardcoded `◐`.
- Digest shown as last-8 mono; full value in `title` + on the drilled Proof view.
- `[›]` deep-links `#proof?receipt=<id>` (session-scoped, carries the id — fixes the "which session's attestation?" ambiguity).
- Chip text ≥ `--fs-micro` (11px); glyph well ≥16px (retires the 8px-in-14px-circle).

---

## 5 · TOOL-CALL + REASONING PRESENTATION

### 5.1 Tool step (the transcript's instrument moment)
Each `tool` part is a `.tool-step` row. **Row (always visible)** — the fact and the verdict never collapse:

```
├ <Seal size16>  <verb> <target>   <+adds −dels | bytes>   <ms> · <tokens>   [▸/▾]
```

- **verb** from tool name: `read_file`→`read`, `write_file`→`write`, git ops→`commit`/`push`/`fetch`, network→`fetch`, exec→`run`.
- **effect icon** (24×24, `stroke-width:1.65`) mirrors the approval-dock effect map (`approval-dock.tsx:73-79`): read/write/network/execute/identity.
- **seal state** = f(effect, state): running→`checking` (animated), denied/failed→`failed`, write allowed & receipted→`verified`, read/local→`asserted`.
- **cost/duration**: `durationMs` → `40 ms`/`1.1 s`; `tokens` from `usage` signal; write shows `+12 −3` or `1.1 KB` byte delta.

**Expanded (`open:true`, one gesture)** — a `.tool-step__detail` disclosure:
```
╎ path      /workspace/app.tsx · Replace          (Create vs Replace from expectedRevision)
╎ args      { … bounded/redacted displayArgs … }   (reuses broker bounds; NOT raw)
╎ approval  Allowed once · 2:41:07 pm              (or "Denied" / "Auto-approved read")
╎ result    wrote 1,104 bytes                       [receipt →]
```
Bounded result preview only; caps at the broker's 512-char string. A turn with many steps caps rendered rows at **12** with `▸ show all N steps` (SCALE gauntlet: no uncapped parts arrays).

### 5.2 Reasoning
`reasoning` part is a collapsed eyebrow: `⌁ Reasoned for N steps · 1.2s [▸]`. Expanded → muted `--fs-meta` prose, no seal (reasoning is not a verdict). Collapsed **by default** (it is genuinely secondary to output, unlike tool actions which are load-bearing evidence). Absent entirely when the provider streams none — no empty affordance.

### 5.3 Interleave order
Steps render **inline at their true position** in the turn (text → tool → text → tool), reflecting `agent.ts` step loop order. This is the ownable move (TOO-GENERIC demand): the proof instrument lives *inside* the transcript, not in a side rail — every turn is a stamped, sealed evidence strip.

---

## 6 · ATTACHMENTS + PASTE / DROP

### 6.1 Inbound (composer)
- Attach control (`.composer-attach`, 24×24 paperclip) + `onPaste` + `onDrop` on `.composer-wrap`.
- Each becomes a removable `.attach-chip` **above** the textarea: type icon, name, `formatBytes`, `[×]`.
- Durability seal on each chip: **ephemeral** = dashed border + steel (this build is memory-only). Honest labeling per P12.
- If the active transport cannot accept it: chip renders `supported:false` → dashed `--v-caution` border + inline "not sent to model" — **explicit, never silent loss** (chat lane demand).
- 44px targets, safe-area, 16px font on mobile.

### 6.2 Outbound (agent-produced) — closes the COMPLETENESS gap
Agent artifacts (a written file, a generated diff, an image) render as an `attachment` part with `origin:"agent"`: thumbnail (image) or file glyph + name + `[open in workspace →]` / `[download]`. Diffs route to the bounded diff preview pattern. This is one-directional today in every competitor; specifying both directions is the parity+trust move.

---

## 7 · MESSAGE QUEUE MODEL

Today Enter mid-turn is a silent no-op (`app.tsx:764,1575`). Spec a **single-slot queue**:

- While `busy`, the textarea stays editable. Enter **enqueues** one pending follow-up → a `.queued-chip` renders above the composer: `⟳ Queued · "fix the test" [×]`.
- On turn completion, the queued text auto-sends (identity-fenced: if the session changed, the queue is dropped with a toast).
- Cap = **1** pending message (prevents runaway auto-send; a second Enter replaces the queued text with a brief flash). Explicit, bounded, legible — never a silent drop.
- Stop clears the queue.

---

## 8 · COPY / EDIT / RETRY / BRANCH

### 8.1 Action row (`.msg-actions`)
Revealed on hover (desktop) / always-present tap target (mobile, 44px). Uses shipped `.icon-button` primitive.

| Action | On | Behavior |
|---|---|---|
| **Copy** | all | Copies derived `content` (concatenated text parts, code fences preserved as ``` ```); tool steps excluded. |
| **Retry** | errored/stopped/completed assistant | Re-runs the originating user content → creates a **variant** (§8.2). Preserves the failed variant. |
| **Edit** | user message | Loads text into composer, focuses; sending creates a new variant thread from that point. |
| **Branch** | assistant | Opens the variant switcher; "Fork session" (distinct, session-level) offered in overflow. |

### 8.2 Response branches (variants) — visualization & navigation
Retry/Edit never mutate the immutable journal. Each produces a new appended turn tagged `variantOf` the prior. The transcript shows the **active variant only**, with a switcher on the message:

```
‹ 2 of 3 ›     ← variant switcher, --fs-meta, on the message head
```
- `‹`/`›` swap the visible variant (state only — no journal write, no re-inference).
- Keyboard: `[` / `]` when the message is focused.
- Deep-linkable: `#chat?msg=<id>&v=2`.
- The switcher appears **only when `total > 1`**; single-variant turns show nothing (no dead chrome).
- **Vocabulary:** UI label is "variant" / "response branch." "Fork" stays reserved for session-level copy-identity (sessions-view), and the bare word "branch" stays reserved for the future ancestor-resolving feature — no collision.

A subtle `.variant-rail` (2px `--line-strong` left inset on the message, matching the `.is-selected` knurl) marks a message that has siblings, so branch points are scannable without reading the switcher.

---

## 9 · MARKDOWN / CODE RENDERER (zero-dep, CSP-safe, incremental)

- **Hand-rolled tokenizer → `createElement` vnodes.** Never `innerHTML`/`dangerouslySetInnerHTML` (trusted-types + locked CSP; rejects marked+DOMPurify). Subset: paragraphs, fenced code, inline code, ordered/unordered lists, links (attribute-safe), bold/italic, blockquote, simple tables.
- **Incremental during streaming** (SCALE gauntlet): maintain `{frozenBlocks: vnode[], openBlockSrc: string}`. Each flush re-tokenizes **only** `openBlockSrc`; on block close it moves to `frozenBlocks` and never re-parses. O(n) total per turn, not O(n²).
- **Code blocks**: `--font-mono`, `--surface-raised` fill, hairline border, **horizontal scroll** (`overflow-x:auto`, `min-width:0` on parent per `styles.css:689`) so long lines scroll, not push. Per-block `[copy]` button. No syntax-highlight dep (feature bloat); optional lazy 2KB tokenizer later.
- **Prose**: `overflow-wrap:anywhere` so a 4000-char digest/URL never overflows the bubble (fixes `pre-wrap` overflow at `styles.css:729`).

---

## 10 · VIRTUALIZATION — 2,000-MESSAGE SESSION

### 10.1 Windowing hook (`useWindowedTranscript`)
```
estimateHeight   = 96px (assistant) / 60px (user)   // seed for unmounted
overscan         = 8 cards each side
heightCache      = Map<msgId+revision, number>       // real measured heights
measurement      = ResizeObserver on each MOUNTED card → write cache → reconcile spacers
spacers          = top spacer (Σ heights above window) + bottom spacer (Σ below)
window           = binary-search scrollTop against cumulative offsets → [start,end]
render           = messages.slice(start, end).map(<MessageCard memo/>)
UNMOUNT both above and below (reject progressive messagesCount)
```
- `MessageCard` wrapped in `memo()` (`preact/compat`); callbacks hoisted/stable (no inline closures per render — fixes `app.tsx:1516-1524`).
- Streaming updates the **active card only** via a per-message signal, never a full-array `map` (fixes `app.tsx:395-397`).
- Variable heights handled by the ResizeObserver cache; estimate error self-corrects on mount. Scroll-anchor uses measured `lastRealCardBottomOffset` (§2.3), never virtual `scrollHeight`.
- `content-visibility:auto` + `contain-intrinsic-size` on off-window spacer stand-ins as a cheap secondary guard.

### 10.2 Boundary markers
- Resumed-session head: reuse the shipped `.transcript-boundary` banner (`app.tsx:1503-1515`) — "N earlier messages omitted."
- Live long thread: a `.window-marker` "▲ 1,847 earlier turns · load earlier" at window top loads a bounded chunk **into the virtual list** (still windowed, still unmounting) — not an un-windowed reveal.

### 10.3 Find-across-full-session (HIDES-POWER demand)
Windowing must not regress Ctrl+F/grep parity. `Cmd/Ctrl+F` opens an in-transcript find that scans the **full** `messages` array (not just mounted cards), shows `n of m`, and on Enter **scrolls the virtual list** to the match (computing its offset from the height cache) and mounts it. CLI scrollback recall is preserved.

### 10.4 Jump-to
- `.jump-latest` pill (§2.3).
- `Cmd/Ctrl+↓` → jump to latest; `Cmd/Ctrl+↑` → jump to thread top (loads the head window).
- Variant deep-links (§8.2) scroll-to via the same offset computation.

---

## 11 · COMPOSER SPEC

### 11.1 Structure (`.composer-wrap`)
```
[ attach chips row (if any) ]
[ queued-chip (if busy + queued) ]
┌────────────────────────────────────────────────────────────┐
│ textarea (auto-grow 1→ cap)                                 │
├────────────────────────────────────────────────────────────┤
│ [🔒 credential in memory] [⚙ approvals on] [◈ model ▾] [☺ profile ▾]   [attach] [send/stop] │
└────────────────────────────────────────────────────────────┘
 caption: Encrypted inference through <model>; attestation this session.
```

### 11.2 Slash-command palette
Keep the shipped combobox (`app.tsx:1528-1595`) — it is already borrow-target quality — and **complete the ARIA**:
- add `role="combobox"` + `aria-expanded={menuOpen}` to the textarea (currently missing);
- add an **Escape** branch that closes the menu without clearing text;
- skip `disabled` options during Arrow traversal;
- when the menu is open, **Enter accepts** the highlighted completion (Tab still accepts) — resolve the highlight/action mismatch where Enter currently sends.
- Menu surface: **100% opaque** `--surface-raised` (blur deleted per P8 / TOO-DECORATIVE), `--radius-md`, hairline border.

### 11.3 Send / Stop
- Idle: `.send-button` (brass `--accent`, `--accent-ink` glyph), disabled on `!input.trim() || !sessionId` **or `offline`** (add offline gate — CONNECTIVITY: disable with inline reason "Offline — encrypted inference needs a connection," not a post-failure bubble).
- Busy: `.send-button.stop` (Stop icon). Enter mid-turn → enqueue (§7), not no-op.

### 11.4 Auto-grow
`field-sizing:content` (progressive) with a `scrollHeight` fallback effect; grows 1 line → `max-height: 180px` then internal scroll. Removes the manual resize handle. Mobile: 16px font (defeats iOS zoom, `styles.css:3333`) — applied to **every** input including the slash field.

### 11.5 Model / profile affordance
- Inline `◈ model ▾` and `☺ profile ▾` in the composer footer (not only topbar), each opening the **searchable bounded picker** (onboarding D: ~30-row cap, debounced `filterModels`, price + context per row) — never a raw native `<select>` of hundreds. Model row shows blended `$/M` + context + `tools` capability marker.
- Changing model mid-session **forks a pinned session** (keep `switchChutesModel` semantics) with the honest fork-consequence copy at the decision point.

### 11.6 Mobile keyboard + safe-area
- **`visualViewport`-aware**: subscribe to `visualViewport` `resize`/`scroll`; when the keyboard opens, translate the bottom nav out and pin `.composer-wrap` to `visualViewport` bottom. Drop the `100dvh + permanent-nav` assumption (`styles.css:3173/3178`). Feature-detected; no change where unsupported.
- **Full safe-area**: `max()` insets on **left/right/top/bottom** for `.composer-wrap`, `.topbar`, `.transcript`, `.mobile-nav` (landscape notch, not just bottom).
- **Per-turn proof glance**: since `.inspector` is `display:none` ≤860 (`styles.css:3135`), the current turn's receipt chip (§4.2) stays rendered in the stage-header on mobile, tappable to Proof.
- Composer tools row: keep the lock + approvals chips **visible** on mobile (currently hidden `styles.css:3345-3351`) — they are trust cues, not decoration.

---

## 12 · TOKENS & CLASS CONVENTIONS

```css
/* type — 11px HARD FLOOR (P4); × --type-scale so the knob actually enlarges chrome */
--fs-micro:   calc(0.6875rem * var(--type-scale)); /* 11px — chip/step/eyebrow floor */
--fs-meta:    calc(0.8125rem * var(--type-scale)); /* 13px — reasoning, tool detail, receipt */
--fs-body:    calc(0.9375rem * var(--type-scale)); /* 15px — prose */
--fs-lead:    calc(1.0625rem * var(--type-scale)); /* 17px */
/* NO literal 7/8/9px anywhere in the transcript (retires the 107-site sub-10px stratum) */

/* verdict tier — IMMUTABLE, outside theme (P1). Seals/chips read ONLY these. */
--v-verified:#67a39a; --v-caution:#d9a441; --v-failed:#c86758; --v-info:#7fa8c9;
--v-neutral:var(--ink-faint); --truth-remote:#bd6f4c; /* copper = asserted */ --truth-local:#8ba0a6;

/* motion — transform/opacity only, ≤160ms; one acting loop */
--dur-control:120ms; --dur-surface:160ms; --dur-acting:1400ms;
--ease-std:cubic-bezier(.2,0,0,1);
.is-acting .pulse{animation:acting-pulse var(--dur-acting) var(--ease-std) infinite}
@keyframes acting-pulse{0%,100%{opacity:.45;transform:scale(1)}50%{opacity:1;transform:scale(1.12)}}
@media (prefers-reduced-motion:reduce){.is-acting .pulse{animation:none}}

/* spacing — 4px grid */
--sp-2:8px; --sp-3:12px; --sp-4:16px;

/* breakpoints — the ONLY three (P/D3h) */
--bp-rail:1040px;  /* inspector → toggle */
--bp-compact:860px;/* sidebar → icon rail; per-turn seal chip to stage-header */
--bp-mobile:640px; /* bottom nav; visualViewport; 16px inputs; safe-area */
```

**Class names** (block-element, `air`-free to match shipped `.transcript`/`.composer`):
`.msg` `.msg--user` `.msg--assistant` `.msg-head` `.msg-body` `.msg-actions` · `.part-text` `.part-reasoning` `.part-error` `.part-footer` · `.tool-step` `.tool-step__row` `.tool-step__seal` `.tool-step__detail` · `.receipt-chip` `.cite-ref` `.cite-list` · `.attach-chip` `.queued-chip` `.variant-switch` `.variant-rail` · `.jump-latest` `.window-marker`. State classes: `.is-acting` `.is-open` `.is-streaming` `.is-pinned`.

Interaction states (each part & control): **rest / hover (`--dur-control` color+bg only) / focus-visible (`2px solid --accent-bright`, offset 2px) / active / disabled (0.5 opacity + reason) / acting (pulse, active turn only) / reduced-motion (instant)**. Transitions are **excluded from any element rendered per-row inside the transcript** until virtualization lands (SCALE gauntlet).

---

## 13 · WIREFRAMES

**A · Assistant turn: reasoning + interleaved tool steps + receipt + actions (desktop ≥1040px)**
```
┌─ A ─────────────────────────────────────────── Engineer · 3 min ago ─┐
│ ⌁ Reasoned for 3 steps · 1.2s                                   [▸]   │  reasoning (collapsed)
│                                                                       │
│ I read the README and patched the composer. Diff below:               │  text/markdown
│ ┌─────────────────────────────────────────────────────────[copy]┐    │
│ │ export function send() {            ⟵ mono, --surface-raised    │    │  fenced code (h-scroll)
│ │   if (!input.trim()) return;                                    │    │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│ ├ ◐ Asserted  read  README.md            512 B · 40 ms          [▸]   │  tool step (copper half seal)
│ └ ⬤✓ Verified write app.tsx  +12 −3      1.1 KB · 120 ms · 34 tok [▾] │  tool step (verified, expanded)
│     ╎ path      /workspace/app.tsx · Replace                          │
│     ╎ args      { path:"app.tsx", … }        (bounded · redacted)     │
│     ╎ approval  Allowed once · 3:41:07 pm                             │
│     ╎ result    wrote 1,104 bytes                        [receipt →]  │
│                                                                       │
│ ⬤✓ Verified · Encrypted & attested · this session  receipt a1b2…9f [›]│  message receipt chip
│ ‹ 1 of 1 ›                          [Copy] [Retry] [Edit] [Branch]    │  variant switch + actions (hover)
└───────────────────────────────────────────────────────────────────────┘
```

**B · Streaming, pre-first-token (acting) + queued follow-up**
```
┌─ A ─────────────────────────────────── ●pulse Running read_file… ────┐
│ ▓▓▓▓▓▓▓▓░░░░░░░  ⟵ skeleton line, not an empty bubble                 │
└───────────────────────────────────────────────────────────────────────┘
 ⟳ Queued · "now run the tests"  [×]        ← single-slot queue chip
 ┌──────────────────────────────────────────────────────────────────┐
 │ (composer editable during turn)                                   │
 │ [🔒 credential in memory][⚙ approvals on][◈ demo-v1 ▾]   [∎ Stop] │
 └──────────────────────────────────────────────────────────────────┘
```

**C · Mobile ≤640px (safe-area, per-turn seal, sticky composer above keyboard)**
```
┌ Airship            [⬤✓ Local·E2EE ▾] ⌘ ┐   ← worst-of trust chip (topbar-center kept)
│ A · 3 min ago               ⬤✓ Verified │   ← per-turn seal chip in stage-header
│ I patched the composer. Diff below:      │
│ └ ⬤✓ write app.tsx +12 −3  1.1KB·120ms ▸ │   ← tool fact always visible
│ receipt a1b2…9f  [›]                      │
│ [Copy][Retry][Edit]        ‹1/1›         │   ← 44px targets
├──────────────────────────────────────────┤
│ Ask Airship or / for tools…              │   ← pinned to visualViewport bottom
│ [📎] [🔒][◈ ▾]                  [ Send ] │
└──────────────────────────────────────────┘
 (bottom nav yields while keyboard open)
```

---

## 14 · BUILD ORDER (dependency-gated)

1. **`memo(MessageCard)` + `useWindowedTranscript`** (measured-height cache, unmounting window). *Gate for everything below.*
2. **`<Seal>` component + `SEAL_PATHS`**; retire all glyph ternaries.
3. **Incremental markdown renderer** + code blocks + `overflow-wrap`.
4. **Parts model** (`AgentSignal` extension + `UiMessage.parts`); render text → then tool steps → then reasoning/citation/attachment/error/footer.
5. **Stick-to-bottom + jump pill + find-across-session.**
6. **Non-destructive Stop + Retry-with-input-preservation + offline send gate.**
7. **Action row + variants**; **single-slot queue**; **attachments (in/out)**.
8. **Composer**: ARIA-complete slash combobox, auto-grow, inline model/profile pickers, `visualViewport` + full safe-area.

Every item ships as **zero-dep Preact** (runtime deps stay exactly `preact/sigma/graphology`). No `innerHTML`, no editor framework, no socket client, no new modal — the single `ApprovalDock` remains the only blocking surface, and model tool activity renders inline as sealed evidence, never as a modal.

---

<!-- Reconciled source: airship/.airship-lab/harvest/32_constitution.md -->

# D6 — DETAILED INTERACTION SPECS

Seven surfaces, each as **Trigger → Flow → States → Mobile-adaptation**, plus the shared primitives they all consume. Every spec is a zero-dep Preact build. Adversarial tensions (TOO DENSE vs HIDES POWER, MOBILE-FICTION, SCALE-PERF, TRUST-ILLEGIBLE) are resolved by decision inline, marked **▸DECISION**.

All px/rem/timing/token names below are canonical (Design Constitution). Breakpoints are the three canonical ones only: `--bp-rail 1040px`, `--bp-compact 860px`, `--bp-mobile 640px`.

---

## 0 · SHARED PRIMITIVES (built once, consumed by a–g)

### 0.1 The `<Seal>` — one component, six shapes / seven named states, real SVG

Kills the four divergent glyph ternaries at `app.tsx:1940, 2217, 2606, 2713`. Shape carries meaning; color reinforces; a plain word renders adjacent (P2/P11). Consumed by trust (e), but also by git conflict rows (a), index health (b), memory node kinds (c), skill/posture chips (d), model trust-readiness (f), approval effect icon (g).

```jsx
// seal.tsx — the only place proof shapes are drawn
const SEAL_PATHS = {
  none:     <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.65"/>,
  checking: <path d="M12 4a8 8 0 1 1-5.66 2.34" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/>, // 270° arc
  stale:    <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.65" stroke-dasharray="3 3"/>,       // dashed ring
  asserted: <path d="M12 4a8 8 0 0 1 0 16z M12 4a8 8 0 0 0 0 16"/>,   // half-filled seal (◐ as geometry)
  verified: <g><circle cx="12" cy="12" r="8" fill="currentColor"/><path d="M8.4 12.2l2.5 2.5 4.7-5" fill="none" stroke="var(--accent-ink)" stroke-width="1.8" stroke-linecap="round"/></g>,
  attention:<g><path d="M12 3l9 9-9 9-9-9z" fill="none" stroke="currentColor" stroke-width="1.65"/><path d="M12 8v5" stroke="currentColor" stroke-width="1.65"/><circle cx="12" cy="16" r="1" fill="currentColor"/></g>, // diamond+!
  failed:   <g><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.65"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" stroke-width="1.65"/></g>, // crossed
};
function Seal({ state, size = 18, label }) {
  const px = Math.max(size, 16);                 // 16px well floor (P2)
  return (
    <span class={`seal seal--${state}`} role="img" aria-label={label}
          style={`--seal-size:${px}px`}>
      <svg viewBox="0 0 24 24" width={px} height={px} aria-hidden="true">{SEAL_PATHS[state]}</svg>
    </span>
  );
}
```

```css
/* seal color = verdict tier ONLY (immutable, never themeable) */
.seal--none,.seal--stale                { color: var(--v-neutral); }
.seal--checking                         { color: var(--v-info); }
.seal--stale                            { color: var(--v-caution); }   /* dashed ring in amber */
.seal--verified                         { color: var(--v-verified); }
.seal--asserted                         { color: var(--truth-remote); }
.seal--attention                        { color: var(--v-caution); }
.seal--failed                           { color: var(--v-failed); }
.seal svg { display:block; width:var(--seal-size); height:var(--seal-size); }
@media (forced-colors: active){ .seal svg *{ stroke:CanvasText; fill:CanvasText; } .seal--verified circle{fill:Highlight;} }
```

**▸DECISION (TRUST-ILLEGIBLE):** a seal never ships alone. The API forces `label`, rendered as an adjacent `<span class="seal-word">` at `--fs-caption` (12px). Warn vs neutral are now different *shapes* (diamond vs ring), so the color-only failure at `app.tsx:1940` is structurally impossible.

### 0.2 `useWindow` — the one virtualization hook (variable-height, measured)

Consumed by file tree (a, 100k), diff/editor (a), memory node-list fallback (c). Resolves SCALE-PERF: measurement cache, not fixed-height.

```jsx
// use-window.ts — ~40 lines, no deps
function useWindow({ count, estimate = 32, overscan = 8, scrollRef }) {
  const sizes = useRef(new Map());          // index -> measured px
  const [range, setRange] = useState([0, 40]);
  const measure = useCallback((i, el) => {
    const h = el.offsetHeight;
    if (sizes.current.get(i) !== h) sizes.current.set(i, h); // ResizeObserver-fed
  }, []);
  const offsetOf = (i) => { let o=0; for(let k=0;k<i;k++) o += sizes.current.get(k) ?? estimate; return o; };
  const total = offsetOf(count);
  const onScroll = () => { /* binary-search first visible by cumulative offset, set [start-overscan,end+overscan] */ };
  return { range, total, offsetOf, measure, onScroll };
}
```

Spacer strategy: one top spacer `height:offsetOf(start)`, windowed rows, one bottom spacer `height:total-offsetOf(end)`. Rows attach a `ResizeObserver` that calls `measure`. **Scroll anchor for stick-to-bottom is the last real row's `offsetOf(count-1)+its size`, never `scrollHeight`** (SCALE-PERF demand).

### 0.3 `<Sheet>` — the mobile bottom-sheet primitive

Consumed by trust chip (e), approval (g), git action confirmations (a), memory node detail (c), model picker (f). One implementation, `role="dialog"`, focus-trap, `inert` on `#shell` while open, `Escape` closes, `env(safe-area-inset-*)` all four sides, `visualViewport`-pinned.

```css
.sheet            { position: fixed; inset: 0; z-index: 60; display: grid; place-items: end center; }
.sheet__scrim     { position: absolute; inset: 0; background: rgba(0,0,0,.55); } /* NO backdrop-filter */
.sheet__panel     { position: relative; width: 100%; max-width: 34rem; max-height: 88dvh;
                    background: var(--surface-raised); border-radius: var(--radius-lg) var(--radius-lg) 0 0;
                    padding: var(--sp-4); padding-bottom: max(var(--sp-4), env(safe-area-inset-bottom));
                    display: grid; grid-template-rows: auto 1fr auto; box-shadow: var(--shadow-float); }
.sheet__actions   { position: sticky; bottom: 0; background: var(--surface-raised); padding-top: var(--sp-3); }
```

**▸DECISION (TOO-DECORATIVE / MOBILE-FICTION):** the scrim uses flat `rgba` at .55 — `backdrop-filter` is deleted from every sheet/scrim/menu (removes the blur that survived only on `.approval-scrim`).

### 0.4 The "Instrument detail" disclosure — progressive disclosure without amputation

Consumed by context lineage (b), claim stack (e), git diff metadata (a). Plain-language summary is always visible; forensics are one gesture away and **remember their open/closed state per surface** in page memory (so an expert who opens it once keeps it open — resolves HIDES-POWER's "don't re-hide the terminal's inline data" against TOO-DENSE's "don't lead with jargon").

```jsx
function InstrumentDetail({ id, summary, children }) {
  const [open, setOpen] = usePersistentDisclosure(id); // page-memory map, default false
  return (
    <details class="instrument-detail" open={open}
             onToggle={(e)=>setOpen(e.currentTarget.open)}>
      <summary class="instrument-detail__summary">{summary}<span class="instrument-detail__hint">Instrument detail</span></summary>
      <div class="instrument-detail__body">{children}</div>
    </details>
  );
}
```

### 0.5 Global additions that every surface below assumes

- **Cmd/Ctrl+K command palette** (`palette.tsx`, `role="dialog"`, focus-trapped) — a HARD prerequisite (HIDES-POWER). Every destination, every slash command, every trust drill-down is one keystroke away, so nav consolidation and progressive disclosure never cost expert reach.
- **Offline runtime truth**: `navigator.onLine` + `online`/`offline` listeners feed a derived `isOnline`. A fifth topbar seal + mobile trust-chip axis. Network CTAs across (a) push/fetch, (f) sign-in/discovery/refresh disable with an inline reason instead of failing after a round-trip.
- **Font tokens with 11px floor** already assumed; every size below is a `--fs-*` token, never a px literal for type.

---

## (a) WORKSPACE + SOURCES/GIT

### a.1 File tree at 100k files

**Trigger:** open `Workspace` nav item, or Cmd/K → "Workspace".

**▸DECISION (SCALE-PERF, the single most dangerous line):** `refreshWorkspaceState` (`app.tsx:1874`) stops calling `Promise.all(entries.map(read))`. It fetches **metadata only** (`listEntries()` → name/path/size/kind/revision). File *content* is read lazily on open (`openFile`, already on-demand at `app.tsx:876`). The context/memory feed (`app.tsx:1623`) takes a **hard-capped, bounded index slice** built from metadata + lazy reads, never the full byte array. This runs on boot and after turns without stalling.

**Flow:**
1. Metadata list arrives → build a flattened, lazily-expanded tree model (collapsed dirs contribute 1 row; expanding a dir fetches its children's metadata on demand).
2. Render through `useWindow` (0.2). `.ws-tree` gets its own bounded height and independent scroll (fixes `.file-list` padding-only at `styles.css:1284`).
3. A filter input (`.ws-tree__filter`, debounced 140ms) narrows by path substring; matches beyond the window are reachable because filtering runs over the metadata model, not the DOM.
4. Row click → lazy content read → editor pane. A **"N of M shown"** boundary row (`.ws-boundary`, reusing the transcript-boundary banner pattern) appears when a directory exceeds a 500-child cap, with "Show all N".

```
DESKTOP ≥1040px — Workspace (three panes REBALANCED, dead column reclaimed)
┌ FILES ───────────┬ EDITOR ───────────────────────────────┐
│ [filter…]        │ src/core/agent.ts   1.4 KB · rev 7  ⧉  │
│ ▸ src/           │ ┌────────────────────────────────────┐ │
│  ▾ core/         │ │ 1  import { … }                    │ │
│   · agent.ts  ●  │ │ 2  export async function run(…) {  │ │
│   · broker.ts    │ │ …  (windowed, first 128 KiB)        │ │
│  ▸ ui/           │ └────────────────────────────────────┘ │
│ ─ 500 of 4,120 ─ │ ⓘ Showing first 128 KiB — file bounded  │
│ [Show all]       │ [Load full file]                       │
└──────────────────┴────────────────────────────────────────┘
▸DECISION: the permanent "Tracking unavailable" changes-panel (app.tsx:2247)
is DELETED. Its width is reclaimed by the editor. Git lives in Sources.
```

```css
.ws-tree            { min-height:0; max-height:100%; overflow-y:auto; overscroll-behavior:contain; }
.ws-tree__row       { display:grid; grid-template-columns:auto 1fr auto; gap:var(--sp-2);
                      min-height:var(--target-desk); padding:0 var(--sp-3); align-items:center;
                      font-size:var(--fs-meta); }        /* 13px, not 7-9px */
.ws-tree__row.is-selected { box-shadow: inset 3px 0 0 var(--accent); background: var(--surface-raised); }
.ws-boundary        { font-size:var(--fs-micro); color:var(--ink-faint); padding:var(--sp-2) var(--sp-3);
                      border-top:1px solid var(--rule-lo); box-shadow:0 1px 0 var(--rule-hi); }
@media (pointer:coarse){ .ws-tree__row{ min-height:var(--target-min); } } /* 44px */
```

**States:** loading (skeleton rows, static under reduced-motion) · empty ("No workspace files — add a supported text/code file") · filtered-empty (distinct copy) · bounded (`.ws-boundary`) · lazy-read-error (row shows inline `Seal state="failed"` + "couldn't read").

### a.2 Editor & diff

**▸DECISION (SCALE-PERF):** editor `<pre>` (`app.tsx:2245`) caps displayed bytes at **128 KiB** with a bounded banner + "Load full file" (windowed reveal). The read path enforces a size cap so a multi-MB file never becomes one text node.

**Diff rendering** (replaces uniform muted mono at `sources-view.tsx:277`): tokenize the unified patch into lines; color per line — additions `--v-verified` bg tint + `+` gutter, deletions `--v-failed` bg tint + `−` gutter, hunk headers `--accent-bright`. Old/new line-number gutters. A **`Wrap` toggle** (`.git-diff__wrap`, switches `white-space: pre` ↔ `pre-wrap`) for narrow screens. Bounded-preview flag preserved; when truncated, show omitted `byteLength`.

```
GIT DIFF (per-line color; shape+letter status; wrap toggle)
┌ app.tsx — Working diff ──────────────── [Wrap ▢] ─┐
│  12  12   const seal = …                          │
│  13  --   - color: brass                (–1)  ░red│
│  --  13   + color: var(--v-verified)    (+1) ░grn │
│  ⓘ 3 of 5 hunks · 1.2 KB of 4 KB shown           │
└───────────────────────────────────────────────────┘
```

### a.3 Staging, commit, worktrees, conflicts

**Change-row status token** (replaces the run-on `staged · modified · working · modified` at `sources-view.tsx:265`, the faintest element). Two-slot chip per plane: a bordered pill with an **uppercase letter** M/A/D/R/C, **index plane = filled brass fill, worktree plane = outlined**. Size `--fs-caption` at `--ink` (not `--ink-faint`). Rename shows `old → new`. A one-line legend/toggle: *"Staged = ready to commit · Working = not yet staged."* Color reinforces; the letter carries.

```
CHANGE ROW
  ▣M  app.tsx            +12 −3   [Staged diff] [Unstage]
  ▢M  styles.css         +4  −0   [Working diff] [Stage]
  ◆C  agent.ts   CONFLICT          [Resolve]         ← diamond seal, --v-caution
   legend: ▣ staged (index) · ▢ working tree
```

**Conflict** (`conflicted` is first-class in `types.ts:19` but has no surface): row gets `Seal state="attention"` (diamond) + `--v-caution` tint + word "Conflict". **▸DECISION (HIDES-POWER + STATES):** conflicted paths are *excluded* from bulk "Stage selected"; they require an explicit per-file "Mark resolved". Where the adapter has no merge engine, the row states plainly *"Conflict resolution not available in this adapter"* — comprehension label only, no merge/security claim. Two-plane model is immutable: never a flat "changes" list.

**Commit / push:** stay two separate approvals (`app.tsx:880`). Force-push never surfaced (`pushRemote force:false`). Remote section gains **ahead/behind vs upstream** and relative **last-fetched** (`lastRemoteSyncAt`, `types.ts:91`, currently never rendered); Push annotates a non-fast-forward warning when behind.

**Version conflict** (`GitVersionConflictError`, `errors.ts:42`): **▸DECISION (STATES/CONNECTIVITY):** branch on `instanceof` and render a dedicated `.git-conflict-banner` (not the generic red alert) with a local **"Refresh this worktree and re-review"** action that re-fetches only the active worktree and preserves selection — the instruction the error already gives finally has an affordance.

**Empty state is actionable** (currently a dead end): render `Clone… / Import folder / Open repository` wired to the already-present `execute()` clone path (`sources-view.tsx:314`); disabled with the adapter's reason when unavailable (mirroring Fetch/Push). Worktree **Create/Remove** controls next to the worktree list.

### a.4 MOBILE git (`≤640`, the lane's critical scenario)

**▸DECISION (MOBILE-FICTION, blocker):** add `.git-sources input, .git-sources select, .git-sources textarea { font-size:16px }` to the `≤640` zoom-guard block (currently omits `.git-sources` at `styles.css:3511`). No git field auto-zooms.

**Sticky mobile action bar** (fixes off-screen commit confirmation at `sources-view.tsx:217` when the layout stacks): a `position:sticky; bottom:env(safe-area-inset-bottom)` bar mirrors the current notice/error + the primary contextual action (Stage selected → Commit → Push). Confirmation and next step live in the thumb zone.

```
MOBILE git (portrait) — action bar sticky in thumb zone
┌───────────────────────────┐
│ ▢M styles.css   +4 −0     │
│ ▣M app.tsx      +12 −3    │
│ … (vertical scan preserved)│
├───────────────────────────┤ ← sticky
│ ✓ Commit created locally. │   notice mirrored here
│ [ Push (2 ahead) ]        │
└───────────────────────────┘
```

Diff on phone: default `Wrap` on; per-line color makes +/− legible at `--fs-caption` without parsing leading characters. Select-all/stage-all header control; create-branch gains a "create and switch" option (`checkout:true`, `types.ts:132`).

---

## (b) CONTEXT / VECTORIZATION

**▸DECISION (HIDES-POWER vs TOO-DENSE):** the plain-language routing panel becomes the **primary** surface; the forensic lineage is **not deleted** — it moves into a sticky-remembering `InstrumentDetail` (0.4). Experts who open it keep it open; novices never hit chunk IDs first. This surfaces the already-built-but-unmounted `ContextFabricDriver` (`context-driver.ts`, `retrieval/contracts.ts:60-107`).

### b.1 "What the agent can search — and why"

**Trigger:** open `Context`, or run a search.

**Flow:** search → `ContextFabricDriver` returns `RoutedExpert{label,kind,score,bytes}` + warnings + `RetrievalCommitment`. Render:
- **Named source + human kind chip** — relabel kinds: `directory→"This folder"`, `profile→"Agent profile"`, `source→"Connected source"`, `recent→"Recent work"`, `global→"Everything else"`, `git→"Repository"`.
- **One-line "why it matched"** — folder match / recent edit / wording overlap.
- **Byte-cost readout** — "read 42 KiB of 8 MiB budget" (the edge budget the brief demands be legible).
- **Recall-reduced banner** when any expert is unavailable/timeout/budget-capped (`.ctx-recall-warn`, `Seal state="attention"`).

```
CONTEXT — routing panel primary, jargon demoted
┌ What the agent will pull in ─────────────────────────┐
│ Preview only — not yet inserted into replies.        │ ← honest disclosure (mirrors Memory callout)
│                                                      │
│ ● This folder    src/ui/     read 42 KiB   why: path │
│ ● Recent work    agent.ts     read 8 KiB   why: edited│
│ ⚠ Connected source — recall reduced (timed out)      │
│  budget: 58 KiB of 8 MiB used                        │
│ ▸ Instrument detail (digests, dims, dense/lexical)   │ ← sticky-collapsible, NOT deleted
└──────────────────────────────────────────────────────┘
```

### b.2 Index health (legible, non-contradictory color)

**▸DECISION (color must not contradict meaning):** split the tone logic at `context-view.tsx:105` so `Degraded ≠ ready`. States renamed to plain words: `Searchable→"Ready to search"`, `Degraded→"Ready · some files skipped"` (tone `--v-caution`, not the green `--v-verified`), `Closed→"Search unavailable"`, `Waiting→"Preparing"`. A compact health line: *"N of M files indexed · K skipped · J failed."* The too-large reason uses `formatBytes` (already present at `context-view.tsx:276`): *"File is larger than 8.0 MiB"* (not `8388608 bytes`).

**De-jargon default labels:** `Vectorization candidates→"Files the agent can search"`, `Generation-pinned retrieval→"Search results"`, `Vector memory→"Index size"`, and the `72%/28%` line → *"Blends meaning (72%) and exact wording (28%)."* Exact terms remain inside Instrument detail.

**Search-during-reindex:** **▸DECISION (STATES):** keep the last-ready generation searchable during refresh, labeled *"From the previous snapshot — reindexing…"*; commit invalidates. Preserves the generation-pinning guarantee (results still carry their true generation digest) while killing the blank-retrieval cliff. Undefined `--shadow-panel` token (`context-view.css:71`) defined in `:root`.

### b.3 Mobile

Panels stack; the routing list is the vertical scan; Instrument detail stays collapsed by default on `≤640` regardless of its remembered desktop state (space-forced). One scope sentence under the heading: *"Searches text and code in this workspace. Sessions, memory, and connected sources are indexed separately."*

---

## (c) MEMORY EXPLORATION

### c.1 One kind-visual source of truth

**▸DECISION (blocker — legend lied for 4/6 kinds):** define a single `KIND_VISUAL = { color, shape }` map consumed by `derive` (`node.type`), the sigma renderer (per-kind node programs, **remove `nodeThemeColor`** at `renderer.tsx:137`), and the legend. **Kind is encoded primarily by shape** so the metals palette isn't overloaded:

```
session  = filled brass disc      profile = bright-brass ring
message  = small steel dot        skill   = copper diamond
file     = verdigris square        term    = hollow outline
```

Each legend swatch renders that exact shape+color glyph (delete divergent legend CSS `styles.css:2292-2297`). A color-blind user separates all six by shape.

**▸DECISION (SCALE-PERF):** `deriveMemoryRelationshipGraph` memoizes on a **stable content hash**, not array references (`app.tsx:2457`), so it does not re-run after every turn. The sigma renderer **diff-updates** the graph instead of full teardown/rebuild on `graph.revision` (`renderer.tsx:215`). Seal-shape node programs are verified at the 5,000-node ceiling on a `failIfMajorPerformanceCaveat`-class GPU; fall back to disc+color if pan/zoom drops below interactive.

### c.2 Selection = pan/zoom-to-node

**Trigger:** click a search result, relationship-list row, or controlled `selectedNodeId`. **Flow:** renderer eases the camera to the node's x/y at a bounded zoom, transform/opacity only, ≤300ms (fixes `emitSelection` never moving the camera at `renderer.tsx:183`). `prefers-reduced-motion` → instant jump.

### c.3 Bounded-view banner + node detail + provenance

**▸DECISION (bounds are computed but discarded):** a `.mem-boundary` strip (transcript-banner pattern) renders only when any `stats.truncated.* > 0`, naming each omitted category + count (nodes, edges, messages, files, terms, unscanned chars). `isolatedNodeCount` shown in the metrics row. The opaque exponential Density tile becomes a banded word + number: *"Sparse · 0.003"* with a tooltip.

**Node inspector** adds the missing **time** dimension: `node.createdAt` (relative label, absolute in `<time datetime>` title) and `node.revision` as first-class rows above the metadata `dl` (currently only `metadata` is iterated at `app.tsx:2490`). Lineage renders as a sentence (*"Extracted from conversation text"*), camelCase keys humanized.

**Hub relationships:** group incident edges by kind with counts + total, sort by weight, render *"showing 18 of N"* + "Load more" in bounded batches (fixes the silent 18-cap at `app.tsx:2491`).

### c.4 Edit/forget (lane-owned mandate, currently absent)

**▸DECISION:** view-level forgetting only — never implies durable deletion. Inspector "Hide from view" + clickable legend toggles a whole kind's visibility (especially the up-to-512 term nodes). Client-only hidden-set filters nodes+incident edges. Label precisely: *"Hidden from this page view — source data unchanged."* Persistent "Show all / reset".

### c.5 Mobile fallback (WebGL is not parity)

**▸DECISION (MOBILE-FICTION):** two guarantees. (1) `.memory-canvas` gets `touch-action: none` + a "drag to explore" hint so pan doesn't fight page scroll; tapping a node opens the detail in a `<Sheet>` (0.3), not below the fold. (2) A **DOM-browsable node list** exists independent of the canvas — empty-query search returns a paged, kind-grouped list (fix `derive.ts:630` returning `[]`) so a phone that fails the WebGL probe, or a keyboard/AT user, can still enumerate and browse. Search debounced 140ms, `role="listbox"` + `aria-activedescendant`, routes acceptance through pan-to-node.

```
MOBILE memory — canvas + list fallback
┌──────────────────────────┐
│ [search nodes…]          │
│  ▣ session · Engineer    │  ← DOM list, always present
│  ◆ skill · Systems Eng.  │
│  ▢ term · "attestation"  │
│ ─ 40 of 512 · Load more ─│
├──────────────────────────┤
│ ⚠ Showing 5,000 of 6,240 │  ← bounded-view banner
└──────────────────────────┘
tap node → detail Sheet (createdAt, lineage, relationships)
```

---

## (d) PROFILES / THEMES / SKILLS

### d.1 Skill permission consequence (the false grant)

**▸DECISION (blocker):** the skill card footer `Tools: …` (`app.tsx:2405`) is relabeled **"Instructions reference:"** with a one-line consequence: *"Enabling adds pinned instructions to the next session. It does not change tool approvals — those are always requested separately."* Tool names stay as context; the implied grant is removed (tool auth is registry-derived, `registry.ts:90`, independent of skills).

### d.2 Minimum posture (the invisible trust floor)

**▸DECISION:** surface `minimumPosture` (gates plaintext/unattested/attested, `app.tsx:1849`, never shown) as a labeled chip in the revision-strip and editor, reusing the **same seal+word grammar** as trust (e): `Seal state="none"` + "Local", `state="asserted"` + "Encrypted · unattested", `state="verified"` + "Encrypted · attested". Editable as a select that mints a new content-addressed revision.

### d.3 Non-destructive Save/Apply

**▸DECISION:** track draft dirty state. "Apply in a new session" is **disabled while dirty** (or performs save-then-apply on the draft), so it can never apply stale saved content (`app.tsx:2357`). A persistent "unsaved changes" indicator sits by the actions. Selecting another profile card while dirty **confirms** before resetting the draft (`app.tsx:2275`). The brass CTA is never the control that discards edits.

### d.4 Safe theme switching + reversible preview

**▸DECISION (Brand P0 — the marquee proof that decoration breaks truth):** split tokens into an **immutable verdict tier** (`--v-*`, `--truth-*`) defined once in `:root`, structurally outside the theme system, and a **themeable personality tier** (`--accent`, `--accent-bright`, `data-corners/density/body-font/mode`). `applyTheme` may `setProperty` only the allow-listed tokens + four enum attrs. This kills the Verdigris inversion (verified renders gold) at the root: `catalog.ts:165` can no longer touch `signal`/`danger`.

**Preview:** swatch click calls `applyTheme` as a **reversible preview** to `:root` with a "previewing — not saved" affordance and revert-on-cancel, decoupled from Save (so saving no longer silently repaints a pinned session, `app.tsx:245/1258`). The swatch is expanded to show **ground, surface, ink, accent, and the immutable verified/failed** so failure color and text legibility are judgeable before commit.

```
PROFILE editor — posture chip, dirty guard, full swatch preview
┌ Systems Engineer  rev a1b2…  ●unsaved ─────────────┐
│ Trust floor:  ⬤✓ Encrypted · attested   [change ▾] │
│ Model: airship-demo-v1   Skills: 3 of 5             │
│ Theme:  [Foundry][Verdigris][Blue Ledger]          │
│  swatch: ▉ground ▉surface Aa-ink ▉accent ✓ver ×fail│ ← previewing (revert)
│ [ Save new revision ]   [ Apply in new session* ]  │  *disabled while unsaved
└────────────────────────────────────────────────────┘
```

### d.5 Global-vs-profile skills + a11y

Keep the two-axis model (global toggle + per-profile inherit/on/off + computed "resolved on/off" chip, `app.tsx:2396`). Add `aria-pressed`/`aria-current` to profile cards and a purpose label to the per-profile skill select (*"Skill mode for {profile}"*). Persona name lifted from 10px to match skill-name legibility (`--fs-lead`); 7px tool/digest/state labels lifted to the 11px floor. Theme-manifest enums that the CSS doesn't implement (`corners:'subtle'`, `scale:'compact'`) are either implemented or removed so no manifest value is inert.

---

## (e) TRUST RECEIPTS — seal → claim-stack → drill-down, in plain language

This is the north-star surface. All of §0.1 applies.

### e.1 The non-misleading rule (governing law for this section)

1. **Shape carries, color confirms** — every state distinguishable in grayscale + a plain word adjacent.
2. **One seal everywhere** — topbar, transcript chip, proof hero, attestations all render `<Seal>`; delete `app.tsx:1940/2217/2606/2713` glyph ternaries.
3. **Plain language leads** — a ranked bottom-line verdict per receipt; enums/digests/ISO behind Instrument detail.
4. **Computed, never hardcoded** — the hero seal is derived from posture, never a constant.

### e.2 Hero seal computed from posture

**▸DECISION (blocker at `app.tsx:2606`):** replace `receipt ? "◐" : "○"` with a computed overall state and headline:

```
local receipt            → Seal none/steel   "Local only"            (--truth-local)
encrypted-unattested     → Seal asserted ◐   "Encrypted, not attested"(--truth-remote)
encrypted-attested +     → Seal verified ⬤✓  "Encrypted & attested"  (--v-verified)
  verified endpointKey
failed / expired claim    → Seal failed / attention                  (--v-failed/-caution)
```

The `h2` and hero copy are driven by `postureLabel()`/`proofLevelLabel()`, never the raw enum.

### e.3 Three-posture glance ribbon (stop conflating local with unattested)

**▸DECISION:** a compact posture ribbon in the stage-header and Proof overview with three mutually-exclusive states as shape+word+one-line subtitle. The TEE-verification metric (`app.tsx:2608`) is reworked so `local` and `encrypted-unattested` never share the "Not established" label.

```
POSTURE RIBBON (stage-header)
[ ⬤✓ Encrypted & attested · this session ]   ⌄
 subtitle: "Endpoint quote checked · key matched"
```

### e.4 Claim stack: ranked verdict → de-jargoned rows → drill-down

One ranked **bottom-line verdict** headline above the flat eight-row stack (`app.tsx:2670`). Rows use `<Seal>` + a plain **word** (Verified / Asserted / Not checked / Stale / Failed), never lowercase `partial`/`unavailable`. Jargon labels get plain primaries with the technical term secondary:

```
CPU TEE       → "Processor secure area"   (CPU TEE)
GPU TEE       → "GPU secure area"         (GPU TEE)
Endpoint key  → "Server identity key"     (endpoint key)
Model artifact→ "Model fingerprint"       (model artifact)
Binding       → "Bound to this reply"     (binding)
```

**Stale ≠ unavailable** (blocker at `app.tsx:2016`): the real "Evidence refresh due" state maps to `Seal state="stale"` (dashed ring, amber) with an in-place **"Re-acquire evidence"** action — visually and audibly distinct from `Seal state="none"` (no evidence). Timestamps render as relative age with absolute in `<time datetime>`; digests/ISO/kebab enums move into Instrument detail. Claim drill-down enriched to the documented grammar: issuer / subject / **scope** / age / **expiry** / evidence-digest / verifier-policy / export (parity with the richer attestations `DimensionInspector`).

```
PROOF INSPECTOR
┌ Verdict ────────────────────────────────────────────┐
│ ⬤✓ Encrypted & attested — everything the endpoint    │  ← ranked bottom line
│    could prove was checked. Payment asserted only.   │
├──────────────────────────────────────────────────────┤
│ ⬤✓ Bound to this reply        Verified   3 min ago   │
│ ⬤✓ Transport encryption       Verified               │
│ ◐  Payment                    Asserted   (unverified)│
│ ◜◞ Fresh evidence             Stale  [Re-acquire]    │
│ ○  GPU secure area            Not checked            │
│ ▸ Instrument detail (digests, verifier policy, ISO)  │
└──────────────────────────────────────────────────────┘
```

### e.5 Topbar seals — clickable, distinct warn shape, session-scoped honesty

**▸DECISION (IA/a11y):** `StatusSeal` becomes a **`<button>`** deep-linking to its canonical view (Vault seal→vault, E2EE→access, Attestation→proof). Warn uses the **diamond**, not the neutral `·` (fixes color-only warn/neutral). The **session-scoped attestation seal is pulled out of the global row** and rendered in the stage-header session cluster, badged with the active session id (fixes the "which session's attestation?" ambiguity at `app.tsx:1422`). Every seal carries `aria-label`; detail is reachable via a focusable popover, not a `title` on a non-focusable span.

### e.6 Mobile trust (MOBILE-FICTION blocker)

**▸DECISION:** replace `display:none` on `topbar-center` (`styles.css:3199`) with **one worst-of trust chip** in the 52px topbar: `<Seal>` of the weakest of Local/Vault/E2EE/Attestation + short word, tappable to a `<Sheet>` listing all axes with their own drill-downs. Proof/attestation **pending badges mirror to the mobile nav** (fix `app.tsx:1742` rendering none). A per-turn proof glance chip returns to the mobile stage-header (inspector is `display:none ≤860`).

```
MOBILE topbar (52px) — worst-of chip, never a re-expanded seal row
┌ ◆Airship        [ ◐ Encrypted ▾ ]        ⌘K ┐
tap → Sheet: Local ⬤ · Vault ◐ · E2EE ⬤ · Attest ◜◞
```

---

## (f) MODEL / AUTH / ACCOUNT / BILLING

### f.1 Sign in with Chutes vs cpk_ escape hatch

Preserve the two-token hierarchy (recommended verdigris "Sign in with Chutes" over collapsed "Use an inference API key instead"). **▸DECISION (onboarding dead-end):** when `window.location.origin !== registered origin`, render the primary button **disabled with an inline reason** *("Sign-in is available from the registered app origin; use an inference API key here")* + link to the details, instead of throwing on click (`app.tsx:352`). Move the OAuth error `<p>` to render **directly beneath the button** inside `.oauth-primary-entry` (not only inside the collapsed diagnostic `<details>` where `role="alert"` is never announced, `access-view.tsx:510`).

**Standardize vocabulary:** one anchor noun per credential — **"Chutes account (Sign in)"** (`cak_`) and **"Inference API key"** (`cpk_`); raw `cak_`/`cpk_` demoted to mono secondary annotations, not primary column headers.

### f.2 Model selection without a 100-item dropdown

**▸DECISION (SCALE-PERF + assigned goal):** replace every native `<select>` of models (`access-view.tsx:387`, `access-view.tsx:359`, `model-control.tsx:47`) with a shared **`ModelPicker`**: a text input bound to the existing-but-unwired `filterModels` `query` param (`domain.ts:24`), **debounced 140ms**, + toggle facets (hot · tools · cheapest · largest-context), rendering a **bounded windowed list hard-capped at ~30 rows** with a **soft "Show all N eligible"** escape (HIDES-POWER: the full eligible catalog stays scannable, not walled behind required search). Each row shows id, hot badge, context, blended price, and a **trust-readiness `<Seal>`**. Recommended model pinned at top. Fork-on-change behavior preserved.

**▸DECISION (filter mismatch):** the selectable discovery list uses the **same requirements** as the recommendation (`tools` + attestation-candidate, `domain.ts:11`), OR keeps the looser set but marks each option (`no tools` / `not attestation-ready`) and shows a soft caution before Connect. No selectable model silently lacks tool support for a tool-capable agent.

```
MODEL PICKER (shared; ≤30 rows; soft "show all")
┌ Choose a model ─────────────────────────────────────┐
│ [search…]  ⦿hot ⦿tools ⦿cheapest ⦿largest-ctx       │
│ ★ airship/qwen-2  ⬤✓ 128k ctx  $0.40/M   hot        │ ← recommended pin
│   airship/llama-3 ◐  32k ctx   $0.20/M   no tools ⚠ │
│ … 28 more shown · [ Show all 214 eligible ]         │
└──────────────────────────────────────────────────────┘
```

### f.3 Usage / burst / balance clarity + funding at exhaustion

Preserve `honesty.ts` verified/unknown/unavailable/loading discipline. **▸DECISION (STATES — stale is a lie):** billing datum functions honor the `loading` flag even when a prior value exists (mark metrics **in-flight** during refresh, don't show old numbers as confidently "verified", `honesty.ts:26`); `Observed {time}` / `Verified · {time}` **age into a warn tone** past a threshold (>10 min → "may be stale — refresh"). Meters use **flat single-token fills** (no truth-color gradients on data, `styles.css:2619/2720`) so verified-green and caution-brass never blend inside one cost meter.

**▸DECISION (funding gap):** when `balanceDatum` tone is danger or a RunwayCard hits 100%, render an **in-card "Add funds at Chutes ↗"** CTA (deep-link) distinct from the generic toolbar link, wired to the documented `awaiting_funding` turn state. Copy never implies Airship processes payment. The cpk_ "account not readable" gate gets an inline Connect CTA rather than a detached toolbar link.

Commerce numbers (money, tokens, reset times) lifted off the 7-8px stratum to the 11px floor — they are the most consequential values to read correctly.

### f.4 Mobile

`ModelPicker` renders as a `<Sheet>` on `≤640` (search + facets + windowed list). Sign-in disabled-with-reason and the funding CTA both reachable one-handed. First-run: the `Local / demo` chip is relabeled *"Demo model — Sign in to run real inference"* routing to Access; a dismissible one-line nudge that does not reappear once connected.

---

## (g) APPROVALS — fail-closed dock/sheet, consequence unmistakable before approving

Preserve the broker's fail-closed spine (deny on abort/timeout/queue-full/duplicate; redaction; bounding). Fix the **dock as an interaction**.

### g.1 Consequence is first-class (currently buried in JSON)

**▸DECISION (WORKSPACE blocker):** for write/workspace effects, surface as **facts** (not a JSON blob at `approval-dock.tsx:59`): **Target path**, a **Create vs Replace** badge (derived from `expectedRevision` vs current revision), **byte size** (and delta when replacing), and a **bounded old→new diff** (reuse the sources bounded-preview) in place of the raw `<pre>`. The tool description is dynamic (path + action), not the static registry string. Write and git approvals read at parity.

### g.2 The safe path is not the hard path

**▸DECISION (WORKSPACE + MOBILE blocker):** Deny and Allow get **equal-width columns and matched button treatment** — drop the brass `.primary-link` CTA styling from Allow (`approval-dock.tsx:66`). Initial keyboard focus actually lands on **Deny** (fix the `panel.focus()` vs `autofocus` conflict at `approval-dock.tsx:14`). On mobile, Allow is **not** the sole thumb-closest control.

```css
.approval-actions        { display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-3); }
.approval-deny,.approval-allow { min-height:var(--target-min); font-size:var(--fs-body);
                           border:1px solid var(--line-strong); border-radius:var(--radius-md); }
.approval-allow          { /* NO brass fill; neutral raised surface */ background:var(--surface-raised); }
@media (max-width:640px){ .approval-actions{ grid-template-columns:1fr 1fr; } } /* side by side, Deny left */
```

### g.3 Queue transparency, timeout visibility, focus trap

**▸DECISION:** expand "1 of N" into an accessible expandable list of pending operations (tool + target); wire the existing-but-unexposed `broker.denyAll()` as a **Deny-all** action; keep per-operation confirm reachable in one gesture (HIDES-POWER: no allow-all that hides per-op detail). Render an **"expires in mm:ss"** countdown tied to `decisionTimeoutMs` so the silent 5-min auto-deny is legible. Add a real **focus trap** + `inert` on `#shell` while pending, and move `Escape=deny` onto the dialog element so it fires regardless of focus; restore focus to the invoker on decide.

### g.4 Mobile bottom sheet

Uses `<Sheet>` (0.3): **sticky non-scrolling `Deny/Allow` footer**, arguments `<details>` **closed by default**, description/facts scroll above. Blocking actions never require scrolling past an open JSON blob; scrim is flat (no blur, honors `prefers-reduced-transparency`).

```
APPROVAL SHEET (mobile)
┌─────────────────────────────────┐
│ ✎ Write file                    │
│ Path:  /workspace/src/app.tsx   │
│ [ Replace ] · 4.2 KB (+120 B)   │  ← consequence as facts
│ ─ bounded diff preview ─        │
│ ▸ Arguments (closed by default) │
├─────────────────────────────────┤ ← sticky footer
│ ⏱ expires in 4:41               │
│ [   Deny   ] [   Allow once   ] │  equal weight, Deny left
└─────────────────────────────────┘
```

---

## CROSS-CUTTING TOKEN BLOCK (referenced by all seven)

```css
:root{
  /* verdict tier — IMMUTABLE, never themeable (seals/meters/status) */
  --v-verified:#67a39a; --v-caution:#d9a441; --v-failed:#c86758; --v-info:#7fa8c9; --v-neutral:var(--ink-faint);
  --truth-local:#8ba0a6; --truth-remote:#bd6f4c;
  /* type — 11px floor, scale knob actually multiplies */
  --fs-micro:calc(.6875rem*var(--type-scale)); --fs-caption:calc(.75rem*var(--type-scale));
  --fs-meta:calc(.8125rem*var(--type-scale)); --fs-body:calc(.9375rem*var(--type-scale)); --fs-lead:calc(1.0625rem*var(--type-scale));
  /* motion */
  --dur-control:120ms; --dur-surface:160ms; --dur-acting:1400ms;
  --ease-std:cubic-bezier(.2,0,0,1);
  /* target */
  --target-min:44px; --target-desk:36px;
}
@media (pointer:coarse){ :where(button,a,input,select,[tabindex]){ min-height:var(--target-min);} }
```

**Decision ledger (adversarial resolutions, one line each):**
- Density vs power: default minimal, forensics one `InstrumentDetail` gesture away with remembered state, Cmd/K palette as the universal escape → both cohorts satisfied without amputation.
- Tool/step & claim rows: the *fact* a step/claim occurred is never collapsed (always a visible seal+word); only heavy previews/digests collapse.
- Virtualization: true windowing with a measurement cache and last-real-row scroll anchor; reject the progressive-`messagesCount` pattern that regrows to unbounded DOM.
- Eager reads: killed at `refreshWorkspaceState` (metadata-only), not merely DOM-windowed.
- Truth color: immutable verdict tier split out of the theme system before any seal ships — a differentiator that can flip meaning is worse than none.
- Mobile: no blanket `display:none` on trust/approval/review; each becomes a thumb-designed chip/sheet with real drill-down.
- Decoration: `backdrop-filter` deleted from near-opaque surfaces and all scrims; meters flat-filled; motion reports state only.

---

<!-- Reconciled source: airship/.airship-lab/harvest/31_constitution.md -->

# D7 · STATE MATRIX — D8 · COMPONENT ARCHITECTURE — D9 · PERF + QA BUDGETS

Built on the Design Constitution tokens. All additions are zero-dependency Preact + CSS. Two orthogonal state axes are defined and never conflated:

- **`data-status`** = *process / lifecycle* axis (empty, loading, streaming, acting, awaiting, cancelled, failed, offline). Answers "what is the surface doing."
- **`data-state`** = *truth / verdict* axis (verified, asserted, checking, stale, attention, failed, none). Answers "how proven is this fact." Rendered by the one `<Seal>`.
- **`data-durability`** = *ephemeral / syncing / synced* axis. Answers the orphaned immutable truth.

`failed` is the only value that appears on both axes (a process can fail; a claim can be cryptographically failed) and they render differently — a process-failed card gets a Retry row; a verdict-failed claim gets a crossed seal.

---

## D7.1 · Canonical seal shape table (the single source, consumed by D8 `<Seal>`)

Six shapes. Shape carries meaning; color only reinforces (P2). Minimum well 16px. Every instance `role="img"` + adjacent plain word.

```
data-state   SHAPE (SVG, 24 viewBox)                WORD           COLOR TOKEN        also used for
──────────────────────────────────────────────────────────────────────────────────────────────────
none         thin ring, 1.65 stroke, open           "Not checked"  --v-neutral        unavailable, resting
checking     270° arc ring, gap top-right           "Checking"     --v-info           acting/in-progress (animated)
stale        270° arc ring, DASHED 3-2               "Stale"        --v-caution        refresh-due, evidence expired-soon
verified     filled disc + inset check               "Verified"     --v-verified       attested, synced, good
asserted     half-filled seal (left solid)           "Asserted"     --truth-remote     partial, service-only, encrypted-unattested
attention    rotated square (diamond) + centered !   "Attention"    --v-caution        conflicted, policy-mismatch, expiry
failed       ring + full X (crossed seal)            "Failed"       --v-failed         expired, blocked, rejected
```

The `stale` and `checking` shapes are the same 270° arc; `checking` is solid stroke (+ acting-pulse when live), `stale` is a dashed stroke (static). This kills the current defect where "refresh due" (`—`) is indistinguishable from "never had evidence" (`—`).

Truth-origin sub-marks (border treatment layered on the seal, not a new shape):
- **local origin** → steel `--truth-local` seal stroke + solid.
- **remote origin** → copper `--truth-remote` (the reinstated third metal) + half seal.
- **ephemeral** → dashed border ring around the seal well.
- **synced** → solid border ring.

---

## D7.2 · Master state matrix

```
STATE          AXIS        SEAL/VISUAL              COLOR         MOTION                COPY LEADER            PRIMARY SURFACES
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
empty          status      no seal; EmptyState      --ink-faint   none                  eyebrow + 1 sentence   every list/view, workspace
                           (eyebrow+line+1 action)                                       + 1 CTA                changes pane, sessions, sources
loading        status      Skeleton rows            --line        shimmer* (bg-pos)      (aria-busy, sr text)   lazy routes, ledgers, lists,
                           (layout-reserved)                       reduced→static                               session restore
streaming      status      live text + Seal[checking] --v-info    acting-pulse on well  status in card head    transcript (active card only)
                           on active card; jump pill               + stick-to-bottom
acting         status      StatusDot pulse +        --state-acting acting-pulse 1400ms   "Working…" / tool name topbar acting dot, ToolStep row,
                           Seal[checking]                          (the ONE loop)                               resume-audit, route load
awaiting-      status      ApprovalSheet/Dock,      --v-caution   sheet enter ≤160ms;   "Approve <tool> once?"  approval dock (desktop),
approval                   Seal[attention] on op    (diamond)     countdown to expiry                          bottom sheet (mobile), ToolStep
cancelled      status      partial output KEPT +    --v-neutral   none                  "Stopped · partial kept" transcript, context search,
                           footer chip; Retry chip                                                              git mutation, discovery
failed         status      Seal[failed] + error     --v-failed    none                  "Couldn't reach…" +      transcript, routes, git, vault,
(process)                  bubble + Retry row                     (crossed seal static)  cause-specific line     billing, boot
offline        status      5th topbar Seal /        --v-caution   none (static warn)    "Offline · local only"   topbar ribbon, mobile trust chip,
                           mobile chip; CTAs off                                                                composer caption, access, billing
stale          truth       Seal[stale] (dashed arc) --v-caution   none                  "Stale · refresh due"    attestation chips, account-metric
                                                                                        + "Re-acquire" action    age, context generation, catalog
partial /      truth       Seal[asserted] (half)    --truth-remote none                 "Asserted · unverified"  proof claims, attestations,
asserted                   copper                                                                               billing partial snapshot, previews
conflicted     truth       Seal[attention] + own    --v-caution → none (banner static)  "Conflict — review"      git change row, git conflict
                           reconcile banner         --v-failed tint                     + reconcile CTA          banner, session-fork guard
synced         durability  Seal[verified] + SOLID   --v-verified  none                  "Synced"                 durability badge (DISABLED this
                           border ring                                                                          build — see honesty rule below)
verified       truth       Seal[verified]           --v-verified  none                  "Verified"               proof hero, attestations grid,
                           (disc+check)                                                                         message attestation chip
asserted       truth       Seal[asserted] (half)    --truth-remote none                 "Asserted"               proof hero (encrypted-unattested),
                                                                                                                receipt chips, endpoint records
unavailable    truth       Seal[none] (open ring)   --v-neutral   none                  "Not available"          resting seals everywhere,
                                                                                        / "Not checked"          no-evidence chips
```
*shimmer is gated behind `prefers-reduced-motion` → static muted bar; never an idle loop.

**Durability honesty rule (P12, closes the orphaned truth):** this build wires `MemoryWorkspace` + `MemoryJournalBackend`, so **nothing is synced**. The `synced` row above is defined but MUST NOT render. Every session/transcript/workspace artifact renders `data-durability="ephemeral"` → dashed-border Seal well, steel `--truth-local`, word **"Ephemeral · this device"**. One stated scope line ships in the stage header and sessions header: *"This build keeps everything on this device. Nothing syncs."* The `syncing`/`synced` visuals are implemented but flag-gated off until a real backend exists — so the UI never implies durability the runtime does not perform.

**Worst-of resolution (topbar ribbon + mobile chip):** the single trust chip computes `min` over axes by severity rank: `failed(0) < attention/conflicted(1) < stale(2) < asserted(3) < checking(4) < verified(5) < none(6)`. The chip renders the lowest-ranked present state's seal + word, and expands to a Sheet listing every axis with its own seal + drill-down. This satisfies "trust legible at a glance" on ≤640 without re-cramming four seals.

**State precedence within one card** (transcript message): `offline` (composer) > `failed` > `awaiting-approval` > `acting/streaming` > `cancelled` > `verified/asserted/…`. A card shows exactly one `data-status` and any number of per-claim `data-state` seals in its evidence row.

### Key wireframes

Streaming card (pinned, active):
```
┌ A ────────────────────────────────────────────────┐
│ prose rendered as markdown (incremental)           │
│   ┌ ToolStep ─────────────────────────────────┐    │
│   │ ◜◞ read  README.md → 512 B      [Asserted] │    │  ← Seal[checking] pulses while running
│   └───────────────────────────────────────────┘    │
│ …next tokens stream here…            ◜◞ working    │  ← acting-pulse on the well, NOT a spinner
└────────────────────────────────────────────────────┘
                              ▼ Jump to latest (streaming)   ← appears only when user scrolled up
```

Failed (process) card — never destroys partial output:
```
┌ A ────────────────────────────────────────────────┐
│ …partial tokens the user was reading are KEPT…     │
│ ⊗ Couldn't reach Chutes — the service may be down. │  ← cause-specific, plain language
│ [ Retry ]   (original prompt preserved)            │
└────────────────────────────────────────────────────┘
```

Offline (topbar → mobile):
```
desktop topbar:  ◈Airship  [⬤✓ Local][◐ E2EE][◇ Attest·session][△ Offline·local only]  ⌘K
≤640 chip:       ◈  [△ Offline]     ← tap → Sheet lists Local/E2EE/Attest/Offline each w/ drill-down
composer offline: Send disabled · "Offline — encrypted inference needs a connection"
```

---

## D8 · COMPONENT / DESIGN-SYSTEM ARCHITECTURE

### D8.1 · Boundary rule (the decision that prevents sprawl)

```
Is it drawn/behavioral and reused ≥2 places, or holds a11y semantics?   → PREACT COMPONENT
Is it a one-property visual repeat with no state/semantics?             → CSS UTILITY (.u-*)
Is it a mode the whole element/app switches between?                    → DATA-ATTR
```

- **Component** when it owns SVG, focus management, ARIA, or a state→visual table (Seal, Sheet, Field, EmptyState, Meter, Skeleton, TruthBadge, CommandPalette, VirtualList).
- **CSS utility** for `.rule--engraved`, `.sr-only`, `.u-mono`, `.u-truncate`, `.u-tabular`, layout primitives `.stack`/`.cluster`.
- **Data-attr** for `:root` theme knobs (`data-mode/-corners/-density/-body-font/-type-scale`), verdict axis (`data-state`), process axis (`data-status`), nav scope (`data-scope`), chip tone (`data-tone`). CSS reads attrs; JS only `setProperty`s the allow-listed tokens (P1 gate).

### D8.2 · Class-name convention

```
.block                     component root (kebab, single class): .seal .chip .panel .tool-step
.block__part               sub-part:                             .seal__svg .tool-step__head
data-state / data-status   variant axis (NOT a class):           <span class="seal" data-state="verified">
--block-*                  instance knob custom prop:            --seal-size, --meter-fill
.u-*                       utility:                              .u-mono .u-truncate .sr-only
.stack / .cluster / .rail  layout primitive                     (gap via --sp-* tokens)
```
No modifier classes for state — always `data-state`/`data-status`/`data-tone`. This keeps the state matrix and CSS in one-to-one correspondence and lets a single selector `[data-state="stale"] .seal__svg` style every surface identically.

### D8.3 · Token layers (fixed by Constitution; components consume, never redefine)

```css
/* Tier 1 neutrals, Tier 2 truth/verdict (--v-*, --truth-*), Tier 3 personality (--accent) */
/* type: --fs-micro(11px floor)…--fs-hero, all × --type-scale */
/* space: --sp-1..7 on 4px grid; --pad-* flex with --pad-scale */
/* motion: --dur-control 120 / --dur-surface 160 / --dur-acting 1400 */
/* new, additive: */
:root{
  --seal-size: 18px;                 /* min 16 */
  --state-offline: var(--v-caution);
  --focus-ring: 2px solid var(--accent-bright);   /* ONE ring app-wide; delete vault blue */
  --meter-track: var(--surface-sunk);
}
```

### D8.4 · Primitives

| Component | Signature | Root class / attrs | States it renders | Notes |
|---|---|---|---|---|
| **Seal** | `Seal({state, size=18, label})` | `.seal[data-state]` `--seal-size` | all `data-state` | ONE SEAL_PATHS table; `role="img"`; retires every inline glyph (`app.tsx:1940/2217/2606/2713`) |
| **StatusDot** | `StatusDot({acting})` | `.status-dot[data-acting]` | acting/wait | pulse only while `acting`; static otherwise; reduced-motion→static |
| **Chip** | `Chip({tone, children})` | `.chip[data-tone]` | tone reinforce | base for receipt/history/durability chips; ≥`--fs-micro` text |
| **TruthBadge** | `TruthBadge({state,label,detail,onDrill})` | `.truth-badge` | truth axis | **word-first**: `<Seal>`+word+optional `<button>` drill (retires title-only detail) |
| **DurabilityBadge** | `DurabilityBadge({durability})` | `.dur-badge[data-durability]` | ephemeral/syncing/synced | this build → always "Ephemeral" |
| **Panel** | `Panel({raised, children})` | `.panel` | — | hairline + `--shadow-panel`; no blur |
| **Sheet** | `Sheet({open,onClose,role,children})` | `.sheet[data-variant]` | — | modal(desktop)/bottom-sheet(mobile); focus-trap + `inert` shell; Esc; sticky footer |
| **Field** | `Field({label,hint,error,...input})` | `.field` | — | 16px input on ≤640 **universally** (fixes `.git-sources` gap); one focus ring |
| **Button** | `Button({variant,size})` | `.btn[data-variant][data-size]` | — | variants: primary/ghost/danger/icon; 44px on `pointer:coarse` |
| **EmptyState** | `EmptyState({eyebrow,title,body,action})` | `.empty-state` | empty | eyebrow + one sentence + ≤1 CTA |
| **Skeleton** | `Skeleton({rows,shape})` | `.skeleton[aria-busy]` | loading | layout-reserved; shimmer gated by reduced-motion |
| **Meter** | `Meter({value,max,tone})` | `.meter` `--meter-fill` | verdict tone | **flat single-token fill** (no gradient); tabular value |
| **Icon** | `Icon({name})` | `.icon` | — | 24×24, stroke 1.65, `currentColor` |
| **BoundaryBanner** | `BoundaryBanner({omitted})` | `.boundary` | bounded | one conditional strip, plain counts (reuse everywhere truncation occurs) |

**Seal SVG spec** (inline, ≤2 KB total, one file `seals.ts`):
```jsx
const SEAL_PATHS = {
  none:     <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.65"/>,
  checking: <path d="M12 3.5a8.5 8.5 0 1 1-6 2.5" fill="none" stroke="currentColor" stroke-width="1.65"/>,     // 270° arc
  stale:    <path d="M12 3.5a8.5 8.5 0 1 1-6 2.5" fill="none" stroke="currentColor" stroke-width="1.65" stroke-dasharray="3 2"/>,
  verified: <><circle cx="12" cy="12" r="8.5" fill="currentColor"/><path d="M8 12l2.6 2.6L16 9.4" fill="none" stroke="var(--accent-ink)" stroke-width="1.9"/></>,
  asserted: <><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.65"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor"/></>,   // half
  attention:<><rect x="12" y="3" width="12.7" height="12.7" transform="rotate(45 12 12)" fill="none" stroke="currentColor" stroke-width="1.65"/><path d="M12 8.5v4.2" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="15.6" r="0.6" fill="currentColor"/></>,
  failed:   <><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.65"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" stroke-width="1.9"/></>,
};
// hero seal is COMPUTED from posture, never hardcoded:
// local→none(steel) · encrypted-unattested→asserted(copper) · encrypted-attested+verified→verified · else→attention/failed
```
The **brand mark** and the `verified` disc share one geometry (disc seeds the mark, diamond seeds `attention`), pinned to `--brand-brass` (never `--accent`), rendered from the same inline SVG as the favicon → favicon, PWA icon, boot, topbar, sidebar are one instrument.

### D8.5 · Composites

```
MessageCard(memo)      → header[Seal status] · MarkdownBody · ToolStep[] · evidence Chip[] · action row(hover/tap)
ToolStep               → [Seal state] tool · arg summary · result link · approval outcome · expanded-by-default
MarkdownBody           → incremental block renderer (frozen blocks + trailing open block); CodeBlock w/ copy + x-scroll
ClaimStack / ClaimRow  → TruthBadge per claim: issuer·subject·scope·age(relative)·expiry·digest(disclosed)·export
ProofHero              → computed Seal + postureLabel + one-line plain gloss (retires hardcoded ◐)
TrustRibbon            → desktop: seals as <button> drill-downs · ≤640: one worst-of TrustChip → Sheet
NavItem                → Icon + label + data-scope edge mark + pending-evidence Chip (mirrored to mobile nav)
ApprovalSheet          → Seal[attention] · dynamic "Create/Replace <path> (+n −m)" facts · bounded diff · countdown
                         · Deny/Allow EQUAL weight, Deny focused, Deny not below Allow on mobile · sticky footer
ModelPicker            → Field(search)→filterModels · facet toggles · ≤30 rows + "Show all N eligible" · price+ctx+tools mark
CommandPalette         → ⌘/Ctrl-K overlay: all 11 destinations + nested Skills/Account tabs + slash registry + recent sessions + proof/attestation drill
SessionCard            → title · Seal[health] · DurabilityBadge · scope · lineage(navigable) · pin toggle
DiffView               → per-line +/− color (--v-verified add / --v-failed del) · line gutters · Wrap toggle
ChangeRow              → two-plane status token M/A/D/R/C (index=filled brass / worktree=outlined) · rename src→dst
BoundaryBanner         → transcript / memory / diff / editor / catalog: "N earlier · K omitted"
```

### D8.6 · Responsive patterns

```
RegionShell — CSS grid, canonical 3 breakpoints ONLY (1040 / 860 / 640)
  ≥1040  sidebar 220 | chat minmax(0,1fr) | inspector min(340,30vw)
  <1040  inspector → toggle (collapsible at 13"-class widths, not only ≤860)
  <860   sidebar → 74px icon rail; inspector → drawer
  <640   sidebar hidden; bottom nav (≤9 items); TrustChip; safe-area L/R/T/B; 16px inputs;
         visualViewport pins composer above keyboard; nav yields when keyboard open

Inspector    rail(≥1040) → drawer(<860) → per-turn Seal chip in stage header(<860)   [never display:none the truth]
Sheet        modal(desktop, --shadow-modal + focus-trap) → bottom sheet(mobile, place-items:end; sticky footer)
Palette      ⌘K overlay, focus-trapped, Esc-close, focus restore — PREREQUISITE for any nav merge
VirtualList  useWindow(items, estimate, overscan) → ResizeObserver measurement cache; unmounts both directions
```

### D8.7 · Module layout & dependency guardrail

```
src/ui/
  seals.ts            SEAL_PATHS + state→word map (single source for D7)
  primitives/         Seal Chip Panel Sheet Field Button EmptyState Skeleton Meter Icon StatusDot
  truth/              TruthBadge DurabilityBadge ClaimStack ProofHero TrustRibbon
  chat/               MessageCard MarkdownBody CodeBlock ToolStep
  patterns/           RegionShell Inspector CommandPalette useWindow.ts
  state.ts            resolveWorstOf(), stateWord(), postureLabel(), formatAge()
```
**Guardrail (P8 / borrow-lane):** runtime deps stay **exactly** `preact, sigma, graphology`. No markdown lib (hand-rolled `MarkdownBody`, createElement only — never `innerHTML`, preserves trusted-types), no sanitizer, no editor framework, no socket client, no component library, no new modal system beyond `<Sheet>`. Any PR adding a runtime dep fails CI.

---

## D9 · PERF + QA BUDGETS

Reference devices: **Mid phone** = Moto G / Pixel 6a class ≈ Chrome + 4× CPU throttle. **Low phone** = 6× throttle. **Desktop** = M-class / recent x86.

### D9.1 · Perceived-performance budgets

| Metric | Target | Device | Measured by | Gate |
|---|---|---|---|---|
| Boot screen visible | ≤ 400 ms | mid phone | Performance mark `boot-paint` | hard |
| First meaningful paint (shell chrome) | ≤ 1200 ms mid / ≤ 600 ms desktop | both | LCP on topbar+nav | hard |
| Acting affordance after Send | ≤ 100 ms | all | send→pulse mount | hard |
| Stream first-token rendered | ≤ 1 rAF (≤ 16 ms) after transport yields first byte | all | delta→paint | hard |
| Input latency (composer keystroke→paint) | ≤ 50 ms; never blocked > 16 ms by transcript | mid phone | Event Timing `keydown` | hard |
| Slash / palette / picker filter | ≤ 16 ms per keystroke (debounced 140 ms upstream) | mid phone | scripting slice | hard |
| Route switch → skeleton | ≤ 150 ms | mid phone | nav→aria-busy | soft |
| Lazy route chunk fetch+exec | ≤ 200 ms desktop / ≤ 500 ms mid | both | chunk eval | soft |
| Offline state flip (topbar+CTAs) | ≤ 1 paint after `offline` event | all | listener→render | hard |
| Approval sheet enter | ≤ 160 ms | all | `--dur-surface` | hard |
| Resume audit (20k events) | never blocks input > 50 ms; yields in ≤ 500-event batches w/ aria-live | mid phone | long-task count = 0 > 50 ms | hard |

### D9.2 · Virtualization / bounding thresholds

| Surface | Threshold | Rule |
|---|---|---|
| Transcript | window when > 60 messages mounted; overscan 8; **unmount both directions** | reject progressive-count; DOM node ceiling ~1500 regardless of length |
| Streaming re-render | only the active card re-renders per frame; `MessageCard` = `memo` w/ stable callbacks | no whole-array `.map` per rAF |
| Autoscroll | pin when within 64 px of last real card's bottom offset (virtual coords, not scrollHeight); instant under reduced-motion | detach on user scroll-up → jump pill |
| Markdown | incremental: freeze completed blocks, re-parse only trailing open block | no O(n²) re-tokenize while streaming |
| Tool steps | render ≤ 12 steps/turn then "Show all N"; result preview bounded 512 chars / 32 items / 64 keys (reuse broker bounds) | no full tool output retained |
| Workspace file list | metadata-only reads; content lazy on open; window > 200 rows; `.file-list` gets `max-height` + `overflow-y:auto` | **kill** `Promise.all(read)` after every turn |
| Editor | display cap 128 KiB + BoundaryBanner + "load full file" chunked at 128 KiB | never one giant text node |
| Context/memory feed | hard-capped slice at read source, not opt-in after full array exists | — |
| Memory graph | derive memoized on stable content hash (not array refs); sigma **diff-updates**, no teardown on revision; keep hideEdges>2000 / hideLabels>1000 | node shapes on canvas only if mounted < 1500 nodes, else 6 distinct hues + DOM node list for AT |
| Model picker | ≤ 30 rows + "Show all N eligible" (soft cap); filter debounced | full catalog never mounts as `<option>`s |
| Session list | 200 cap + max-height/overflow (existing) | reuse as the template |

### D9.3 · Bundle ceilings (gzip)

| Chunk | Ceiling |
|---|---|
| Total runtime JS | ≤ 180 KB |
| Initial shell chunk | ≤ 90 KB |
| Each lazy route (context/billing/attestations/…) | ≤ 40 KB |
| `MarkdownBody` renderer | ≤ 6 KB |
| Inline seal SVG set | ≤ 2 KB |
| Runtime deps | frozen: preact + sigma + graphology (CI-enforced) |

### D9.4 · Animation / motion / thermal budget

- 60 fps = 16.7 ms/frame; streaming path ≤ 8 ms scripting/frame on mid phone.
- One rAF flush per frame (preserve `pendingDelta`). Animate **transform/opacity/color/border-color/background-color only**, ≤ 160 ms.
- The **only loop** is `acting-pulse` (`--dur-acting` 1400 ms), mounted solely while in-flight; static dot otherwise; killed by reduced-motion.
- **Decision (decorative vs perf tension):** functional state-change transitions ≤ 120 ms are permitted on **bounded chrome only** (nav-active, buttons/chips outside lists, sheet enter/exit) as state feedback — **explicitly excluded** from any element rendered per-row in the transcript or file list, and from all list rows until virtualized. No purely decorative motion, no idle loop, no motion added to satisfy an adjective.
- Delete `backdrop-filter` on topbar/composer/slash-menu/approval-scrim (all near-opaque or scrim-occluded); flat single-token meter fills; blueprint grid and glows removed unless a rendered pass proves visibility AND data-encoding.

### D9.5 · Device / browser design-QA matrix

```
                         │ shell  seal      autoscroll  offline  iOS-no  approval  landscape  WebGL     type-scale
DEVICE / ENGINE          │ FMP    grayscale + 2000msg   flip     zoom    above-fold notch     graph     +200% zoom
─────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────
Desktop Chrome/Edge 1440 │  ✓      ✓          ✓          ✓        n/a     ✓          n/a        ✓          ✓
Desktop Safari (WebKit)  │  ✓      ✓          ✓          ✓        n/a     ✓          n/a        ✓          ✓   (dvh, focus-visible)
Desktop Firefox (Gecko)  │  ✓      ✓          ✓          ✓        n/a     ✓          n/a        ✓          ✓   (scrollbar, forced-colors)
iPhone SE 375 Safari     │  ✓      ✓          ✓          ✓        ✓       ✓          ✓          ✓          ✓
iPhone 15 Pro 393 Safari │  ✓      ✓          ✓          ✓        ✓       ✓          ✓ (notch)  ✓          ✓
iPad 810 portrait        │  ✓      ✓          ✓          ✓        ✓       ✓          n/a        ✓          ✓   (860 bp, drawer)
Android mid (Pixel 6a)   │  ✓      ✓          ✓          ✓        n/a     ✓          ✓          ✓          ✓
Low Android (6× throttle)│  ✓*     ✓          ✓ (fps≥50) ✓        n/a     ✓          ✓          FALLBACK   ✓
```
`*` low-end FMP budget relaxes to ≤ 1800 ms. WebGL FALLBACK = probe fails → DOM node-list browse (search + list), never a dead canvas.

### D9.6 · Condition QA matrix (every condition tested on ≥1 phone + ≥1 desktop engine)

| Condition | Must pass |
|---|---|
| `prefers-reduced-motion` | acting-pulse→static; autoscroll instant; skeletons static; zero transitions |
| `prefers-reduced-transparency` | all blur nulled incl. approval scrim & slash menu |
| forced-colors / Win High Contrast | seal shapes + borders map to system colors; warn≠neutral by SHAPE; focus ring visible |
| 200% browser zoom **+** `data-type-scale=large` | no computed font < 11px anywhere; nav/composer/chat body/dense labels enlarge; no clipping |
| Offline (airplane mode) | topbar+chip flip ≤1 paint; remote CTAs disabled w/ reason; local surfaces fully usable |
| Slow-3G / throttled | skeletons + acting affordance appear; no blank frozen surfaces |
| Keyboard-only | ⌘K palette reaches all 11 destinations + nested Skills/Account tabs + slash cmds; approval focus-trapped, Esc denies from any focus; skip-link first |
| Screen reader (VoiceOver + NVDA) | every seal announces its word; runtime detail reachable (no title-only); nav pending badges named on desktop + mobile |
| Colorblind (grayscale render) | all 6 seal states + all memory kinds distinguishable by shape/position without hue |

### D9.7 · Acceptance gates (resolve every RENDERED-PASS-NEEDED)

1. **Seal legibility:** at 16px well, grayscale, all six states distinguishable on iPhone SE + Pixel 6a. Fail → enlarge well before ship.
2. **2000-message stream:** ≥ 55 fps sustained on mid phone; flat DOM node count; profiler shows only active card re-rendering.
3. **Autoscroll:** pinned view keeps newest token visible; scroll-up detaches + shows pill; reduced-motion jumps instantly.
4. **iOS zoom:** focusing commit textarea, new-branch input, and every git/profile/memory select does NOT zoom (all fields ≥16px via `<Field>`).
5. **Approval:** Deny/Allow both above the fold on iPhone SE with a large `displayArguments`; Deny focused; Allow not the sole thumb-zone control.
6. **Landscape notch:** composer, topbar mark, transcript text, nav clear of notch/rounded corners on iPhone 15 Pro landscape (safe-area L/R/T).
7. **Offline flip:** verified within one paint of the `offline` event on all three desktop engines + one phone.
8. **Memory shapes at scale:** shape-on-canvas mode holds interactive pan/zoom at 5000 nodes on a `failIfMajorPerformanceCaveat`-class GPU, else auto-falls back to 6-hue discs + DOM list.

---

<!-- Reconciled source: airship/.airship-lab/harvest/35_constitution.md -->

Below is the finished deliverable: **D10 (Backlog)**, **D11 (Remove/Simplify)**, **D12 (North-Star Walkthrough)**. It is built directly on the Design Constitution's tokens and resolves every adversarial tension by decision. All new classes follow the existing `kebab-case` convention; all sizes are `rem`-on-4px-grid with the 11px floor; all timings honor the motion budget.

Shared token additions referenced throughout (author once in `:root`, Tier-2 immutable):

```css
/* One glyph/word table for every trust surface (P2/P11) */
--seal-well-min: 16px;              /* no seal renders in a smaller well */
--fs-micro: calc(0.6875rem * var(--type-scale)); /* 11px HARD FLOOR */
/* posture → seal mapping (computed, never hardcoded) */
/* local            -> state:'verified' tone:--truth-local  (steel solid seal) */
/* encrypted-unatt. -> state:'asserted' tone:--truth-remote (copper half seal) */
/* encrypted-attest.-> state:'verified' tone:--v-verified   (verdigris check)  */
--bp-rail: 1040px; --bp-compact: 860px; --bp-mobile: 640px; /* the only 3 */
```

The single canonical component every seal now flows through:

```jsx
// components/Seal.tsx — ONE seal, six shapes / seven named states, real SVG, always word-labelled
const SEAL = {
  none:      { word:'Not checked', tone:'--v-neutral'  }, // ○ thin ring
  checking:  { word:'Checking',    tone:'--v-info'      }, // ◜◞ 270° ring (dashed => "Stale", tone:--v-caution)
  verified:  { word:'Verified',    tone:'--v-verified'  }, // ⬤✓ disc + inset check
  asserted:  { word:'Asserted',    tone:'--truth-remote'}, // ◐ vertical half-fill
  attention: { word:'Attention',   tone:'--v-caution'   }, // ◇! rotated square + bang
  failed:    { word:'Failed',      tone:'--v-failed'    }, // ⊗ circle + cross
};
function Seal({ state, size=18, tone, label }) {
  const well = Math.max(size, 16), t = tone ?? `var(${SEAL[state].tone})`;
  return (
    <span class={`seal seal--${state}`} role="img"
          aria-label={label ?? SEAL[state].word}
          style={`--seal-size:${well}px;--seal-ink:${t}`}>
      <svg viewBox="0 0 24 24" stroke-width="1.65" aria-hidden="true">{SEAL_PATHS[state]}</svg>
    </span>
  );
}
```

---

# D10 — PRIORITIZED DESIGN BACKLOG

Legend: **[QUICK]** = token/CSS/copy or a single-component edit · **[STRUCTURAL]** = new component, data-shape change, or windowing. IDs (B#) are referenced by D12.

## P0 — Experience blockers (the core promise fails without these)

**B1 · Lock the truth/verdict color tier out of the theme system** — [STRUCTURAL]
Drop `signal`/`danger` from `ThemeColorRole` (domain.ts) and from every theme's `colors` block (catalog.ts). Define `--v-verified/-caution/-failed/-info` and `--truth-local/-remote` once in `:root`, unreachable by `applyTheme`. Repoint every `.claim-seal.*`, `.status-seal.*`, `.large-seal.*`, attestation chip/mark to the verdict tier; delete the hardcoded `#a8cbc1` in `.status-seal.good`.
*Accept:* Cycling Foundry→Verdigris→Blue-Ledger, a verified seal is the identical verdigris and a failed seal the identical red in all three; no `theme.colors` path can recolor any seal/meter/status; topbar "good" seal and proof "verified" seal match hue within one theme.

**B2 · Ship the six-state SVG Seal instrument and compute the hero from posture** — [STRUCTURAL]
Replace the four divergent inline glyph ternaries (app.tsx:1940, 2217, 2606, 2713) and the 18px-circle-plus-9px-char CSS with the `Seal` component. The Proof hero seal is computed via `postureSeal(posture)` (steel solid / copper half / verdigris check), never `receipt ? '◐' : '○'`. Same component seeds the brand mark, favicon, boot, topbar chip.
*Accept:* For any `ProofStatus`, topbar, transcript, proof inspector, and attestations render the identical shape + accessible word; the three postures produce three visibly distinct hero seals; grayscale test distinguishes all six states without color; VoiceOver announces the word on every seal.

**B3 · Virtualize the live transcript and isolate the streaming re-render** — [STRUCTURAL]
Window to visible range + bounded overscan using a **per-card ResizeObserver measurement cache** with estimated-height spacers (message cards are variable height — no fixed-row windowing). Wrap `MessageCard` in `memo()` with hoisted/stable callbacks. Stop mapping the whole array per rAF (app.tsx:395-397): update only the in-flight card via its own slot. Reject Open-WebUI "progressive messagesCount" (it never unmounts). Reuse the transcript-boundary banner for the windowed head.
*Accept:* A 2000-message session mounts a roughly constant DOM-node count (including after "load earlier"); a profiler shows only the streaming card re-rendering per frame; RENDERED-PASS-NEEDED for 60fps + mobile thermals.

**B4 · Stick-to-bottom autoscroll + "Jump to latest" pill** — [QUICK, ships after B3]
Ref the `.transcript`; anchor to the **last real card's offset** (never virtual `scrollHeight`). Pinned within ~64px of bottom → keep newest content visible on each delta (`behavior:auto` while streaming); scroll-up detaches follow and reveals `.jump-latest` pill (bottom-right, re-pins on tap). Instant jump under `prefers-reduced-motion`.
*Accept:* Streaming keeps the newest token visible when pinned; scrolling up detaches and shows the pill; reduced-motion uses instant jump.

**B5 · Make the transcript CLI-grade: structured output + visible sealed tool activity** — [STRUCTURAL]
(a) Extend `AgentSignal` with `tool-call`/`tool-result`(/`reasoning-summary`); change `UiMessage.content` from string to an ordered `parts[]` (text|tool-call|tool-result|reasoning|error). (b) Render a zero-dep Preact markdown subset via `createElement` (never `innerHTML` — trusted-types intact): fenced code (`ui-monospace`, `--surface-raised`, horizontal scroll, copy button), inline code, lists, links, tables, blockquote. **Incremental parse during streaming**: freeze completed blocks, re-parse only the trailing open block. (c) Render model tool-calls as a bounded, collapsible, seal-stamped step card: `⬤✓ write app.tsx +12 −3` summary → bounded result preview; cap rendered steps ("N of M · show all"); store only bounded previews (reuse broker's 512-char/32-item/64-key bounds).
*Accept:* A ```code fence``` renders a bordered mono block with working copy; a 4000-char no-space token stays inside the bubble (`overflow-wrap:anywhere`); a multi-tool turn shows each step in order, each seal-stamped, none exceeding the preview cap; no tool activity is representable only as transient status text; zero new runtime deps; no `innerHTML` in the render path.

**B6 · Kill eager full-file reads; virtualize file list; bound editor** — [STRUCTURAL]
`refreshWorkspaceState` fetches **metadata only** and lazy-reads content on open; never runs `Promise.all(entries.map(read))` after every turn (app.tsx:445/723/842). Context/memory feed from a **hard-capped** index slice, not all bytes. `.file-list` gets `max-height` + `overflow-y:auto` + row windowing; add an "N of M shown" boundary row. Editor `<pre>` capped with "showing first N KiB — bounded" banner + windowed load-more; read path enforces a byte cap.
*Accept:* A 100k-file workspace mounts a bounded row count and the list scrolls independently of the editor; no full-content `Promise.all` runs on boot/after-turn; a multi-MB file opens with a boundary notice, not one giant text node.

**B7 · Enforce the 11px type floor and make the type-scale knob scale the chrome** — [STRUCTURAL]
Author all chrome in `--fs-*` rem tokens × `--type-scale`; delete every 7/8/9px literal (~107 sites). `data-type-scale="large|x-large"` multiplies the token calc so nav, composer, chat body, and dense grids visibly enlarge.
*Accept:* No computed `font-size` below `0.6875rem` anywhere; toggling `data-type-scale="large"` OR raising the browser default visibly enlarges sidebar labels, chat body, skill-card and billing-ledger labels.

**B8 · Restore trust legibility on mobile (persistent worst-of chip + sheet)** — [STRUCTURAL]
Replace `display:none` on `topbar-center` (styles.css:3198-3203) with one always-visible `.trust-chip` (worst-of Local/Vault/E2EE/Attestation) in the 52px topbar → tap expands a bottom sheet listing all four axes with drill-downs. Mirror pending proof/attestation badges onto mobile-nav buttons.
*Accept:* On a ≤640 chat view the current weakest posture is visible without navigating; the chip reflects worst-of and expands to the four-axis sheet; mobile-nav shows the same proof/attestation dots as desktop; seal semantics are unchanged on desktop.

**B9 · Offline / connectivity as a first-class runtime truth** — [STRUCTURAL]
Own `navigator.onLine` + `online`/`offline` listeners in app.tsx. Render a **fifth topbar seal** (`state:'attention'`, "Offline · local only", detail "Remote inference, sync, and account reads are paused"), reflected into the mobile worst-of chip. Disable Send / model discovery / "Continue to Chutes" / billing Refresh with an inline reason. Keep local surfaces (workspace, `/ls`, `/read`, memory, cached-receipt proof) fully live.
*Accept:* Airplane-mode toggles the seal and disables all network CTAs with a legible reason within one paint; local features stay interactive; reconnect clears the seal and re-enables CTAs.

**B10 · Never destroy streamed output; inline Retry; preserve the prompt** — [QUICK]
On mid-stream disconnect and on user **Stop**, keep already-streamed tokens and **append** a status footer ("connection lost — partial response" / "stopped — partial kept") instead of overwriting content (app.tsx:843-857). Store originating user content on the failed message; render an inline **Retry** in the transcript; restore the composer text on Stop. Purge raw codes (`STREAM_TRUNCATED`) from user copy.
*Accept:* A network-failed turn keeps its partial text + a working Retry that resends without retyping; Stop preserves partial output and restores the prompt; neither silently loses data.

**B11 · Rebalance the approval dock so the safe path isn't the hard path** — [QUICK]
Equal-width Deny/Allow columns, matched treatment (drop the brass primary from Allow); initial keyboard focus truly lands on Deny (fix `panel.focus()` vs `autofocus` conflict); on the mobile sheet Allow is not the sole thumb-zone control. Surface write consequence as first-class facts: **Target path**, **Create vs Replace** badge (from `expectedRevision`), **byte size/delta**, and a bounded old→new diff — not a raw JSON `<pre>`.
*Accept:* Allow is not larger/brighter than Deny; initial focus is Deny; approving a write shows filename + create/overwrite + size + bounded diff without expanding JSON; git and write approvals read at parity.

## P1 — Flagship quality

**B12 · Cmd/Ctrl+K command palette (prerequisite for any nav consolidation)** — [STRUCTURAL]
Global keydown → focus-trapped `role=dialog` palette: all destinations + the registry-derived slash commands + recent sessions, type-ahead filtered, Arrow/Enter/Esc, focus restored on close. Add `g c`-style jumps for high-traffic views.
*Accept:* Cmd/K opens from any view; typing filters; Enter runs the highlighted item; Esc restores prior focus; focus stays trapped while open.

**B13 · Consolidate nav 13→11 + Trust hub + scope edge-mark** — [STRUCTURAL]
Fold **Skills into Profiles** (tab) and **Account into Connection** (Account is unreadable without OAuth). **Keep Sources/Git top-level** and **keep Proof and Attestations as separate destinations** (they answer different questions) but group the Trust set under one hub header tab-strip; preserve `#proof`/`#attestations`/`#vault` hashes. Encode scope with **one** 2px low-chroma left-edge token (session/global/profile/workspace) reusing the active inset-bar — no legend key, no third color layer.
*Accept:* No two nav labels answer the same question; every removed slot is reachable via in-view tab + its deep-link hash survives; nav drops to 11; a first-time user can predict which surfaces re-render on session switch from the edge mark alone; consolidation ships only with B12.

**B14 · Wire topbar seals to drill-downs; separate session-scoped attestation** — [STRUCTURAL]
Convert `StatusSeal` from `<span>` to `<button>` navigating to its canonical view. Pull the receipt/session-scoped attestation seal out of the global row and render it in the stage-header session cluster, badged with the active `#sessionId`.
*Accept:* Clicking any seal lands on its matching view; the attestation indicator visibly reads "this session" (carries the id), not app-global.

**B15 · Enrich the claim stack + route every proof surface through humanizers** — [STRUCTURAL/QUICK]
Extend `ClaimRow` to the documented grammar (issuer, subject, **scope**, age, **expiry**, evidence digest, verifier policy, export) at parity with the attestations `DimensionInspector`. Replace raw `proofLevel`/`posture`/`status`/ISO outputs with `proofLevelLabel()`/new `postureLabel()`/capitalized `statusLabel()`/relative age (absolute in `<time datetime>`). De-jargon claim labels ("CPU TEE"/"GPU TEE"/"Endpoint key"/"Binding") to plain-language primary + technical secondary; demote digests behind a `Technical details` `<details>`. Provide one ranked bottom-line verdict above the flat claim list.
*Accept:* No kebab enum/raw ISO/raw digest is visible by default on any proof surface; opening any seal reveals issuer/subject/scope/age/expiry/digest/policy/export; a one-line plain verdict leads each receipt.

**B16 · Message action row (copy / retry / edit / branch)** — [STRUCTURAL]
Hover-on-desktop / tap-on-mobile cluster: Copy (always), Retry (errored/aborted turns), Edit-and-resend (user messages), Branch (fork-from-here reusing `expectedSourceHead`). Existing `.icon-button` primitives, 44px targets ≤640; evidence chips stay visually primary.
*Accept:* Copy works; a failed turn shows Retry that re-runs the same user turn; editing a user message repopulates the composer; Branch creates a pinned fork.

**B17 · Composer: auto-grow, attachments, queue feedback** — [STRUCTURAL]
`field-sizing:content` (scrollHeight fallback) from 1 line to 180px cap. Attach control + `onPaste`/`onDrop` → removable chips above the textarea carried as an attachment part, or an explicit "attachments not supported by this endpoint" state (never silent loss). Mid-turn Enter either queues with a visible chip or gives explicit "Agent is busy" feedback (no silent no-op).
*Accept:* Textarea grows to the cap without manual drag; pasting an image adds a removable chip; sending includes it as a part or clearly states unsupported; Enter mid-turn queues or gives feedback.

**B18 · Sources/Git comprehension + mobile safety** — [STRUCTURAL]
Add `.git-sources input/select/textarea` to the ≤640 16px guard. Replace the run-on `staged · modified` string with a two-slot **shape+letter status token** (M/A/D/R/C; filled=index, outlined=working) at `--ink`; show rename `from→to`; add a "Staged = ready to commit / Working = not yet staged" legend. Per-line diff coloring (`--v-verified` add / `--v-failed` remove, gutter signs, line numbers) + Wrap toggle. Surface ahead/behind vs upstream + relative last-fetch; gate Push with a non-fast-forward warning. Actionable empty state (Clone/Import/Open wired to `execute()`); worktree Create/Remove. Distinct `conflicted` row (diamond + "Conflict", excluded from bulk Stage, explicit "Mark resolved"). Version-conflict → dedicated reconcile banner with a local "Refresh this worktree and re-review" that preserves selection.
*Accept:* Focusing any git field on iPhone doesn't zoom; a non-git user can tell staged vs unstaged and change kind from the row; add/remove lines are distinguishable at 360px; the user sees ahead/behind before pushing; an empty Sources view offers one enabled/reasoned path; a conflicted file can't be silently bulk-staged; a version conflict shows a reconcile banner, not the generic red toast.

**B19 · Context: surface the routing layer above the forensics** — [STRUCTURAL]
Mount the already-built `ContextFabricDriver` output (`RoutedExpert{label,kind,score,bytes}`, warnings, `RetrievalCommitment`) as the **primary** result presentation: plain source name + humanized kind chip, one-line "why it matched", byte-cost readout, and a visible "recall reduced" banner on unavailable/timeout/budget. Keep the forensic lineage (generation/snapshot digests, embedding dims, chunker params, dense/lexical weights) **default-visible/sticky** — add the human layer above it, do not demote it. Split degraded tone off the green `ready` tone; rename states to plain words; add a preview-vs-injected disclosure line mirroring Memory's.
*Accept:* A search shows named sources + human "why" + byte cost above the forensic block; an unavailable expert produces a visible recall-reduced warning; a degraded generation renders caution (not green); the header states whether results feed the agent's replies.

**B20 · Memory: one kind-visual source of truth + navigable discovery** — [STRUCTURAL]
Single `KIND_VISUAL {color,shape}` consumed by derive, the sigma renderer (per-kind node programs; delete `nodeThemeColor`), and the legend — encode kind primarily by **shape** (session=brass disc, message=steel dot, file=verdigris square, profile=bright-brass ring, skill=copper diamond, term=hollow). Pan/zoom-to-node on every selection (≤300ms, instant under reduced-motion). Bounded-view banner surfacing `stats.truncated.*`/isolated/maxDegree. View-level "Hide from view" + clickable-legend kind filter (labelled "view filter, source unchanged"). `createdAt`/`revision` + humanized lineage in the inspector. **Memoize derive on a stable content hash** (not array refs) and **diff-update sigma** instead of teardown/rebuild on `graph.revision`. Debounce search 140ms + `role=listbox` keyboard nav.
*Accept:* Every legend entry's shape+color equals the canvas; all six kinds separable by shape without color; selecting via search/relationship-list centers the node; truncation is stated when any bound is hit; derive does not re-run every turn and sigma is not fully rebuilt; a keyboard user can arrow to a result and see it centered.

**B21 · Sessions: fork primacy, one verb, consequence-at-decision, rename + pin** — [QUICK/STRUCTURAL]
Drive button emphasis from `compatibility.action`: when `fork-required`/`blocked`, Fork becomes the brass primary ("Fork to continue"), disabled Resume becomes a ghost with a one-line reason. Use "Fork" as the only user-facing verb (retire "branch operation"); add a persistent definition "Fork = new identity · empty transcript · source untouched"; append a consequence line in the compatibility panel before the user reaches Fork. Add inline **rename** (reusing library validation) and a **pin/favorite** star with a sticky Pinned group. Add an "Auditing history…" busy state + aria-live; chunk `auditSessionHistory` in bounded event-count batches.
*Accept:* On a fork-required session the only enabled/brass control is Fork; "branch" never appears as action copy; the empty-transcript consequence is visible before forking; a user can rename a session and pin ≥1 to stay atop the 200-item fold; Resume shows "Auditing…" and a 20k-event audit doesn't freeze input.

**B22 · Profiles: honest permissions + non-destructive save/apply + reversible preview** — [QUICK/STRUCTURAL]
Relabel the skill "Tools:" footer to "Instructions reference:" + a line stating enable = pinned instructions only, tools remain approval-gated. Surface `minimumPosture` as a labelled trust-floor chip using the three posture words. Track draft dirty state; disable "Apply in a new session" while dirty (or save-then-apply); confirm before resetting on card switch. Reversible live theme preview (applyTheme without a revision, "previewing — not saved", revert-on-cancel); expand the swatch to ground/surface/ink/accent/signal/**danger**.
*Accept:* No card copy implies enabling a skill grants tools; every profile shows its minimum posture; no path applies/forks stale content; a theme can be previewed and reverted before save; the swatch shows danger and ink.

**B23 · Onboarding: bounded model picker, OAuth-origin legibility, aligned filter, funding CTA** — [STRUCTURAL/QUICK]
Shared `ModelPicker`: text input bound to `filterModels` **query (debounced)** + facets (hot/tools/cheapest/largest-context), rendering a bounded ~30-row list with a one-gesture **"Show all N eligible"** (soft cap, never a wall); each row shows id, hot, context, blended price; recommended pinned. Used in discovery, active-connection, and chat header (retire native `<select>`). On non-registered origin, disable "Continue to Chutes" with an inline reason and render OAuth errors adjacent to the button (not inside a collapsed `<details>`). Align the discovery filter with `DEFAULT_AIRSHIP_MODEL_REQUIREMENTS` or mark "no tools"/"not attestation-ready" per option. Add an in-card "Add funds at Chutes ↗" CTA when balance ≤0 / runway exhausted.
*Accept:* A 150+ model catalog narrows in ≤3 keystrokes; no surface renders >30 rows without "show all"; on a non-registered origin the primary button is disabled with a reason and errors are announced; no selectable model silently lacks tools; a zero balance shows an in-card funding CTA.

**B24 · Mobile: keyboard, safe-area, sticky approval, per-turn proof, legible bottom bar** — [STRUCTURAL/QUICK]
`visualViewport` hook: on keyboard open, yield the bottom nav and pin `.composer-wrap` to the visual-viewport bottom (feature-detected). Add `env(safe-area-inset-left/right/top)` via `max()` to topbar/transcript/composer/work-view/nav. Approval sheet: `position:sticky` non-scrolling Deny/Allow footer, arguments `<details>` closed by default, Deny not below Allow. Compact per-turn proof seal chip in the stage-header (opens Proof) since the inspector is hidden ≤860. Bottom bar: render exactly five fixed tabs — Chat, Sessions, Workspace, Trust, More — with no horizontal overflow. Put the remaining seven top-level destinations and nested Skills/Account tabs in the More sheet and expose the same complete set in Cmd/Ctrl+K. Mirror pending proof/attestation badges onto Trust/More and use a non-color active state (2px top rail/filled icon).
*Accept:* Keyboard-open keeps the composer above the keyboard and the nav yields; landscape on a notched device clears the notch on all sides; Deny/Allow are always visible without scrolling; per-turn verification is glanceable in mobile chat; all five fixed tabs remain visible and the active tab is distinguishable without color.

**B25 · States coherence: cause-specific errors, stale-aware account, timeout countdown** — [QUICK/STRUCTURAL]
One boundary mapper keyed on `SourceRequestError.code` + `navigator.onLine` + HTTP status → four distinct plain messages (offline / unreachable / 401·403 credential / 5xx provider) across chat, Access, Account. Billing datum functions honor the `loading` flag even when a prior value exists (mark in-flight during refresh); age "Observed {time}" / "Verified · {time}" into a caution tone past a threshold; label a stale catalog snapshot as stale. Render an "expires in mm:ss" countdown in the approval dock tied to `decisionTimeoutMs`.
*Accept:* Offline, a bad key, and a 500 produce three visibly different messages; a refresh marks metrics as updating and an old snapshot renders caution; a pending approval visibly counts toward expiry.

**B26 · Coherence: one focus color, on-brand Vault/LocalLab, serif on all h1** — [QUICK]
Delete the `#8db8df` focus ring and `--signal-good/-warn/-info` mint/blue fallbacks in vault-view.css / local-lab-setup.css; map onto `--v-*`/`--accent` and one `--focus:var(--accent-bright)`. Add `font-family:var(--font-display)` to the four rem-view `h1`s (access/attestations/context/sources).
*Accept:* One brass focus ring app-wide including Vault; Vault status colors match verdigris/brass/danger; all top-level `h1`s render in the editorial serif.

**B27 · Resilience: ErrorBoundary + beforeunload guard** — [QUICK]
A render `ErrorBoundary` around each view with a "recover to a working view" affordance; a `beforeunload` guard when unsaved profile edits, an in-flight turn, or an unsynced session exist.
*Accept:* An uncaught view throw shows a recovery affordance, not a white screen; closing with unsaved page-memory state warns first.

**B28 · Own "ephemeral vs synced" (the orphaned immutable truth)** — [STRUCTURAL]
Add a per-session/per-artifact durability indicator (`ephemeral | syncing | synced`) using dashed-border=ephemeral / solid=synced, and state once, plainly, that this build is **ephemeral-only** (`MemoryWorkspace`/`MemoryJournalBackend`) so the absence of sync is honest, not silent.
*Accept:* Every session/workspace surface shows a durability state; the build's ephemeral-only scope is stated in words; no UI implies sync the runtime does not perform.

**B29 · PWA update flow** — [QUICK]
Wire `updatefound`/`controllerchange` → a "New version available — reload" banner (transform/opacity only) so a cached shell is never silently pinned.
*Accept:* Deploying a new build surfaces a reload prompt; accepting it activates the new shell.

## P2 — Polish

**B30 · Functional micro-motion, tightly scoped** — [QUICK] `transition: background-color,border-color,color,transform ≤120ms` on nav-item/buttons/chips/selectable cards **only**; excluded from any transcript/file-list row until virtualized; already covered by the global reduced-motion kill-switch. *Accept:* State changes ease not snap; no transition >160ms; none animates layout; reduced-motion disables all.

**B31 · Static, layout-reserving skeletons** — [QUICK] Style `.route-loading` + 2–3 placeholder lines shaped like the target layout for lazy routes and restores; shimmer reduced-motion-gated (static fallback), never an idle loop. *Accept:* Lazy routes show a bounded skeleton matching the layout; zero cumulative layout shift on content arrival; reduced-motion is static.

**B32 · Ship the paper/light theme on the locked verdict tier** — [STRUCTURAL] Add `data-mode="light"` (`--paper #f3efe5` ground) inheriting identical `--v-*`/`--truth-*`. *Accept:* Verified/failed/attention are the same shape and meaning on paper as dark; RENDERED-PASS-NEEDED for AA text contrast.

**B33 · Settings/Preferences home** — [STRUCTURAL] A real surface (topbar gear + palette entry, not a nav slot) exposing type-scale, density, corners, body-font, and light/dark as global overrides. *Accept:* A user can change type-scale/density/corners/mode without editing a profile.

**B34 · Copper as the third working metal** — [QUICK] Un-alias `--copper` to a real oxidized copper and bind it to exactly one systematic role — the **asserted / present-but-unattested** half-seal — plus the mark's fin accent; brass stops carrying both CTA and caution. *Accept:* Copper appears in the asserted mid-state and the mark; grep shows `--copper` ≠ `var(--accent)`.

**B35 · De-duplicate the profile switcher; align labels↔hashes** — [QUICK] One authoritative `<select>` (topbar); the sidebar footer becomes a profile-detail card or the New-session CTA. Rename `#billing`→`#account`, `#access`→`#connection`. *Accept:* Exactly one profile control; every hash matches its visible label.

**B36 · Away-from-chat turn-complete signal** — [QUICK] `visibilitychange`/title-flash + a nav badge when a turn completes off the chat view. *Accept:* A turn finishing while the user is elsewhere produces a legible signal.

**B37 · Reconcile theme-manifest enums with implemented CSS; grouped hub relationships; multi-tab + selected-workspace honesty** — [QUICK] Implement or narrow `data-density=comfortable`/`corners=subtle`/`scale=compact`; group/paginate memory hub edges ("showing 18 of N"); add a `BroadcastChannel` "open elsewhere" note; add a workspace name indicator or state single-workspace intent. *Accept:* Every manifest value produces a visible change or is removed; hub edges page beyond 18; a second tab is legible; the selected-workspace truth is answered or scoped out in writing.

---

# D11 — REMOVE OR SIMPLIFY

Each line is an explicit action.

**Misleading / broken seals & truth colors**
- **Delete** the four inline glyph ternaries (app.tsx:1940, 2217, 2606, 2713) → single `Seal` component (B2).
- **Delete** the hardcoded `◐` Proof hero → `postureSeal(posture)` (B2).
- **Delete** the hardcoded `#a8cbc1` in `.status-seal.good` → `var(--v-verified)` (B1).
- **Remove** `signal`/`danger` from `ThemeColorRole` and every theme `colors` block; verdict colors move to immutable `:root` (B1).
- **Retire** the 2-glyph topbar seal (`✓`/`·`) where warn≡neutral; warn uses the diamond shape, not a color tint (B2/B8).
- **Un-alias** `--copper`; **un-overload** brass by giving copper the asserted role (B34).

**Duplicated concepts / surfaces to merge**
- **Delete** the second sidebar profile `<select>` (app.tsx:1466-1475) (B35).
- **Merge** Skills → a tab inside Profiles; **merge** Account → a section inside Connection (B13).
- **Group** Vault/Attestations/Proof/Connection under one Trust hub header (keep separate destinations + hashes) (B13).
- **Collapse** the four topbar seals into one worst-of posture chip; **move** the session-scoped attestation seal into the stage-header (B8/B14).
- **Collapse** the triple proof exposure: nav Proof + topbar proof button + always-mounted inspector → one canonical Proof home + a collapsible/toggleable inspector (B13/B24).

**Dead / decorative clutter**
- **Delete** the permanent "Tracking unavailable" workspace changes-panel column; reclaim the width for the editor (B6).
- **Delete** `backdrop-filter` blur on `.topbar` (:121), `.composer-wrap` (:836), `.slash-command-menu` (:864) → 100% opaque solid fills. **Drop** the `.approval-scrim` blur (:2866) and gate under `prefers-reduced-transparency` + ≤640.
- **Delete** the `.main` blueprint double-gradient grid (:419-421) — imperceptible, encodes no data.
- **Delete** decorative glows: brand-mark dot glow (:153), body radial (:47), memory-canvas radial (:2263), pulse-dot ring (:261).
- **Simplify** the nav-active state to the 2px inset knurl bar only; **delete** the brass gradient wash (:336).
- **Flatten** runway/usage meter fills to a single verdict token; **delete** the `--signal→--accent-bright` gradients (:2619, :2720) that blend two truth colors on one meter.
- **Reject** a self-hosted display serif — keep zero-byte Georgia (or drop serif); spend no font bytes on vibe.

**Weak labels / sub-legible text**
- **Delete** every sub-11px font literal (~107 sites) → `--fs-*` tokens (B7).
- **Retire** raw kebab enums (`encrypted-unattested`, `attested-endpoint`, `conversation-bound`, `not-supplied`), lowercase machine states (`partial`), raw ISO strings, and 64-char digests from all default views → humanizers + relative age + `Technical details` disclosure (B15).
- **De-jargon** claim labels ("CPU TEE"/"GPU TEE"/"Endpoint key"/"Model artifact"/"Binding") to plain-language primary + technical secondary (B15).
- **Rename** the fork "branch operation" copy → "fork"; reserve "branch/continue thread" for the future feature (B21).
- **Rename** context headline jargon ("Vectorization candidates"→"Files the agent can search", "Generation-pinned retrieval"→"Search results", "Vector memory"→"Index size", the 72/28 line→"Blends meaning (72%) and exact wording (28%)") (B19).
- **Relabel** the skill "Tools:" footer → "Instructions reference:" + non-grant qualifier (B22).

**Interaction / behavior to remove**
- **Remove** the eager `Promise.all(entries.map(read))` full-file read after every turn (app.tsx:1874) (B6).
- **Remove** native `<select>` model lists (model-control.tsx:47, access-view.tsx:387) → `ModelPicker` (B23).
- **Reject** the Open-WebUI "progressive messagesCount" pattern in favor of true unmounting windowing (B3).
- **Remove** the blue focus ring (`#8db8df`) and `--signal-good/-warn/-info` mint/blue fallbacks → brass focus + `--v-*` (B26).
- **Remove** the CSS that hides Sort between 861–1180px (sessions-view.css:865-867) → wrap to a second row or overflow menu (B21).
- **Remove** the silent no-op on mid-turn Enter → queue chip or explicit feedback (B17).
- **Remove** silent column drops on mobile (usage tokens, session-meta, session origin) → an explicit expand affordance (B24).

---

# D12 — NORTH-STAR WALKTHROUGH

One continuous journey, on the shipped **Instrument** system. Every seal below is the *same* `Seal` component; every truth color is immutable; nothing drops below 11px; motion is transform/opacity only, ≤160ms, reduced-motion-safe.

**0 · First paint (offline-resilient boot).**
The cached shell paints instantly on `--ground #101417`. Center stage: the brand mark — a milled brass diamond seeded from the *same geometry as the verified seal* (B2), pinned to `--brand-brass`, no glow. A single hairline `.rule--engraved` under a Georgia headline "Airship". No blueprint wash, no idle animation. Because the runtime assembles locally (`MemoryWorkspace` + `DemoInferenceTransport`), you land in a working local-demo agent even with no network — and if you are offline, the topbar already shows a fifth seal, `◇ Attention · Offline · local only` (B9), so the truth "local vs remote" is legible before you touch anything.

**1 · Connect — Sign in with Chutes.**
You open the palette with **⌘K** (B12), type "conn", hit Enter → the Connection view. The recommended path is a verdigris-bordered card "Sign in with Chutes"; beneath it a collapsed `Use an inference API key instead`. You are on the registered origin, so "Continue to Chutes ↗" is enabled (on a deploy where it isn't, the button is disabled with an inline reason, not a dead click — B23). OAuth completes; the callback shows a genuine success tone, and the topbar E2EE seal transitions to `◐ Asserted · Encrypted · unattested` in **copper `--truth-remote`** — honest: encrypted, not independently checked. The capability matrix names the credential in plain language with `cak_` as a secondary monospace annotation, not a headline.

```
┌ TOPBAR (≥1040) ─────────────────────────────────────────────────────────────┐
│ ◆Airship   [ posture ▾ ⬤✓ On-device ]   ⟳acting  ⌘K   [Foundry ▾] [+ New]    │
│            ↑ one worst-of chip, click → sheet; session attestation lives      │
│              in the stage-header, not here                                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**2 · Choose model + profile.**
Instead of a native dropdown of hundreds, the **ModelPicker** opens (B23): a search field (debounced onto `filterModels`) over facet chips `[hot] [tools] [cheapest] [largest ctx]`, a bounded ~30-row list, a pinned "Recommended", and a one-gesture "Show all N eligible" so an expert can still scan the tail. Each row shows id · hot · context · blended $/M. Rows lacking tool support are marked "no tools" — the selectable set no longer diverges silently from the recommendation. You pick a tools-capable, attestation-candidate model; the Foundry profile is active in the topbar. Its `minimumPosture` chip reads "Encrypted · unattested" (B22), so you know the trust floor this persona will run on.

**3 · Start a session; the transcript is the instrument.**
⌘K → "new" (or the persistent **[+ New]** in topbar-actions, distinct from Chat-nav — B35). The stage header carries the session `#id`, a durability chip `⌟ Ephemeral — discarded on teardown` (B28, honest for this build), and a session-scoped `◐ Asserted` attestation seal (B14). You type a multi-line prompt; the composer auto-grows to its 180px cap (B17). You send. The user bubble appears right-aligned; the assistant bubble left-aligned shows an **acting** pulse (the one permitted loop, mounted only while working). First tokens stream in, rendered as real markdown — a fenced code block in `ui-monospace` on `--surface-raised` with a working **Copy** button, parsed **incrementally** (completed blocks frozen, only the trailing block re-parsed) so a long code reply never melts the CPU (B5). You stay pinned to bottom; scroll up and a `▼ Jump to latest` pill appears (B4). The transcript is windowed with a ResizeObserver measurement cache, so a 2000-message thread stays smooth (B3).

```
┌ STAGE ── Active session · Engineer #a91f  ◐ Asserted·this session ─ [model ▾] ┐
│ You  ▸ refactor the auth guard and commit it                                  │
│ A    ▸ Here's the plan: …  (markdown, code fences, copy)                      │
│      ├ ◐ read  auth.ts        → 4.1 KB            [▸]   ← sealed tool step     │
│      └ ⬤✓ write auth.ts       +12 −3              [▸]                          │
│ ▼ jump to latest (streaming)                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ Ask Airship or / for tools…                                    ] (send)     │
│ 🔒 credential in memory · tool approvals on · ⌟ ephemeral                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Every model tool-call is now **visible** as a collapsible, seal-stamped step row (B5) — not an ephemeral 9px status label. You can see exactly which file was read (`◐ read auth.ts → 4.1 KB`) and expand a bounded preview.

**4 · Attach + use the workspace.**
You drag a spec file onto the composer; it becomes a removable chip above the textarea (B17). You ask the agent to apply it. Opening **Workspace**, the file list scrolls in its own bounded pane — no 100k-button blowout, because reads are metadata-only and content is lazy-loaded on open (B6). The editor opens `auth.ts`; a large file shows "showing first N KiB — bounded" rather than a frozen giant `<pre>`. The dead "Tracking unavailable" column is gone; the editor uses the reclaimed width.

**5 · Approve an action — the safe path is the easy path.**
The agent's `write auth.ts` needs approval. The **ApprovalDock** appears (a focus-trapped modal on desktop; a bottom sheet with a **sticky** Deny/Allow footer on mobile — B24). It leads with the *consequence*: `Target /workspace/auth.ts`, a `Replace` badge (from `expectedRevision`), `+12 −3, 4.2 KB`, and a bounded old→new diff — not raw JSON (B11). Deny and Allow are equal-width, matched weight; **Deny holds initial keyboard focus**; Escape denies. A subtle `expires in 4:58` counts down so a silent auto-deny is never a surprise (B25). You Allow-once; the step row flips to `⬤✓ Verified` in verdigris.

**6 · Inspect Git.**
**Sources** shows the change list with **shape+letter status tokens**: a filled brass `M` (staged/index) and an outlined `M` (working), with a "Staged = ready to commit / Working = not yet staged" legend so a non-expert can read the two planes (B18). The diff panel colors additions `--v-verified` and deletions `--v-failed` per line with number gutters and a Wrap toggle. The Remote section shows `↑1 ↓0 vs origin/main · fetched 3 min ago`, so you know a push will fast-forward. On a phone this whole flow is usable one-handed: fields are 16px (no zoom), and a sticky bottom action bar keeps the "Commit created locally. Nothing was pushed." confirmation in the thumb zone (B18/B24). Commit and push remain two separate approvals; force-push is never exposed.

**7 · Context + Memory.**
**Context** now leads with the human routing layer: named sources with humanized kind chips ("This folder", "Recent work"), a one-line "why it matched", and a byte-cost readout ("read 42 KiB of 8 MiB budget") — with the forensic lineage (generation/snapshot digests, embedding dims, dense/lexical weights) kept **default-visible** below for experts (B19). A degraded index renders **caution**, not the verified green. A plain line states results are "preview only — not yet inserted into replies." **Memory** renders one kind-visual source of truth: shapes distinguish all six node kinds (session disc, message dot, file square, profile ring, skill copper-diamond, term hollow) so the legend never lies and color-blind users can still read it (B20). You search a term; the camera eases to the node (≤300ms, instant under reduced-motion). A bounded-view banner tells you if any nodes/edges were truncated. You "Hide from view" a noisy term kind — labelled clearly as a view filter, source unchanged.

**8 · Verify a receipt.**
**Proof** opens on the session's receipt. The hero seal is **computed from posture** (B2): here `⬤✓ Verified` in verdigris with a one-line plain verdict "Encrypted & attested · this session" — never a permanent `◐`. A local demo turn would instead show a steel solid seal "Local only"; an unattested turn the copper half seal — three visibly distinct states. Below, the claim stack leads with a ranked bottom-line verdict, then rows carrying issuer/subject/**scope**/age/**expiry**/evidence-digest/verifier-policy/**export** — plain-language labels, relative age ("checked 3 min ago", absolute in `<time>`), digests tucked behind `Technical details` (B15). The topbar posture chip is clickable and lands you right here (B14); the same seal shapes you saw on the tool steps and the message chips appear here identically — one instrument, everywhere.

**9 · Check account/standing.**
**Connection → Account** (Account is a section of Connection now, since it's unreadable without OAuth — B13). Four honest datums: Balance, Runway, Invocation authorization, Usage — each degrading to verified/unknown/unavailable/loading, never fabricating "unlimited". During a refresh the cards mark themselves in-flight and "Observed 2 min ago" ages into caution past threshold, so a stale balance never masquerades as fresh (B25). If balance hits zero, an in-card "Add funds at Chutes ↗" CTA appears exactly where you need it (B23).

**10 · Resume on mobile.**
Later, on a phone, you reopen the PWA (a "New version available — reload" banner offers the fresh shell — B29). The 52px topbar shows the **one worst-of trust chip** — trust is *not* dropped on mobile (B8). You tap it: a bottom sheet lists Local / Vault / E2EE / Attestation, each with a drill-down. The bottom nav is the fixed five-tab bar — Chat, Sessions, Workspace, Trust, More — with no horizontal scrolling, pending proof/attestation badges, and a non-color active rail; the other destinations remain one tap away in More and one gesture away in the palette (B24). You open **Sessions**; your session is pinned to the top (you starred it — B21). It changed model since, so **Fork to continue** is the brass primary while a ghosted Resume states the reason, and the panel already tells you a fork starts a fresh transcript while the source stays intact — the consequence is visible *before* you commit (B21). You Fork, type a follow-up; `visualViewport` pins the composer above the keyboard and yields the nav (B24). The reply streams, stays pinned to bottom, and every tool step is sealed and legible — the same instrument you trusted on the desktop, now in your hand.

The through-line: **subtract chrome, never expert reach; render the agent's real work inline and virtualized; make the one six-shape / seven-named-state seal the signature on a color system where trust meaning can never move; and keep that truth legible at 11px, on a phone, offline.** That is the difference between a beautiful proof shell around a generic chat and the instrument Airship claims to be.

---
