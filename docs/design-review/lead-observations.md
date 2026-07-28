# Lead observations — measured from real captures, 1440x900 connected turn

Source: `.aesthetic/shots/desktop-09-turn-30000.png` (live Chutes turn, GLM-5.2-TEE, two tool calls).

## 1. Tool-call rollup genuinely swallows the answer — confirmed, worse than described

One tool invocation renders as **two full-width bordered cards** (TOOL CALL, then TOOL RESULT). Two
invocations = four stacked cards consuming **~360px** (y 230→590). The assistant's actual prose — the
thing the person asked for — is **four lines at y 590→700**, visually subordinate to the machinery
that produced it.

Each card carries **three labels for one status**:
- a title: "Tool step failed" / "Tool step completed"
- a kind label: "TOOL CALL" / "TOOL RESULT"
- a status pill: FAILED / ERROR / COMPLETED / SUCCESS

Plus "ARGUMENTS · BOUNDED DISPLAY", a code box, and a raw `call_596e09d4159e47659a3c4535` id at rest.

The answer needs to be the visual subject; the calls need to be an inspectable strip, not four cards.

## 2. The trust contradiction is still live

In this single viewport, about the same turn:

| where | says |
|---|---|
| topbar pill | **Evidence unavailable** |
| session model badge | **E2EE · evidence recorded** |
| session status row | **Evidence unavailable · this session** |
| receipt chip under the answer | **Evidence not pulled** |
| right rail header | Encrypted · no required endpoint proof · some claims are assertions |
| right rail, green | **VERIFIED 1 — Protected CPU runtime ✓ Verified** |

"Evidence unavailable" and "evidence recorded" and "VERIFIED" simultaneously. A careful person cannot
answer "is this turn proven"; a careless one reads the green check.

## 3. The claim stack is six identical rows

Right rail (~320px wide) lists ASSERTIONS 6 — Encrypted transport, Fresh evidence, Protected
accelerator, Endpoint identity, Model artifact, Conversation integrity — and **every one reads
"Asserted · Turn receipt"**. Six rows carrying one fact. This is the clearest case in the product of
information that should be re-presented rather than dropped: the six claims are real and must stay
reachable, but at rest they are one line.

## 4. Chrome before content

topbar 58px → title + floating model card → status row → content starts ~230px. On a 900px viewport
that is ~26%.

## 5. Composer still clipped when connected

"Ask Airship or type / for tools and session commands…" wraps to two lines and is cut off at the
bottom edge, at 1440x900 and on iPhone. A new caption also sits below it: "Encrypted inference
through zai-org/GLM-5.2-TEE; this compatibility connection has no required endpoint-proof gate."

## 6. Model selector

Renders as `CHUTES · SESSION MODEL / GLM-5.2-TEE ⌄` floating top-centre-right with an `E2EE ·
evidence recorded` pill beside it — detached from the conversation title it sits next to.
