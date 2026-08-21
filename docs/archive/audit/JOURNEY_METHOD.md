# The journey method, and the four ways the last pass got it wrong

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../../SIMPLIFICATION.md`](../../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

A human-journey audit found 148 gaps. Twenty-six were fixed, thirty-four were
declined with a reason, and **eighty-eight were never routed to anyone**. The
audit was good; the execution around it leaked. This is the corrected method,
written down because every one of those leaks was structural rather than
accidental, and none of them announced itself.

## What went wrong

**The batches were hand-picked.** Six thematic briefs were written from what one
reader happened to remember, and findings were cherry-picked into them. Nothing
counted, so nothing could notice that 60% of the findings had no owner. A pass
that cannot tell you its own coverage does not have any.

**Ownership was by file; journeys are not.** File-exclusive batches are correct
for safe concurrency and wrong for coherence. "A returning person can return"
crosses the shell, the session library, the vault and two routes. Split across
owners, each fixed their fragment and nobody owned the outcome.

**Nobody reviewed the integrated product.** Six reviewers each re-drove their own
batch. Not one re-drove a journey against the *merged* result. That is how a
branch became six-times-accepted while still losing conversations: the defect
lived exactly where two batches met, which is the one place the review design
could not look.

**"Accept with repairs" was treated as terminal.** It is not a verdict, it is a
to-do list. Thirty-four repairs sat unapplied under a word that reads like
approval.

## The method

### 1. Route mechanically, before anyone starts

Every finding gets a stable ID at discovery time. A script partitions all of
them and **asserts that the routed count equals the total**. If one finding has
no owner the script fails and the pass does not start. No agent — and no lead —
chooses what to work on.

Route by **surface**, not by file: surfaces are what humans navigate, they keep a
journey mostly intact, and they are near-exclusive in the file system anyway.

### 2. Own a surface, fix a journey

An owner receives a lane of findings *and* the journeys those findings belong to.
The instruction is to make the journey whole, not to clear the list. Where a
finding is a symptom of a cause outside the lane, the owner names the cause and
declines the symptom — a decline with a real reason is a good outcome and is
tracked as one.

### 3. Reviewers re-drive on the integrated build

A reviewer does not review a batch. They take a journey, drive it end to end on
the merged product at 1440x900 **and** 390x844, and compare against the Atlas's
baseline evidence for that journey. They are asked to disprove the improvement,
not to confirm it.

### 4. Verdicts are binary

**Approved** or **changes requested**. Nothing else. If repairs are needed the
verdict is changes-requested and the work returns to an implementer. A repair
that is merely recorded has not happened.

### 5. Close with a full re-drive

After integration, every persona from the original Atlas is driven again against
the merged product and diffed against baseline. A journey that regressed
somewhere else is a finding of this pass. Only that diff can call a pass
complete.

### 6. Evidence is rendered, not asserted

Every claim carries what a person saw before and after, at both device classes.
A green test is not evidence that a human can understand what happened. A
screenshot read by the person making the claim is worth more than a passing
assertion about the DOM.

## The standing laws these serve

1. Organize complexity; never erase capability.
2. Meet the user at their level — connect-and-chat immediately, expert depth close.
3. Profiles are real silos; Vault, Connection and Account are global.
4. Capability comes forward automatically.
5. Every state tells the truth — never a stronger claim than the evidence supports.
6. Mobile is reorganization, not reduction.
7. Performance is architectural; the first-paint ceiling does not move for feature work.
