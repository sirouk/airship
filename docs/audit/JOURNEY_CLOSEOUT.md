# Human-journey audit — closeout

What this pass changed, what it proved, and what is still open. Written to be
checkable: every claim here is either enforced by a gate or names the file that
demonstrates it.

## The three findings that mattered most

**The audit's own paperwork was the largest unowned defect.** `JOURNEY_ROUTING.md`
opened with "148 findings, 148 routed, 0 unrouted" and the line "Assertion: the
sum of lane counts equals the Atlas total, or the routing script fails." There
was no routing script. The number was true when it was typed and nothing kept it
true.

`scripts/journey-atlas-gate.mjs` is now that mechanism, wired into `npm run
check`. Running it for the first time found four findings sitting in the Atlas
prose owned by no lane at all, and found that the Atlas narrated 100 of 152
findings while presenting itself as the canonical document.

**One boot navigation was being chased as four separate bugs.** A cold visit
navigates three times and only the third is the app: document at 29ms, minted
conversation address at 127ms, a full document reload at 153ms as the service
worker takes control so the isolation headers apply, and a second — different —
minted address at 212ms. That single event produced "Execution context was
destroyed" in one spec, a keyboard chord vanishing into a document with no
handlers attached in another, and a geometry probe returning `undefined` for a
route whose elements were all present when probed with a settle.

`e2e/support/settled.ts` names the boundary once. The product-side half is J151.

**J151 was already written down and nobody owned it.** "The service-worker
takeover reloads the document mid-journey and the page-memory conversation does
not survive it." It had evidence. It had no lane, so nobody read it, so it was
rediscovered from zero three passes later at a cost of most of a session. That
is what an unowned finding costs, and it is the argument for the gate above.

## Product changes

| Finding | Change | Enforced by |
|---|---|---|
| J151 | The service-worker takeover no longer reloads over work no authority could give back. The gesture fence stays; `reloadWouldDiscardWork` adds recorded turns and unsent drafts under page memory. Under an adopted Vault it still reloads immediately — the journal is on the far side. | `src/ui/reload-risk.test.ts` (7) |
| J152 | The runtime-update banner offsets by a live measurement instead of a constant, so it stops landing on the composer's send button. The capability dock's private copy of that measurement became `bottom-floor.ts`, read by both. | `src/ui/bottom-floor.test.ts` (4) |
| Deletion vs loss | Deleting a conversation forgets its return-ledger entry. Before this, deleting a thread and returning the next day was reported as lost work — a count, a timestamp, and an offer to set up a Vault to protect work that was thrown away on purpose. | `src/ui/chat/return-ledger.test.ts` |
| Proof overflow | `.proof-verdict`'s `auto` first column took its max-content and starved the body: at 1024x900 the columns resolved to 819px and 48px and the scope panel ran 132px past the main column. The screen whose whole job is to be checkable was the one that scrolled sideways. | `e2e/responsive-breakpoints.spec.ts` |
| Rail auto-open | The self-opening recents list no longer pushes Vault, Connection and Account below the fold on a short viewport. | `src/ui/rail.tsx` height gate |

## Standing rules this pass did not bend

- **The entry ceiling did not move during this pass.** It stood at 112 KiB gzip,
  first paint, and entry measured 111.98 KiB — it passed with 20 bytes of
  headroom. Everything added this pass was either deferred or paid for out of
  the lazy graph. (It has ratcheted since; the ceiling in force is the one in
  `scripts/release-gate.mjs` and its mirrored row in `docs/RELEASE_GATE.md`,
  which the gate checks against each other. Read that pair, not this dated
  number, before sizing an entry-path change.)
- **Budgets ratchet with a measurement and a reason, or not at all.** Two whole-KiB
  steps moved this pass; both comments record what crossed them and what it
  bought. `scripts/release-gate.test.mjs` still demands the tightest whole-KiB step.
- **No test was weakened to make a failure go away.** Every spec fix in this pass
  made the test measure the thing it claimed to measure — waiting for the element
  under assertion rather than a proxy for it. Where a change traded one durability
  failure for another it was reverted whole.

## Review round two — what changed

Every item review raised was confirmed before it was fixed, including the two
about this document's own machinery.

**1. The gate was not reproducible.** It read `.ui-capture/atlas.json`, which is
gitignored, so `npm run check` passed on one workstation and could not run from
a clean clone. The sanitized findings now live at
`docs/audit/JOURNEY_FINDINGS.json`, tracked. Proved by cloning the repo to a
fresh directory with no `.ui-capture/` present and running the gate there.

**2. The gate passed states it existed to reject.** `--fix` was not idempotent:
the header rewrite searched for `|---|---|---|---|`, which is a *prefix* of the
`|---|---|---|---|---|` it writes, so it matched its own output and five runs
stacked five `id` columns. The "idempotence check" that missed it compared exit
codes rather than bytes. The Atlas also said "Ten personas" and "8 personas ·
100 gaps" on the same page as a 152-finding index, because nothing generated
those numbers.

Now: every derived number and table is generated from the tracked source;
verification parses lane tables and proves ownership per row (exactly one lane,
the declared lane, each lane opened once, counts equal to rows present);
`--fix` re-runs over its own output and compares text; and
`scripts/journey-atlas-gate.test.mjs` has 18 tests, one per failure mode —
missing source, duplicate ids, unlaned findings, drifted persona totals, a
finding in two lanes, a finding in the wrong lane, a lane opened twice, count
drift, a finding in no lane, a stale header, malformed headers, stacked id
columns, and non-idempotent generation.

