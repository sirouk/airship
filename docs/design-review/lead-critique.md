# Lead critique — my own complaints, measured

Measured across ten routes (`#chat`, `#workspace`, `#editor`, `#terminal`, `#memory`, `#proof`,
`#vault`, `#access`, `#profiles`, `#account`) at 1440x900 on the running build.

## The three numbers that explain almost everything

| measure | found | what a system looks like |
|---|---|---|
| distinct font sizes | **36** | 6–8 |
| distinct border radii | **13** | 2–3 |
| distinct border styles | **32** | 3–4 |
| unique uppercase eyebrow labels | **49** across 10 routes | a handful, if any |

The font sizes are the tell. They include `11.6875px`, `12.92px`, `12.24px`, `11.73px`, `12.58px`,
`13.3333px`. Those are not choices — they are `em`/`%` compounding through nested containers. There
is no type ramp; there is inheritance drift. Everything downstream in this critique follows from
that.

## 1. Nothing on screen tells the eye what matters

Tool cards, claim rows, status pills, suggestion cards, the model card, the guidance banner and the
assistant's actual answer are all rendered as 1px-bordered rounded rectangles on near-identical
backgrounds. There is no weight hierarchy, so the eye has no way to find the content.

This is the *root cause* of "the tool rollup swallows the message". The rollup is not too big in
absolute terms — it is the same visual weight as the answer, and there are four of them. Fixing the
rollup's height alone will not fix this. Content needs a distinct visual register from evidence.

## 2. Borders are doing the work whitespace should do

93 elements share `1px rgba(225,217,200,0.106)` and 55 more share the 0.18 variant. Grouping is
achieved almost entirely by drawing a box around things, which is why the product reads as boxes
inside boxes inside boxes. Modern dark interfaces group with spacing and a subtle background step,
and reserve borders for genuine containment or interactivity.

## 3. The monospace eyebrow is a tic, not a pattern

49 unique uppercase labels: "ACTIVE SESSION · GENERAL", "DEVICE-EXECUTED · PAGE WORKSPACE",
"PRIVATE RECALL & ON-DEVICE RETRIEVAL", "REVISION-BOUND LOCAL MATERIALIZATION", "ARGUMENTS ·
BOUNDED DISPLAY", "ONE, OR SEVERAL AT ONCE", "SELECT A NODE"…

Every panel gets one. Each costs a line of vertical space, and because they are everywhere the eye
learns to skip them — so the few that carry real meaning are skipped too. Several are internal
vocabulary leaking out ("revision-bound local materialization" is an implementation detail, not a
label for a human).

## 4. The display serif is spent on navigation, not on titles

Six elements render at 47px: the route H1s — "Editor", "Memory", "Proof", "Connect models". These are
destinations the user already chose from the rail; restating them in magazine-headline serif is the
single largest contributor to every route being top-heavy. A serif that appears on a conversation
title is expressive; a serif that appears on "Editor" is decoration with a 47px vertical cost.

## 5. One route template is applied to two different kinds of screen

Every route follows: eyebrow → serif H1 → paragraph → pill → content. That template suits a
*document* (Proof, which genuinely explains things). It is wrong for a *tool* (Editor, Terminal,
Memory) where the content should start at the top and fill the frame. Applying one template to both
is why the editor spends a large band before showing a single file.

## 6. Status is spoken in five visual languages at once

Outlined pills (topbar), filled pills with a leading dot ("Ready"), monospace hash tokens
(`#f614ef61`), bordered rows with a coloured status word ("Verified" / "Asserted"), and plain prose
sentences. All express the same class of thing — the state of a claim — in five different renderings.
The claim rail's six ASSERTIONS rows, every one reading "Asserted · Turn receipt", is the extreme
case: six rows, one fact.

## 7. Empty states describe absence instead of offering action

"Airship has not looked yet." · "No completed turn." · "Enter a query or refine it to surface results
from this scope." · "Open a file from Explorer."

Each is accurate and each is a dead end. An empty state is the best opportunity a product has to
teach itself, and these spend it apologising.

## 8. The layout moves under the user

The claim rail appears only when a turn produces a receipt, taking ~320px and narrowing the
conversation column mid-session. Nothing warned it was coming and nothing lets the user keep it away.

## 9. Numbers are printed without meaning

"105 recorded steps", "1 recorded step #b18d5959", "7 established · 1 not established". No unit, no
baseline, no indication whether any of these is good, normal, or worth attention. A number a user
cannot act on is decoration that looks like data.

## 10. The composer is surrounded by things that are not the composer

The input shares its row with Attach image, a durability lock line, an "Ask First" pill, a chevron
and Send — and carries a permanent caption beneath it: "Encrypted inference through
zai-org/GLM-5.2-TEE; this compatibility connection has no required endpoint-proof gate." That is 108
characters restating what the topbar pill and the model badge already say, sitting under the one
element the user touches most. Meanwhile the text field itself is so short its own placeholder wraps
and clips.

## The thesis

Airship's interface is not cluttered because it shows too much. It is cluttered because **everything
is shown at the same volume.** There is no type ramp, no weight hierarchy, and no distinction between
content and evidence — so every honest detail this product fought to earn competes with every other
one, and with the answer the user actually came for.

The fix is not to remove information. It is to give the interface a *register*: one type ramp, a
content layer that is visually dominant, an evidence layer that is quiet but one interaction away,
and a single status language. Every piece of information keeps its place in that structure — most of
them just stop shouting.
