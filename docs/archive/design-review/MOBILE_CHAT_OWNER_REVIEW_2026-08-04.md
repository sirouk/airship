# Mobile review — the owner, on an iPhone 14 Pro Max, 2026-08-04

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../../SIMPLIFICATION.md`](../../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

Recorded verbatim in substance, at the time it was given, because the failure
this project keeps repeating is that reviews like this get read once and then
live nowhere. Screenshots were taken at 430×932.

The owner's framing, which sets the bar: **"this is the most important
experience, people use their phones and it needs to be state of the art like
using ChatGPT or Claude or even OpenWebUI on mobile; those are all so much
better."**

And the direction for the whole product: **"this entire application needs a
minimalist touch."**

---

## Chat

**The header is a tumor.** It consumes roughly 200px of a 932px screen before a
single message. Within it:

- The model dropdown renders as a card floating inside a circular outline, the
  two overlapping — a visual artifact, not a design. `CHUTES · SESSI…` is
  clipped mid-word above it.
- The skills glyph and the session-state control each take their own slot on
  that row.
- The conversation title sits on the same row and is squeezed by all of it.

**What the owner wants instead:** the `Browser / Edge runtime` pill at the top
already exists and should carry the session's facts — which model is being
chatted with in *this* thread, the encrypted-inference statement, and the pinned
conversation skills. Those do not each need their own icon eating horizontal
space. The chat title and model should be **slim horizontally but visible**, and
**tapping the title should edit it**.

The session state with its `✕` is fine where it is: "that's good to know, the
last known info about the current chat and thread, they can click and see the
info fine."

**Messages are truncated.** Text is clipped at the right edge in both
screenshots. Note `.transcript` computes to `overflow-x: auto`, which absorbs
horizontal overflow before it can reach `main.main` — so
`e2e/narrow-viewport-overflow.spec.ts` passes while the content is unreadable.
That absorber is already documented in that spec's own header comment as the
reason a route-level assertion is silent about everything inside it.

**The composer is too large**, and two things in it are wrong:

- The `Encrypted inference through …` caption is always present beneath the
  input. The owner: *"that's great to know but does it have to be shown that
  way?"* — the information is wanted, the permanent placement is not.
- **"Key in memory" in the composer is "ridiculous ... why show it there in the
  input box, that's so strange."**

**The profile picker (top right)** is "clunky looking" — extra concentric circles
and a caret. *"Why are we doing things like it's 1998? These elements should be
fast, lightweight, but not clunky, it should be minimalist really."*

**The `Idle` indicator and the `0` above it** (bottom-left of the mobile nav):
the owner does not know what it means. He typed a prompt and neither the word
nor the number changed. Either it reports something real and must visibly do so,
or it should not occupy a nav slot.

**Bottom nav order.** He likes the bottom bar and its placement. But **Memory
should come before Trust** — currently `Idle · Chat · Workspace · Trust · More`.

---

## Memory (mobile)

*"Nope, it's not [up to par] ... Very horrible design."*

The route opens with two posture pills, a search field, a status line, a
recent-searches card, a starter-terms card, and then three cards — `Current
conversation`, `Active profile memory`, `Workspace & sources` — each showing an
icon and a bare count inside a circle, with no explanation.

His objection is that the pills, icons and counts carry **no understandable
information**: *"Do I click them? What do I do with those pills and rows?"*

**What he wants:** *"Why on the memory page do we have anything other than a
search, the results, and then at the bottom the stats? Organize it better, don't
remove information but it needs to be presented better and definitely less
wordy."*

So: search first, results second, statistics last. Nothing deleted — restructured
and cut down in words.

---

## Trust / Proof (mobile)

He likes the substance and one element specifically: **the `VERIFIED / ASSERTED /
NO EVIDENCE` block with its counts and one-line definitions is good** — keep it.

The problem is everything above it: a heading, a subtitle, a two-line policy
sentence, a tab pair, a verdict card, a `TURN EVIDENCE` panel, a further
paragraph, and a six-row `RECORDED IN THIS SESSION'S JOURNAL` list — a wall of
text before the part that reads well.

*"I like the info, but how it's being presented is just not well thought about
from UI/UX ... I don't want to lose information but present it in a better way."*

---

## What the audits already found, and what this adds

This is not new ground, which is the uncomfortable part:

- `docs/design-review/journey-complaints.md:96-102` and
  `docs/design-review/visual-critique.md:302` measured that **the phone renders
  the desktop type scale verbatim** — computed `:root` is byte-identical at 360,
  430 and 1440. Title-to-body is 1.12:1 on phone against 1.54:1 on desktop, so
  there is no hierarchy, and `--fs-micro` (~11.7px) carries the trust vocabulary
  and the nav labels. That one fact explains the cramped header, the unreadable
  labels and the wall-of-text Trust page simultaneously.
- Register item 1.6: a `/help` turn scrolls the transcript sideways by 57px at
  320px. Same absorber.
- Register item 1.7: the conversation title collapses to one or two characters.

See `docs/audit/RECOVERED_WORK_REGISTER_2026-08-04.md` §1.6–1.8 for the
measurements, the designed fixes and — importantly — the recorded blind-fix
risks. In particular the type-scale fix must be expressed in **rem multiples of
`--type-scale`**, never px literals, or it breaks WCAG 1.4.4 text scaling, and
bumping `--type-scale` inside a media query is the wrong lever because it
composes multiplicatively with the user's own preference.

What this review adds beyond those: the header composition (fold session facts
into the runtime pill), the composer's two misplaced controls, the profile
picker's weight, the `Idle` indicator's meaning, the nav order, and the Memory
route's structure.