**3. Deletion is now atomic in the way that matters.** The ledger module is
loaded before the delete begins so the write after it is a synchronous
`setItem`, and it is awaited before "Deleted …" is announced. A Vault wipe
retires its continuity records too, in every backend branch. Four browser
journeys cross the browser-session boundary, carrying `storageState` forward —
without which "delete, close, reopen, assert no loss" asserts that an empty
ledger reports nothing.

**4. All browser failures were diagnosed, never excused.** Every one had a
cause. Several were product defects: the trust sheet losing keyboard focus on
close, a rename discarded by an unrelated background write, a bare `import()`
with one attempt on the transcript renderer. Two were the product being right
and the test being early — the delete refused by its own head fence while a
turn was still appending, exactly as designed.

**5. Entry headroom restored by deferral, not by a raise.** Entry breached the
ceiling at 112.01 KiB gzip during this work, which settled the question: 20
bytes is not a margin. The command palette and preferences dialog left the entry
chunk for `platform-overlays.tsx`, warmed on idle after first paint.

  Entry JS: 112.01 (breach) → **110.68 KiB gzip**, ceiling 112, headroom 1.32 KiB.

**6. Ephemerality is now a decision, not an implementation.** See the posture
section below.

**7. `app.tsx` was not touched structurally.** Decomposition stays the first
dedicated architectural follow-up after merge.

## The ephemeral posture

Keeping the continuity witness, and dropping the claim it contradicted.

| was | is |
|---|---|
| "Page memory only / Nothing survives closing this tab." | "Ephemeral content / Your writing dies with the tab. One line per conversation stays, so a return can tell you." |
| "Ephemeral · this page only" | "Ephemeral · content not saved" |

The disclosure names every retained field and all three ways the record ends.
**Erase continuity record** sits on the Vault route under this posture and
clears the witness alone — no journal, no drafts, no preferences. The 14 days is
marked PROVISIONAL in source: a guess never checked against real return
behaviour. Strict ephemeral, with no cross-tab metadata at all, remains open as
a future posture rather than being silently foreclosed.

## The build is not deterministic across checkouts

Found while proving the clean-checkout gate, and worth stating plainly because
it invalidates a class of measurement this pass relied on.

`src/ui/chat/transcript-operations.ts` is imported by `platform-shell.tsx` (boot
path) and by `message-parts-view.tsx` (deferred). Rollup is free to resolve that
shared module either way, and it does: two clones of the identical tree — same
sources, same config, same lockfile, verified byte-identical — emitted a **350 B
stub in one and a 10.5 KiB chunk in the other**, moving the baseline budget by
4 KiB gzip.

The release-gate ceilings had been tuned to the smaller split, so `npm run
check` passed on the machine it was written on and failed in a clean clone. That
is the same class of defect as a gate reading an untracked file, one level down.

Naming the chunk in `vite.config.ts` did not pin it. The ceilings now cover both
splits and record both figures rather than pretending one of them is the number.
**Making the split itself deterministic is a real piece of work and is not this
pass's job** — it is the second architectural follow-up after `app.tsx`.

## Where the browser suite finished

Desktop **146 passed, 0 failed, 38 skipped of 184**. Mobile **92 passed, 0 failed,
92 skipped of 184**. Playwright owning its own web server, both projects.

Two measurement lessons are worth more than the number:

- A run taken while `dist` was being rebuilt underneath it reported "89 passed,
  0 failed" and accounted for only 127 of 180 tests. It looked like the best
  result of the session and was worthless. Arithmetic on the totals is what
  caught it.
- A run taken against a hand-started `npm run preview` reported 44 failures,
  including whole worker and OAuth suites. Playwright's own web server supplies
  the cross-origin isolation headers those suites need. A green-looking server
  on the right port is not the right server.

*Historical note.* Four failures remained at an earlier checkpoint in this pass
and were listed here as open. All were subsequently diagnosed and closed, along
with the ones that surfaced behind them; several turned out to be product
defects rather than test problems. **The zero-failure matrix above is
authoritative.**

## Open

- **`app.tsx` is 620 KB in one file.** Splitting it is architectural and was not
  attempted here. It is the single largest obstacle to reviewing shell changes.
- **48 of 152 findings are owned and evidenced but not narrated.** The complete
  index in `JOURNEY_ATLAS.md` marks them `prose: no`. They are findings, not gaps
  in the audit, but a reader working from the narrative alone will not meet them.
  Both figures are generated, so this line cannot drift from the index again.
- **The return ledger's 14-day witness is provisional, not settled.** It has a
  documented reason and a test; it has never been checked against how people
  actually return. See the posture section above — the Erase control is what
  makes the interim defensible, and strict ephemeral remains open.
- **The build is not deterministic across checkouts.** Recorded above. This is
  the first architectural follow-up, ahead of `app.tsx`: every bundle
  measurement, release manifest and artifact digest depends on reproducible
  output, so nondeterminism undermines the measurement system itself.
- **Retrieval is three implementations, not one.** `docs/architecture/ADR-001-hybrid-retrieval.md`
  records hybrid BM25 + dense retrieval as Airship's default and supersedes the
  per-route scorers. Measured during this pass: the lane that assembles turn
  context scores lexical evidence with `matches / |query|` — no IDF, no term
  frequency, no length normalization — while a proper BM25 sits unused in a
  sibling directory. Third follow-up, behind determinism and `app.tsx`.
- **Touch-floor sweep** covered the controls this pass added; it is not a
  whole-product sweep.
