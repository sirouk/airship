# Shell and navigation rail — the owner, 2026-08-04

Companion to `MOBILE_CHAT_OWNER_REVIEW_2026-08-04.md`, same session, desktop
rail this time. Recorded verbatim in substance for the same reason: reviews here
have a habit of being read once and then living nowhere.

Screenshots at desktop width, `#chat` with six conversations, General profile.

---

## 1. The collapse control is in the wrong place, and hover-expand is worse

**Today:** a chevron pinned at the rail's bottom-left corner, plus auto-expand
when the pointer enters the collapsed rail.

**Wanted:** the collapse/expand affordance belongs **in the middle of the seam
between the rail and the page**, behaving like a drawer handle — *"ever so
subtle."* And **hovering the left edge must not auto-expand**: *"that's clunky
and jumps around."*

**Note this is a revision, not a dropped fix.** The bottom-left chevron is the
shipped design, specified at `docs/design-review/lane-proposals-surfaces.md:44`:
> a 24×24 chevron button pinned at the rail's bottom-left corner
> (`aria-label="Collapse navigation rail"` / `"Expand navigation rail"`,
> `aria-expanded`)

So the earlier design was built, and the owner has now judged the result. Keep
`⌘\` / `Ctrl+\` and the command-palette entries from that proposal — those are
not in dispute — and move the visible affordance.

**Hover-expand lives at `src/ui/shell.css:1310`**, inside `@media (hover: hover)`:
`.sidebar[data-rail-state="rail"]:not([data-recents="flyout"]):hover .rail`
widening to 268px on a 180ms delay, with a matching block at `:1317` revealing
the labels. Removing it must not remove the *keyboard* path to expansion, and
the flyout guard exists for a reason — read it before deleting.

---

## 2. Three different visual languages in one rail

The owner's objection is consistency, and he is describing three groups that do
not agree:

- **The destination rows** (`Chat`, `Workspace`, `Memory`, `Proof`, `Vault`,
  `Connection`, `Account`) carry a thick, well-spaced active/selection mark on
  their left edge. **He likes these** — they are the reference the other two
  should follow: *"the thicker and properly spaced and sized tab mark that's to
  the left of each entry."*
- **The top block** (`Profiles`, `Skills`, `Capabilities`) uses a different
  treatment entirely — a thin hairline rather than that mark.
- **`All conversations`** is a bordered button sitting inside the conversation
  list, in a third style again.

*"Why have it different?"* — no reason has been recorded. Unify on the
destination-row language, with the caveat below.

Related and already designed: `docs/design-review/screen-reviews.md:1042-1049`
requires `All conversations` to move **out** of the `#airship-recent-conversations`
scroller and become a pinned footer row with a count (`↳ All conversations · 9`),
because at six or more threads it currently scrolls out of reach entirely. The
restyle and that relocation are the same edit — do them together, and note the
owner now has exactly six conversations, so he is at the threshold.

---

## 3. The profile name is starved

`General` fits; `Research` truncates to `Resear…`. The row spends its width on a
monogram, the name, a caret, and the word **`Profiles`** beside a person glyph.

**Wanted:** *"perhaps the Profiles can just be a small button without the word
title 'Profiles' so the name can have the space to breathe."*

This agrees with an existing proposal.
`docs/design-review/lane-proposals-surfaces.md:76` already deletes the
`AGENT PROFILE` eyebrow as visible copy while preserving it as the popover header
and the row's `aria-label`, on the grounds that a visible label on a row already
showing a monogram and a name is redundant. Same argument applies to the word
`Profiles` on the button: keep the glyph, keep the accessible name, drop the
visible word.

---

## 4. Palette diversity

**What ships today** (`src/profiles/catalog.ts:380-520`): **Nord**, **Tokyo
Night**, **Catppuccin Mocha**, **Gruvbox Dark**, **Solarized Dark**, **One
Dark**, **Foundry** — seven, all well-known, and the owner is explicit that he
does not want them thrown away.

**His judgement:** *"some of them I like, but perhaps we can have a more diverse
mix, some are really similar to the others, but maybe don't get rid of them
unless you can tell they should be diversified."*

Reading the set against that: it is **six dark themes and one house theme, with
no light option at all**, and several occupy adjacent territory — Nord, Tokyo
Night and Catppuccin Mocha are all cool blue-violet darks. The gap is not "more
themes", it is **coverage**: at least one genuine light theme, and chromatic
range beyond cool-dark — warm, green, and high-contrast.

Candidates from the same well-known open space, chosen for distance from what
exists rather than popularity alone: **Rosé Pine Dawn** or **Solarized Light**
(light), **Everforest** (warm green), **Dracula** (saturated purple),
**Ayu Mirage** (warm amber-dark), **GitHub Light** (neutral light).

Constraints that already apply and must not be relaxed to fit a palette: every
theme is a `ThemeManifestDraft` of surface/ink/accent tokens
(`src/profiles/domain.ts:77-91`) with **no arbitrary CSS** — pinned by
`src/profiles/domain.test.ts:57` — and a theme **cannot recolour truth states**.
The verdict vocabulary (`--v-verified`, `--v-caution`, `--danger`) is not a
theming surface, because a palette that can repaint "verified" green onto a
failed claim defeats the entire product.

**Distinct from the editor syntax theme.** A separate lane is adding editor
themes (One Dark Pro and others) for the *code* surface. That is the syntax
palette; this is the app chrome. Note the collision risk: a shell theme named
`One Dark` already exists here, and the editor lane is adding `One Dark Pro`
there. They are different things and must be named so a person can tell.
